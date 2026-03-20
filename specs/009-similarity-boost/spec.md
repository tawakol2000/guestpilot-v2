# Feature Specification: Similarity Boost + Description-Enhanced Classification

**Feature Branch**: `009-similarity-boost`
**Created**: 2026-03-20
**Updated**: 2026-03-20 (post-research rewrite)
**Status**: Draft
**Input**: Enhance classification accuracy using KNN top-3 similarity boost, SOP description embeddings as LR features, hard cap + gap filter, and bilingual prototypes. Rename KNN diagnostic to Similarity Boost across codebase.

## Clarifications

### Session 2026-03-20

- Q: Should the boost threshold (0.80) be configurable per-tenant (DB), config file, or hardcoded? → A: Config file constant (like centroid_switch_threshold in topic_state_config.json). No DB lookup per classification.
- Q: Should SOP description similarities be used as a standalone signal or fed into LR? → A: **Fed into LR as features** (research finding: automatic per-class calibration is significantly more accurate than standalone cosine threshold). Requires retraining LR with augmented feature vector.
- Q: Single sentence or rich paragraph per SOP description? → A: **2-4 sentence natural paragraphs** per category (research: 8-15% accuracy improvement over keyword lists).
- Q: English-only or bilingual? → A: **Dual English + Arabic (MSA) prototypes** per category. Separate embeddings. Cross-lingual gap of 5-15% documented for Arabic. Do NOT concatenate languages in one string.
- Q: Should broad categories get multiple descriptions? → A: Yes. Narrow categories get 1 English + 1 Arabic. Broad categories (complaint, amenity-request, booking-inquiry) get 3 English + 3 Arabic. Use **max similarity** (not average) at classification time.
- Q: How to handle `non-actionable` category? → A: **Via thresholding, not description matching.** Research: describing "everything that doesn't fit" is semantically impossible. If no class exceeds threshold → non-actionable.
- Q: Where should raw SOP description text be stored? → A: **Dedicated JSON config file** in `backend/src/config/` (e.g., `sop_descriptions.json`). Version-controlled, loaded at startup, accessible to both Node.js backend and Python training script without DB access. Matches existing `topic_state_config.json` pattern.
- Q: What if new code deploys before LR is retrained on augmented features? → A: **Detect and fall back gracefully.** At weight load time, check feature dimension. If old weights (1024-dim) detected with new code expecting 1024+N, fall back to plain 1024-dim LR (description features disabled, boost still works). Aligns with critical rule #1: never break the main guest messaging flow.
- Q: What if LR accuracy doesn't improve after retraining with description features? → A: **Ship anyway.** KNN boost + hard cap/gap filter are independent wins. If description features regress accuracy, disable them via the dimension-mismatch fallback (FR-012b) and iterate on description quality. Do not block the entire feature on LR accuracy.

## Problem Statement

The LR classifier scores only 37.7% confidence on "I need a pillow" — even though the EXACT training example exists with label `sop-amenity-request`. This happens because LR is a global linear model that produces weak sigmoid scores for short messages. It also returns 7 labels simultaneously because per-category thresholds are too loose.

**Root cause (from research):** Raw embedding similarity is systematically miscalibrated — scores concentrate in a narrow band. The LR sees only the 1024-dim embedding, with no explicit signal about which SOP category the message resembles semantically. Adding per-category description similarity scores as features gives the LR a direct signal to learn from.

**Three fixes combined:**

1. **KNN Similarity Boost** — the KNN diagnostic already runs on every message (~100µs). When it finds a near-exact match (sim ≥ 0.80, all 3 neighbors agree), override LR with KNN's confident answer. Handles ~40% of messages (exact/near-exact training matches).

2. **Description-Enhanced LR** (NEW — research-driven) — write rich, domain-contextualized descriptions for each SOP category in English + Arabic. Embed them once at startup. At classification time, compute cosine similarity between the message and all description embeddings, producing a feature vector. **Feed this as additional features into the LR** alongside the original 1024-dim embedding. The LR automatically learns per-class weights and biases that calibrate the description similarities. Requires one retrain. Handles novel phrasings, multilingual messages, and categories with sparse training data.

