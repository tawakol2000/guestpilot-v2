# Implementation Plan: Similarity Boost + Description-Enhanced Classification

**Branch**: `009-similarity-boost` | **Date**: 2026-03-20 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/009-similarity-boost/spec.md`

## Summary

Enhance the LR classifier with three independent improvements: (1) KNN Similarity Boost — override LR when KNN finds a near-exact training match (sim ≥ 0.80, 3/3 neighbors agree), (2) Description-Enhanced LR — embed rich SOP descriptions and feed per-category cosine similarities as additional LR features (1024+20 dims), requiring one retrain, and (3) Hard cap (3 labels) + gap filter (10%) to eliminate label floods. Rename all "KNN" references to "Similarity Boost" across codebase.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+ (backend), Python 3 (training script), Next.js 16 + React 19 (frontend)
**Primary Dependencies**: Express 4.x, Prisma ORM, Cohere SDK (`cohere-ai@^7.20.0`), Anthropic SDK, scikit-learn + numpy (Python)
**Storage**: PostgreSQL + pgvector + Prisma ORM + file-based `classifier-weights.json`
**Testing**: Manual acceptance testing via pipeline display + `/api/ai-config/test` endpoint. No automated test suite.
**Target Platform**: Railway (backend), Vercel (frontend)
**Project Type**: Multi-tenant web service (SaaS)
**Performance Goals**: <1ms LR inference (current), ~100µs KNN diagnostic (current), <1ms description similarity computation (20 dot products on 1024-dim vectors)
**Constraints**: Graceful degradation (constitution §I), multi-tenant isolation (§II), <$0.007/message AI cost
**Scale/Scope**: 164 training examples, 22 SOP categories (20 with descriptions), ~60 descriptions total, 1024-dim Cohere embeddings

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Justification |
|-----------|--------|---------------|
| §I Graceful Degradation (NON-NEG) | **PASS** | FR-012b: dimension mismatch → fall back to plain 1024-dim LR. Uninitialized classifier → plain LR. Description embedding failure at startup → plain LR. KNN boost is additive (only increases confidence). Hard cap/gap filter are pure output post-processing. |
| §II Multi-Tenant Isolation (NON-NEG) | **PASS** | SOP descriptions are global (shared across tenants) — covered by existing carve-out: "classifier training examples are shared globally." Per-tenant SOP *content* retrieved at response time is unchanged. |
| §III Guest Safety (NON-NEG) | **PASS** | No changes to access code gating, financial restrictions, or Omar persona. Classifier changes affect SOP routing only, not response content. |
| §IV Structured AI Output | **PASS** | No changes to AI output schema or parsing. |
| §V Escalate When In Doubt | **PASS** | Boost increases confidence for near-exact matches → fewer false LOW tiers → fewer unnecessary Tier 2 calls. No escalation triggers removed. Hard cap reduces label noise → cleaner escalation signal. |
| §VI Observability by Default | **PASS** | FR-016 adds ragContext fields (boostApplied, topDescriptionMatches). FR-017/018 enhance pipeline display. FR-015 adds cross-class diagnostic. |
| §VII Self-Improvement with Guardrails | **PASS** | Judge already skips evaluation when topSimilarity ≥ judgeThreshold + majority agreement — same cases where boost fires. No change to auto-fix rate limits or similarity validation. |

**Result: All 7 gates PASS. No violations. No complexity tracking needed.**

**Post-Phase 1 Re-check:** All gates still pass. Description features degrade gracefully (dimension fallback). No new hard dependencies introduced.

## Project Structure

### Documentation (this feature)

```text
specs/009-similarity-boost/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0: research findings
├── data-model.md        # Phase 1: data model changes
├── quickstart.md        # Phase 1: development quickstart
├── contracts/
│   └── pipeline-feed.md # Phase 1: updated API contract
└── tasks.md             # Phase 2 output (created by /speckit.tasks)
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── config/
│   │   └── sop_descriptions.json       # NEW: 60 SOP descriptions (EN + AR)
│   ├── services/
│   │   ├── classifier.service.ts       # MODIFY: boost logic, desc features, cap/gap, rename
│   │   ├── rag.service.ts              # MODIFY: update ragContext fields
│   │   └── ai.service.ts              # MODIFY: update ragContext construction
│   ├── controllers/
│   │   └── knowledge.controller.ts     # MODIFY: add diagnostic endpoint
│   └── routes/
│       └── ai-pipeline.ts             # MODIFY: add boost/desc data to feed
├── config/
│   └── topic_state_config.json         # MODIFY: add boost/gap/cap thresholds
├── scripts/
│   └── train_classifier.py             # MODIFY: augmented feature training
└── prisma/
    └── schema.prisma                   # NO CHANGE (weights JSON field is flexible)

frontend/
└── components/
    └── ai-pipeline-v5.tsx              # MODIFY: rename + show boost/description data
