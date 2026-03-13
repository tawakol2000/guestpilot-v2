-- Add ragContext column to AiApiLog (was missing from init migration)
-- Without this, prisma.aiApiLog.create() silently fails on every AI call
-- and prisma.aiApiLog.findMany() errors → falls back to in-memory ring buffer
ALTER TABLE "AiApiLog" ADD COLUMN IF NOT EXISTS "ragContext" JSONB;

-- Allow propertyId to be NULL in PropertyKnowledgeChunk
-- Global SOP chunks (tenant-wide) are inserted with propertyId = NULL
-- The init migration created this column as NOT NULL, which caused all SOP seeding to fail
ALTER TABLE "PropertyKnowledgeChunk" ALTER COLUMN "propertyId" DROP NOT NULL;