3. **Hard cap + gap filter** — LR never returns more than 3 labels, and only labels within 10 percentage points of the top score survive. Eliminates the 7-label problem.

**The KNN was never actually removed.** A codebase audit found:
- `runKnnDiagnostic()` runs on every classification (~100µs, no API call)
- KNN `neighbors` field is used by the judge to suppress evaluation
- KNN `queryEmbedding` is used by Tier 3 for centroid distance
- KNN `topSimilarity` is stored in ragContext and displayed on frontend
- Comments saying "KNN removed in 005" are incorrect

**Classification cascade (post-research design):**
```
Message → Embed (1024-dim)
  → Compute description similarities (20-dim vector) — ALWAYS, regardless of boost
  → KNN Boost check: sim ≥ 0.80 + 3/3 agree? → YES → 1 SOP, HIGH confidence (method: lr_boost)
  → NO → Concatenate [1024-dim embedding, 20-dim desc sims]
       → Feed to LR → per-category thresholds → gap filter (10pp) → hard cap (3)
       → Tier routing (HIGH / MEDIUM / LOW → Tier 2) (method: lr_desc or lr_sigmoid)
```

**Cascade note:** Description similarities are computed BEFORE the boost check so they are always available for ragContext observability (FR-016), even when boost fires. The boost check runs after description similarity computation but overrides the LR result entirely when triggered.

## Research Findings (from Claude Research paper)

### Key Finding 1: Descriptions as LR Features > Standalone Signal
Raw cosine similarity is miscalibrated — reliable for ranking but NOT for absolute thresholds. Feeding similarity scores as features into the LR allows automatic per-class calibration. A Taylor & Francis study found "statistically significant accuracy increases" across 5 datasets. This is our primary approach.

### Key Finding 2: Natural Sentences > Keyword Lists
Transformer embeddings encode sentences, not bags of words. OpenAI found 87% → 95% accuracy improvement with enriched descriptions. Jina AI found ~30% improvement by rephrasing labels as sentences. The optimal structure is a 2-4 sentence paragraph naming the category, describing defining characteristics, listing example trigger language, and specifying domain context.

### Key Finding 3: Bilingual Dual Prototypes
Cohere embed-multilingual-v3.0 maps 100+ languages into shared space, but a "language gap" means same-language matching scores higher. Arabic drops 5-15% vs English on XNLI. Solution: separate English and Arabic (MSA) descriptions per category. At classification time, compute similarity against ALL prototypes and take max per category. Do NOT concatenate English + Arabic in one string.

### Key Finding 4: Multiple Prototypes for Broad Categories
SemSup (Princeton 2022) showed multiple descriptions per class outperform single descriptions. CHiLS (ICML 2023) confirmed sub-category decomposition improves accuracy. Use 3-5 variants for broad categories (complaint, amenity-request, booking-inquiry), 1 for narrow categories (wifi-doorcode, early-checkin).

### Key Finding 5: Discriminative Descriptions
Biggest failure mode: descriptions so broad they match everything. Avoid "general", "any", "various". Cross-check all description embeddings — any pair with similarity > 0.70 needs rewriting. Negation doesn't work in transformers ("this is NOT a complaint" embeds near complaint). Always describe what a class IS.

### Key Finding 6: Non-Actionable via Thresholding
Don't write a description for "non-actionable" — describing "everything that doesn't fit" is semantically impossible. Route to non-actionable when no class exceeds a similarity threshold.

### Key Finding 7: Cohere input_type
Use `input_type="classification"` for ALL texts (both descriptions and messages) per Cohere's official cookbook. This produces a symmetric embedding space optimized for in-class comparison. Model outputs 1024-dim embeddings with 512-token limit.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Near-Exact Matches Get HIGH Confidence (Priority: P1)

When a guest sends a message that closely matches a training example, the classifier returns HIGH confidence immediately — no need for Tier 2 fallback.

**Why this priority**: Core value. Messages like "I need a pillow", "Can I get cleaning?", "What's the WiFi password?" have exact or near-exact training examples. Currently they score LOW (37-50%) and waste a Tier 2 Haiku call. With the boost, they score HIGH (80-99%) and get routed directly.

