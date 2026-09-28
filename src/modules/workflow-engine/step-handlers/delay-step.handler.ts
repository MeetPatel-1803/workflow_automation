import type { DelayStepConfigDto } from '../../workflows/dto/step-configs/delay-step-config.dto';
import type {
  StepHandlerContext,
  StepHandlerOutcome,
} from './step-handler.types';

/**
 * delay step (first dispatch only — see WorkflowExecutionTickService, which
 * never re-invokes this handler on resume): computes `resumeAt` and returns
 * immediately. Deliberately does no setTimeout/sleep and touches no I/O —
 * scheduling the actual BullMQ delayed job, and persisting the WAITING
 * StepExecution row, are the tick service's job, not the handler's.
 */
export async function delayStepHandler({
  step,
}: StepHandlerContext): Promise<StepHandlerOutcome> {
  const config = step.config as DelayStepConfigDto;
  return {
    kind: 'waiting',
    resumeAt: new Date(Date.now() + config.durationMs),
  };
}
