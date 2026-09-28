import type { PrismaClient } from '@prisma/client';

/**
 * Wipes every application table, children first, regardless of which
 * tables *this* spec file's own tests touch directly. Jest does not
 * guarantee test file execution order — if a later module's spec (e.g.
 * workflow-execution) happens to run before an earlier one (e.g. auth),
 * a beforeEach that only knows about its own module's tables (e.g. just
 * `user`/`organization`) can hit a foreign-key violation deleting a row
 * another module's leftover data still references. Every e2e spec's
 * beforeEach should call this instead of hand-rolling its own subset.
 */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.stepExecution.deleteMany();
  await prisma.idempotencyRecord.deleteMany();
  await prisma.workflowExecution.deleteMany();
  await prisma.workflow.deleteMany();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();
}
