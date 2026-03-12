# Advanced AI Upgrades Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade GuestPilot v2 backend from prototype to SaaS-quality AI platform with RAG, BullMQ queuing, tiered memory, grounded prompts, per-tenant config, Langfuse observability, and prompt caching — all on the `advanced-ai` branch.

**Architecture:** All changes are backend-only (`backend/` only, never touch `frontend/`). New services degrade gracefully when optional env vars are missing. Every DB query retains `tenantId` filtering. The 30-second debounce is preserved exactly — BullMQ adds speed without changing the debounce logic.

**Tech Stack:** Node.js + TypeScript + Express, PostgreSQL + Prisma, Anthropic Claude (chat only), OpenAI (embeddings only), BullMQ + Redis, Langfuse, pgvector

**CRITICAL CONCURRENCY RULE:** Agents must NEVER edit the same file concurrently. The orchestrator coordinates file access — especially for `ai.service.ts` and `schema.prisma`. All schema changes happen in one sequential session before any service that references new models.

---

## Chunk 1: Pre-Flight + Install + Schema Migrations

Run all of this in the main session. Must complete before any agent starts.

- [ ] Verify branch: `git -C "$(git rev-parse --show-toplevel)" branch --show-current` → must show `advanced-ai`
- [ ] Install deps: `cd backend && npm install bullmq ioredis langfuse openai`
- [ ] Verify build before changes: `cd backend && npx tsc --noEmit 2>&1 | head -30`

### Schema changes (all in one prisma migrate session)

**File: `backend/prisma/schema.prisma`**

Add to `Tenant` model (after `automatedMessages` relation):
```prisma
  propertyKnowledgeChunks PropertyKnowledgeChunk[]
  tenantAiConfig           TenantAiConfig?
```

Add to `Property` model (after `knowledgeSuggestions` relation):
```prisma
  propertyKnowledgeChunks PropertyKnowledgeChunk[]
```

Add to `Conversation` model (after `hostawayConversationId` field):
```prisma
  conversationSummary    String?   @db.Text
  summaryUpdatedAt       DateTime?
  summaryMessageCount    Int       @default(0)
```

Add new models at the bottom of schema.prisma (before enums):
```prisma
// ─── Property Knowledge Chunks (RAG) ─────────────────────────────────────────

model PropertyKnowledgeChunk {
  id          String   @id @default(cuid())
  tenantId    String
  propertyId  String
  content     String   @db.Text
  category    String   @default("general")
  sourceKey   String   @default("")
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  tenant   Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  property Property @relation(fields: [propertyId], references: [id], onDelete: Cascade)

  @@index([tenantId, propertyId])
  @@index([propertyId, category])
}

// ─── Per-Tenant AI Configuration ─────────────────────────────────────────────

model TenantAiConfig {
  id                   String   @id @default(cuid())
  tenantId             String   @unique
  agentName            String   @default("Omar")
  agentPersonality     String   @db.Text @default("")
  customInstructions   String   @db.Text @default("")
  model                String   @default("claude-haiku-4-5-20251001")
  temperature          Float    @default(0.25)
  maxTokens            Int      @default(1024)
  debounceDelayMs      Int      @default(30000)
  aiEnabled            Boolean  @default(true)
  screeningEnabled     Boolean  @default(true)
  ragEnabled           Boolean  @default(true)
  memorySummaryEnabled Boolean  @default(true)
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
}
```

- [ ] Run: `cd backend && npx prisma migrate dev --name add_knowledge_chunks_summary_and_tenant_config`
- [ ] Run: `cd backend && npx prisma generate`
- [ ] Create pgvector SQL file: `backend/prisma/migrations/add_pgvector.sql`

```sql
-- Run ONCE on Railway PostgreSQL after deploying the branch
-- Via Railway dashboard: your PostgreSQL service > Query tab

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "PropertyKnowledgeChunk"
  ADD COLUMN IF NOT EXISTS embedding vector(1536);

CREATE INDEX IF NOT EXISTS property_knowledge_embedding_idx
  ON "PropertyKnowledgeChunk"
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

---

## Chunk 2: New Service Files (Create in Parallel — 5 Agents)

All agents in this chunk create NEW files only. No file conflicts possible.

### Task 2A — observability.service.ts

**File:** `backend/src/services/observability.service.ts`

```typescript
/**
 * Langfuse observability — fire-and-forget tracing for every Claude API call.
 * Gracefully disabled when LANGFUSE env vars are missing.
 */
import { Langfuse } from 'langfuse';

interface TraceParams {
  tenantId: string;
  conversationId: string;
  agentName: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  responseText: string;
  escalated: boolean;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  error?: string;
}

let client: Langfuse | null = null;
let _warned = false;

function getClient(): Langfuse | null {
  if (client) return client;
  const { LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_HOST } = process.env;
  if (!LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY) {
    if (!_warned) {
      console.warn('[Observability] LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY missing — tracing disabled');
      _warned = true;
    }
    return null;
  }
  client = new Langfuse({
    publicKey: LANGFUSE_PUBLIC_KEY,
    secretKey: LANGFUSE_SECRET_KEY,
    baseUrl: LANGFUSE_HOST || 'https://cloud.langfuse.com',
  });
  return client;
}

