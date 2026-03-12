# Advanced AI Upgrades — Backend Notes

Branch: `advanced-ai` | Do NOT merge to `main` until fully tested.

---

## Summary of Upgrades

### Upgrade 1 — Langfuse Observability
Every Claude API call is now traced. Tracks: model, tokens, cost, duration, agent name, tenant, conversation, cache hit/miss.
- New file: `src/services/observability.service.ts`
- Modified: `src/services/ai.service.ts` (fire-and-forget `traceAiCall()` after every call)
- Modified: `src/server.ts` (flush on graceful shutdown)

### Upgrade 2 — BullMQ Event-Driven Queue
Replaces setInterval polling with event-driven Redis delayed jobs. **The 30-second debounce is preserved exactly** — each new message cancels and re-adds the job, resetting the timer.
- New files: `src/services/queue.service.ts`, `src/workers/aiReply.worker.ts`
- Modified: `src/services/debounce.service.ts` (addAiReplyJob / removeAiReplyJob)
- Modified: `src/server.ts` (startAiReplyWorker, closeQueue)
- Fallback: `jobs/aiDebounce.job.ts` poll remains active when Redis unavailable

### Upgrade 3 — pgvector RAG
Property knowledge is embedded and stored as vectors. Each AI call retrieves the top-5 most relevant chunks for the guest's question, grounding responses in verified property data.
- New files: `src/services/embeddings.service.ts`, `src/services/rag.service.ts`
- New Prisma model: `PropertyKnowledgeChunk`
- Modified: `src/services/import.service.ts` (ingest after property sync)
- New endpoint: `POST /api/properties/:id/reindex-knowledge`
- **Requires manual SQL**: Run `prisma/migrations/add_pgvector.sql` on Railway after deploy

### Upgrade 4 — Tiered Conversation Memory
Conversations >10 messages use a bullet-point summary + verbatim recent 10 messages. The summary is cached in DB and only regenerated when new older messages arrive.
- New file: `src/services/memory.service.ts`
- New Prisma fields on `Conversation`: `conversationSummary`, `summaryUpdatedAt`, `summaryMessageCount`
- Modified: `src/services/ai.service.ts` (buildTieredContext + formatConversationContext)

### Upgrade 5 — Grounded Generation Prompts
`buildPropertyInfo()` now outputs a strict authoritative format that instructs the AI to only answer from listed data. Amenities list is exhaustive and explicit. RAG chunks are injected into the property context. Multi-message batching instruction added to system prompt.

### Upgrade 6 — Per-Tenant AI Configuration
Each tenant can independently set: agent name, model, temperature, max tokens, debounce delay, custom instructions, RAG on/off, memory summaries on/off.
- New Prisma model: `TenantAiConfig`
- New files: `src/services/tenant-config.service.ts`, `src/routes/tenant-config.ts`
- New endpoints: `GET /api/tenant-config`, `PUT /api/tenant-config`
- Modified: `src/services/ai.service.ts` (getTenantAiConfig at top of generateAndSendAiReply)

### Upgrade 7 — Railway Configuration
- New file: `railway.toml` (repo root)
- New file: `backend/railway.toml`

### Upgrade 8 — Prompt Caching
System prompt is sent with `cache_control: { type: 'ephemeral' }` and the `anthropic-beta: prompt-caching-2024-07-31` header. Cache hit rate is logged and tracked in Langfuse traces.

---

## Manual Railway Steps After Deploy

### 1. Add Redis Service
In Railway dashboard: New Service → Redis. Copy the `REDIS_URL`.

### 2. Set Environment Variables
Add to your Railway backend service:
```
REDIS_URL=<from Redis service>
OPENAI_API_KEY=<your OpenAI key>
LANGFUSE_PUBLIC_KEY=<from Langfuse dashboard>
LANGFUSE_SECRET_KEY=<from Langfuse dashboard>
LANGFUSE_HOST=https://cloud.langfuse.com
```

### 3. Run pgvector SQL Migration
In Railway dashboard: PostgreSQL service → Query tab.
Run the contents of `backend/prisma/migrations/add_pgvector.sql`:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "PropertyKnowledgeChunk"
  ADD COLUMN IF NOT EXISTS embedding vector(1536);

CREATE INDEX IF NOT EXISTS property_knowledge_embedding_idx
  ON "PropertyKnowledgeChunk"
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

### 4. Trigger Initial RAG Ingestion
After deploy, trigger a property import or use the reindex endpoint for each property:
```
POST /api/properties/:id/reindex-knowledge
Authorization: Bearer <token>
```

---

## Graceful Degradation

| Missing Variable | Behavior |
|------------------|----------|
| `REDIS_URL` | BullMQ worker not started, falls back to 30s poll. Guests still get AI replies. |
| `OPENAI_API_KEY` | RAG skipped entirely. AI replies work without retrieved context. |
| `LANGFUSE_*` | Tracing skipped silently. AI replies unaffected. |

**Core guest messaging NEVER breaks due to missing optional services.**

---

## New API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tenant-config` | Get current tenant's AI config |
| PUT | `/api/tenant-config` | Update AI config (validated) |
| POST | `/api/properties/:id/reindex-knowledge` | Re-embed property knowledge for RAG |
