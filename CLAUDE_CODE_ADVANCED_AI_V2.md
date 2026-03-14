# Claude Code Instructions — advanced-ai-v2 Branch

## What This Is

Integration of the Bait RAG embedding classifier into GuestPilot v2's AI pipeline. The classifier replaces pgvector-based SOP retrieval for the guestCoordinator agent with a deterministic, in-memory KNN-3 classifier that scores 99/100 on our test suite.

**Branch:** `advanced-ai-v2` (forked from `advanced-ai`)
**Scope:** `backend/` only — do NOT touch `frontend/` (frontend changes come later)

## The Problem We're Solving

The current system (`advanced-ai` branch) uses pgvector to retrieve SOP chunks for every guest message. It retrieves ~8 chunks per query via cosine similarity search. This is:
- **Expensive**: pgvector query + embedding API call per message
- **Noisy**: returns 5-8 SOP chunks when most messages need 0-2
- **Slow**: ~200ms for vector search vs <1ms for in-memory KNN
- **Non-deterministic**: pgvector results can vary slightly

The embedding classifier uses 164 labeled training examples in memory with KNN-3 weighted voting to classify messages into the exact SOP chunks they need. It returns 0-4 chunk IDs deterministically in <1ms.

## Architecture Change

```
BEFORE (advanced-ai):
  Guest message → embed query → pgvector search ALL chunks → top 8 → filter by 0.2 threshold → inject into prompt

AFTER (advanced-ai-v2):
  Guest message → KNN-3 classifier (in-memory) → 0-4 SOP chunk IDs → look up SOP content from memory map
                                                                     ↓
                                              ALSO: pgvector search property-specific chunks only
                                                                     ↓
                                              Combine SOP chunks + property chunks → inject into prompt
```

**What stays on pgvector:** property-info, property-description, property-amenities, learned-answers (these are per-property and change when properties are re-synced)

**What moves to in-memory classifier:** All 11 SOP chunks (sop-cleaning, sop-amenity-request, sop-maintenance, sop-wifi-doorcode, sop-visitor-policy, sop-early-checkin, sop-late-checkout, sop-escalation-info, property-info, property-description, property-amenities)

**What's baked into system prompt (no retrieval):** sop-scheduling, sop-house-rules, sop-escalation-immediate, sop-escalation-scheduled (270 tokens, always present)

**screeningAI is completely unchanged** — it keeps using pgvector with its own category filters.

## Pre-Flight Checklist

```bash
# 1. Create and switch to new branch
git checkout advanced-ai
git pull origin advanced-ai
git checkout -b advanced-ai-v2

# 2. Verify build passes
cd backend && npm run build

# 3. Verify current tests work
# (no automated tests yet, just verify build)
```

## Files to Create (3 new files)

### File 1: `backend/src/services/classifier.service.ts`

The TypeScript port of `run_embedding_eval_v2.py`. This is the core classifier.

See `CLASSIFIER_INTEGRATION_SPEC.md` for the complete file content.

Key points:
- Loads 164 training examples from a hardcoded array (same as Python script)
- Embeds all examples on first use using existing `embeddings.service.ts`
- KNN-3 with weighted voting, 0.30 vote threshold, 2/3 neighbor agreement
- Contextual gate: if nearest neighbor has empty labels and similarity > 0.85, return empty
- Token budget: 500 tokens max
- Returns `{ labels: string[], method: string, topK: [...] }`
- Graceful degradation: if not initialized, returns empty labels (falls through to pgvector)

### File 2: `backend/src/services/classifier-data.ts`

The 164 training examples + SOP content map + chunk token costs as TypeScript constants.

### File 3: `backend/src/config/baked-in-sops.ts`

The 4 SOP chunks (scheduling, house-rules, escalation-immediate, escalation-scheduled) formatted for direct injection into the system prompt. ~270 tokens total.

## Files to Modify (4 files)

### Modify 1: `backend/src/services/rag.service.ts`

**Changes:**
1. Import classifier: `import { classifyMessage, isClassifierInitialized } from './classifier.service'`
2. Modify `retrieveRelevantKnowledge()`:
   - Add `agentType` parameter check
   - For `guestCoordinator`: use classifier first, then pgvector only for property chunks
   - For `screeningAI`: unchanged (still uses pgvector with category filters)
3. Add `initializeClassifier()` call in `seedTenantSops()` to trigger classifier init after SOP seeding

**The critical change in `retrieveRelevantKnowledge()`:**