export function traceAiCall(params: TraceParams): void {
  // Fire-and-forget — never await this
  const lf = getClient();
  if (!lf) return;
  try {
    const trace = lf.trace({
      name: `ai-reply-${params.agentName}`,
      userId: params.tenantId,
      sessionId: params.conversationId,
      metadata: { tenantId: params.tenantId, conversationId: params.conversationId, escalated: params.escalated },
    });
    trace.generation({
      name: params.agentName,
      model: params.model,
      input: { tokens: params.inputTokens },
      output: params.error ? undefined : params.responseText.substring(0, 1000),
      usage: {
        input: params.inputTokens,
        output: params.outputTokens,
        unit: 'TOKENS',
      },
      metadata: {
        costUsd: params.costUsd,
        durationMs: params.durationMs,
        cacheCreationTokens: params.cacheCreationTokens ?? 0,
        cacheReadTokens: params.cacheReadTokens ?? 0,
        error: params.error,
      },
    });
  } catch (err) {
    console.warn('[Observability] Trace failed (non-fatal):', err);
  }
}

export async function flushObservability(): Promise<void> {
  const lf = getClient();
  if (!lf) return;
  try {
    await lf.flushAsync();
  } catch (err) {
    console.warn('[Observability] Flush failed (non-fatal):', err);
  }
}
```

### Task 2B — queue.service.ts + aiReply.worker.ts

**File: `backend/src/services/queue.service.ts`**

```typescript
/**
 * BullMQ queue for debounced AI replies.
 * Preserves the 30-second debounce: each new message removes and re-adds
 * the job, resetting the delay timer. The LAST message's job fires.
 * Gracefully disabled when REDIS_URL is missing.
 */
import { Queue, Job } from 'bullmq';
import IORedis from 'ioredis';

let queue: Queue | null = null;
let redisConn: IORedis | null = null;
let _warned = false;

function getQueue(): Queue | null {
  if (queue) return queue;
  const { REDIS_URL } = process.env;
  if (!REDIS_URL) {
    if (!_warned) {
      console.warn('[Queue] REDIS_URL missing — BullMQ disabled, falling back to poll');
      _warned = true;
    }
    return null;
  }
  try {
    redisConn = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue('ai-replies', { connection: redisConn });
    console.log('[Queue] BullMQ connected to Redis');
    return queue;
  } catch (err) {
    console.warn('[Queue] Failed to connect to Redis:', err);
    return null;
  }
}

export async function addAiReplyJob(
  conversationId: string,
  tenantId: string,
  delayMs: number
): Promise<void> {
  const q = getQueue();
  if (!q) return;
  try {
    // Remove any existing pending job for this conversation (debounce reset)
    const existing = await q.getJob(conversationId);
    if (existing) {
      await existing.remove();
    }
    await q.add(
      'process-reply',
      { conversationId, tenantId },
      { jobId: conversationId, delay: delayMs, attempts: 3, backoff: { type: 'exponential', delay: 5000 } }
    );
  } catch (err) {
    console.warn(`[Queue] Failed to add job for ${conversationId}:`, err);
  }
}

export async function removeAiReplyJob(conversationId: string): Promise<void> {
  const q = getQueue();
  if (!q) return;
  try {
    const existing = await q.getJob(conversationId);
    if (existing) await existing.remove();
  } catch (err) {
    console.warn(`[Queue] Failed to remove job for ${conversationId}:`, err);
  }
}

export function getQueueInstance(): Queue | null {
  return getQueue();
}

export async function closeQueue(): Promise<void> {
  try {
    if (queue) await queue.close();
    if (redisConn) await redisConn.quit();
  } catch (err) {
    console.warn('[Queue] Error during shutdown:', err);
  }
}
```

**File: `backend/src/workers/aiReply.worker.ts`**

```typescript
/**
 * BullMQ worker — processes ai-replies queue.
 * For each delayed job: fetches conversation, checks flags, calls generateAndSendAiReply.
 * Complements (never replaces) the aiDebounce.job.ts poll fallback.
 */
import { Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { PrismaClient } from '@prisma/client';
import { generateAndSendAiReply } from '../services/ai.service';

export function startAiReplyWorker(prisma: PrismaClient): Worker | null {
  const { REDIS_URL } = process.env;
  if (!REDIS_URL) {
    console.log('[Worker] REDIS_URL missing — BullMQ worker not started');
    return null;
  }

  const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

  const worker = new Worker(
    'ai-replies',
    async (job: Job) => {
      const { conversationId, tenantId } = job.data as { conversationId: string; tenantId: string };
      console.log(`[Worker] Processing job for conversation ${conversationId}`);

      // Fetch full conversation with all relations
      const conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, tenantId },
        include: {
          reservation: {
            include: {
              property: true,
              guest: true,
              tenant: true,
            },
          },
          guest: true,
          property: true,
          tenant: true,
        },
      });

      if (!conversation) {
        console.warn(`[Worker] Conversation ${conversationId} not found — skipping`);
        return;
      }

      const { reservation } = conversation;
      if (!reservation) {
        console.warn(`[Worker] No reservation for conversation ${conversationId} — skipping`);
        return;
      }

      if (!reservation.aiEnabled) {
        console.log(`[Worker] AI disabled for conversation ${conversationId} — skipping`);
        return;
      }

      if (reservation.aiMode !== 'autopilot' && reservation.aiMode !== 'auto' && reservation.aiMode !== 'copilot') {
        console.log(`[Worker] aiMode=${reservation.aiMode} for conversation ${conversationId} — skipping`);
        return;
      }

      const { property, guest, tenant } = reservation;
      const listing = {
        name: property.name,
        internalListingName: property.name,
        address: property.address,
        doorSecurityCode: (property.customKnowledgeBase as Record<string, string>)?.doorCode || '',
        wifiUsername: (property.customKnowledgeBase as Record<string, string>)?.wifiName || '',
        wifiPassword: (property.customKnowledgeBase as Record<string, string>)?.wifiPassword || '',
      };

      const context = {
        tenantId,
        conversationId,
        propertyId: property.id,
        hostawayConversationId: conversation.hostawayConversationId,
        hostawayApiKey: tenant.hostawayApiKey,
        hostawayAccountId: tenant.hostawayAccountId,
        guestName: guest.name,
        checkIn: reservation.checkIn.toISOString().split('T')[0],
        checkOut: reservation.checkOut.toISOString().split('T')[0],
        guestCount: reservation.guestCount,
        reservationStatus: reservation.status,
        listing,
        customKnowledgeBase: property.customKnowledgeBase as Record<string, unknown>,
        listingDescription: property.listingDescription,
        aiMode: reservation.aiMode,
      };

      await generateAndSendAiReply(context, prisma);
      console.log(`[Worker] Successfully processed conversation ${conversationId}`);
    },
    {
      connection,
      concurrency: 5,
    }
  );

  worker.on('failed', (job, err) => {
    console.error(`[Worker] Job failed for ${job?.data?.conversationId}:`, err.message);
  });

  worker.on('completed', (job) => {
    console.log(`[Worker] Job completed for ${job.data.conversationId}`);
  });

  console.log('[Worker] BullMQ AI reply worker started (concurrency: 5)');
  return worker;
}
```

### Task 2C — embeddings.service.ts + rag.service.ts

**File: `backend/src/services/embeddings.service.ts`**

```typescript
/**
 * OpenAI embeddings — text-embedding-3-small (1536 dimensions).
 * Used ONLY for vector search, never for AI responses.
 * Gracefully disabled when OPENAI_API_KEY is missing.
 */
import OpenAI from 'openai';

let openai: OpenAI | null = null;
let _warned = false;

interface CacheEntry { embedding: number[]; ts: number }
const embeddingCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function getClient(): OpenAI | null {
  if (openai) return openai;
  if (!process.env.OPENAI_API_KEY) {
    if (!_warned) {
      console.warn('[Embeddings] OPENAI_API_KEY missing — RAG disabled');
      _warned = true;
    }
    return null;
  }
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

function cacheKey(text: string): string {
  return text.trim().toLowerCase().substring(0, 200);
}

export async function embedText(text: string): Promise<number[]> {
  const client = getClient();
  if (!client) return [];
  // Skip cache for long unique texts
  const key = cacheKey(text);
  if (text.length <= 1000) {
    const cached = embeddingCache.get(key);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return cached.embedding;
    }
  }
  try {
    const res = await client.embeddings.create({ model: 'text-embedding-3-small', input: text });
    const embedding = res.data[0].embedding;
    if (text.length <= 1000) {
      embeddingCache.set(key, { embedding, ts: Date.now() });
    }
    return embedding;
  } catch (err) {
    console.error('[Embeddings] embedText failed:', err);
    return [];
  }
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const client = getClient();
  if (!client) return texts.map(() => []);
  const results: number[][] = new Array(texts.length).fill([]);
  const BATCH_SIZE = 20;
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    try {
      const res = await client.embeddings.create({ model: 'text-embedding-3-small', input: batch });
      res.data.forEach((item, idx) => { results[i + idx] = item.embedding; });
    } catch (err) {
      console.error(`[Embeddings] embedBatch failed at offset ${i}:`, err);
    }
  }
  return results;
}
```

**File: `backend/src/services/rag.service.ts`**

```typescript
/**
 * RAG (Retrieval-Augmented Generation) service.
 * Ingests property knowledge as vector chunks and retrieves relevant context
 * for each AI call to ground responses in verified property data.
 */
import { PrismaClient } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';
import { embedText, embedBatch } from './embeddings.service';