**Independent Test**: Send "I need a pillow" → verify Tier 1 shows HIGH confidence (~99%) and `sop-amenity-request` → Tier 2 does NOT fire.

**Acceptance Scenarios**:

1. **Given** "I need a pillow" exists as a training example with label `sop-amenity-request`, **When** a guest sends "I need a pillow", **Then** KNN finds the exact match (sim ~0.99), all 3 neighbors agree → confidence boosted to 0.99 → HIGH tier → single SOP injected, Tier 2 skipped.
2. **Given** "Can I check in early?" exists as a training example, **When** a guest sends "Can I check in early?", **Then** same boost → HIGH confidence → no Tier 2.
3. **Given** a guest sends "My flight might get cancelled and I want a refund" (no near-exact match), **When** KNN top similarity is 0.65 and neighbors disagree, **Then** no boost applied → falls through to description-enhanced LR.

---

### User Story 2 — Description-Enhanced LR Catches Novel Phrasings (Priority: P2)

When a guest uses a phrasing not in training data (including Arabic), the description similarity features give the LR enough signal to classify correctly without Tier 2.

**Why this priority**: KNN boost handles exact matches. But guests in Arabic, guests with novel phrasings, or guests asking about specific items (baby crib, espresso machine) not in training data need this. The description similarity features act as semantic anchors per category inside the LR.

**Independent Test**: Send a message in Arabic about a maintenance issue not in training examples → verify LR classifies correctly as `sop-maintenance` with MEDIUM+ confidence.

**Acceptance Scenarios**:

1. **Given** Arabic description for sop-amenity-request exists, **When** a guest sends "هل يمكنني الحصول على مخدة إضافية؟" (Can I get an extra pillow?), **Then** Arabic description similarity is high → LR feature vector includes this signal → `sop-amenity-request` classified with improved confidence.
2. **Given** no training example mentions "espresso machine", **When** a guest sends "do you have an espresso machine?", **Then** sop-amenity-request description covers appliance/amenity requests → description similarity feature boosts LR toward correct label.
3. **Given** a guest sends "I'm locked out of the apartment", **When** no exact match exists, **Then** sop-wifi-doorcode description covers "lockout, access issues" → LR receives strong description similarity feature → correct classification.

---

### User Story 3 — Hard Cap + Gap Filter Prevents Label Flood (Priority: P3)

The classifier never returns more than 3 labels, and only labels close in score to the top label are returned. No more 7-SOP floods.

**Why this priority**: Even with description-enhanced features, LR output should be reasonable. 7 labels wastes tokens and confuses downstream routing.

**Independent Test**: Send an ambiguous message → verify at most 3 labels returned, all within 10% of the top score.

**Acceptance Scenarios**:

1. **Given** LR returns scores of 38%, 36%, 34%, 32%, 30%, 28%, 27%, **When** gap filter (10%) applies, **Then** only labels ≥ 28% survive: 38%, 36%, 34%, 32%, 30% → hard cap at 3 → final: top 3 labels.
2. **Given** LR returns scores of 90%, 20%, 15%, **When** gap filter applies, **Then** only 90% survives (20% is >10% below) → 1 label returned.

---

### User Story 4 — Rename KNN to Similarity Boost Everywhere (Priority: P4)

All references to "KNN", "KNN diagnostic", "knn_vote", "knn_rerank" across the codebase, frontend, logs, and database are renamed to "Similarity Boost" or removed. The system presents a unified "Description-Enhanced LR + Similarity Boost" model.

**Why this priority**: Current naming is misleading. Comments say "KNN removed" when it wasn't. Frontend shows "Embedding Diagnostic" which doesn't explain what it does.

**Independent Test**: Search entire codebase for "KNN", "knn" — zero results except in historical comments/data. Pipeline display shows "Similarity Boost" not "Embedding Diagnostic".

**Acceptance Scenarios**:

1. **Given** the classifier runs, **When** the method is logged, **Then** it shows `lr_boost` (when KNN boost applied) or `lr_desc` (description-enhanced LR) — never `knn_vote` or `knn_rerank`.
2. **Given** the pipeline display renders, **When** the diagnostic section appears, **Then** it's labeled "Similarity Boost" with top-3 neighbors and whether boost was applied.
3. **Given** ragContext is stored in the database, **When** the boost fires, **Then** ragContext includes `boostApplied: true`, `boostSimilarity: 0.99`, `boostLabels: ['sop-amenity-request']`.

