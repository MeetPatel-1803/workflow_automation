import { validateEnv } from './env.validation';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(16) + 'y'.repeat(16),
  JWT_EXPIRES_IN: '1h',
  REDIS_HOST: 'localhost',
  REDIS_PORT: '6379',
};

describe('validateEnv', () => {
  it('accepts a valid environment and coerces numbers/defaults', () => {
    const env = validateEnv(valid);
    expect(env.REDIS_PORT).toBe(6379);
    expect(env.PORT).toBe(3000);
    expect(env.REDIS_DB).toBe(0);
  });

  it.each(['DATABASE_URL', 'JWT_SECRET', 'REDIS_HOST', 'REDIS_PORT'])(
    'fails fast when %s is missing',
    (key) => {
      const { [key]: _omitted, ...rest } = valid as Record<string, string>;
      expect(() => validateEnv(rest)).toThrow(new RegExp(key));
    },
  );

  it('defaults JWT_EXPIRES_IN to 1h when unset', () => {
    const { JWT_EXPIRES_IN: _omitted, ...rest } = valid;
    expect(validateEnv(rest).JWT_EXPIRES_IN).toBe('1h');
  });

  it.each([
    ['empty', ''],
    ['too short', 'short-secret'],
    ['single repeated char', 'a'.repeat(40)],
    [
      'example placeholder',
      'replace-with-a-long-random-string-of-at-least-32-chars',
    ],
  ])('rejects a trivial JWT_SECRET (%s)', (_label, secret) => {
    expect(() => validateEnv({ ...valid, JWT_SECRET: secret })).toThrow(
      /JWT_SECRET/,
    );
  });

  it('rejects a malformed JWT_EXPIRES_IN', () => {
    expect(() => validateEnv({ ...valid, JWT_EXPIRES_IN: 'soon' })).toThrow(
      /JWT_EXPIRES_IN/,
    );
  });
});