// Note: cuid2 may not be available — fallback to manual cuid-like string
function generateId(): string {
  return `ckn${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
}

function inferCategory(key: string): string {
  const k = key.toLowerCase();
  if (/wifi|password|network|internet/.test(k)) return 'access';
  if (/door|code|entry|key|lock/.test(k)) return 'access';
  if (/clean|cleaning|housekeeping/.test(k)) return 'service';
  if (/check.?in|check.?out|arrival|departure/.test(k)) return 'policy';
  if (/pool|gym|amenity|parking|spa/.test(k)) return 'amenity';
  if (/contact|phone|emergency|support/.test(k)) return 'contact';
  return 'general';
}

export async function ingestPropertyKnowledge(
  tenantId: string,
  propertyId: string,
  property: { customKnowledgeBase?: unknown; listingDescription?: string },
  prisma: PrismaClient
): Promise<number> {
  // 1. Delete all existing chunks for this property
  await prisma.$executeRaw`
    DELETE FROM "PropertyKnowledgeChunk"
    WHERE "propertyId" = ${propertyId} AND "tenantId" = ${tenantId}
  `;

  const chunks: { content: string; category: string; sourceKey: string }[] = [];

  // 2a. Build chunks from customKnowledgeBase
  const customKb = property.customKnowledgeBase as Record<string, unknown> | null;
  if (customKb && typeof customKb === 'object') {
    for (const [key, val] of Object.entries(customKb)) {
      if (!val || String(val).trim() === '' || String(val).trim() === 'N/A') continue;
      chunks.push({
        content: `Q: What is the ${key}?\nA: ${String(val)}`,
        category: inferCategory(key),
        sourceKey: key,
      });
    }
  }

  // 2b. Chunk listing description by paragraph
  if (property.listingDescription) {
    const paragraphs = property.listingDescription
      .split(/\n\n|\.\n/)
      .map(p => p.trim())
      .filter(p => p.length >= 50);
    for (const para of paragraphs) {
      chunks.push({ content: para, category: 'description', sourceKey: 'listing_description' });
    }
  }

  if (chunks.length === 0) return 0;

  // 3. Embed all chunks
  const texts = chunks.map(c => c.content);
  const embeddings = await embedBatch(texts);

  // 4. Insert via raw SQL (pgvector not supported natively by Prisma)
  let inserted = 0;
  for (let i = 0; i < chunks.length; i++) {
    const embedding = embeddings[i];
    if (!embedding || embedding.length === 0) continue;
    const id = generateId();
    const embeddingStr = `[${embedding.join(',')}]`;
    try {
      await prisma.$executeRaw`
        INSERT INTO "PropertyKnowledgeChunk"
          (id, "tenantId", "propertyId", content, category, "sourceKey", embedding, "createdAt", "updatedAt")
        VALUES (
          ${id}, ${tenantId}, ${propertyId},
          ${chunks[i].content}, ${chunks[i].category}, ${chunks[i].sourceKey},
          ${embeddingStr}::vector, now(), now()
        )
      `;
      inserted++;
    } catch (err) {
      console.error(`[RAG] Failed to insert chunk ${i}:`, err);
    }
  }

  console.log(`[RAG] Ingested ${inserted}/${chunks.length} chunks for property ${propertyId}`);
  return inserted;
}

export async function retrieveRelevantKnowledge(
  tenantId: string,
  propertyId: string,
  query: string,
  prisma: PrismaClient,
  topK = 5
): Promise<Array<{ content: string; category: string; similarity: number }>> {
  try {
    const embedding = await embedText(query);
    if (!embedding || embedding.length === 0) return [];

    const embeddingStr = `[${embedding.join(',')}]`;
    const results = await prisma.$queryRaw<Array<{ id: string; content: string; category: string; similarity: number }>>`
      SELECT id, content, category,
        1 - (embedding <=> ${embeddingStr}::vector) as similarity
      FROM "PropertyKnowledgeChunk"
      WHERE "propertyId" = ${propertyId}
        AND "tenantId" = ${tenantId}
        AND embedding IS NOT NULL
      ORDER BY embedding <=> ${embeddingStr}::vector
      LIMIT ${topK}
    `;

    return results
      .filter(r => r.similarity > 0.5)
      .map(r => ({ content: r.content, category: r.category, similarity: r.similarity }));
  } catch (err) {
    console.error('[RAG] retrieveRelevantKnowledge failed:', err);
    return [];
  }
}
```

### Task 2D — memory.service.ts

**File: `backend/src/services/memory.service.ts`**

```typescript
/**
 * Tiered conversation memory.
 * Keeps last 10 messages verbatim + compresses older history into a bullet-point summary.
 * Summary is cached in DB and only regenerated when new messages arrive.
 */
import Anthropic from '@anthropic-ai/sdk';
import { PrismaClient, Message, Conversation } from '@prisma/client';

export function formatMessages(messages: Message[]): string {
  return messages
    .map(m => {
      const role = m.role === 'GUEST' ? '[GUEST]' : '[PROPERTY TEAM]';
      return `${role}: ${m.content}`;
    })
    .join('\n');
}

export function formatConversationContext(tiered: {
  recentMessagesText: string;
  summaryText: string | null;
}): string {
  if (tiered.summaryText) {
    return `[CONVERSATION SUMMARY — earlier messages]\n${tiered.summaryText}\n\n[RECENT MESSAGES]\n${tiered.recentMessagesText}`;
  }
  return tiered.recentMessagesText;
}

export async function buildTieredContext(params: {
  conversationId: string;
  messages: Message[];
  conversation: Conversation;
  prisma: PrismaClient;
  anthropicClient: Anthropic;
}): Promise<{ recentMessagesText: string; summaryText: string | null; totalMessageCount: number }> {
  const { conversationId, messages, conversation, prisma, anthropicClient } = params;

  const recentMessages = messages.slice(-10);
  const olderMessages = messages.slice(0, -10);
  const recentMessagesText = formatMessages(recentMessages);

  if (olderMessages.length === 0) {
    return { recentMessagesText, summaryText: null, totalMessageCount: messages.length };
  }

  // Check if we have a fresh enough summary
  const needsUpdate = conversation.summaryMessageCount < olderMessages.length;
  if (!needsUpdate && conversation.conversationSummary) {
    return {
      recentMessagesText,
      summaryText: conversation.conversationSummary,
      totalMessageCount: messages.length,
    };
  }

  // Generate new summary via Claude Haiku
  try {
    const historyText = formatMessages(olderMessages);
    const response = await anthropicClient.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: 'You are a conversation summarizer for a hospitality AI system. Be extremely concise. Output only bullet points.',
      messages: [{
        role: 'user',
        content: `Summarize this guest conversation history. Focus on:
- What the guest asked for or reported
- What was resolved vs still pending
- Any preferences or special needs mentioned
- Any complaints or escalation-worthy issues
Keep to 5 bullet points maximum. Be brief.

[CONVERSATION HISTORY]
${historyText}`,
      }],
    });

    const summary = response.content.find(b => b.type === 'text')?.text || '';

    // Save to DB
    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        conversationSummary: summary,
        summaryUpdatedAt: new Date(),
        summaryMessageCount: olderMessages.length,
      },
    });

    return { recentMessagesText, summaryText: summary, totalMessageCount: messages.length };
  } catch (err) {
    console.error('[Memory] Failed to generate summary:', err);
    // Return without summary on failure — never crash
    return { recentMessagesText, summaryText: conversation.conversationSummary || null, totalMessageCount: messages.length };
  }
}
```

### Task 2E — tenant-config.service.ts + routes/tenant-config.ts

**File: `backend/src/services/tenant-config.service.ts`**

```typescript
/**
 * Per-tenant AI configuration with 5-minute in-memory cache.
 * Creates default config on first access.
 */
import { PrismaClient, TenantAiConfig } from '@prisma/client';

interface CacheEntry { config: TenantAiConfig; cachedAt: number }
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const ALLOWED_MODELS = [
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-5',
  'claude-opus-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
];

export async function getTenantAiConfig(tenantId: string, prisma: PrismaClient): Promise<TenantAiConfig> {
  const cached = cache.get(tenantId);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.config;
  }

  const config = await prisma.tenantAiConfig.upsert({
    where: { tenantId },
    update: {},
    create: { tenantId },
  });

  cache.set(tenantId, { config, cachedAt: Date.now() });
  return config;
}

export function invalidateTenantConfigCache(tenantId: string): void {
  cache.delete(tenantId);
}

export async function updateTenantAiConfig(
  tenantId: string,
  updates: Partial<TenantAiConfig>,
  prisma: PrismaClient
): Promise<TenantAiConfig> {
  // Validation
  if (updates.agentName !== undefined) {
    if (!updates.agentName || updates.agentName.length > 50 || /<[^>]+>/.test(updates.agentName)) {
      throw Object.assign(new Error('agentName must be 1-50 chars with no HTML'), { field: 'agentName' });
    }
  }
  if (updates.customInstructions !== undefined && updates.customInstructions.length > 2000) {
    throw Object.assign(new Error('customInstructions max 2000 chars'), { field: 'customInstructions' });
  }
  if (updates.temperature !== undefined && (updates.temperature < 0 || updates.temperature > 1)) {
    throw Object.assign(new Error('temperature must be 0.0–1.0'), { field: 'temperature' });
  }
  if (updates.model !== undefined && !ALLOWED_MODELS.includes(updates.model)) {
    throw Object.assign(new Error(`model must be one of: ${ALLOWED_MODELS.join(', ')}`), { field: 'model' });
  }

  // Strip non-updatable fields
  const { id, tenantId: _tid, createdAt, updatedAt, ...safeUpdates } = updates as any;

  const config = await prisma.tenantAiConfig.upsert({
    where: { tenantId },
    update: safeUpdates,
    create: { tenantId, ...safeUpdates },
  });

  invalidateTenantConfigCache(tenantId);
  return config;
}
```

**File: `backend/src/routes/tenant-config.ts`**

```typescript
import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { AuthenticatedRequest } from '../types';
import { getTenantAiConfig, updateTenantAiConfig } from '../services/tenant-config.service';

export function tenantConfigRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.use(authMiddleware as unknown as RequestHandler);

  // GET /api/tenant-config — returns current tenant's TenantAiConfig
  router.get('/', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const config = await getTenantAiConfig(tenantId, prisma);
      res.json(config);
    } catch (err) {
      console.error('[TenantConfig] GET failed:', err);
      res.status(500).json({ error: 'Failed to get tenant config' });
    }
  });

  // PUT /api/tenant-config — update tenant's TenantAiConfig
  router.put('/', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const config = await updateTenantAiConfig(tenantId, req.body, prisma);
      res.json(config);
    } catch (err: any) {
      if (err.field) {
        res.status(400).json({ error: err.message, field: err.field });
        return;
      }
      console.error('[TenantConfig] PUT failed:', err);
      res.status(500).json({ error: 'Failed to update tenant config' });
    }
  });

  return router;
}
```

---

## Chunk 3: Modify Existing Shared Files (Sequential — One Agent)

**IMPORTANT:** One agent handles ALL changes to shared files in sequence. Never run concurrent edits.

### Task 3A — schema.prisma (done in Chunk 1)

Already handled in Chunk 1 migration.

### Task 3B — ai.service.ts (ALL upgrade modifications in one pass)

This is the largest file change. One agent applies ALL of these modifications in sequence.

**Add imports at top of ai.service.ts:**
```typescript
import { traceAiCall } from './observability.service';
import { retrieveRelevantKnowledge } from './rag.service';
import { buildTieredContext, formatConversationContext } from './memory.service';
import { getTenantAiConfig } from './tenant-config.service';
```

**Upgrade 1 — Add Langfuse tracing in `createMessage()`:**
After the `if (_prismaRef && options?.tenantId)` DB persist block (around line 154–172), add:
```typescript
    // Langfuse observability — fire-and-forget
    if (options?.tenantId && options?.conversationId) {
      traceAiCall({
        tenantId: options.tenantId,
        conversationId: options.conversationId,
        agentName: options.agentName || 'unknown',
        model,
        inputTokens: logEntry.inputTokens,
        outputTokens: logEntry.outputTokens,
        costUsd: calculateCostUsd(model, logEntry.inputTokens, logEntry.outputTokens),
        durationMs: logEntry.durationMs,
        responseText: responseText,
        escalated: false,
        cacheCreationTokens: (response.usage as any)?.cache_creation_input_tokens ?? 0,
        cacheReadTokens: (response.usage as any)?.cache_read_input_tokens ?? 0,
      });
    }
```

In the catch block of `createMessage()`, also call traceAiCall with `error`:
```typescript
    if (options?.tenantId && options?.conversationId) {
      traceAiCall({
        tenantId: options.tenantId,
        conversationId: options.conversationId,
        agentName: options.agentName || 'unknown',
        model,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        durationMs: logEntry.durationMs,
        responseText: '',
        escalated: false,
        error: logEntry.error,
      });
    }
```

**Upgrade 5a — Restructure `buildPropertyInfo()` signature:**

Replace the entire `buildPropertyInfo` function (lines 765–815) with:
```typescript
function buildPropertyInfo(
  guestName: string,
  checkIn: string,
  checkOut: string,
  guestCount: number,
  listing: {
    name?: string;
    internalListingName?: string;
    personCapacity?: number;
    roomType?: string;
    bedroomsNumber?: number;
    bathroomsNumber?: number;
    address?: string;
    city?: string;
    doorSecurityCode?: string;
    wifiUsername?: string;
    wifiPassword?: string;
  },
  customKb?: Record<string, unknown>,
  retrievedChunks?: Array<{ content: string; category: string }>
): string {
  let info = `## PROPERTY DATA — AUTHORITATIVE SOURCE
CRITICAL INSTRUCTION: You MUST only answer questions using data explicitly listed in this section.
If a guest asks about something not listed here, respond with "Let me check on that for you" and set escalate to true.
NEVER use general hotel, apartment, or hospitality knowledge to fill information gaps. If it is not listed below, it does not exist.

### RESERVATION DETAILS
Guest Name: ${guestName}
Check-in: ${checkIn}
Check-out: ${checkOut}
Number of Guests: ${guestCount}

### ACCESS & CONNECTIVITY
`;

  if (listing.doorSecurityCode && listing.doorSecurityCode !== 'N/A') {
    info += `Door Code: ${listing.doorSecurityCode}\n`;
  }
  if (listing.wifiUsername && listing.wifiUsername !== 'N/A') {
    info += `WiFi Network Name: ${listing.wifiUsername}\n`;
  }
  if (listing.wifiPassword && listing.wifiPassword !== 'N/A') {
    info += `WiFi Password: ${listing.wifiPassword}\n`;
  }

  info += `
### AVAILABLE AMENITIES — COMPLETE LIST
The following is the COMPLETE and EXHAUSTIVE list of available amenities.
Anything NOT on this list does not exist at this property. Do not suggest,
confirm, or imply the availability of any item not listed here.
• Baby crib — available free on request
• Extra bed — available free on request
• Hair dryer — available free on request
• Kitchen blender — available free on request
• Kids dinnerware set — available free on request
• Espresso machine — available free on request
• Extra towels — available free on request
• Extra pillows — available free on request
• Extra blankets — available free on request
• Hangers — available free on request
• Cleaning service — $20 per session, available 10am–5pm only (working hours)
`;

  if (customKb && typeof customKb === 'object' && Object.keys(customKb).length > 0) {
    info += '\n### PROPERTY-SPECIFIC INFORMATION\n';
    for (const [key, val] of Object.entries(customKb)) {
      if (val && String(val).trim() && String(val).trim() !== 'N/A') {
        info += `${key}: ${String(val)}\n`;
      }
    }
  }

  if (retrievedChunks && retrievedChunks.length > 0) {
    info += '\n### VERIFIED PROPERTY KNOWLEDGE (from knowledge base search)\n';
    info += 'The following was retrieved from the property\'s verified knowledge base based on the guest\'s current question:\n';
    for (const chunk of retrievedChunks) {
      info += `[${chunk.category}] ${chunk.content}\n`;
    }
  }

  return info;
}
```

**Upgrade 5b — Add batched messages instruction to OMAR_SYSTEM_PROMPT:**

In the `OMAR_SYSTEM_PROMPT` string, find `## CONTEXT YOU RECEIVE` and prepend right before it:
```
IMPORTANT — BATCHED MESSAGES: The guest may have sent multiple messages in sequence. All messages are presented together for context. Treat them as a single continuous conversation, not separate requests. Read all messages before responding. Address everything the guest mentioned in one natural, coherent reply. Do not number your responses or say "regarding your first message". Just respond naturally.

---

```

**Upgrade 4 + 5c + 6d — Modify `generateAndSendAiReply()`:**

At the very top of `generateAndSendAiReply()`, after the destructuring (line 963), add:
```typescript
  // Fetch per-tenant AI configuration
  const tenantConfig = await getTenantAiConfig(tenantId, prisma).catch(() => null);
```

Replace the message history building section (lines 969–980) with:
```typescript
    // Fetch ALL message history from DB
    const dbMessages = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { sentAt: 'asc' },
    });
    // Exclude [MANAGER] private messages from AI context
    const allMsgs = dbMessages.filter(m => !m.content.startsWith('[MANAGER]') && m.role !== 'AI_PRIVATE' && m.role !== 'MANAGER_PRIVATE');

    // Fetch conversation for tiered memory
    const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });

    // Build tiered context (summary for old messages + verbatim recent)
    let historyText: string;
    if (tenantConfig?.memorySummaryEnabled !== false && conversation && allMsgs.length > 10) {
      const tiered = await buildTieredContext({
        conversationId,
        messages: allMsgs,
        conversation,
        prisma,
        anthropicClient: anthropic,
      }).catch(() => ({ recentMessagesText: allMsgs.slice(-10).map(m => `${m.role === 'GUEST' ? 'Guest' : 'Omar'}: ${m.content}`).join('\n'), summaryText: null, totalMessageCount: allMsgs.length }));
      historyText = formatConversationContext(tiered);
    } else {
      historyText = allMsgs
        .map(m => `${m.role === 'GUEST' ? 'Guest' : 'Omar'}: ${m.content}`)
        .join('\n');
    }
```

For RAG retrieval, add BEFORE the `buildPropertyInfo` call (around line 1024):
```typescript
    // RAG: retrieve relevant knowledge chunks for this query
    const ragQuery = currentMsgs.map((m: { content: string }) => m.content).join(' ');
    const retrievedChunks = (tenantConfig?.ragEnabled !== false && context.propertyId)
      ? await retrieveRelevantKnowledge(tenantId, context.propertyId, ragQuery, prisma).catch(() => [])
      : [];

    const propertyInfo = buildPropertyInfo(
      context.guestName,
      context.checkIn,
      context.checkOut,
      context.guestCount,
      context.listing,
      context.customKnowledgeBase,
      retrievedChunks
    );
```

In `generateAndSendAiReply()`, where `personaCfg.model`, `personaCfg.temperature`, `personaCfg.maxTokens` are used — overlay with tenantConfig values:
```typescript
    // Override persona config with tenant-specific settings
    const effectiveModel = tenantConfig?.model || personaCfg.model;
    const effectiveTemperature = tenantConfig?.temperature ?? personaCfg.temperature;
    const effectiveMaxTokens = tenantConfig?.maxTokens || personaCfg.maxTokens;
    const effectiveAgentName = tenantConfig?.agentName || agentName;

    // Append custom instructions to system prompt if configured
    let effectiveSystemPrompt = personaCfg.systemPrompt;
    if (tenantConfig?.agentPersonality) {
      // Replace the default name in the system prompt
      effectiveSystemPrompt = effectiveSystemPrompt.replace(/\bOmar\b/g, tenantConfig.agentName || 'Omar');
    }
    if (tenantConfig?.customInstructions) {
      effectiveSystemPrompt += `\n\n## TENANT-SPECIFIC INSTRUCTIONS\nThe following instructions are specific to this property and override general guidelines where they conflict:\n${tenantConfig.customInstructions}`;
    }
