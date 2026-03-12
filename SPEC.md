# Advanced AI Branch — Implementation Spec

## Branch: `advanced-ai`
## Repo: `guest-pilot-v2`
## Scope: `backend/` only — do not touch `frontend/`
## Goal: Upgrade from prototype to production-quality AI guest services

---

## Pre-Flight Checklist (Before Writing Any Code)

1. Confirm current branch: `git branch --show-current` → must show `advanced-ai`
2. Confirm clean working tree: `git status`
3. Confirm build passes: `cd backend && npm run build`
4. Fix any pre-existing build errors before proceeding

---

## Dependencies to Install

```bash
cd backend
npm install bullmq ioredis langfuse openai
```

---

## Upgrade 1 — Observability (Langfuse)

**New file:** `backend/src/services/observability.service.ts`

- Initialize Langfuse client using env vars: `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST` (default: `https://cloud.langfuse.com`)
- Export `traceAiCall(params)` — creates a Langfuse trace with:
  - `tenantId`, `conversationId`, `agentName`, `model`
  - `inputTokens`, `outputTokens`, `costUsd`, `durationMs`
  - `responseText`, `error` (if any)
- Export `flushObservability()` for graceful shutdown
- **If env vars missing:** log a warning once, then no-op gracefully — never crash

**Modify:** `backend/src/services/ai.service.ts`
- Import and call `traceAiCall()` inside the existing `createMessage()` function after every Claude API call
- Fire-and-forget — do NOT await (non-blocking)

**Modify:** `backend/src/server.ts`
- Import `flushObservability()` and call it in the shutdown handler

---

## Upgrade 2 — Event-Driven Queue (BullMQ + Redis)

**New file:** `backend/src/services/queue.service.ts`

- Initialize BullMQ Queue named `'ai-replies'` using `REDIS_URL` env var
- Export `addAiReplyJob(conversationId, tenantId, delayMs)`:
  - Adds a delayed job to the queue
  - If a job already exists for this `conversationId`, remove it first (debounce reset)
- Export `removeAiReplyJob(conversationId)` — cancels pending job
- Export `getQueue()` — returns queue instance
- Handle graceful shutdown (close Redis connections)
- **If `REDIS_URL` missing:** log warning, skip queue operations silently

**New file:** `backend/src/workers/aiReply.worker.ts`

- BullMQ Worker processing `'ai-replies'` queue
- For each job:
  1. Fetch full conversation from DB with all relations (reservation, property, guest, tenant)
  2. Check `reservation.aiEnabled` and `aiMode` — skip if disabled
  3. Call `generateAndSendAiReply()` with the same context object shape as `aiDebounce.job.ts`
  4. Log success/failure with `conversationId`
- Export `startAiReplyWorker(prisma)` function

**Modify:** `backend/src/services/debounce.service.ts`
- In `scheduleAiReply()`: after creating/updating `PendingAiReply`, also call `addAiReplyJob()` if Redis is available
- In `cancelPendingAiReply()`: also call `removeAiReplyJob()` if Redis is available

**Modify:** `backend/src/server.ts`
- Import and call `startAiReplyWorker(prisma)` after `startAiDebounceJob`

**Keep:** existing `aiDebounce.job.ts` poll — leave it as fallback. It will find no due jobs when BullMQ is processing them, which is correct.

---

## Upgrade 3 — pgvector RAG (Property Knowledge)

### Schema Changes — `backend/prisma/schema.prisma`

Add new model:
```prisma
model PropertyKnowledgeChunk {
  id          String   @id @default(cuid())
  tenantId    String
  propertyId  String
  content     String   @db.Text
  category    String   @default("general")
  sourceKey   String   @default("")
  // embedding column added via raw SQL migration (pgvector)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  tenant      Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  property    Property @relation(fields: [propertyId], references: [id], onDelete: Cascade)

  @@index([tenantId, propertyId])
  @@index([propertyId, category])
}
```

Add `propertyKnowledgeChunks PropertyKnowledgeChunk[]` to both `Tenant` and `Property` models.

Run: `npx prisma migrate dev --name add_knowledge_chunks`

### Manual SQL Migration (run once on Railway PostgreSQL after deploy)

