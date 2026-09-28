import type {
  StepHandlerContext,
  StepHandlerOutcome,
} from './step-handler.types';

/**
 * complete step: a real entry in the dispatch table (not a special-cased
 * "last step" check) for consistency with the other three step types — its
 * presence in the workflow just signals completion once the tick service
 * reaches it. No-op otherwise.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function completeStepHandler(
  _context: StepHandlerContext,
): Promise<StepHandlerOutcome> {
  return { kind: 'success', output: {} };
}
