import { computeWorkflowContentHash } from './workflow-content-hash';

describe('computeWorkflowContentHash', () => {
  const steps = [{ id: 's1', type: 'complete', config: {} }];

  it('is deterministic for the same input', () => {
    const a = computeWorkflowContentHash('My workflow', steps);
    const b = computeWorkflowContentHash('My workflow', steps);
    expect(a).toBe(b);
  });

  it('is unaffected by object key order (only array/step order is meaningful)', () => {
    const a = computeWorkflowContentHash('My workflow', [
      { id: 's1', type: 'complete', config: {} },
    ]);
    const b = computeWorkflowContentHash('My workflow', [
      { config: {}, type: 'complete', id: 's1' },
    ]);
    expect(a).toBe(b);
  });

  it('differs when the name differs', () => {
    const a = computeWorkflowContentHash('Workflow A', steps);
    const b = computeWorkflowContentHash('Workflow B', steps);
    expect(a).not.toBe(b);
  });

  it('differs when step order differs', () => {
    const twoSteps = [
      { id: 's1', type: 'http' },
      { id: 's2', type: 'complete' },
    ];
    const reversed = [twoSteps[1], twoSteps[0]];
    const a = computeWorkflowContentHash('wf', twoSteps);
    const b = computeWorkflowContentHash('wf', reversed);
    expect(a).not.toBe(b);
  });

  it('differs when a nested config value differs', () => {
    const a = computeWorkflowContentHash('wf', [
      { id: 's1', type: 'delay', config: { durationMs: 1000 } },
    ]);
    const b = computeWorkflowContentHash('wf', [
      { id: 's1', type: 'delay', config: { durationMs: 2000 } },
    ]);
    expect(a).not.toBe(b);
  });
});
