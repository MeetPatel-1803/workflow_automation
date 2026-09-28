import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { PrismaService } from '../../prisma/prisma.service';
import { ApiError } from '../../shared/response/apiError.service';
import { WorkflowExecutionQueueService } from '../workflow-engine/workflow-execution-queue.service';
import { ExecutionDetailResponseDto } from './dto/execution-detail-response.dto';

export interface ExecuteResult {
  executionId: string;
  status: string;
  /** true only when this call created a brand-new execution (controls 202 vs 200). */ created: boolean;
}

@Injectable()
export class ExecutionsService {
  private readonly logger = new Logger(ExecutionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: WorkflowExecutionQueueService,
  ) {}

  /**
   * `organizationId` always comes from the caller's JWT — the workflow
   * lookup below is scoped to it, so an org can only ever execute its own
   * workflows. See README "How idempotency works" for the exact race this
   * closes.
   */
  async execute(
    organizationId: string,
    workflowId: string,
    idempotencyKey?: string,
  ): Promise<ExecuteResult> {
    const workflow = await this.prisma.workflow.findFirst({
      where: { id: workflowId, organizationId },
      select: { id: true },
    });
    if (!workflow) {
      throw ApiError.notFound('Workflow not found');
    }

    if (!idempotencyKey) {
      // Deliberate: every call with no Idempotency-Key creates a new
      // execution — no dedup — see README "How idempotency works".
      const execution = await this.prisma.workflowExecution.create({
        data: { workflowId, organizationId, status: 'PENDING' },
      });
      await this.queue.enqueueInitial(execution.id);
      this.logger.log(
        `Enqueued execution ${execution.id} for workflow ${workflowId}`,
      );
      return {
        executionId: execution.id,
        status: execution.status,
        created: true,
      };
    }

    const existing = await this.findByIdempotencyKey(
      organizationId,
      idempotencyKey,
    );
    if (existing) {
      return {
        executionId: existing.id,
        status: existing.status,
        created: false,
      };
    }

    try {
      const execution = await this.prisma.$transaction(async (tx) => {
        const created = await tx.workflowExecution.create({
          data: { workflowId, organizationId, status: 'PENDING' },
        });
        await tx.idempotencyRecord.create({
          data: {
            organizationId,
            key: idempotencyKey,
            executionId: created.id,
          },
        });
        return created;
      });
      await this.queue.enqueueInitial(execution.id);
      this.logger.log(
        `Enqueued execution ${execution.id} for workflow ${workflowId} (idempotency key ${idempotencyKey})`,
      );
      return {
        executionId: execution.id,
        status: execution.status,
        created: true,
      };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // Two concurrent requests with the same key can both pass the
        // findByIdempotencyKey check above before either commits — this is
        // the exact race the unique constraint on
        // (organizationId, key) closes, not the transaction alone. The
        // loser re-queries for the winner's execution rather than erroring.
        const winner = await this.findByIdempotencyKey(
          organizationId,
          idempotencyKey,
        );
        if (winner) {
          return {
            executionId: winner.id,
            status: winner.status,
            created: false,
          };
        }
      }
      throw error;
    }
  }

  private async findByIdempotencyKey(
    organizationId: string,
    key: string,
  ): Promise<{ id: string; status: string } | null> {
    const record = await this.prisma.idempotencyRecord.findUnique({
      where: { organizationId_key: { organizationId, key } },
      include: { execution: { select: { id: true, status: true } } },
    });
    return record?.execution ?? null;
  }

  /**
   * WHERE id = :id AND organizationId = :organizationId directly on
   * WorkflowExecution (the denormalized column) — no join through Workflow
   * needed for this check. Identical 404 whether the id doesn't exist or
   * belongs to a different org — same reasoning as WorkflowsService.
   */
  async findOne(
    organizationId: string,
    executionId: string,
  ): Promise<ExecutionDetailResponseDto> {
    const execution = await this.prisma.workflowExecution.findFirst({
      where: { id: executionId, organizationId },
      include: { stepExecutions: { orderBy: { startedAt: 'asc' } } },
    });
    if (!execution) {
      throw ApiError.notFound('Execution not found');
    }

    return plainToInstance(ExecutionDetailResponseDto, {
      executionId: execution.id,
      workflowId: execution.workflowId,
      status: execution.status,
      currentStep: execution.currentStepId,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
      error: execution.error,
      stepExecutions: execution.stepExecutions,
    });
  }
}
