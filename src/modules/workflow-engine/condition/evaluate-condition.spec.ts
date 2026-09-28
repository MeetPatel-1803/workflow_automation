import { evaluateCondition } from './evaluate-condition';
import { ConditionOperator } from '../../workflows/dto/step-configs/condition-step-config.dto';

describe('evaluateCondition', () => {
  it.each([
    [ConditionOperator.EQ, 'a', 'a', true],
    [ConditionOperator.EQ, 'a', 'b', false],
    [ConditionOperator.NEQ, 'a', 'b', true],
    [ConditionOperator.NEQ, 'a', 'a', false],
    [ConditionOperator.GT, 5, 3, true],
    [ConditionOperator.GT, 3, 5, false],
    [ConditionOperator.GTE, 5, 5, true],
    [ConditionOperator.LT, 3, 5, true],
    [ConditionOperator.LTE, 5, 5, true],
    [ConditionOperator.CONTAINS, 'hello world', 'world', true],
    [ConditionOperator.CONTAINS, 'hello world', 'xyz', false],
  ])('%s(%p, %p) === %p', (operator, actual, expected, result) => {
    expect(evaluateCondition(operator, actual, expected)).toBe(result);
  });

  it('contains works on arrays', () => {
    expect(evaluateCondition(ConditionOperator.CONTAINS, [1, 2, 3], 2)).toBe(
      true,
    );
    expect(evaluateCondition(ConditionOperator.CONTAINS, [1, 2, 3], 9)).toBe(
      false,
    );
  });

  it('numeric operators are false (not a crash) for non-numeric operands', () => {
    expect(evaluateCondition(ConditionOperator.GT, 'a', 3)).toBe(false);
    expect(evaluateCondition(ConditionOperator.GT, undefined, 3)).toBe(false);
  });
});
