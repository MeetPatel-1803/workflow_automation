import { StepType } from '../../workflows/dto/step-type.enum';
import type { StepDto } from '../../workflows/dto/step.dto';
import { delayStepHandler } from './delay-step.handler';

function delayStep(durationMs: number): StepDto {
  return {
    id: 'delay',
    type: StepType.DELAY,
    config: { durationMs },
  } as StepDto;
}

describe('delayStepHandler', () => {
  it('returns "waiting" with resumeAt ~durationMs in the future, without blocking', async () => {
    const before = Date.now();
    const outcome = await delayStepHandler({
      step: delayStep(5000),
      attempt: 1,
      previousOutput: undefined,
    });
    const elapsed = Date.now() - before;

    expect(elapsed).toBeLessThan(100); // did not actually wait
    expect(outcome.kind).toBe('waiting');
    if (outcome.kind === 'waiting') {
      const delta = outcome.resumeAt.getTime() - before;
      expect(delta).toBeGreaterThanOrEqual(4900);
      expect(delta).toBeLessThanOrEqual(5100);
    }
  });
});
