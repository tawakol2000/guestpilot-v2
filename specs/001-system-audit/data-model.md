# Data Model Changes: Full System Audit

**Date**: 2026-03-19
**Feature**: 001-system-audit

This audit adds constraints and columns to existing models. No new
models are introduced.

## Schema Changes

### PendingAiReply — Unique Constraint

**Change**: Add `@@unique([conversationId])` to ensure only one pending
reply per conversation at a time.

**Before**:
```prisma
@@index([fired, scheduledAt])
@@index([conversationId])
```

**After**:
```prisma
@@unique([conversationId])
@@index([fired, scheduledAt])
```

**Migration impact**: Existing duplicate records (if any) must be
cleaned up before applying. Query: `SELECT conversationId, COUNT(*)
FROM "PendingAiReply" WHERE fired = false GROUP BY conversationId
HAVING COUNT(*) > 1` — delete older duplicates.

**Behavior change**: `scheduleAiReply()` must use `upsert` instead of
`findFirst` + `create/update`.

---

### Message — Deduplication Constraint

**Change**: Add conditional unique constraint on `(conversationId,
hostawayMessageId)` to prevent duplicate message inserts.

**Challenge**: `hostawayMessageId` defaults to `""` (empty string).
Multiple messages per conversation can legitimately have empty IDs
(e.g., host-sent messages, AI messages). The unique constraint must
exclude empty strings.

**Approach**: Add a partial unique index via raw SQL migration (Prisma
doesn't support partial unique indexes natively):

```sql
CREATE UNIQUE INDEX "Message_conv_hostaway_msg_unique"
ON "Message" ("conversationId", "hostawayMessageId")
WHERE "hostawayMessageId" != '';
```

**Migration impact**: Check for existing duplicates first:
`SELECT "conversationId", "hostawayMessageId", COUNT(*) FROM "Message"
WHERE "hostawayMessageId" != '' GROUP BY "conversationId",
"hostawayMessageId" HAVING COUNT(*) > 1`.

---

### PropertyKnowledgeChunk — Cohere Embedding Column

**Change**: Add `embedding_cohere vector(1024)` column with HNSW index.

**Migration SQL**:
```sql
ALTER TABLE "PropertyKnowledgeChunk"
ADD COLUMN "embedding_cohere" vector(1024);

CREATE INDEX "PropertyKnowledgeChunk_cohere_hnsw"
ON "PropertyKnowledgeChunk"
USING hnsw ("embedding_cohere" vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
```

**Migration impact**: Existing rows will have `NULL` for
`embedding_cohere`. When a tenant switches to Cohere, all chunks need
re-embedding (the existing re-embed flow handles this). No data loss.

---

### ClassifierExample — Deduplication

**Change**: Add unique constraint on `(tenantId, text)` to prevent
duplicate training examples.

**Before**:
```prisma
@@index([tenantId, active])
```

**After**:
```prisma
@@unique([tenantId, text])
@@index([tenantId, active])
```

**Migration impact**: Check for existing duplicates:
`SELECT "tenantId", text, COUNT(*) FROM "ClassifierExample"
WHERE active = true GROUP BY "tenantId", text HAVING COUNT(*) > 1`.
Keep the most recent, deactivate older duplicates.

**Behavior change**: `addExample()` in `classifier-store.service.ts`
must use `upsert` instead of `create`.

---

## State Changes (In-Memory)

### ClassifierState — Atomic Swap

**Change**: Bundle `_examples` + `_exampleEmbeddings` into a single
`ClassifierState` object reference.

```typescript
interface ClassifierState {
  examples: TrainingExample[];
  embeddings: number[][];
  initDurationMs: number;
}

let _state: ClassifierState | null = null;
```

Readers capture `const state = _state` (snapshot). Writers build the
complete new state, then assign `_state = newState` (atomic swap).

### TopicStateCache — Periodic Cleanup

**Change**: Add `setInterval` cleanup (every 5 minutes) that evicts
expired entries from `_cache: Map<string, TopicState>`.

### JudgeThresholdCache — TTL Eviction

**Change**: Add periodic cleanup for `_thresholdCache` and `_fixCounts`
Maps in `judge.service.ts` to evict expired entries.

### SSE Client Registry — Empty Set Cleanup

**Change**: When a client disconnects and the tenant's Set becomes
empty, delete the tenant key from the outer `clients` Map.
