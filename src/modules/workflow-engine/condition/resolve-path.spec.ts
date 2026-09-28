import { resolvePath } from './resolve-path';

describe('resolvePath', () => {
  it('resolves a top-level field', () => {
    expect(resolvePath({ status: 'ok' }, 'status')).toBe('ok');
  });

  it('resolves a nested dot-path', () => {
    expect(resolvePath({ data: { status: 'ok' } }, 'data.status')).toBe('ok');
  });

  it('returns undefined for a missing intermediate segment', () => {
    expect(resolvePath({ data: {} }, 'data.status.deep')).toBeUndefined();
  });

  it('returns undefined when the source is null/undefined', () => {
    expect(resolvePath(null, 'a.b')).toBeUndefined();
    expect(resolvePath(undefined, 'a.b')).toBeUndefined();
  });

  it('returns undefined when traversing through a primitive', () => {
    expect(resolvePath({ data: 5 }, 'data.status')).toBeUndefined();
  });
});
