import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { HttpStepConfigDto } from '../workflows/dto/step-configs/http-step-config.dto';
import type { StepDto } from '../workflows/dto/step.dto';
import { StepType } from '../workflows/dto/step-type.enum';
import { StepHandlerDispatchService } from './step-handlers/step-handler-dispatch.service';
import type { StepHandlerOutcome } from './step-handlers/step-handler.types';
import { WorkflowExecutionQueueService } from './workflow-execution-queue.service';

/** Raw shape of a `SELECT * FROM "WorkflowExecution" ... FOR UPDATE` row. */
interface LockedExecutionRow {
  id: string;
  workflowId: string;
  organizationId: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  currentStepId: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  error: string | null;
  createdAt: Date;
}

type ClaimResult =
  | { action: 'noop' }
  | { action: 'advance-only'; nextStepId: string | null }
  | { action: 'ensure-failed'; error: string }
  | { action: 're-wait'; stepId: string; remainingMs: number }
  | {
      action: 'complete-wait';
      stepId: string;
      attempt: number;
      nextStepId: string | null;
    }
  | {
      action: 'execute';
      step: StepDto;
      attempt: number;
      previousOutput: unknown;
      nextStepId: string | null;
    };

type EnqueueIntent =
  | { type: 'none' }
  | { type: 'next'; nextStepId: string }
  | { type: 'delay-wake'; stepId: string; delayMs: number }
  | {
      type: 'retry-wake';
      stepId: string;
      nextAttempt: number;
      delayMs: number;
    };

function toJsonInput(
  value: unknown,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === undefined || value === null
    ? Prisma.DbNull
    : (value as Prisma.InputJsonValue);
}

const lockExecutionSql = (executionId: string) =>
  Prisma.sql`SELECT * FROM "WorkflowExecution" WHERE id = ${executionId} FOR UPDATE`;

/**
 * One processor invocation = one call to processTick(executionId). Every
 * call re-reads current state from Postgres — the BullMQ job payload is
 * never trusted for anything beyond "which execution to look at" (see
 * README "How concurrency is handled").
 *
 * Deliberately a plain injectable service (not hidden inside the BullMQ
 * Worker callback) so it can be invoked directly in tests, bypassing the
 * queue entirely, to exercise the FOR UPDATE race directly and
 * deterministically.
 */
@Injectable()
export class WorkflowExecutionTickService {
  private readonly logger = new Logger(WorkflowExecutionTickService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatch: StepHandlerDispatchService,
    private readonly queue: WorkflowExecutionQueueService,
  ) {}

  async processTick(executionId: string): Promise<void> {
    const claim = await this.claimTick(executionId);

    switch (claim.action) {
      case 'noop':
        return;
      case 'advance-only':
        await this.advanceOnly(executionId, claim.nextStepId);
        return;
      case 'ensure-failed':
        await this.ensureFailed(executionId, claim.error);
        return;
      case 're-wait':
        await this.queue.enqueueDelayWake(
          executionId,
          claim.stepId,
          claim.remainingMs,
        );
        return;
      case 'complete-wait':
        await this.persistDelayResume(executionId, claim);
        return;
      case 'execute': {
        let outcome: StepHandlerOutcome;
        try {
          outcome = await this.dispatch.dispatch({
            step: claim.step,
            attempt: claim.attempt,
            previousOutput: claim.previousOutput,
          });
        } catch (error) {
          // A step handler should never throw (each one wraps its own I/O in
          // try/catch) — this is a last-resort net so an unexpected bug in a
          // handler still resolves as a clean FAILED step, never an
          // unhandled rejection that crashes the worker process.
          this.logger.error(
            `Step handler threw for execution ${executionId}, step ${claim.step.id}`,
            error instanceof Error ? error.stack : String(error),
          );
          outcome = {
            kind: 'failure',
            retryable: false,
            error:
              error instanceof Error
                ? error.message
                : 'Unknown step handler error',
          };
        }
        await this.persistOutcome(executionId, claim, outcome);
        return;
      }
    }
  }

  // ---- TX 1: claim/verify ownership of this tick ----

