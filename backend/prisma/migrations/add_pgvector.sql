-- Run this ONCE on Railway PostgreSQL after deploying the branch
-- Via Railway dashboard: your PostgreSQL service > Query tab

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "PropertyKnowledgeChunk"
  ADD COLUMN IF NOT EXISTS embedding vector(1536);

CREATE INDEX IF NOT EXISTS property_knowledge_embedding_idx
  ON "PropertyKnowledgeChunk"
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