```

**Structure Decision**: Web application (Option 2). Follows existing `backend/` + `frontend/` separation. No new directories created — all changes are modifications to existing files plus one new JSON config file.

## Implementation Phases

### Phase A: Foundation — Config + Types (no runtime changes)

**Goal**: Create the description data file, add config thresholds, and update TypeScript interfaces. No behavioral changes yet — safe to merge incrementally.

**Files touched**:
- `backend/src/config/sop_descriptions.json` (NEW)
- `backend/config/topic_state_config.json` (MODIFY)
- `backend/src/services/classifier.service.ts` (MODIFY — types only)

**Tasks**:
1. Create `sop_descriptions.json` with all 60 descriptions (20 categories × EN/AR, broad categories get 3 variants each). Structure:
   ```json
   {
     "categories": {
       "sop-amenity-request": {
         "broad": true,
         "descriptions": {
           "en": ["paragraph 1", "paragraph 2", "paragraph 3"],
           "ar": ["paragraph 1", "paragraph 2", "paragraph 3"]
         }
       },
       "sop-wifi-doorcode": {
         "broad": false,
         "descriptions": {
           "en": ["paragraph 1"],
           "ar": ["paragraph 1"]
         }
       }
     }
   }
   ```
2. Add thresholds to `topic_state_config.json` under `global_settings`:
   - `boost_similarity_threshold`: 0.80
   - `boost_min_agreement`: 3 (all K neighbors)
   - `lr_hard_cap`: 3
   - `lr_gap_filter`: 0.10
3. Update `ClassificationResult` interface:
   - Rename `knnDiagnostic` → `similarityBoost`
   - Add fields: `boostApplied: boolean`, `boostSimilarity: number`, `boostLabels: string[]`, `originalLrConfidence: number`, `originalLrLabels: string[]`, `topDescriptionMatches: Array<{label: string, similarity: number}>`
   - Add `descriptionFeaturesActive: boolean` flag

### Phase B: Backend Core — Similarity Boost + Hard Cap (independent of descriptions)

**Goal**: Implement the KNN boost override and hard cap/gap filter. These work without description features and deliver immediate value.

**Files touched**:
- `backend/src/services/classifier.service.ts` (MODIFY)
- `backend/src/services/ai.service.ts` (MODIFY)

**Tasks**:
4. In `classifyMessage()` (line ~432), after KNN diagnostic runs:
   - Check: `topSimilarity ≥ boost_threshold` AND all 3 neighbors share same primary label
   - If YES: override LR labels with KNN label, set confidence = topSimilarity, method = `lr_boost`, tier = compute from boosted confidence
   - If NO: keep LR result unchanged
5. After LR scoring (line ~429 in `classifyWithLR()`):
   - Sort labels by confidence descending
   - Apply gap filter: keep only labels within `lr_gap_filter` (0.10) of top score
   - Apply hard cap: keep at most `lr_hard_cap` (3) labels
6. Update ragContext construction in `ai.service.ts` (line ~1488):
   - Add: `boostApplied`, `boostSimilarity`, `boostLabels`, `originalLrConfidence`

### Phase C: Backend Core — Description-Enhanced LR Features

**Goal**: Load SOP descriptions at startup, embed them, compute per-category similarity features at classification time, and handle dimension fallback.

**Files touched**:
- `backend/src/services/classifier.service.ts` (MODIFY)
- `backend/src/services/embeddings.service.ts` (NO CHANGE — already supports batch + input_type)

**Tasks**:
7. At startup in `initializeClassifier()` (line ~219):
   - Load `sop_descriptions.json`
   - Embed all descriptions via `embedBatch(texts, 'classification')` — ~60 texts, one Cohere API call
   - Store in `_state.descriptionEmbeddings: Map<string, number[][]>` (category → array of embeddings)
   - Compute max similarity per category as a precomputed structure
   - If embedding fails (Cohere down), log warning and continue without description features
8. In `classifyMessage()`, after embedding the query (line ~414):
   - Compute cosine similarity between queryEmbedding and all description embeddings
   - For multi-prototype categories: take max similarity → produces 20-dim feature vector
   - Populate `topDescriptionMatches` (top 3 by similarity) for ragContext
9. Implement dimension detection (FR-012b):
   - At `loadLrWeightsMetadata()` (line ~147): check `coefficients[0].length`
   - If `== 1024`: old weights → set `descriptionFeaturesActive = false`, use plain embedding for LR
   - If `== 1044` (1024 + 20): augmented weights → set `descriptionFeaturesActive = true`, concatenate description features
   - Log warning if mismatch detected
10. When `descriptionFeaturesActive`:
    - Concatenate `[queryEmbedding (1024), descriptionSimilarities (20)]` → 1044-dim vector
    - Feed to `classifyWithLR()` (this function already does `dot(coef, embedding)` — works with any dimension matching weights)

### Phase D: Training Script Update

**Goal**: Update the Python training script to compute augmented feature vectors and train the LR on 1044-dim input.

**Files touched**:
- `backend/scripts/train_classifier.py` (MODIFY)

**Tasks**:
11. Update stdin JSON input to accept `descriptions` field:
    ```json
    {
      "examples": [...],
      "cohereApiKey": "...",
      "descriptions": { "sop-amenity-request": { "en": [...], "ar": [...] }, ... }
    }
    ```
12. Embed all descriptions using Cohere (same `input_type="classification"`)
13. For each training example embedding:
    - Compute cosine similarity against all description embeddings
    - Take max per category → 20-dim feature vector
    - Concatenate: `[original_1024_embedding, 20_desc_similarities]` → 1044-dim
14. Train OneVsRestClassifier(LogisticRegression) on augmented 1044-dim vectors
15. Output augmented weights (coefficients now 1044-wide) + description embeddings in JSON
16. Update `knowledge.controller.ts` to pass descriptions when invoking training script
17. Store description embeddings in `ClassifierWeights.weights` JSON alongside coefficients

### Phase E: Rename KNN → Similarity Boost

**Goal**: Replace all "KNN", "knn", "Embedding Diagnostic" references with "Similarity Boost" terminology.

**Files touched**:
- `backend/src/services/classifier.service.ts` (MODIFY)
- `backend/src/services/rag.service.ts` (MODIFY)
- `backend/src/services/ai.service.ts` (MODIFY)
- `backend/src/routes/ai-pipeline.ts` (MODIFY)
- `frontend/components/ai-pipeline-v5.tsx` (MODIFY)

**Tasks**:
18. Backend renames:
    - `knnDiagnostic` → `similarityBoost` in ClassificationResult (from Phase A types)
    - `knn_vote` method string → `similarity_boost` (or remove — boost uses `lr_boost`)
    - `runKnnDiagnostic()` → `runSimilarityDiagnostic()` (function name)
    - All log messages referencing "KNN"
    - `_lastClassifierResult` fields in rag.service.ts
19. Frontend renames:
    - "Embedding Diagnostic" label (line ~957) → "Similarity Boost"
    - Any `classifierTopSim` display labels
    - PipelineFeedEntry interface field names (if renamed in backend)

### Phase F: Frontend Pipeline Display Enhancement

**Goal**: Show boost decision and description match scores in the pipeline visualization.

**Files touched**:
- `frontend/components/ai-pipeline-v5.tsx` (MODIFY)

**Tasks**:
20. Update the "Similarity Boost" section (formerly "Embedding Diagnostic") to show:
    - When boost applied: boost similarity, neighbor agreement (3/3), original LR confidence, boosted confidence, tier change
    - When not applied: neighbor similarity, agreement count, "no boost — below threshold"
21. Add "Description Matches" subsection:
    - Top 3 description similarities with category labels
    - Whether description features are active (`descriptionFeaturesActive`)
22. Update collapsed row to show boost badge when `boostApplied: true`

### Phase G: Diagnostic Endpoint

**Goal**: Add cross-class description similarity matrix as an admin diagnostic.

**Files touched**:
- `backend/src/controllers/knowledge.controller.ts` (MODIFY)
- `backend/src/routes/` (MODIFY — add route)

**Tasks**:
23. Add `GET /api/classifier/description-matrix` endpoint:
    - Compute cosine similarity between all pairs of description embeddings
    - Return matrix with flags for pairs > 0.70
    - Requires classifier to be initialized with descriptions

## Phase Dependencies

```text
Phase A ──→ Phase B (boost needs types + config)
Phase A ──→ Phase C (desc features need types + descriptions file)
Phase C ──→ Phase D (training script needs description embedding logic to mirror)
Phase A ──→ Phase E (rename needs updated types)
Phase B + C + E ──→ Phase F (frontend needs all backend data)
Phase C ──→ Phase G (diagnostic needs description embeddings loaded)
```

**Independent parallelism**: Phases B and C are independent after Phase A. Phase E can be done any time after A. Phase G is independent after C.

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Description embeddings too similar (>0.70 cross-class) | Medium | High — misclassification | FR-015 diagnostic matrix. Review before deploy. Rewrite descriptions iteratively. |
| LR accuracy regression with augmented features | Low | Medium | Ship boost + cap independently (clarification answer). Disable descriptions via dimension fallback. |
| Cohere API down at startup | Low | Low | Graceful fallback to plain LR. Cached description embeddings in ClassifierWeights DB. |
| 60 descriptions exceed Cohere batch limit | None | None | Cohere batch size = 96. 60 < 96. Single API call. |
| Training script timeout with augmented features | Low | Low | Current timeout is 10min. Augmented training adds ~60 cosine similarity computations per example — negligible. |

## Artifact References

- **Research**: [research.md](research.md) — Phase 0 findings
- **Data Model**: [data-model.md](data-model.md) — interface + schema changes
- **Contracts**: [contracts/pipeline-feed.md](contracts/pipeline-feed.md) — updated API response
- **Quickstart**: [quickstart.md](quickstart.md) — development setup guide