---

### User Story 5 — Pipeline Display Shows Classification Decision (Priority: P5)

The pipeline visualization clearly shows when the Similarity Boost overrode LR, with numeric scores for both KNN boost and description matching.

**Why this priority**: Operators need to see WHY a message was classified — was it KNN boost, or description-enhanced LR, or plain LR?

**Independent Test**: Send a near-exact match → pipeline shows boost info. Send a novel phrasing → pipeline shows top description similarities.

**Acceptance Scenarios**:

1. **Given** KNN boost applied, **When** pipeline renders, **Then** shows: boost similarity, neighbor agreement (3/3), original LR confidence, boosted confidence, tier change.
2. **Given** description-enhanced LR, **When** pipeline renders, **Then** shows: top 3 description match scores, which descriptions matched, final LR confidence.
3. **Given** no boost, **When** pipeline renders, **Then** shows: neighbor similarity, agreement, "no boost — below threshold", and description match scores.

---

### Edge Cases

- What if KNN top similarity is exactly 0.80 (threshold boundary)? Include it — ≥ 0.80 triggers boost.
- What if 2 of 3 neighbors agree but the 3rd has a different label? Require ALL 3 to agree for boost. 2/3 agreement is not enough.
- What if the classifier is not initialized (no embeddings)? No boost, no description features — fall through to plain LR behavior.
- What if the boost would change the tier from LOW to HIGH, skipping Tier 2? This is intended — Tier 2 is expensive and unnecessary when KNN has a near-exact match.
- What if the boosted label differs from LR's top label? Use the boosted (KNN) label — KNN is more reliable for near-exact matches.
- What if SOP descriptions haven't been embedded yet (startup race)? Fall through to plain LR. Descriptions load async at startup.
- What if description similarity matrix shows two categories with > 0.70 similarity? Rewrite descriptions to increase discriminability before deploying.
- What if a guest message is in dialect Arabic (Egyptian, Gulf, Levantine)? MSA descriptions provide best cross-dialect coverage per research. Monitor and add dialect variants if needed.
- What if new code deploys before LR retraining with augmented features? Detect dimension mismatch at weight load time → fall back to plain 1024-dim LR. Description features disabled, KNN boost still works. Warning log emitted.
- What if all LR scores fall below the global threshold after gap filter? Always return the top-1 label. Non-actionable routing is handled downstream by tier logic (LOW tier → Tier 2 intent extraction), not by returning zero labels from the classifier.
- What if descriptions are updated in `sop_descriptions.json` but the LR has not been retrained? The description similarity values will shift relative to what the LR weights were trained on. This causes feature distribution drift. Re-embedding descriptions at startup is safe (no crash), but classification accuracy may degrade. Retraining SHOULD follow any description edit. Log a warning if description file hash differs from the hash stored in weights metadata.
- What if description features are disabled (FR-012b fallback) but boost fires? Method is `lr_boost`. Boost is independent of description features — it only requires KNN neighbors, which always run.
- What if non-actionable routing thresholds need adjustment after description features change the LR score distribution? Non-actionable routing uses existing per-category thresholds (unchanged). The retrained LR produces recalibrated thresholds via cross-validation. No manual threshold adjustment needed.

## Requirements *(mandatory)*

### Functional Requirements

**KNN Similarity Boost**
- **FR-001**: When KNN top-3 neighbors all share a common label AND the highest similarity ≥ 0.80, the classifier MUST boost confidence to the **top-1 neighbor's cosine similarity** (the single highest similarity score, not an average) and use the neighbors' shared label.
- **FR-002**: The boost MUST only apply when all 3 neighbors share at least one common label in their label arrays. For multi-label training examples, "agreement" means the intersection of all 3 neighbors' label sets is non-empty; the boost label is the shared label. 2/3 agreement is NOT sufficient.
- **FR-003**: The classification method field MUST reflect the cascade path taken:
  - `lr_boost` — KNN boost override activated (sim ≥ threshold, 3/3 agree)
  - `lr_desc` — description-enhanced LR (augmented 1044-dim weights active, no boost)
  - `lr_sigmoid` — plain LR (description features disabled via FR-012b fallback, no boost)
  - `embedding_failed` / `classifier_not_initialized` — error states (unchanged)

