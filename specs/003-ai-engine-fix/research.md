# Research: AI Engine Comprehensive Fix

**Date**: 2026-03-19
**Feature**: 003-ai-engine-fix

## R1: Classification Method — LR on Cohere Embeddings

**Decision**: Replace KNN-3 majority voting with logistic regression
trained on Cohere embeddings. Inference is matrix multiply + softmax
in TypeScript (~10 lines). Training runs via Python child process
(sklearn) on Railway.

**Rationale**: Three research reports converge:
- KNN-3 with triple filter (vote + agreement + threshold) rejects 90%
- Centroids eliminate density bias but can't learn decision boundaries
- LR learns actual boundaries, handles overlapping classes
- Cohere API (25ms) beats local models on Railway (100-300ms) for
  Arabic and English
- SetFit doesn't transfer across embedding spaces

**Implementation**:
- Embed all ~450 training examples with Cohere
  `input_type="classification"`
- Train sklearn `LogisticRegression` on embeddings
- Export `coef_` (shape: [20, 1024]), `intercept_` (shape: [20]),
  `classes_` as JSON
- TypeScript inference: `scores = coef * embedding + intercept`,
  then softmax for confidence

**Alternatives rejected**:
- Pure centroid: simpler but can't learn non-spherical boundaries
- SetFit: requires local model, embedding spaces don't transfer
- Local ONNX: slower on Railway CPU, worse Arabic, 20x more expensive

---

## R2: Threshold Calibration

**Decision**: Leave-one-out cross-validation on training data to
determine rejection threshold and per-category thresholds.

**Rationale**: The current 0.30 cosine threshold was set by intuition.
Research shows thresholds are model-specific and must be calibrated
empirically. Per-category thresholds (mean - 2*std) handle varying
topic "spread."

**Implementation**:
- For each example: classify with remaining 449, record confidence
- Compute overall threshold at precision >= 85%
- Compute per-category thresholds at mean - 2*std of within-class
  softmax scores
- Store thresholds alongside LR weights in the JSON file

---

## R3: Topic Switch via Centroid Distance

**Decision**: Use cosine similarity between message embedding and
cached topic centroid as primary switch signal. Keep keyword list
as secondary fast-path.

**Rationale**: Research 1 shows embedding distance to topic centroid
is the strongest single signal for implicit switches. Available at
zero cost since centroids are already computed for the training data.
Per-topic thresholds (mean - 2*std) handle varying topic spread.

**Implementation**:
- Compute centroids (mean embedding per category) during training
- On Tier 3 check: compute similarity to cached topic centroid
- If below per-topic threshold → topic switch detected
- Combine with keyword list: keyword OR centroid mismatch → switch

---

## R4: Training Data Rebalancing

**Decision**: Cap majority categories, boost minorities to 10-15 via
LLM paraphrase augmentation in English and Arabic.

**Rationale**: Research shows:
- 5 examples: 63-84% accuracy
- 10 examples: +5-8% improvement
- 15 examples: +2-3% marginal gain
- 20+: diminishing returns
Cap non-actionable at 25, contextual at 20 (square-root rule).

**Implementation**:
- Identify examples furthest from centroid → deactivate (not delete)
- Generate paraphrases via Claude Haiku for under-represented
  categories
- Include Arabic translations of all English examples
- Target: every category has 10-15 examples, Arabic at 40%+

---

## R5: Multi-Slot Topic Cache

**Decision**: Replace single-slot 30-min TTL cache with 3-slot
confidence-decay cache.

**Rationale**: Research 1 recommends exponential decay (half-life
10 min) with 3 slots. Guests naturally bounce between topics.
Returning to a previous topic should be recognized, not treated as
a new classification.

---

## R6: Python on Railway

**Decision**: Add Python 3 + sklearn to the Railway Docker image
for LR training. Python runs only during retrain (on demand), never
per-request.

**Rationale**: Clarification session confirmed this approach.
Retraining triggers on demand (operator button) or after batch
operations. Python + sklearn adds ~50MB to Docker image.

---

## R7: Three-Tier Confidence Routing

**Decision**: Route messages through three tiers based on LR softmax
confidence. High → inject 1 SOP. Medium → inject top 3 SOPs for
Claude to pick. Low → fire intent extractor (existing Tier 2) then
inject matched SOPs.

**Rationale**: Research 4 (architecture validation) showed that
confidence-based cascading raises accuracy from ~90% to 92-96% at
minimal cost increase (~$0.0024/message average). Google Speculative
Cascades, Amazon Bedrock routing, and Voiceflow all use this pattern.

**Key insight**: The low-confidence tier uses the EXISTING intent
extractor (Haiku call) rather than injecting all 20 SOPs. This
avoids information overload in the prompt and reuses proven
infrastructure. The intent extractor returns specific SOP labels,
which are then injected normally.

**Alternatives rejected**:
- Binary routing (old approach): loses medium-confidence accuracy
- Inject all 20 SOPs for low confidence: ~3,500 tokens of procedural
  text creates information overload for the LLM
- Tool-use (let Claude pick SOP): 2x latency, 2x cost, no confidence

---

## R8: Deployment Strategy

**Decision**: Deploy as a separate Railway service (`backend-new-ai`)
sharing the same Postgres + Redis as `backend-advanced-ai`. Deploy
from `003-ai-engine-fix` branch. One shared frontend auto-adapts via
`/classifier-status` engine type.

**Rationale**: This is a fundamental classifier replacement — too
risky for in-place deployment. Separate service enables:
- A/B testing with test tenants
- Rollback = just repoint webhook URL
- Old service stays live for production tenants
- Merge into advanced-ai-v7 when proven

**DB compatibility**: Confirmed safe. No new tables or columns.
LR weights are file-based. Both services read/write the same tables.
The ragContext JSON field in AiApiLog stores engine-specific data
(LR confidence vs KNN similarity) — frontend handles both formats.
Retraining triggers on operator "Retrain" button or after batch
operations (gap analysis, bulk approve). Python + sklearn adds ~50MB
to the Docker image but doesn't affect Node.js startup or runtime.
