# Feature Specification: AI Engine Comprehensive Fix

**Feature Branch**: `003-ai-engine-fix`
**Created**: 2026-03-19
**Status**: Draft
**Input**: Deep dive on AI engine — classifier, topic switch, and pipeline fixes informed by three research reports on KNN classification, topic detection, and local vs API inference

## Clarifications

### Session 2026-03-19

- Q: How should LR training run on Railway? → A: Add Python to the Railway Docker image and run sklearn as a child process when retraining is triggered. No pure-TypeScript LR math needed.
- Q: When does retraining trigger? → A: On demand — operator clicks "Retrain" button, or auto-triggered after batch operations (gap analysis, bulk approve). Not on every individual example add.
- Q: What happens to the existing KNN code? → A: Keep KNN as diagnostic/display only. LR makes the classification decision, but KNN neighbors are still computed and shown in the pipeline feed for debugging. Frontend updated to show LR confidence as the primary metric alongside KNN neighbors.
- Q: How should the new AI engine be deployed alongside the old one? → A: Separate Railway service (`backend-new-ai`) in the same project, pointing to the same Postgres + Redis. Test with one tenant by pointing their Hostaway webhook at the new service. Old service stays live for all other tenants. Migrate tenants one by one when confident.
- Q: What branch does the new service deploy from? → A: Deploy from `003-ai-engine-fix` directly. It already has the full codebase (branched off advanced-ai-v7). Merge back into advanced-ai-v7 when proven in production.
- Q: Should the frontend be shared or separate? → A: One frontend, backward-compatible. `/classifier-status` returns `classifierType: "knn" | "lr"` and the frontend auto-adapts: show LR confidence if LR engine, show topSimilarity if KNN. Retrain button and LR-specific UI hidden when connected to old engine. No env var switching, no two frontends.
- Q: What happens on first startup without LR weights? → A: Classifier refuses to process AI replies until retrain is run. Operator MUST run retrain before messages flow. No fallback to KNN or intent extractor — keep it simple.
- Q: Should the LR classifier support multi-label? → A: Yes — use sklearn OneVsRestClassifier to return all labels above a threshold. Existing training examples already have multiple SOP labels. All matching SOPs are injected.
- Q: What happens when both LR and intent extractor return nothing? → A: Respond using baked-in SOPs only (always in prompt) AND create an escalation (info_request) so the manager follows up.
- Q: How should cross-validation calibration work given cost? → A: Embed all examples once during retrain, cache embeddings, reuse across all 450 CV folds (exclude one per fold). No extra Cohere calls — calibration runs as part of the retrain step (~5s of sklearn math).
- Q: Can both services' judges write to the same DB without conflicts? → A: No conflict — each tenant's webhooks point to ONE service, so a conversation only flows through one judge. Both services write to the same tables safely.

## Research Findings (Summary)

Three research reports identified root causes and the optimal fix:

**Classifier (Research 2 + 3):**
- K=3 majority voting with 2/3 agreement + 0.30 threshold creates a
  triple filter that rejects almost everything
- "non-actionable" (44 examples) has a ~27% base probability of
  appearing among K=3 neighbors purely from density
- **Logistic regression trained on Cohere embeddings** is the
  recommended replacement — learns actual decision boundaries, handles
  overlapping classes, and is ~10 lines of TypeScript (matrix multiply
  + argmax on exported JSON weights)
- Centroid classification is still useful for topic switch detection
  but LR is strictly better for the classification decision
- **Keep Cohere API** — local models on Railway are slower (100-300ms
  vs 25ms), more expensive ($40/mo vs $2/mo), and worse for Arabic
- SetFit fine-tuning doesn't transfer across embedding models — can't
  fine-tune a local model and use weights with Cohere embeddings
- The 0.30 cosine threshold is miscalibrated — must be calibrated
  empirically via cross-validation

**Architecture Validation (Research 4):**
- Classify-then-inject pattern is confirmed optimal at 20 categories
  + 450 examples — beats RAGFlow, tool-use, single-call, and
  enterprise NLU platforms on both cost and accuracy
- **Three-tier confidence routing** is the highest-impact upgrade:
  high confidence → inject 1 SOP ($0.002), medium → inject top 3
  SOPs for LLM to pick ($0.003), low → inject all SOPs ($0.005).
  Raises accuracy from ~90% to ~92-96% at $0.0024/message average.