Create file `backend/prisma/migrations/add_pgvector.sql`:
```sql
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "PropertyKnowledgeChunk"
  ADD COLUMN IF NOT EXISTS embedding vector(1536);

CREATE INDEX IF NOT EXISTS property_knowledge_embedding_idx
  ON "PropertyKnowledgeChunk"
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

### New file: `backend/src/services/embeddings.service.ts`

- Initialize OpenAI client using `OPENAI_API_KEY`
- Export `embedText(text: string): Promise<number[]>` — calls `text-embedding-3-small`, returns embedding array
- Export `embedBatch(texts: string[]): Promise<number[][]>` — batch embedding
- In-memory cache (simple `Map`) with 1-hour TTL to avoid re-embedding identical strings
- **If `OPENAI_API_KEY` missing:** return empty arrays, log warning once

### New file: `backend/src/services/rag.service.ts`

Export `ingestPropertyKnowledge(tenantId, propertyId, property, prisma)`:
1. Delete all existing chunks for this `propertyId`
2. Build chunks from `customKnowledgeBase` JSON — each key-value → `"Q: What is [key]? A: [value]"`, category inferred from key
3. Also chunk `listingDescription` by paragraph (skip chunks under 50 chars)
4. Embed all chunks in batches of 20
5. Save via `$executeRaw` (Prisma doesn't support vector natively):
   ```sql
   INSERT INTO "PropertyKnowledgeChunk"
     (id, "tenantId", "propertyId", content, category, "sourceKey", embedding, "createdAt", "updatedAt")
   VALUES ($1, $2, $3, $4, $5, $6, $7::vector, now(), now())
   ```

Export `retrieveRelevantKnowledge(tenantId, propertyId, query, prisma, topK = 5)`:
1. Embed the query
2. Run hybrid search via `$queryRaw`:
   ```sql
   SELECT id, content, category,
     1 - (embedding <=> $1::vector) as similarity
   FROM "PropertyKnowledgeChunk"
   WHERE "propertyId" = $2 AND "tenantId" = $3
     AND embedding IS NOT NULL
   ORDER BY embedding <=> $1::vector
   LIMIT $4
   ```
3. Return `{ content, category, similarity }[]`
4. **If no embedding available:** return `[]`, never throw

**Modify:** `backend/src/services/import.service.ts`
- After upserting each property, call `ingestPropertyKnowledge()`
- Wrap in `try/catch` — RAG failure must never break property import

**Add endpoint:** `POST /api/properties/:id/reindex-knowledge`
- Calls `ingestPropertyKnowledge` for that property
- Returns `{ ok: true, chunks: number }`

---

## Upgrade 4 — Tiered Conversation Memory

### Schema Changes

Add to `Conversation` model:
```prisma
conversationSummary  String?   @db.Text
summaryUpdatedAt     DateTime?
summaryMessageCount  Int       @default(0)
```

Run: `npx prisma migrate dev --name add_conversation_summary`

### New file: `backend/src/services/memory.service.ts`

Export `buildTieredContext(conversationId, messages, prisma, aiConfig)`:

1. Split messages: `recentMessages` = last 10, `olderMessages` = everything before
2. If `olderMessages.length > 0`:
   - Check if `conversation.summaryMessageCount < olderMessages.length` (new messages since last summary)
   - If needs update: call Claude Haiku with:
     ```
     Summarize this conversation history in 3-5 bullet points.
     Focus on: what the guest requested, what was resolved,
     any pending issues, guest preferences observed. Be concise.
     Max 400 tokens.
     ```
   - Save to `conversation.conversationSummary` and update `summaryMessageCount`
3. Return:
   ```typescript
   {
     recentMessagesText: string,
     summaryText: string | null,
     totalMessageCount: number
   }
   ```

Export `formatConversationContext(tiered)`:
- If summary exists: `"[CONVERSATION SUMMARY]\n{summary}\n\n[RECENT MESSAGES]\n{recent}"`
- If no summary: just recent messages

**Modify:** `backend/src/services/ai.service.ts`
- Replace existing flat history building with `buildTieredContext()` + `formatConversationContext()`

---

## Upgrade 5 — Grounded Generation Prompts

**Modify:** `buildPropertyInfo()` in `backend/src/services/ai.service.ts`

New structured format:

```
## PROPERTY DATA — AUTHORITATIVE SOURCE
CRITICAL: Only answer using data explicitly listed below.
If a guest asks about something not listed here, say "Let me check on that
for you" and escalate. NEVER use general hotel/apartment knowledge to fill gaps.

### RESERVATION INFO
Guest: {guestName}
Check-in: {checkIn}
Check-out: {checkOut}
Guests: {guestCount}

### ACCESS & CONNECTIVITY
[Only include fields with actual values — skip N/A fields]
Door Code: {doorCode}
WiFi Network: {wifiNetwork}
WiFi Password: {wifiPassword}

### AVAILABLE AMENITIES
(These are the ONLY amenities. Anything not listed does NOT exist.)
- Baby crib (free, on request)
- Extra bed (free, on request)
- Hair dryer (free, on request)
- Kitchen blender (free, on request)
- Kids dinnerware (free, on request)
- Espresso machine (free, on request)
- Extra towels (free, on request)
- Extra pillows (free, on request)
- Extra blankets (free, on request)
- Hangers (free, on request)
- Cleaning service ($20/session, working hours 10am–5pm only)

