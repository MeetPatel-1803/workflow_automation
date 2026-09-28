import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { WORKFLOW_EXECUTION_QUEUE } from './workflow-engine.constants';
import { WorkflowExecutionTickService } from './workflow-execution-tick.service';

interface WorkflowExecutionJobData {
  executionId: string;
}

// @Processor()'s worker options are evaluated at class-decoration time
// (module load), before Nest's DI container exists — ConfigService isn't
// reachable here, so WORKER_CONCURRENCY is read directly off process.env
// with a fallback, same value space as the rest of the app's env vars but
// outside the normal validated ConfigService path.
const WORKER_CONCURRENCY = Number(process.env.WORKER_CONCURRENCY) || 5;

/**
 * Thin wrapper: the job payload is minimal ({ executionId }) and carries no
 * business state (see README "BullMQ setup") — every invocation re-reads
 * current state from Postgres inside WorkflowExecutionTickService, which is
 * why it's a plain injectable service rather than logic embedded here. That
 * separation is also what lets tests invoke the exact same tick logic
 * directly, bypassing the queue, to exercise concurrency deterministically.
 *
 * `lockDuration`/`maxStalledCount` are BullMQ's first line of defense
 * against a crashed worker (see README "What happens when a worker
 * crashes"): 30s is long enough to cover this processor's own overhead
 * (DB round trips), NOT the external HTTP call itself — an http step's own
 * `timeoutMs` (max 60s) can run longer than the lock, which is fine: BullMQ
 * extends the lock automatically while the job is still actively being
 * processed (lockDuration is a stall-detection window, not a hard cap).
 */
@Processor(WORKFLOW_EXECUTION_QUEUE, {
  concurrency: WORKER_CONCURRENCY,
  lockDuration: 30_000,
  maxStalledCount: 2,
})
export class WorkflowExecutionProcessor extends WorkerHost {
  private readonly logger = new Logger(WorkflowExecutionProcessor.name);

  constructor(private readonly tick: WorkflowExecutionTickService) {
    super();
  }

  async process(job: Job<WorkflowExecutionJobData>): Promise<void> {
    try {
      await this.tick.processTick(job.data.executionId);
    } catch (error) {
      // Never let a step/tick failure surface as an unhandled rejection —
      // log it and let BullMQ's own `attempts`/backoff (infra-level retry,
      // distinct from step-level business retry) decide whether to retry
      // this job. WorkflowExecutionTickService itself already converts
      // every business-level failure into a clean FAILED state without
      // throwing; reaching here means something unexpected happened (e.g. a
      // transient DB connection error).
      this.logger.error(
        `Tick failed for execution ${job.data.executionId} (job ${job.id})`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }
}
