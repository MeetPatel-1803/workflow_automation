import type { ConditionStepConfigDto } from '../../workflows/dto/step-configs/condition-step-config.dto';
import { evaluateCondition } from '../condition/evaluate-condition';
import { resolvePath } from '../condition/resolve-path';
import type {
  StepHandlerContext,
  StepHandlerOutcome,
} from './step-handler.types';

/**
 * condition step: reads `config.field` off the previous step's output and
 * compares it against `config.value` with `config.operator`.
 *
 * A false result is a BUSINESS failure, not a retryable one — the truth
 * value won't change on retry — so it's always reported with
 * `retryable: false` regardless of the step's (nonexistent; condition steps
 * don't accept retry config) attempt settings.
 */
export async function conditionStepHandler({
  step,
  previousOutput,
}: StepHandlerContext): Promise<StepHandlerOutcome> {
  const config = step.config as ConditionStepConfigDto;
  const actual = resolvePath(previousOutput, config.field);
  const matched = evaluateCondition(config.operator, actual, config.value);

  if (matched) {
    return {
      kind: 'success',
      output: {
        field: config.field,
        operator: config.operator,
        value: config.value,
        actual,
        matched: true,
      },
    };
  }

  return {
    kind: 'failure',
    retryable: false,
    error: `Condition failed: field '${config.field}' expected ${config.operator} ${JSON.stringify(
      config.value,
    )}, got ${JSON.stringify(actual)}`,
  };
}
