import type { StepDto } from '../../workflows/dto/step.dto';

/**
 * Uniform contract every step handler returns, regardless of step type.
 * The tick service interprets `kind` the same way for all of them:
 *   - success:  advance to the next step (or COMPLETE the execution, if this
 *               was the terminal step).
 *   - failure:  `retryable` decides whether the tick service schedules a
 *               business-level retry (see README "How retries work") or
 *               fails the execution outright.
 *   - waiting:  (delay step's first dispatch only) park this step at
 *               `resumeAt`; the tick service schedules a BullMQ delayed job
 *               and does NOT advance currentStepId yet.
 */
export type StepHandlerOutcome =
  | { kind: 'success'; output: unknown }
  | { kind: 'failure'; retryable: boolean; error: string }
  | { kind: 'waiting'; resumeAt: Date };

/** Everything a step handler needs to run one attempt, and nothing more. */
export interface StepHandlerContext {
  step: StepDto;
  /** 1-based attempt number for this step (see StepExecution.attempt). */
  attempt: number;
  /** The previous step's stored output, if any (undefined for the first step). */
  previousOutput: unknown;
}

export type StepHandler = (
  context: StepHandlerContext,
) => Promise<StepHandlerOutcome>;
