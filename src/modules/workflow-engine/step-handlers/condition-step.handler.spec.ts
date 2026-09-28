import { ConditionOperator } from '../../workflows/dto/step-configs/condition-step-config.dto';
import { StepType } from '../../workflows/dto/step-type.enum';
import type { StepDto } from '../../workflows/dto/step.dto';
import { conditionStepHandler } from './condition-step.handler';

function conditionStep(
  field: string,
  operator: ConditionOperator,
  value: unknown,
): StepDto {
  return {
    id: 'cond',
    type: StepType.CONDITION,
    config: { field, operator, value },
  } as StepDto;
}

describe('conditionStepHandler', () => {
  it('true path: succeeds and reports the match', async () => {
    const outcome = await conditionStepHandler({
      step: conditionStep('data.status', ConditionOperator.EQ, 'ok'),
      attempt: 1,
      previousOutput: { data: { status: 'ok' } },
    });
    expect(outcome.kind).toBe('success');
  });

  it('false path: a non-retryable failure with a clear message, not an exception', async () => {
    const outcome = await conditionStepHandler({
      step: conditionStep('data.status', ConditionOperator.EQ, 'ok'),
      attempt: 1,
      previousOutput: { data: { status: 'error' } },
    });
    expect(outcome).toMatchObject({ kind: 'failure', retryable: false });
    if (outcome.kind === 'failure') {
      expect(outcome.error).toContain("field 'data.status'");
      expect(outcome.error).toContain('eq');
    }
  });

  it('a missing field resolves to undefined, evaluated normally (not a crash)', async () => {
    const outcome = await conditionStepHandler({
      step: conditionStep('missing.field', ConditionOperator.EQ, 'ok'),
      attempt: 1,
      previousOutput: {},
    });
    expect(outcome).toMatchObject({ kind: 'failure', retryable: false });
  });
});
