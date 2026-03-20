# Research: Similarity Boost + Description-Enhanced Classification

**Date**: 2026-03-20 | **Branch**: `009-similarity-boost`

## R1: Cohere Model Version

**Question**: Spec references `embed-multilingual-v3.0` but codebase uses `embed-v4.0`. Which is correct?

**Decision**: Use `embed-v4.0` (current codebase).

**Rationale**: `embed-v4.0` is the newer model that supersedes `embed-multilingual-v3.0`. It retains full multilingual support (100+ languages including Arabic) and outputs 1024-dim vectors via `outputDimension: 1024`. The codebase already uses it everywhere (`embeddings.service.ts:122,148`). No migration needed.

**Alternatives considered**: Downgrading to v3.0 for spec consistency — rejected because v4.0 is strictly better and already deployed.

## R2: Cohere `input_type` Parameter

**Question**: Does `input_type="classification"` work for both descriptions and messages in `embed-v4.0`?

**Decision**: Use `input_type="classification"` for ALL texts (descriptions + messages).

**Rationale**: Per Cohere's cookbook and the spec (FR-022), `classification` produces a symmetric embedding space optimized for in-class comparison. The codebase already uses `'classification'` for all classifier embeddings (`classifier.service.ts:234,414`). The `embedText()` and `embedBatch()` functions accept an `inputType` parameter (`embeddings.service.ts:173,198`).

**Alternatives considered**: Using `search_document` for descriptions and `search_query` for messages — rejected because this is asymmetric search mode, not classification.

## R3: Description File Location

**Question**: Where should `sop_descriptions.json` live? `backend/src/config/` or `backend/config/`?

**Decision**: `backend/src/config/sop_descriptions.json`.

**Rationale**: FR-012a specifies `backend/src/config/`. While `topic_state_config.json` lives in `backend/config/`, the classifier-related config files (`classifier-data.ts`, `classifier-weights.json`) live in `backend/src/config/`. Since descriptions are classifier config, `src/config/` is the correct location. The Python training script is invoked from `knowledge.controller.ts` and receives data via stdin, so file path doesn't affect training.

**Alternatives considered**: `backend/config/` for consistency with `topic_state_config.json` — rejected because classifier config files cluster in `src/config/`.

## R4: Augmented Feature Vector Dimensions

**Question**: What exactly is N in the 1024+N augmented vector?

**Decision**: N = 20. Augmented vector = 1044 dimensions.

**Rationale**: 22 total categories minus `non-actionable` minus `contextual` = 20 categories with descriptions. For multi-prototype categories (broad with 3 EN + 3 AR variants), we take max similarity per category, collapsing to exactly 1 value per category. So the feature vector is always 20-dim regardless of how many descriptions exist per category.

**Categories with descriptions (20)**:
1. sop-cleaning
2. sop-amenity-request (broad: 3+3)
3. sop-maintenance
4. sop-wifi-doorcode
5. sop-visitor-policy
6. sop-early-checkin
7. sop-late-checkout
8. sop-complaint (broad: 3+3)
9. sop-booking-inquiry (broad: 3+3)
10. pricing-negotiation (broad: 3+3)
11. pre-arrival-logistics
12. sop-booking-modification
13. sop-booking-confirmation
14. payment-issues
15. post-stay-issues (broad: 3+3)
16. sop-long-term-rental
17. sop-booking-cancellation
18. sop-property-viewing
19. property-info
20. property-description

**Broad categories (5)**: 3 EN + 3 AR = 30 descriptions
**Narrow categories (15)**: 1 EN + 1 AR = 30 descriptions
**Total descriptions**: 60

## R5: Dimension Detection Strategy

**Question**: How to detect old vs augmented weights at load time?

**Decision**: Check `coefficients[0].length` against expected augmented dimension.

**Rationale**: Current LR weights have `coefficients[0].length === 1024` (one weight per embedding dimension per class). After retraining with description features, it becomes 1044. At `loadLrWeightsMetadata()` (classifier.service.ts:147), we can check this dimension:
- If 1024 → old weights, disable description features, use plain embedding
- If 1044 → augmented weights, enable description features
- Any other value → log error, fall back to plain LR

The category order in the 20-dim feature vector must be deterministic. Use alphabetical sort of category names as the canonical ordering, stored in the weights JSON alongside coefficients.

**Alternatives considered**: Version field in weights JSON — rejected as unnecessary when dimension itself is the signal. But we WILL add a `featureSchema` field documenting the category order for safety.

## R6: KNN Boost Interaction with Judge

**Question**: Should the judge evaluate messages where boost overrides LR?

**Decision**: No change needed — existing judge skip logic covers boost cases.

**Rationale**: The judge already skips evaluation when `topSimilarity >= judgeThreshold` AND majority neighbor agreement (constitution §VII). These are exactly the same conditions that trigger the boost (sim ≥ 0.80 + 3/3 agree). So boosted messages are already skipped by the judge. No new logic needed.

## R7: Description Similarity Computation Cost

**Question**: What's the per-message cost of computing description similarities?

**Decision**: Negligible — ~20µs per message. No performance concern.

**Rationale**: Computing cosine similarity between a 1024-dim query vector and 60 description embeddings = 60 dot products. Each dot product is ~1024 multiply-adds. Total: ~61K float operations. On modern CPUs at ~10 GFLOPS, this is ~6µs. With max-per-category reduction (60 → 20 values), total overhead is ~20µs. The existing KNN diagnostic already does 164 dot products (~100µs) so this is faster.

## R8: Existing `cosineSimilarity()` Function

**Question**: Can we reuse the existing cosine similarity implementation?

**Decision**: Yes. Reuse `cosineSimilarity()` from `classifier.service.ts:529-543`.

**Rationale**: Already exported, handles dimension validation, uses epsilon for numerical stability. Used by KNN diagnostic, judge validation, and topic-state service. No need for a new implementation.

## R9: Training Script Invocation Changes

**Question**: How does the training script get description data?

**Decision**: Pass descriptions via stdin JSON alongside examples and API key.

**Rationale**: The training script (`backend/scripts/train_classifier.py`) reads from stdin:
```json
{ "examples": [...], "cohereApiKey": "..." }
```
We extend this to:
```json
{ "examples": [...], "cohereApiKey": "...", "descriptions": {...} }
```
The controller (`knowledge.controller.ts`) already reads and pipes data to the script. It will additionally read `sop_descriptions.json` and include it. No file path dependencies in the Python script.

## R10: Backward Compatibility of ragContext

**Question**: Do new ragContext fields break existing frontend code?

**Decision**: No — new fields are additive. Frontend uses optional chaining.

**Rationale**: The frontend (`ai-pipeline-v5.tsx`) accesses ragContext fields via optional chaining (`p.classifierTopSim ?? null`). New fields (`boostApplied`, `topDescriptionMatches`, etc.) are simply not present in old log entries. The frontend will show them when present, ignore when absent. No migration needed for existing AiApiLog records.
