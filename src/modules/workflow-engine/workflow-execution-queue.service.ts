import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { JobsOptions, Queue } from 'bullmq';
import {
  WORKFLOW_EXECUTION_JOB,
  WORKFLOW_EXECUTION_QUEUE,
} from './workflow-engine.constants';

function safeIdPart(raw: string): string {
  // BullMQ rejects any custom jobId containing ':' (reserved for its own
  // repeatable-job id format, confirmed empirically) — stepId is
  // user-supplied (Workflow.steps[].id), so strip it defensively.
  return raw.replace(/:/g, '_');
}

/**
 * The only place that knows the queue's jobId scheme (see README "jobId
 * strategy"). Every jobId here is unique to the specific tick it represents
 * — critically, NEVER the same id as whatever job is *currently executing*
 * when the `.add()` call happens. That constraint is the one this file
 * exists to enforce: this queue's producer calls (enqueueNextStep,
 * enqueueDelayWake, enqueueRetryWake) are all made from *inside* the
 * currently-processing job's own callback (see WorkflowExecutionTickService),
 * before that job has returned/completed. BullMQ's jobId dedup treats
 * re-adding a still-active job's own id as a silent no-op — confirmed
 * empirically — so reusing it here would silently drop the follow-up job
 * the instant the current one finishes normally afterward. Only
 * `enqueueInitial` uses the bare `executionId`, and only because at that
 * point no job for this execution exists yet at all.
 */
@Injectable()
export class WorkflowExecutionQueueService {
  /** Outer/infra-level retry safety net — see README "How retries work". */
  private readonly defaultJobOptions: JobsOptions = {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 86_400 },
  };

  constructor(
    @InjectQueue(WORKFLOW_EXECUTION_QUEUE) private readonly queue: Queue,
  ) {}

  /** Right after a new WorkflowExecution row commits — no job exists yet. */
  async enqueueInitial(executionId: string): Promise<void> {
    await this.queue.add(
      WORKFLOW_EXECUTION_JOB,
      { executionId },
      { ...this.defaultJobOptions, jobId: executionId },
    );
  }

  /** A step just succeeded with no delay/retry — move straight to the next one. */
  async enqueueNextStep(
    executionId: string,
    nextStepId: string,
  ): Promise<void> {
    await this.queue.add(
      WORKFLOW_EXECUTION_JOB,
      { executionId },
      {
        ...this.defaultJobOptions,
        jobId: `${executionId}-${safeIdPart(nextStepId)}`,
      },
    );
  }

  /**
   * A delay step just parked itself at WAITING. Also used by the
   * reconciliation cron's re-sweep for the same stepId, which is why it's a
   * safe no-op if the original delayed job is still legitimately pending —
   * jobId only changes once this step's wait is actually resolved, never
   * mid-flight.
   */
  async enqueueDelayWake(
    executionId: string,
    stepId: string,
    delayMs: number,
  ): Promise<void> {
    await this.queue.add(
      WORKFLOW_EXECUTION_JOB,
      { executionId },
      {
        ...this.defaultJobOptions,
        jobId: `${executionId}-${safeIdPart(stepId)}-wait`,
        delay: Math.max(delayMs, 0),
      },
    );
  }

  /**
   * A retryable step failure scheduling its next attempt. `nextAttempt` is
   * embedded so each backoff wake gets a fresh id — reusing the same id
   * across attempts would hit the exact same "reuse after completion"
   * no-op once the previous attempt's wake job finishes.
   */
  async enqueueRetryWake(
    executionId: string,
    stepId: string,
    nextAttempt: number,
    delayMs: number,
  ): Promise<void> {
    await this.queue.add(
      WORKFLOW_EXECUTION_JOB,
      { executionId },
      {
        ...this.defaultJobOptions,
        jobId: `${executionId}-${safeIdPart(stepId)}-retry-${nextAttempt}`,
        delay: Math.max(delayMs, 0),
      },
    );
  }
}