**Description-Enhanced LR (research-driven)**
- **FR-004**: Each of the 22 SOP categories (excluding `non-actionable` and `contextual`) MUST have at least one English and one Arabic (MSA) description paragraph of 2-4 sentences. Broad categories (sop-complaint, sop-amenity-request, sop-booking-inquiry, pricing-negotiation, post-stay-issues) MUST have 3 English + 3 Arabic variant descriptions.
- **FR-005**: Descriptions MUST be written as natural sentences describing how guests phrase requests — NOT as procedural SOP instructions. They MUST include synonyms, variant phrasings, and domain-specific language woven into prose.
- **FR-006**: Descriptions MUST NOT use negation ("this is NOT about...") as transformer embeddings do not reliably encode negation. Always describe what a class IS.
- **FR-007**: The `non-actionable` and `contextual` categories MUST NOT have descriptions. They are handled via thresholding: if no category exceeds the confidence threshold, route to non-actionable.
- **FR-008**: All SOP descriptions MUST be embedded once at startup using Cohere `input_type="classification"`. Embeddings cached in memory. No per-message API call for descriptions.
- **FR-009**: At classification time, compute cosine similarity between the message embedding and ALL description embeddings. For multi-prototype categories, take **max similarity** per category. This produces an N-dimensional feature vector (N=20, one value per category, excluding non-actionable/contextual). Categories MUST be ordered **alphabetically by category name** to ensure deterministic feature vector construction. This canonical ordering MUST be identical in both the training script and runtime inference.
- **FR-010**: The description similarity feature vector MUST be concatenated with the original 1024-dim message embedding to form the augmented feature vector fed to the LR (total: 1044 dimensions). This requires retraining the LR on augmented vectors.
- **FR-011**: The Python training script MUST be updated to compute description similarities for each training example and train the LR on augmented feature vectors (1024 + 20 dimensions). The training script MUST use the same alphabetical category ordering and max-per-category reduction as runtime inference (FR-009).
- **FR-012**: Description embeddings MUST be stored alongside LR weights (in ClassifierWeights DB table) so fresh container deploys can load them without re-embedding.
- **FR-012a**: The raw SOP description text MUST be stored in a dedicated JSON config file (`backend/src/config/sop_descriptions.json`), version-controlled alongside the codebase. The file is loaded at startup for embedding and is also read by the Python training script to compute augmented feature vectors.
- **FR-012b**: At weight load time, the classifier MUST detect feature dimension mismatch (old 1024-dim weights vs expected 1024+N augmented weights). On mismatch, the system MUST fall back to plain 1024-dim LR with description features disabled. KNN similarity boost MUST still function independently. A warning log MUST be emitted indicating retraining is required.

**Hard Cap + Gap Filter**
- **FR-013**: LR MUST return a maximum of 3 labels, regardless of how many pass per-category thresholds. Labels MUST be sorted by confidence descending. If all LR scores fall below the global threshold after filtering, the top-1 label MUST still be returned (the classifier always produces at least 1 label; non-actionable routing is handled downstream by tier logic, not by returning zero labels).
- **FR-014**: Only labels within 10 **absolute** percentage points of the top LR score MUST be returned (e.g., top score 38% → keep ≥ 28%). Labels below this gap are filtered out. Filter ordering: (1) per-category thresholds filter first (existing behavior), (2) gap filter second, (3) hard cap third.

**Diagnostics + Observability**
- **FR-015**: A cross-class similarity matrix MUST be computable as a diagnostic (admin endpoint or CLI command). Any category pair with description similarity > 0.70 MUST be flagged for rewriting.
- **FR-016**: ragContext stored in the database MUST include: `boostApplied`, `boostSimilarity`, `boostLabels`, `originalLrConfidence`, `originalLrLabels`, `topDescriptionMatches` (top 3 description similarities with labels).
- **FR-017**: The pipeline feed endpoint MUST include boost data and top description match scores.
- **FR-018**: The frontend pipeline display MUST show the Similarity Boost section and description match scores.

