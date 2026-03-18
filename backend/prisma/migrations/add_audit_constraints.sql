-- ============================================================================
-- System Audit: Duplicate cleanup + constraints + Cohere vector column
-- Run BEFORE `prisma db push` to clean up data that would violate new constraints
-- ============================================================================

-- ─── T003: Clean up duplicate PendingAiReply (keep newest per conversationId) ─
DO $$
DECLARE
  deleted_count INTEGER;
BEGIN
  WITH duplicates AS (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY "conversationId"
      ORDER BY "createdAt" DESC
    ) AS rn
    FROM "PendingAiReply"
  )
  DELETE FROM "PendingAiReply"
  WHERE id IN (SELECT id FROM duplicates WHERE rn > 1);
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RAISE NOTICE '[Audit Migration] Cleaned % duplicate PendingAiReply records', deleted_count;
END $$;

-- ─── T004: Clean up duplicate Messages (keep newest per conv + hostawayMessageId) ─
DO $$
DECLARE
  deleted_count INTEGER;
BEGIN
  WITH duplicates AS (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY "conversationId", "hostawayMessageId"
      ORDER BY "sentAt" DESC
    ) AS rn
    FROM "Message"
    WHERE "hostawayMessageId" != ''
  )
  DELETE FROM "Message"
  WHERE id IN (SELECT id FROM duplicates WHERE rn > 1);
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RAISE NOTICE '[Audit Migration] Cleaned % duplicate Message records', deleted_count;
END $$;

-- ─── T005: Deactivate duplicate ClassifierExamples (keep newest per tenant+text) ─
DO $$
DECLARE
  deactivated_count INTEGER;
BEGIN
  WITH duplicates AS (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY "tenantId", text
      ORDER BY "updatedAt" DESC
    ) AS rn
    FROM "ClassifierExample"
    WHERE active = true
  )
  UPDATE "ClassifierExample"
  SET active = false
  WHERE id IN (SELECT id FROM duplicates WHERE rn > 1);
  GET DIAGNOSTICS deactivated_count = ROW_COUNT;
  RAISE NOTICE '[Audit Migration] Deactivated % duplicate ClassifierExample records', deactivated_count;
END $$;

-- ─── T007: Partial unique index for Message deduplication ─────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "Message_conv_hostaway_msg_unique"
ON "Message" ("conversationId", "hostawayMessageId")
WHERE "hostawayMessageId" != '';

-- ─── T008: Cohere embedding column + HNSW index ──────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'PropertyKnowledgeChunk' AND column_name = 'embedding_cohere'
  ) THEN
    ALTER TABLE "PropertyKnowledgeChunk" ADD COLUMN "embedding_cohere" vector(1024);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "PropertyKnowledgeChunk_cohere_hnsw"
ON "PropertyKnowledgeChunk"
USING hnsw ("embedding_cohere" vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