```

Then replace all `personaCfg.model`, `personaCfg.temperature`, `personaCfg.maxTokens`, `agentName`, and `personaCfg.systemPrompt` in the `createMessage()` calls with the `effective*` variables.

**Upgrade 8 — Prompt caching in `createMessage()`:**

Modify the `anthropic.messages.create()` call to use prompt caching. Replace the current call structure:
```typescript
    const response = await withRetry(() =>
      (anthropic.messages.create as any)({
        model,
        max_tokens: maxTokens,
        ...(options?.topK !== undefined ? { top_k: options.topK } : {}),
        ...(options?.topP !== undefined ? { top_p: options.topP } : {}),
        ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options?.stopSequences?.length ? { stop_sequences: options.stopSequences } : {}),
        system: [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: userContent as Anthropic.ContentBlock[] }],
      }, {
        headers: { 'anthropic-beta': 'prompt-caching-2024-07-31' },
      })
    );
```

### Task 3C — debounce.service.ts

Add imports at top:
```typescript
import { addAiReplyJob, removeAiReplyJob } from './queue.service';
```

In `scheduleAiReply()`, after the DB upsert block, add:
```typescript
  // Also enqueue in BullMQ (if Redis available) — fire-and-forget, never breaks DB debounce
  addAiReplyJob(conversationId, tenantId, delay).catch(err =>
    console.warn('[Debounce] BullMQ enqueue failed (non-fatal):', err)
  );