**Rename**
- **FR-019**: All references to "KNN diagnostic", "knn_vote", "knn_rerank", "Embedding Diagnostic" MUST be renamed to "Similarity Boost" across backend code, frontend components, log messages, and comments.
- **FR-020**: The `ClassificationResult` interface field `knnDiagnostic` MUST be renamed to `similarityBoost`.

**Configuration**
- **FR-021**: All thresholds (boost: 0.80, gap filter: 0.10, hard cap: 3) MUST be configurable via config file (same pattern as `centroid_switch_threshold` in `topic_state_config.json`).
- **FR-022**: Cohere `input_type="classification"` MUST be used for embedding both descriptions and incoming messages.

### Key Entities

- **SOP Description**: A 2-4 sentence natural language paragraph describing how guests communicate about a specific SOP category. One or more per category, in English and Arabic. Embedded once at startup, used as LR features.
- **Description Feature Vector**: N-dimensional vector of cosine similarities between message and each SOP description (max similarity per category for multi-prototype categories). Concatenated with embedding for augmented LR input.
- **Similarity Boost**: The KNN top-3 neighbor signal. When similarity ≥ threshold and all neighbors agree, overrides LR confidence entirely.
- **Augmented Feature Vector**: [1024-dim Cohere embedding, N-dim description similarities] — the input to the retrained LR.
- **Cross-Class Similarity Matrix**: Diagnostic tool — cosine similarity between all pairs of description embeddings. Pairs > 0.70 indicate overlapping descriptions.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Messages with exact or near-exact training matches (similarity ≥ 0.80) achieve HIGH confidence (≥ 0.80) in Tier 1 — measured by checking that these messages no longer trigger Tier 2.
- **SC-002**: Tier 2 fire rate drops by at least 30% — because near-exact matches are handled by boost and description-enhanced LR catches more novel phrasings.
- **SC-003**: LR accuracy on validation set improves after retraining with description features — measured by 5-fold CV accuracy in training script output. No individual category's per-category accuracy MAY regress by more than 15 percentage points. If overall accuracy does not improve or regresses, description features MAY be disabled (via FR-012b fallback) while shipping KNN boost + hard cap independently. Description quality is then iterated on separately.
- **SC-004**: No message returns more than 3 labels from Tier 1. Verified by querying ragContext for label counts.
- **SC-005**: Cross-class description similarity matrix has no pairs > 0.70 at deployment. Verified by running diagnostic.
- **SC-006**: Arabic messages achieve classification accuracy within 10 percentage points of English messages — measured by checking Arabic test messages against expected SOPs.
- **SC-007**: Zero references to "KNN" in user-facing UI or active log messages (historical data in DB is fine).
- **SC-008**: Pipeline display shows boost data and description match scores for every classified message.

## Assumptions

- `runKnnDiagnostic()` already runs on every message with negligible cost (~100µs, no API call). No additional computation needed for KNN boost.
- The boost threshold of 0.80 cosine similarity is a conservative starting point — may be tuned.
- All 3 neighbors must agree for KNN boost to activate.
- The boost only INCREASES confidence — it never decreases confidence.
- Cohere embed-v4.0 (multilingual, 1024-dim) handles Arabic well enough for MSA descriptions to cover common Gulf/Levantine dialect variations.
- One retrain cycle is required after writing descriptions to produce augmented LR weights.
- Description embeddings are small enough to store in ClassifierWeights DB table (~1024 floats × ~50 descriptions = ~200KB JSON).
- `input_type="classification"` is compatible with our existing embedding pipeline (verified: already used for all classifier embeddings).

## Out of Scope

- Removing `runKnnDiagnostic()` code entirely — it's the foundation of the boost feature.
- Changing the KNN K value (stays at 3) or the neighbor agreement threshold.
- Stacking classifier / meta-learner ensemble (future optimization per research).
- Dialect-specific Arabic descriptions (start with MSA, add dialects if needed).
- Per-tenant description customization (global for now).
- Automatic description generation via LLM (descriptions are hand-crafted for quality).