  private async claimTick(executionId: string): Promise<ClaimResult> {
    return this.prisma.$transaction(async (tx): Promise<ClaimResult> => {
      const rows = await tx.$queryRaw<LockedExecutionRow[]>(
        lockExecutionSql(executionId),
      );
      const execution = rows[0];
      if (!execution) {
        this.logger.warn(`processTick: execution ${executionId} not found`);
        return { action: 'noop' };
      }
      if (execution.status === 'COMPLETED' || execution.status === 'FAILED') {
        return { action: 'noop' }; // safe no-op: duplicate/stale job after finish
      }

      if (execution.status === 'PENDING') {
        await tx.workflowExecution.update({
          where: { id: executionId },
          data: { status: 'RUNNING', startedAt: new Date() },
        });
      }

      const workflow = await tx.workflow.findUniqueOrThrow({
        where: { id: execution.workflowId },
      });
      const steps = workflow.steps as unknown as StepDto[];

      const currentStepId = execution.currentStepId ?? steps[0]?.id;
      if (!currentStepId) {
        // Defensive: CreateWorkflowDto's validators never allow an empty
        // steps array, but don't crash the worker if this is ever reached.
        await tx.workflowExecution.update({
          where: { id: executionId },
          data: {
            status: 'FAILED',
            error: 'Workflow has no steps',
            completedAt: new Date(),
          },
        });
        return { action: 'noop' };
      }

      const stepIndex = steps.findIndex((s) => s.id === currentStepId);
      const step = steps[stepIndex];
      const nextStepId = steps[stepIndex + 1]?.id ?? null;

      const latest = await tx.stepExecution.findFirst({
        where: { executionId, stepId: currentStepId },
        orderBy: { attempt: 'desc' },
      });

      const previousOutput =
        stepIndex > 0
          ? await this.readStepOutput(tx, executionId, steps[stepIndex - 1].id)
          : undefined;

      if (!latest) {
        await this.createAttemptRow(tx, executionId, step, 1, previousOutput);
        return {
          action: 'execute',
          step,
          attempt: 1,
          previousOutput,
          nextStepId,
        };
      }

      switch (latest.status) {
        case 'RUNNING':
        case 'PENDING':
          // A prior invocation started this exact attempt but crashed
          // before persisting a result — resume the SAME attempt (never
          // skip it, never duplicate it). This is the at-least-once
          // resumption behavior — see README "What happens when a worker
          // crashes".
          return {
            action: 'execute',
            step,
            attempt: latest.attempt,
            previousOutput,
            nextStepId,
          };

        case 'RETRYING': {
          const attempt = latest.attempt + 1;
          await this.createAttemptRow(
            tx,
            executionId,
            step,
            attempt,
            previousOutput,
          );
          return {
            action: 'execute',
            step,
            attempt,
            previousOutput,
            nextStepId,
          };
        }

        case 'WAITING':
          if (!latest.resumeAt || latest.resumeAt.getTime() <= Date.now()) {
            return {
              action: 'complete-wait',
              stepId: currentStepId,
              attempt: latest.attempt,
              nextStepId,
            };
          }
          return {
            action: 're-wait',
            stepId: currentStepId,
            remainingMs: latest.resumeAt.getTime() - Date.now(),
          };

        case 'COMPLETED':
          // Stale pointer (defensive): this step already finished under an
          // earlier tick; just advance past it without re-executing.
          return { action: 'advance-only', nextStepId };

        case 'FAILED':
          // Stale pointer (defensive): the step already failed under an
          // earlier tick, but the execution somehow wasn't marked FAILED —
          // fix that up rather than treating it as complete.
          return {
            action: 'ensure-failed',
            error: latest.error ?? 'Unknown failure',
          };
      }
    });
  }

  private async createAttemptRow(
    tx: Prisma.TransactionClient,
    executionId: string,
    step: StepDto,
    attempt: number,
    previousOutput: unknown,
  ): Promise<void> {
    try {
      await tx.stepExecution.create({
        data: {
          executionId,
          stepId: step.id,
          stepType: step.type,
          attempt,
          status: 'RUNNING',
          input: toJsonInput(previousOutput),
          startedAt: new Date(),
        },
      });
    } catch (error) {
      // Idempotent write target (@@unique([executionId, stepId, attempt])):
      // if this exact attempt row somehow already exists (should not happen
      // while we hold the execution row lock, but the constraint is the
      // backstop, not the FOR UPDATE lock alone), treat it as already
      // created rather than crashing the tick.
      if (!(
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )) {
        throw error;
      }
    }
  }

