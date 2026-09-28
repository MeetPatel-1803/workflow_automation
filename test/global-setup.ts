import { execSync } from 'node:child_process';
import { applyTestEnv } from './test-env';

/** Applies the committed migrations to the (real) test database once per run. */
export default function globalSetup(): void {
  applyTestEnv();
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: process.env,
  });
}
