import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { RECONCILIATION_STUCK_PENDING_MS } from './workflow-engine.constants';
import { WorkflowExecutionQueueService } from './workflow-execution-queue.service';

/**
 * Worker-process-only safety net (see README "How delays survive a
 * restart" and "known limitation" under idempotency). Runs every 60s:
 *
 *  1. PENDING executions older than RECONCILIATION_STUCK_PENDING_MS: the
 *     commit-then-enqueue window between creating a WorkflowExecution row
 *     and successfully calling queue.add() is the one place a job can be
 *     lost without a trace (DB commit succeeds, the enqueue call itself
 *     fails) — this re-enqueues them.
 *  2. WAITING step executions whose resumeAt has passed: answers "what if
 *     Redis loses the delayed job" (e.g. a restart without persistence).
 *
 * Both re-enqueues use the same jobId scheme as the job they're standing in
 * for (bare executionId for a stuck-PENDING re-dispatch, `{executionId}-
 * {stepId}-wait` for an overdue wait), so if that job actually still exists
 * (delayed/waiting), BullMQ's own dedup makes this a safe no-op — confirmed
 * empirically (see README "jobId strategy").
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: WorkflowExecutionQueueService,
  ) {}

  @Cron('*/60 * * * * *')
  async sweep(): Promise<void> {
    await this.reconcileStuckPending();
    await this.reconcileOverdueWaits();
  }

  private async reconcileStuckPending(): Promise<void> {
    const cutoff = new Date(Date.now() - RECONCILIATION_STUCK_PENDING_MS);
    const stuck = await this.prisma.workflowExecution.findMany({
      where: { status: 'PENDING', createdAt: { lt: cutoff } },
      select: { id: true },
    });
    for (const { id } of stuck) {
      this.logger.warn(
        `Reconciliation: re-enqueuing stuck PENDING execution ${id}`,
      );
      await this.queue.enqueueInitial(id);
    }
  }

  private async reconcileOverdueWaits(): Promise<void> {
    const overdue = await this.prisma.stepExecution.findMany({
      where: { status: 'WAITING', resumeAt: { lt: new Date() } },
      select: { executionId: true, stepId: true },
      distinct: ['executionId'],
    });
    for (const { executionId, stepId } of overdue) {
      this.logger.warn(
        `Reconciliation: re-enqueuing overdue WAITING execution ${executionId} (step ${stepId})`,
      );
      await this.queue.enqueueDelayWake(executionId, stepId, 0);
    }
  }
}
