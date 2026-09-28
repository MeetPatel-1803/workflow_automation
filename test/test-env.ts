/**
 * Environment for e2e runs. Real env vars win; these are test-only placeholders
 * that line up with the `postgres-test` service in docker-compose.yml
 * (`docker compose --profile test up -d postgres-test redis`).
 */
export function applyTestEnv(): void {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL ??=
    process.env.TEST_DATABASE_URL ??
    'postgresql://workflow:workflow@localhost:5433/workflow_test?schema=public';
  process.env.JWT_SECRET ??= 'e2e-test-secret-e2e-test-secret-0123456789';
  process.env.JWT_EXPIRES_IN ??= '1h';
  process.env.REDIS_HOST ??= 'localhost';
  process.env.REDIS_PORT ??= '6379';
  // Dedicated logical DB so tests can flush throttler counters safely.
  process.env.REDIS_DB ??= '15';
}