- Per-SOP threshold optimization (grid-search per category) is a
  quick win — some SOPs need 0.70, others 0.90
- Don't adopt RAGFlow/LangChain (wrong problem), tool-use (2x cost),
  enterprise NLU (vendor lock-in, worse Arabic), or single-call
  (loses supervised learning signal)

**Topic Switch (Research 1):**
- Keyword-based switch detection only catches explicit switches
- Embedding distance to the cached topic centroid is the strongest
  signal and adds zero latency (centroids computed from training data)
- Multi-slot confidence-decay cache outperforms single-slot TTL
- Per-topic thresholds (mean - 2*std from training data) handle
  varying topic "spread" in embedding space

## User Scenarios & Testing

### User Story 1 — Replace KNN Voting with Trained Classifier (Priority: P0)

The KNN-3 majority voting classifier returns empty labels on 90% of
messages because three independent filters (cosine threshold, 2/3
agreement, vote weight) compound to reject almost everything. Research
across three reports converges on the fix: **train a logistic
regression head on the Cohere embeddings of the training examples.**
This learns actual decision boundaries (not just nearest-neighbor
geometry), handles overlapping classes, and is ~10 lines of TypeScript
at inference time (matrix multiply + argmax on exported JSON weights).

Additionally, pre-compute centroids (mean embeddings) per category —
these are used for topic switch detection (US4), not for the
classification decision itself.

**Why this priority**: This is THE root cause of the 90% empty-label
rate. Every other fix depends on Tier 1 producing labels.

**Independent Test**: Run the test-classify endpoint against 50
representative messages. Empty-label rate should drop from 90% to
below 15%.

**Acceptance Scenarios**:

1. **Given** the ~450 training examples, **When** all examples are
   embedded with Cohere (input_type="classification"), **Then** a
   logistic regression is trained on those embeddings and the weights
   (coefficients + intercepts + class names) are exported as JSON.
2. **Given** a guest message, **When** the trained classifier runs,
   **Then** it embeds the message with Cohere, multiplies by the LR
   weight matrix, applies softmax, and returns the top category with
   a calibrated confidence score. If confidence is below the rejection
   threshold, return empty labels and route to Tier 2.
3. **Given** the LR classifier and training data changes (new examples
   added, gap analysis, operator corrections), **When** the classifier
   is reinitialized, **Then** the LR is retrained on the updated
   embeddings and new weights are swapped in atomically (same swap
   pattern as the existing classifier).
4. **Given** the same training examples, **When** centroids (mean
   embeddings per category) are also computed, **Then** they are stored
   alongside the LR weights for use by the topic switch detector (US4)
   — not for classification.

---

### User Story 2 — Three-Tier Confidence Routing (Priority: P0)

Instead of a binary "confident → use, not confident → Tier 2",
route messages through three tiers based on LR confidence. The LLM
catches the classifier's mistakes on ambiguous messages while the
classifier handles the 65-75% of messages that are unambiguous.

**Why this priority**: This is where the accuracy jump from ~90% to
~92-96% comes from. Without it, medium-confidence messages either
get the wrong SOP or get rejected entirely. Research across Voiceflow,
Google Speculative Cascades, and Amazon Bedrock routing confirms
this pattern.

**Independent Test**: Classify a mix of easy ("WiFi not working"),
ambiguous ("loud noise from AC"), and hard ("Terrace?") messages.
Verify each routes to the correct tier and the LLM picks the right
SOP in Tier 2.

**Acceptance Scenarios**:

1. **Given** an LR confidence >= 0.85 (high), **When** the message
   is classified, **Then** only the single top SOP is injected into
   the prompt — same as current behavior but with calibrated
   confidence. Estimated 65-75% of messages, ~$0.002 cost.
2. **Given** an LR confidence between 0.55 and 0.85 (medium), **When**
   the message is classified, **Then** the top 3 candidate SOPs are
   injected into the main Claude call with an instruction: "The
   classifier suggests [Category X] but is uncertain. Based on
   conversation context, select the most appropriate SOP and respond."
   Estimated 20-30% of messages, ~$0.003.
