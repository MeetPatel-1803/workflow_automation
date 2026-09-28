-- AlterTable: add nullable first (existing rows have no value yet)
ALTER TABLE "Workflow" ADD COLUMN "contentHash" TEXT;

-- Backfill pre-existing rows with a unique placeholder (their own id).
-- Correctness of the hash only matters for rows created from now on --
-- this just satisfies NOT NULL + the unique index below without rejecting
-- data that predates this migration.
UPDATE "Workflow" SET "contentHash" = "id" WHERE "contentHash" IS NULL;

-- AlterTable: now safe to enforce
ALTER TABLE "Workflow" ALTER COLUMN "contentHash" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Workflow_organizationId_contentHash_key" ON "Workflow"("organizationId", "contentHash");