```

In `cancelPendingAiReply()`, after the `updateMany` call, add:
```typescript
  // Also cancel BullMQ job if Redis available
  removeAiReplyJob(conversationId).catch(err =>
    console.warn('[Debounce] BullMQ cancel failed (non-fatal):', err)
  );
```

Note: `scheduleAiReply` needs `tenantId` param — it already has it. Good.

### Task 3D — server.ts

Add imports:
```typescript
import { startAiReplyWorker } from './workers/aiReply.worker';
import { closeQueue } from './services/queue.service';
import { flushObservability } from './services/observability.service';
```

After `startAiDebounceJob`:
```typescript
  // Start BullMQ worker (graceful no-op if REDIS_URL missing)
  const aiReplyWorker = startAiReplyWorker(prisma);
```

In the `shutdown` handler, add before `prisma.$disconnect()`:
```typescript
    if (aiReplyWorker) await aiReplyWorker.close();
    await closeQueue();
    await flushObservability();
```

### Task 3E — app.ts

Add import:
```typescript
import { tenantConfigRouter } from './routes/tenant-config';
```

Add route registration (after existing routes):
```typescript
  app.use('/api/tenant-config', tenantConfigRouter(prisma));
```

Also add the property reindex-knowledge route:
```typescript
  app.post('/api/properties/:id/reindex-knowledge', authMiddleware as any, async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const propertyId = req.params.id;
      const property = await prisma.property.findFirst({ where: { id: propertyId, tenantId } });
      if (!property) { res.status(404).json({ error: 'Property not found' }); return; }
      const { ingestPropertyKnowledge } = await import('./services/rag.service');
      const chunks = await ingestPropertyKnowledge(tenantId, propertyId, property, prisma);
      res.json({ ok: true, chunks });
    } catch (err) {
      console.error('[Properties] Reindex knowledge failed:', err);
      res.status(500).json({ error: 'Reindex failed' });
    }
  });