3. **Given** an LR confidence below 0.55 (low), **When** the message
   is classified, **Then** the existing intent extractor (Haiku call)
   fires to determine the correct SOP label(s). The matched SOP(s)
   are then injected into the main Claude call as normal. This reuses
   the existing Tier 2 infrastructure rather than injecting all 20
   SOPs. Estimated 5-10% of messages, ~$0.003 (intent extractor
   $0.0001 + main call $0.002).
4. **Given** the three-tier routing, **When** the LLM overrides the
   classifier's suggestion in Tier 2 or 3, **Then** the override is
   logged (classifier said X, LLM chose Y) for monitoring. If the
   override rate exceeds 15%, the classifier needs retraining.

---

### User Story 3 — Calibrate Rejection Threshold Empirically (Priority: P0)

The current 0.30 cosine threshold was set by intuition. Research shows
there is no universal good cosine threshold — it must be calibrated on
the actual training data. A leave-one-out cross-validation determines
the optimal threshold for the chosen embedding model.

**Why this priority**: Without a calibrated threshold, the centroid
classifier (US1) will either reject too much or accept too much. This
must be done alongside US1.

**Independent Test**: After calibration, the rejection threshold
produces fewer than 15% false rejections (correct category exists but
below threshold) on the training set.

**Acceptance Scenarios**:

1. **Given** the ~450 training examples, **When** leave-one-out
   cross-validation runs, **Then** for each example it classifies
   using the remaining 449 and records whether the correct category
   was returned, at what confidence, and what the gap was between
   1st and 2nd best centroid.
2. **Given** the cross-validation results, **When** the system
   computes optimal thresholds, **Then** it sets: (a) an overall
   rejection threshold where precision >= 85%, and (b) per-category
   thresholds at mean - 2*std of within-class similarities.
3. **Given** the calibrated thresholds, **When** they are applied,
   **Then** the Tier 2 handoff fires only for genuinely uncertain
   messages, not for every low-density category.

---

### User Story 4 — Rebalance Training Data (Priority: P1)

"non-actionable" has 44 examples, "contextual" has 30, but niche SOPs
like sop-long-term-rental have only 5. This creates density bias even
with centroid classification — categories with few examples have noisy
centroids. Research recommends: cap majority categories at ~25, boost
all minorities to 10-15, and add Arabic translations of English
examples.

**Why this priority**: Centroid quality depends on representative
training examples. Noisy centroids from 5-example categories will
produce unreliable confidence scores.

**Independent Test**: After rebalancing, every SOP category has at
least 10 training examples and no category exceeds 25. Arabic examples
make up at least 40% of the training set.

**Acceptance Scenarios**:

1. **Given** the current imbalanced training data, **When** the system
   caps "non-actionable" at 25 and "contextual" at 20, **Then** the
   removed examples are deactivated (not deleted) and the least
   representative ones are chosen for removal (furthest from centroid).
2. **Given** categories with fewer than 10 examples, **When** the
   system generates augmentation examples via LLM paraphrasing,
   **Then** each generated example is a semantically valid variation
   of an existing example, in both English and Arabic.
3. **Given** the augmented training set, **When** centroids are
   recomputed, **Then** the cross-validation accuracy improves by
   at least 15 percentage points over the unbalanced set.

---

### User Story 5 — Semantic Topic Switch Detection (Priority: P1)

The topic switch system uses keyword matching ("also", "by the way")
which misses implicit switches like "Terrace?" during a booking
conversation. Research shows that comparing the message embedding
against the cached topic's centroid — which is already computed in
US1 — is the strongest signal and adds zero latency or cost.

**Why this priority**: With centroids computed (US1) and the LR classifier (US1+US2), this
becomes a free upgrade. The centroid distance tells us whether the message
belongs to the cached topic without any keyword matching.

**Independent Test**: Send "Terrace?" during a booking inquiry
conversation. The system should detect the topic switch and classify
it as property-description, not re-inject sop-booking-inquiry.

**Acceptance Scenarios**:

1. **Given** a cached topic (e.g., sop-booking-inquiry), **When** a
   new message arrives, **Then** the system computes cosine similarity
   between the message embedding and the cached topic's centroid. If
   similarity is below the per-topic threshold (from US2 calibration),
   the topic switch is detected.
