-- Add conversation summary fields for tiered memory
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "conversationSummary" TEXT;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "summaryUpdatedAt" TIMESTAMP(3);
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "summaryMessageCount" INTEGER NOT NULL DEFAULT 0;

-- Create PropertyKnowledgeChunk table for pgvector RAG
CREATE TABLE IF NOT EXISTS "PropertyKnowledgeChunk" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'general',
    "sourceKey" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyKnowledgeChunk_pkey" PRIMARY KEY ("id")
);

-- Create indexes on PropertyKnowledgeChunk
CREATE INDEX IF NOT EXISTS "PropertyKnowledgeChunk_tenantId_propertyId_idx" ON "PropertyKnowledgeChunk"("tenantId", "propertyId");
CREATE INDEX IF NOT EXISTS "PropertyKnowledgeChunk_propertyId_category_idx" ON "PropertyKnowledgeChunk"("propertyId", "category");

-- Add foreign keys for PropertyKnowledgeChunk
ALTER TABLE "PropertyKnowledgeChunk" ADD CONSTRAINT "PropertyKnowledgeChunk_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PropertyKnowledgeChunk" ADD CONSTRAINT "PropertyKnowledgeChunk_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Create TenantAiConfig table for per-tenant AI configuration
CREATE TABLE IF NOT EXISTS "TenantAiConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentName" TEXT NOT NULL DEFAULT 'Omar',
    "agentPersonality" TEXT NOT NULL DEFAULT '',
    "customInstructions" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT 'claude-haiku-4-5-20251001',
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.25,
    "maxTokens" INTEGER NOT NULL DEFAULT 1024,
    "debounceDelayMs" INTEGER NOT NULL DEFAULT 30000,
    "aiEnabled" BOOLEAN NOT NULL DEFAULT true,
    "screeningEnabled" BOOLEAN NOT NULL DEFAULT true,
    "ragEnabled" BOOLEAN NOT NULL DEFAULT true,
    "memorySummaryEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantAiConfig_pkey" PRIMARY KEY ("id")
);

-- Create unique constraint on TenantAiConfig.tenantId
CREATE UNIQUE INDEX IF NOT EXISTS "TenantAiConfig_tenantId_key" ON "TenantAiConfig"("tenantId");

-- Add foreign key for TenantAiConfig
ALTER TABLE "TenantAiConfig" ADD CONSTRAINT "TenantAiConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
