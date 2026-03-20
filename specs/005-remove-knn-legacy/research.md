# Research: Remove KNN Legacy & Complete LR Migration

**Branch**: `005-remove-knn-legacy`
**Date**: 2026-03-19

---

## Finding 1: Two Decision Paths Use Wrong Metric (Bug)

**Decision**: Fix `rag.service.ts` and `knowledge.controller.ts` to use LR `confidence` instead of KNN `topSimilarity`.

**Rationale**: Full codebase audit found two places where KNN cosine similarity drives decisions that should use LR sigmoid confidence:

1. **rag.service.ts line ~501**: `topSimilarity` (KNN) determines the backward-compat `tier` field. Should use `classifierResult.confidence` (LR).
2. **knowledge.controller.ts line ~478**: Operator reinforcement threshold compares `classifierTopSim < 0.40` (KNN). Should compare LR confidence from the ragContext.

Both produce wrong behavior when LR and KNN diverge — e.g., LR says HIGH (0.92) but KNN says LOW (0.47), causing unnecessary Tier 2 fallback or missed reinforcement opportunities.

**Alternatives considered**: None — these are bugs, not design choices.

---

## Finding 2: 11 Files Need Comment/Label Updates

**Decision**: Update comments, labels, defaults, and OPUS report text in 11 files across backend and frontend.

**Rationale**: The audit found KNN referenced as the "primary" or "active" engine in comments, UI labels, and log messages despite LR being the sole decision-maker since 003-ai-engine-fix. Full list:

| File | What to change |
|------|---------------|
| `classifier.service.ts` lines 1-12 | File header: "KNN-3 Embedding Classifier" → "LR Sigmoid Classifier" |
| `rerank.service.ts` line 2, 9 | Remove claim that rerank is used in KNN path |
| `rag.service.ts` line 347 | Comment: "use KNN classifier" → "use LR classifier" |
| `opus.service.ts` lines 264-283 | Audit report headers: "KNN Embedding Classifier" → "LR Embedding Classifier" |
| `knowledge.ts` line 31 | Route comment: "(KNN + LR)" → "(LR primary)" |
| `knowledge.controller.ts` line 372 | Comment: "reinit of the KNN classifier" → "reinit of the LR classifier" |
| `ai-pipeline-v5.tsx` line 1420 | Default engine type: `'knn'` → `'lr'` |
| `ai-pipeline-v5.tsx` line 1434 | Fallback comment: "keep default knn" → "keep default lr" |
| `ai-pipeline-v5.tsx` line 2104-2106 | Label: "Tier 1: KNN" → "Tier 1: LR" |
| `ai-pipeline-v5.tsx` line 833 | Comment update |
| `classifier-v5.tsx` | No changes needed — already handles both types correctly |

**Alternatives considered**: Remove KNN diagnostic entirely — rejected per spec (kept for observability in pipeline display).

---

## Finding 3: Centroid-Based Semantic Topic Switch Detection

**Decision**: Add cosine distance check between current message embedding and active topic centroid in `topic-state.service.ts`. Threshold configurable via `topic_state_config.json`.

**Rationale**: Current keyword-only detection misses silent topic changes. The trained LR model already computes and stores per-category centroids in `classifier-weights.json`. The topic state cache can access these centroids (already loaded in classifier state) and compare the current message's embedding to the active topic's centroid to detect topic switches without keywords.

**Design**:
- When `getReinjectedLabels()` is called and no keyword switch is detected, compute cosine similarity between the message embedding and the active topic's centroid
- If similarity < threshold (default 0.60) → topic switch detected → clear cache, classify fresh
- If similarity >= threshold → genuinely same topic → re-inject as before
- Requires the message embedding to be passed to `getReinjectedLabels()` (new parameter)
- Falls back to keyword-only when centroids unavailable (no trained model)

**Threshold choice**: 0.60 cosine similarity. Reasoning:
- Higher than 0.70 would be too aggressive — catches too many false switches
- Lower than 0.50 would miss real switches — too permissive
- 0.60 is a conservative starting point; tunable via `topic_state_config.json` → `centroid_switch_threshold`
- Categories with < 3 training examples skip centroid check (centroid unreliable)

**Alternatives considered**:
- Embedding distance to ALL centroids (pick closest) — more complex, higher latency, not needed for switch detection
- LLM-based switch detection — too expensive ($0.0001/call on every contextual message)
- No centroid feature — rejected; user explicitly requested it

---

## Finding 4: No New Dependencies Required

**Decision**: All changes use existing code and data structures.

**Rationale**:
- Centroids already in `classifier-weights.json` and loaded into `_state.centroids` at startup
- `cosineSimilarity()` helper already exists in `classifier.service.ts`
- `topic_state_config.json` already exists for topic state configuration
- No new packages, no schema changes, no migration needed