```typescript
export async function retrieveRelevantKnowledge(
  tenantId: string,
  propertyId: string,
  query: string,
  prisma: PrismaClient,
  topK = 8,
  agentType?: 'guestCoordinator' | 'screeningAI'
): Promise<Array<{ content: string; category: string; similarity: number; sourceKey: string; propertyId: string | null }>> {
  
  // For guestCoordinator: use KNN classifier for SOPs + pgvector for property chunks
  if (agentType === 'guestCoordinator' && isClassifierInitialized()) {
    const classifierResult = await classifyMessage(query);
    const sopChunks = classifierResult.labels.map(label => ({
      content: getSopContent(label),  // from in-memory map
      category: label,
      similarity: 1.0,  // classifier confidence
      sourceKey: label,
      propertyId: null,
    })).filter(c => c.content);

    // Also get property-specific chunks via pgvector (property-info, property-description, property-amenities, learned-answers)
    const propertyChunks = await retrievePropertyChunks(tenantId, propertyId, query, prisma, 3);
    
    return [...sopChunks, ...propertyChunks];
  }

  // For screeningAI or when classifier not available: use existing pgvector path
  // ... existing code unchanged ...
}
```

### Modify 2: `backend/src/services/ai.service.ts`

**Changes:**
1. Import baked-in SOPs: `import { BAKED_IN_SOPS_TEXT } from '../config/baked-in-sops'`
2. In `generateAndSendAiReply()`, append baked-in SOPs to the system prompt for guestCoordinator:
   ```typescript
   let effectiveSystemPrompt = personaCfg.systemPrompt;
   if (!isInquiry) {
     // Bake scheduling, house-rules, escalation-immediate, escalation-scheduled into prompt
     effectiveSystemPrompt += '\n\n' + BAKED_IN_SOPS_TEXT;
   }
   ```
3. Add classifier metadata to ragContext logging

### Modify 3: `backend/src/server.ts`

**Changes:**
1. Import: `import { initializeClassifier } from './services/classifier.service'`
2. In the startup background task (after `seedTenantSops`), call `initializeClassifier()`

### Modify 4: `backend/src/routes/knowledge.ts`

**Changes:**
Add 2 new endpoints:
1. `GET /api/knowledge/classifier-status` — returns `{ initialized, exampleCount, lastInitMs }`
2. `POST /api/knowledge/test-classify` — accepts `{ message: string }`, returns classifier result

## What NOT to Modify

- ❌ `frontend/` — no frontend changes in this branch
- ❌ Database schema — no migrations needed
- ❌ `screeningAI` path in `retrieveRelevantKnowledge()` — completely unchanged
- ❌ `buildPropertyInfo()` — the chunks array format is the same
- ❌ `ai-config.json` — no config changes
- ❌ `embeddings.service.ts` — use it as-is for classifier initialization
- ❌ The `SOP_CHUNKS` array in `rag.service.ts` — keep it for DB storage/admin viewing, just don't use pgvector for guestCoordinator SOP retrieval

## Execution Order

1. Create `backend/src/services/classifier-data.ts`
2. Create `backend/src/config/baked-in-sops.ts`
3. Create `backend/src/services/classifier.service.ts`
4. Modify `backend/src/services/rag.service.ts`
5. Modify `backend/src/services/ai.service.ts`
6. Modify `backend/src/server.ts`
7. Modify `backend/src/routes/knowledge.ts`
8. Run `npm run build` — fix all TypeScript errors
9. Commit and push

## Verification

After deployment:
```bash
# Check classifier initialized
curl -H "Authorization: Bearer $TOKEN" https://your-backend/api/knowledge/classifier-status

# Test classification
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"message": "Can we get cleaning today?"}' \
  https://your-backend/api/knowledge/test-classify

# Expected: { "labels": ["sop-cleaning"], "method": "knn_vote", ... }

# Test contextual message (should return empty)
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"message": "Ok thanks"}' \
  https://your-backend/api/knowledge/test-classify

# Expected: { "labels": [], "method": "contextual_match", ... }
```

## Graceful Degradation

| Scenario | Behavior |
|----------|----------|
| OPENAI_API_KEY missing | Classifier can't embed examples → stays uninitialized → falls through to pgvector |
| Classifier init fails | Logs warning → guestCoordinator uses pgvector fallback (existing behavior) |
| Classifier returns empty for a real question | Property chunks from pgvector still get returned |
| pgvector unavailable | Classifier still returns SOP chunks from memory → partial context |

## Success Criteria

- [ ] `npm run build` passes with zero errors
- [ ] Classifier initializes on startup (log: `[Classifier] Initialized: 164 examples, Xms`)
- [ ] `GET /api/knowledge/classifier-status` returns `{ initialized: true, exampleCount: 164 }`
- [ ] `POST /api/knowledge/test-classify` with `"Can we get cleaning?"` returns `["sop-cleaning"]`
- [ ] `POST /api/knowledge/test-classify` with `"Ok thanks"` returns `[]`
- [ ] Guest messages in production get 0-3 SOP chunks (not 8)
- [ ] screeningAI conversations are completely unaffected
- [ ] No cross-tenant data leaks
- [ ] AI Logs page shows classifier method in ragContext