```

### Task 3F — import.service.ts

After each property upsert, add RAG ingestion. Find the property upsert call in `runImport()` and add:
```typescript
      // RAG: ingest property knowledge chunks — failure never breaks import
      const { ingestPropertyKnowledge } = require('../services/rag.service');
      ingestPropertyKnowledge(tenantId, property.id, property, prisma)
        .catch((err: Error) => console.error('[Import] RAG ingestion failed (non-fatal):', err));
```

---

## Chunk 4: Config Files + Documentation

### Task 4A — Railway config files

**File: `railway.toml` (repo root)**
```toml
[build]
builder = "nixpacks"

[deploy]
startCommand = "cd backend && npm run start"
healthcheckPath = "/api/health"
healthcheckTimeout = 30
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 3
```

**File: `backend/railway.toml`**
```toml
[build]
builder = "nixpacks"
buildCommand = "npm install && npx prisma generate && npm run build"

[deploy]
startCommand = "npx prisma migrate deploy && npm run start"
```

### Task 4B — .env.example additions

Add to `backend/.env.example`:
```env
# Redis (BullMQ) — add Redis service on Railway, paste URL here
# Without this: system falls back to 30-second poll (graceful degradation)
REDIS_URL=""

# OpenAI — for embeddings only, not for AI responses
# Without this: RAG is skipped, prompts still work correctly
OPENAI_API_KEY=""