### PROPERTY-SPECIFIC INFO
[Render customKnowledgeBase key-value pairs — skip empty values]

### RAG RETRIEVED CONTEXT
[Top relevant chunks from vector search — verified property data]
{retrievedChunks}
```

**Update function signature:**
```typescript
buildPropertyInfo(
  guestName, checkIn, checkOut, guestCount,
  listing, customKb?, retrievedChunks?
)
```

**In `generateAndSendAiReply()`:**
- Call `retrieveRelevantKnowledge()` before `buildPropertyInfo()`
- Pass retrieved chunks into `buildPropertyInfo()`
- If RAG returns empty, continue without it

---

## Upgrade 6 — Per-Tenant AI Config in Database

### Schema Changes

Add new model:
```prisma
model TenantAiConfig {
  id                  String   @id @default(cuid())
  tenantId            String   @unique
  agentName           String   @default("Omar")
  agentPersonality    String   @default("")
  customInstructions  String   @db.Text @default("")
  model               String   @default("claude-haiku-4-5-20251001")
  temperature         Float    @default(0.25)
  maxTokens           Int      @default(1024)
  debounceDelayMs     Int      @default(5000)
  aiEnabled           Boolean  @default(true)
  screeningEnabled    Boolean  @default(true)
  ragEnabled          Boolean  @default(true)
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  tenant              Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
}
```

Add `tenantAiConfig TenantAiConfig?` to `Tenant` model.

Run: `npx prisma migrate dev --name add_tenant_ai_config`

### New file: `backend/src/services/tenant-config.service.ts`

- Export `getTenantAiConfig(tenantId, prisma)` — returns config, creates default if missing
- Export `updateTenantAiConfig(tenantId, updates, prisma)` — upserts config
- In-memory cache with 5-minute TTL (simple `Map` with timestamp)
- Export `invalidateTenantConfigCache(tenantId)`

### New routes: `backend/src/routes/ai-config.ts`

- `GET /api/ai-config/tenant` — returns current tenant's `TenantAiConfig`
- `PUT /api/ai-config/tenant` — updates config with validation:
  - `agentName`: max 50 chars
  - `customInstructions`: max 2000 chars
  - `temperature`: 0–1
  - `model`: must be one of the allowed Claude models

### Modify: `backend/src/services/ai.service.ts`

In `generateAndSendAiReply()`:
- Fetch tenant config at top: `const tenantConfig = await getTenantAiConfig(tenantId, prisma)`
- Use `tenantConfig.model` (overrides hardcoded model)
- Use `tenantConfig.temperature`
- Use `tenantConfig.debounceDelayMs`
- If `tenantConfig.ragEnabled === false`, skip RAG retrieval
- If `tenantConfig.customInstructions` is non-empty, append to system prompt:
  `"\n\n## CUSTOM PROPERTY INSTRUCTIONS\n{customInstructions}"`

---

## Railway Config Files

### `railway.toml` (repo root)
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

### `backend/railway.toml`
```toml
[build]
builder = "nixpacks"
buildCommand = "npm install && npx prisma generate && npm run build"

[deploy]
startCommand = "npx prisma migrate deploy && npm run start"
```

---

## Final Steps After All Upgrades

1. `npx prisma generate`
2. `npm run build` — fix all TypeScript errors
3. Update `backend/.env.example`:
   ```env
   REDIS_URL="redis://..."
   OPENAI_API_KEY=""
   LANGFUSE_PUBLIC_KEY=""
   LANGFUSE_SECRET_KEY=""
   LANGFUSE_HOST="https://cloud.langfuse.com"
   ```
4. Create `backend/UPGRADE_NOTES.md` documenting:
   - What changed and why
   - The manual pgvector SQL migration needed
   - Which env vars enable which features
   - Graceful degradation behavior for each missing var
5. Commit: `"feat(backend): advanced AI upgrades — RAG, BullMQ, tiered memory, grounded prompts, per-tenant config, Langfuse"`
6. Push to `origin advanced-ai` only — do NOT merge to `main`

---

## Success Criteria

- [ ] `npm run build` passes with zero errors
- [ ] Guest messaging works when `REDIS_URL` is missing (falls back to poll)
- [ ] Guest messaging works when `OPENAI_API_KEY` is missing (skips RAG)
- [ ] Guest messaging works when `LANGFUSE_*` keys are missing (skips tracing)
- [ ] Long conversations (20+ messages) use tiered memory instead of full dump
- [ ] Property-specific amenities are grounded — AI won't invent unlisted items
- [ ] Each tenant can have different agent name, model, and instructions
- [ ] No regressions in existing Hostaway webhook flow
- [ ] No cross-tenant data leaks in any DB query