2. **Given** a topic switch is detected, **When** the centroid
   classifier (US1) returns a different category, **Then** the cache
   is updated with the new topic and the new SOP is injected.
3. **Given** a genuine follow-up ("ok thanks" during a cleaning
   request), **When** the message embedding is close to the cached
   topic centroid, **Then** the system re-injects the cached SOP
   as before — no false switch detected.
4. **Given** the existing keyword-based switch detection, **When**
   the centroid-based detection is added, **Then** both signals are
   combined: keyword match OR centroid mismatch triggers a switch.
   The keyword list is kept as a fast-path for explicit switches.

---

### User Story 6 — Multi-Slot Topic Cache with Decay (Priority: P2)

The current cache stores one topic with a 30-minute TTL. Guests in
hospitality naturally bounce between 2-3 topics ("booking + amenities +
property info"). Research recommends a multi-slot cache with confidence
decay — top 3 topics with exponential half-life.

**Why this priority**: This improves the guest experience for multi-
topic conversations, but depends on US1 (centroids) and US5 (switch detection) being in place
first.

**Independent Test**: A guest discusses cleaning, switches to WiFi,
then says "so tomorrow at 10am?" — the system correctly associates
this with the cleaning topic (still in cache) not the WiFi topic.

**Acceptance Scenarios**:

1. **Given** a conversation with topics A, B, and C discussed in order,
   **When** the cache is queried, **Then** it maintains all three with
   confidence scores that decay exponentially over time (half-life of
   10 minutes by default).
2. **Given** a new message that matches a previously-discussed topic
   (not the most recent), **When** the centroid distance is computed,
   **Then** the system recognizes the return to a previous topic and
   boosts its confidence rather than treating it as a new switch.
3. **Given** the multi-slot cache, **When** no cached topic matches
   the message, **Then** the system classifies from scratch (centroid
   → Tier 2 fallback) and pushes the new topic into the cache.

---

### User Story 7 — Short Message Context Augmentation (Priority: P2)

Messages like "Terrace?", "Pool?", "WiFi?" produce poor embeddings
because there's insufficient context. Research recommends prepending
conversational context before embedding: "In a {current_topic}
conversation, the guest says: {message}".

**Why this priority**: This improves embedding quality for short
messages without any architecture change — just a preprocessing step
before the embedding call. Depends on having topic context from the
cache (US5).

**Independent Test**: Embed "Pool?" standalone vs "In a booking
conversation, the guest says: Pool?" — the augmented version should
have higher similarity to property-related centroids.

**Acceptance Scenarios**:

1. **Given** a message shorter than 4 words, **When** it is about to
   be embedded, **Then** the system prepends context:
   "Guest message about {cached_topic or 'general inquiry'}: {message}"
2. **Given** the augmented embedding, **When** centroid classification
   runs, **Then** short messages achieve higher confidence scores and
   fewer false "contextual" classifications.
3. **Given** a message longer than 4 words, **When** it is embedded,
   **Then** no augmentation is applied (the message has sufficient
   context on its own).

---

### Edge Cases

- What happens when all centroids are equidistant from the message?
  The system MUST return empty labels and route to Tier 2, not pick
  randomly.
- What happens when a category has only 1 training example? The
  centroid IS the single example. This is acceptable but should be
  flagged in the dashboard as "low-confidence centroid."
- What happens when the multi-slot cache has 3 topics and a 4th
  arrives? The lowest-confidence topic is evicted.
- What happens during classifier reinitialization while centroids are
  being recomputed? The atomic swap pattern (from 001-system-audit)
  ensures readers see either the old or new state, never partial.
- What happens if the Python retraining process crashes? The old LR
  weights MUST remain active. The system MUST log the failure and
  alert the operator via the dashboard, never leave the classifier
  without weights.
- What happens if Cohere API is down during retraining? Retraining
  MUST fail gracefully with a clear error. Old weights remain active.
- What happens when both LR classifier AND intent extractor return
  no labels? Respond using baked-in SOPs only (always in the prompt)
  and auto-create an escalation (info_request) for the manager.
- What happens on first deploy when no LR weights exist? The
  classifier refuses to process messages. Operator MUST run retrain
  before enabling AI for any tenant on this service.

## Requirements

### Functional Requirements

- **FR-001**: The classifier MUST use a trained logistic regression
  head (sklearn OneVsRestClassifier for multi-label support) on Cohere
  embeddings instead of KNN-3 majority voting. The LR weights MUST be
  exported as JSON and inference MUST be matrix multiply + sigmoid per
  label in TypeScript. All labels above a per-label threshold are
  returned (supporting multi-SOP messages). Centroids (mean embeddings
  per category) MUST also be computed for topic switch detection.
  The classifier MUST refuse to process messages until initial retrain
  is run (no fallback to KNN).
- **FR-002**: The LR training pipeline MUST: (a) embed all training
  examples with Cohere input_type="classification", (b) train sklearn
  LogisticRegression on the embeddings, (c) export weights as JSON,
  (d) run on demand via API endpoint (POST /api/knowledge/retrain-
  classifier). Retraining triggers on operator button or after batch
  operations.
- **FR-003**: The rejection threshold MUST be calibrated via leave-one-
  out cross-validation on the training set, not set by intuition.
  Per-category thresholds MUST be supported.
- **FR-004**: Three-tier confidence routing MUST replace the binary
  confident/not-confident decision:
  - High (>= 0.85): inject single top SOP → Claude response
  - Medium (0.55-0.85): inject top 3 candidate SOPs with verification
    instruction → Claude picks the correct one and responds
  - Low (< 0.55): fire the existing intent extractor (Haiku) to
    determine correct SOP label(s), then inject matched SOP(s) →
    Claude response. Reuses existing Tier 2 infrastructure.
  The confidence thresholds (0.85, 0.55) MUST be configurable per
  tenant. LLM overrides of the classifier MUST be logged.
- **FR-004a**: When the LLM overrides the classifier's suggestion in
  Tier 2 or 3, the override MUST be logged with: classifier's pick,
  LLM's pick, confidence score, and the guest message. If the
  override rate exceeds 15% over a 7-day window, the dashboard MUST
  flag that the classifier needs retraining.
- **FR-005**: Training data MUST be rebalanced: cap "non-actionable"
  at 25 examples, cap "contextual" at 20, boost all categories below
  10 to at least 10-15 via LLM paraphrase augmentation in both
  English and Arabic.
- **FR-006**: Topic switch detection MUST use centroid distance as the
  primary signal: if the message embedding's similarity to the cached
  topic centroid is below the per-topic threshold, a switch is detected.
  The existing keyword list MUST be kept as a secondary fast-path.
- **FR-007**: The topic cache MUST support multiple slots (default: 3
  topics) with exponential confidence decay (half-life configurable,
  default 10 minutes). When a message matches a previously-cached
  topic, that topic's confidence is boosted.
- **FR-008**: Messages shorter than 4 words MUST be augmented with
  conversational context before embedding to improve embedding quality.
- **FR-009**: The pipeline dashboard MUST be updated to show: LR
  confidence score as the primary classification metric, per-category
  sigmoid confidence scores, AND KNN neighbors (kept as diagnostic info). The
  pipeline feed entries MUST show both LR decision (category +
  confidence) and KNN neighbors (for debugging why the LR chose
  what it chose). The "Retrain Classifier" button MUST be visible
  in the classifier settings page.
- **FR-010**: LR weights and centroids MUST be recomputed on demand
  (operator "Retrain" button) or auto-triggered after batch operations
  (gap analysis approval, bulk import). NOT on every individual
  example add. The swap uses the same atomic pattern as the current
  classifier reinitialization.
- **FR-011**: Cohere embed-multilingual-v4.0 with `input_type=
  "classification"` MUST be used consistently for both training
  example and query embeddings. Mixing input types is not allowed.
- **FR-012**: The LR training MUST run via a Python child process on
  Railway (sklearn installed in Docker image). The inference MUST be
  pure TypeScript (matrix multiply + sigmoid per label on exported JSON weights).
  Python is only invoked during retraining, not per-request.
- **FR-013**: The existing KNN classifier MUST be kept as a diagnostic
  tool. KNN neighbors MUST still be computed per classification and
  included in the pipeline feed and AiApiLog ragContext for debugging.
  KNN MUST NOT be used for the classification decision — only LR.
- **FR-014**: The Dockerfile MUST be updated to include Python 3 and
  sklearn for the LR training child process. The Python dependency
  MUST NOT affect Node.js startup time or runtime performance.
- **FR-015**: The new engine MUST be deployed as a separate Railway
  service (`backend-new-ai`) sharing the same Postgres + Redis as
  `backend-advanced-ai`. Both services run simultaneously. Test
  tenants have their Hostaway webhooks pointed at the new service.
  Merge into `advanced-ai-v7` when proven.
- **FR-016**: `/classifier-status` MUST return `classifierType: "lr"`
  on the new engine (vs `"knn"` on the old). The frontend MUST
  auto-detect the engine type and adapt the UI: show LR confidence +
  retrain button for LR engine, show topSimilarity for KNN engine.
  Pipeline feed entries MUST render correctly for both engine types.
- **FR-017**: Two new columns added to TenantAiConfig
  (highConfidenceThreshold, lowConfidenceThreshold) with safe defaults
  — old service ignores them. No new tables. LR weights are file-based.
  Both services read/write the same DB tables without conflict. The
  ragContext JSON field in AiApiLog stores engine-specific data (LR
  confidence vs KNN similarity) — the frontend handles both formats.

### Key Entities

- **ClassifierWeights**: JSON file containing LR coefficients
  (shape: [n_classes, embedding_dim]), intercepts (shape: [n_classes]),
  and class names. Loaded at startup, swapped atomically on retrain.
- **CategoryCentroid**: Mean embedding per SOP category, computed from
  training examples. Used for topic switch detection, not classification.
  Recomputed alongside LR weights on training data changes.
- **TopicCacheSlot**: One of 3 slots in the multi-slot cache, holding
  a topic label, confidence score, and last-updated timestamp.
  Confidence decays exponentially.
- **CalibrationResult**: Per-category rejection threshold computed
  from leave-one-out cross-validation, stored alongside the LR weights.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Empty-label rate drops from 90% to below 5% (three-tier
  routing means almost no message goes unclassified).
- **SC-002**: End-to-end accuracy (LR + LLM override) reaches at least
  92% (measured by judge evaluations).
- **SC-003**: Topic switch detection correctly identifies implicit
  switches (e.g., "Terrace?" during booking conversation) at least
  80% of the time.
- **SC-004**: No category has fewer than 10 training examples after
  rebalancing.
- **SC-005**: Classification latency remains under 50ms (centroid
  lookup is <1ms; embedding API call is the bottleneck).
- **SC-006**: The multi-slot topic cache correctly handles return-to-
  previous-topic scenarios at least 80% of the time.
- **SC-007**: Arabic messages are classified with accuracy within 10%
  of English message accuracy (no significant language gap).

## Assumptions

- **Keep Cohere API** — local models on Railway are slower (100-300ms
  vs 25ms), more expensive ($40/mo vs $2/mo), and worse for Arabic.
  Research conclusively recommends Cohere embed-multilingual-v4.0
  with input_type="classification" as the embedding provider.
- **LR over centroids for classification** — logistic regression
  learns actual decision boundaries and handles overlapping classes
  better than nearest-centroid. Centroids are still computed for
  topic switch detection. Both use the same Cohere embeddings.
- **LR training runs via Python child process on Railway** — sklearn
  LogisticRegression trained on Cohere embeddings, weights exported
  as JSON. Runtime inference is pure TypeScript (matrix multiply).
  Retraining triggers on demand (operator button) or after batch
  operations. Python + sklearn added to the Docker image.
- SetFit fine-tuning is NOT recommended — it requires a local model
  and the embedding spaces don't transfer to Cohere. The LR approach
  on Cohere embeddings is simpler and matches the deployment model.
- The multi-slot cache (US6) and short message augmentation (US7) are
  enhancements that build on US1-US5 — they can be deferred if the
  LR classifier + three-tier routing delivers sufficient accuracy.
- The three-tier routing replaces the current binary Tier 1/Tier 2
  handoff. The existing intent extractor (Haiku call) is KEPT as the
  low-confidence fallback (same as current Tier 2). The medium tier
  is NEW — top 3 SOPs injected for Claude to pick from.
- Prompt caching is already implemented and reduces repeated prompt
  costs by ~90%.
- LLM paraphrase augmentation for training data rebalancing uses the
  existing Claude Haiku integration — no new API dependencies.
