import { ConditionOperator } from '../../workflows/dto/step-configs/condition-step-config.dto';

/**
 * Fixed operator table — the safe alternative to an expression language (see
 * ConditionStepConfigDto). `gt`/`gte`/`lt`/`lte` only ever compare numbers;
 * a non-numeric comparison is simply `false`, not an error (the condition
 * step handler reports that as a normal "condition not met" failure).
 */
export function evaluateCondition(
  operator: ConditionOperator,
  actual: unknown,
  expected: unknown,
): boolean {
  switch (operator) {
    case ConditionOperator.EQ:
      return actual === expected;
    case ConditionOperator.NEQ:
      return actual !== expected;
    case ConditionOperator.GT:
      return (
        typeof actual === 'number' &&
        typeof expected === 'number' &&
        actual > expected
      );
    case ConditionOperator.GTE:
      return (
        typeof actual === 'number' &&
        typeof expected === 'number' &&
        actual >= expected
      );
    case ConditionOperator.LT:
      return (
        typeof actual === 'number' &&
        typeof expected === 'number' &&
        actual < expected
      );
    case ConditionOperator.LTE:
      return (
        typeof actual === 'number' &&
        typeof expected === 'number' &&
        actual <= expected
      );
    case ConditionOperator.CONTAINS:
      if (typeof actual === 'string' && typeof expected === 'string') {
        return actual.includes(expected);
      }
      if (Array.isArray(actual)) {
        return actual.includes(expected);
      }
      return false;
  }
}