# Langfuse — observability dashboard
# Without this: tracing is skipped silently
LANGFUSE_PUBLIC_KEY=""
LANGFUSE_SECRET_KEY=""
LANGFUSE_HOST="https://cloud.langfuse.com"
```

### Task 4C — UPGRADE_NOTES.md

Create `backend/UPGRADE_NOTES.md` documenting all changes.

---

## Chunk 5: Build + Fix + Commit

- [ ] `cd backend && npx prisma generate`
- [ ] `cd backend && npx tsc --noEmit 2>&1` — fix ALL TypeScript errors
- [ ] `npm run build` — must exit 0
- [ ] `git add -A`
- [ ] `git commit -m "feat(backend): advanced AI — RAG, BullMQ debounce queue, tiered memory, grounded prompts, per-tenant config, Langfuse observability, prompt caching"`
- [ ] `git push origin advanced-ai`

---

## Success Criteria

- [ ] `npm run build` passes with zero errors
- [ ] Guest messaging works when `REDIS_URL` is missing (falls back to poll)
- [ ] Guest messaging works when `OPENAI_API_KEY` is missing (skips RAG)
- [ ] Guest messaging works when `LANGFUSE_*` keys are missing (skips tracing)
- [ ] Long conversations (20+ messages) use tiered memory instead of full dump
- [ ] Property-specific amenities are grounded — AI won't invent unlisted items
- [ ] Each tenant can have different agent name, model, and instructions
- [ ] No cross-tenant data leaks in any DB query
- [ ] `advanced-ai` branch only — never merged to `main`