  private async readStepOutput(
    tx: Prisma.TransactionClient,
    executionId: string,
    stepId: string,
  ): Promise<unknown> {
    const previous = await tx.stepExecution.findFirst({
      where: { executionId, stepId, status: 'COMPLETED' },
      orderBy: { attempt: 'desc' },
    });
    return previous?.output ?? undefined;
  }

  /**
   * Updates one StepExecution row, tolerating the case where it no longer
   * matches (P2025 "record not found"): the FOR UPDATE lock on
   * WorkflowExecution serializes ticks for a given execution, but it does
   * NOT serialize a genuinely concurrent *duplicate* delivery of the same
   * tick (two different jobIds racing for the same execution, or two direct
   * processTick() calls in a test) all the way through — both can pass
   * claimTick's "resume this RUNNING attempt" branch before either commits a
   * result. Whichever commits first wins; the other's update target can then
   * legitimately no longer match here. Treating that as "someone else
   * already resolved this" (log + return false) rather than throwing is
   * exactly the "observe state has already moved past what it expected and
   * no-op safely" behavior this module is built around — see README "How
   * concurrency is handled".
   */
  private async tryUpdateStepExecution(
    tx: Prisma.TransactionClient,
    key: { executionId: string; stepId: string; attempt: number },
    data: Prisma.StepExecutionUpdateInput,
  ): Promise<boolean> {
    try {
      await tx.stepExecution.update({
        where: { executionId_stepId_attempt: key },
        data,
      });
      return true;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        this.logger.warn(
          `Step ${key.stepId} attempt ${key.attempt} for execution ${key.executionId} was already resolved by a concurrent tick — no-op.`,
        );
        return false;
      }
      throw error;
    }
  }

  // ---- TX 2: persist the result and advance ----

  private async persistOutcome(
    executionId: string,
    claim: Extract<ClaimResult, { action: 'execute' }>,
    outcome: StepHandlerOutcome,
  ): Promise<void> {
    const { step, attempt, nextStepId } = claim;

    const intent = await this.prisma.$transaction(
      async (tx): Promise<EnqueueIntent> => {
        const rows = await tx.$queryRaw<LockedExecutionRow[]>(
          lockExecutionSql(executionId),
        );
        const execution = rows[0];
        if (
          !execution ||
          execution.status === 'COMPLETED' ||
          execution.status === 'FAILED'
        ) {
          return { type: 'none' }; // stale: another tick already finished this
        }

        const stepExecutionKey = { executionId, stepId: step.id, attempt };

        if (outcome.kind === 'success') {
          if (
            !(await this.tryUpdateStepExecution(tx, stepExecutionKey, {
              status: 'COMPLETED',
              output: toJsonInput(outcome.output),
              completedAt: new Date(),
            }))
          ) {
            return { type: 'none' };
          }

          if (step.type === StepType.COMPLETE || nextStepId === null) {
            await tx.workflowExecution.update({
              where: { id: executionId },
              data: { status: 'COMPLETED', completedAt: new Date() },
            });
            return { type: 'none' };
          }
          await tx.workflowExecution.update({
            where: { id: executionId },
            data: { currentStepId: nextStepId },
          });
          return { type: 'next', nextStepId };
        }

        if (outcome.kind === 'waiting') {
          if (
            !(await this.tryUpdateStepExecution(tx, stepExecutionKey, {
              status: 'WAITING',
              resumeAt: outcome.resumeAt,
            }))
          ) {
            return { type: 'none' };
          }
          return {
            type: 'delay-wake',
            stepId: step.id,
            delayMs: outcome.resumeAt.getTime() - Date.now(),
          };
        }

        // outcome.kind === 'failure'
        const maxAttempts =
          step.type === StepType.HTTP
            ? ((step.config as HttpStepConfigDto).maxAttempts ?? 1)
            : 1;

        if (outcome.retryable && attempt < maxAttempts) {
          if (
            !(await this.tryUpdateStepExecution(tx, stepExecutionKey, {
              status: 'RETRYING',
              error: outcome.error,
            }))
          ) {
            return { type: 'none' };
          }
          const retryDelayMs =
            step.type === StepType.HTTP
              ? ((step.config as HttpStepConfigDto).retryDelayMs ?? 1000)
              : 1000;
          const backoffMs = retryDelayMs * 2 ** (attempt - 1);
          return {
            type: 'retry-wake',
            stepId: step.id,
            nextAttempt: attempt + 1,
            delayMs: backoffMs,
          };
        }

        if (
          !(await this.tryUpdateStepExecution(tx, stepExecutionKey, {
            status: 'FAILED',
            error: outcome.error,
            completedAt: new Date(),
          }))
        ) {
          return { type: 'none' };
        }
        await tx.workflowExecution.update({
          where: { id: executionId },
          data: {
            status: 'FAILED',
            error: outcome.error,
            completedAt: new Date(),
          },
        });
        return { type: 'none' };
      },
    );

    // Enqueue AFTER the transaction commits — never inside it (job broker
    // and DB commit are two different systems; see README "known
    // limitation").
    await this.applyIntent(executionId, intent);
  }

  private async persistDelayResume(
    executionId: string,
    claim: Extract<ClaimResult, { action: 'complete-wait' }>,
  ): Promise<void> {
    const intent = await this.prisma.$transaction(
      async (tx): Promise<EnqueueIntent> => {
        const rows = await tx.$queryRaw<LockedExecutionRow[]>(
          lockExecutionSql(executionId),
        );
        const execution = rows[0];
        if (
          !execution ||
          execution.status === 'COMPLETED' ||
          execution.status === 'FAILED'
        ) {
          return { type: 'none' };
        }

        if (
          !(await this.tryUpdateStepExecution(
            tx,
            { executionId, stepId: claim.stepId, attempt: claim.attempt },
            {
              status: 'COMPLETED',
              output: Prisma.DbNull,
              completedAt: new Date(),
            },
          ))
        ) {
          return { type: 'none' };
        }

        if (claim.nextStepId === null) {
          await tx.workflowExecution.update({
            where: { id: executionId },
            data: { status: 'COMPLETED', completedAt: new Date() },
          });
          return { type: 'none' };
        }
        await tx.workflowExecution.update({
          where: { id: executionId },
          data: { currentStepId: claim.nextStepId },
        });
        return { type: 'next', nextStepId: claim.nextStepId };
      },
    );

    await this.applyIntent(executionId, intent);
  }

  private async advanceOnly(
    executionId: string,
    nextStepId: string | null,
  ): Promise<void> {
    const intent = await this.prisma.$transaction(
      async (tx): Promise<EnqueueIntent> => {
        const rows = await tx.$queryRaw<LockedExecutionRow[]>(
          lockExecutionSql(executionId),
        );
        const execution = rows[0];
        if (
          !execution ||
          execution.status === 'COMPLETED' ||
          execution.status === 'FAILED'
        ) {
          return { type: 'none' };
        }
        if (nextStepId === null) {
          await tx.workflowExecution.update({
            where: { id: executionId },
            data: { status: 'COMPLETED', completedAt: new Date() },
          });
          return { type: 'none' };
        }
        await tx.workflowExecution.update({
          where: { id: executionId },
          data: { currentStepId: nextStepId },
        });
        return { type: 'next', nextStepId };
      },
    );

    await this.applyIntent(executionId, intent);
  }

  private async ensureFailed(
    executionId: string,
    error: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<LockedExecutionRow[]>(
        lockExecutionSql(executionId),
      );
      const execution = rows[0];
      if (
        !execution ||
        execution.status === 'COMPLETED' ||
        execution.status === 'FAILED'
      ) {
        return;
      }
      await tx.workflowExecution.update({
        where: { id: executionId },
        data: { status: 'FAILED', error, completedAt: new Date() },
      });
    });
  }

  private async applyIntent(
    executionId: string,
    intent: EnqueueIntent,
  ): Promise<void> {
    switch (intent.type) {
      case 'next':
        await this.queue.enqueueNextStep(executionId, intent.nextStepId);
        return;
      case 'delay-wake':
        await this.queue.enqueueDelayWake(
          executionId,
          intent.stepId,
          intent.delayMs,
        );
        return;
      case 'retry-wake':
        await this.queue.enqueueRetryWake(
          executionId,
          intent.stepId,
          intent.nextAttempt,
          intent.delayMs,
        );
        return;
      case 'none':
        return;
    }
  }
}
