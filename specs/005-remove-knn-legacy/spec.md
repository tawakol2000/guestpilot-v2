# Feature Specification: Remove KNN Legacy & Complete LR Migration

**Feature Branch**: `005-remove-knn-legacy`
**Created**: 2026-03-19
**Status**: Draft
**Input**: User description: "Get rid of all the stuff using the old AI engine, switch fully to the new one, double check everything is wired up correctly, add centroid-based semantic topic switch detection."

## Problem Statement

The AI classification pipeline currently runs two systems in parallel: the new LR (Logistic Regression) classifier as the primary decision-maker, and the old KNN-3 classifier as a "diagnostic" that still runs on every message. This creates three problems:

1. **Confusion**: Comments, labels, defaults, and log messages still reference KNN as the primary engine, making the codebase misleading.
2. **Bugs**: Two critical code paths still use the old KNN similarity metric (`topSimilarity`) for decisions that should use the new LR confidence score — meaning tier routing and training data reinforcement are sometimes using the wrong signal.
3. **Missing feature**: Topic switch detection currently relies only on keyword matching ("by the way", "also", etc.). The trained LR model includes per-category centroids that can detect topic switches semantically — a guest silently changing topics would be caught by measuring the distance between their current message embedding and the active topic's centroid.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — All Decisions Use LR Confidence (Priority: P1)

Every classification-dependent decision in the system — confidence tier routing, judge skip conditions, operator reinforcement triggers, and logging — uses the LR sigmoid confidence score as the primary metric instead of the old KNN cosine similarity.

**Why this priority**: The audit found two places where KNN similarity is incorrectly used for decisions that should use LR confidence. This means some messages are being routed to the wrong confidence tier and some training examples are being reinforced at the wrong threshold. Fixing this directly improves classification accuracy.

**Independent Test**: Send a message where LR confidence and KNN similarity diverge significantly (e.g., LR=0.92 HIGH, KNN=0.47 LOW). Verify the system routes based on LR (HIGH tier, single SOP) not KNN (LOW tier, Tier 2 fallback).

**Acceptance Scenarios**:

1. **Given** a message with LR confidence 0.90 and KNN similarity 0.45, **When** the RAG pipeline runs, **Then** the message is routed as HIGH confidence (single SOP injected), not LOW.
2. **Given** a message with LR confidence 0.30 and KNN similarity 0.80, **When** the judge evaluates, **Then** the skip decision is based on LR confidence (not skipped), not KNN similarity (would be skipped).
3. **Given** an operator approves a training example, **When** the reinforcement threshold check runs, **Then** it compares LR confidence against the threshold, not KNN similarity.

---

### User Story 2 — Clean Labels, Comments & Defaults (Priority: P2)

All user-facing labels, developer comments, log messages, and UI defaults accurately describe the LR engine as the primary classifier. No references to "KNN" as the active engine remain except where the KNN diagnostic is explicitly labeled as such.

**Why this priority**: Misleading labels cause operators and developers to misunderstand system behavior. The dashboard defaulting to "KNN Engine" when LR is always active creates unnecessary confusion.

**Independent Test**: Open the pipeline visualization dashboard and verify it shows "LR Engine" by default and labels Tier 1 as "LR Sigmoid Classifier", not "KNN".

**Acceptance Scenarios**:

1. **Given** the dashboard loads, **When** the engine status endpoint responds, **Then** the UI defaults to "LR Engine" display mode.
2. **Given** a developer reads the classifier service file header, **When** they look at the description, **Then** it describes the LR classifier as primary with KNN as an optional diagnostic.
3. **Given** the daily audit report (OPUS) runs, **When** it describes Tier 1, **Then** it says "LR Embedding Classifier" not "KNN Embedding Classifier".

---

### User Story 3 — Semantic Topic Switch Detection (Priority: P3)

When a guest silently changes topics mid-conversation — without using explicit switch keywords like "by the way" or "also" — the system detects the topic change using the distance between the current message's embedding and the active topic's centroid, and re-classifies instead of re-injecting the old SOP.

**Why this priority**: Currently, if a guest asks about cleaning, then follows up with "what's the WiFi password?" (no switch keyword), the system re-injects the cleaning SOP because keyword detection misses it. Centroid-based detection would catch this by measuring how far "WiFi password" is from the cleaning centroid.

**Independent Test**: Start a conversation about one topic (e.g., cleaning), then send a follow-up about a completely different topic without any switch keywords. Verify the system detects the topic change and classifies the new message fresh.

**Acceptance Scenarios**:

1. **Given** a conversation with active topic "sop-cleaning" and no switch keywords in the follow-up, **When** a guest sends "what's the WiFi password?", **Then** the system detects a topic switch (embedding is far from cleaning centroid) and classifies the new message as "sop-wifi-doorcode".
2. **Given** a conversation with active topic "sop-cleaning", **When** a guest sends "ok thanks, I'll wait" (genuine follow-up), **Then** the system does NOT detect a topic switch (embedding is close to cleaning centroid) and re-injects the cleaning SOP as before.
3. **Given** the LR model has not been trained yet (no centroids available), **When** the topic switch check runs, **Then** it falls back to keyword-only detection gracefully — no crash, no change in behavior.

---

### Edge Cases

- What if the KNN diagnostic is completely removed in the future? All code paths must work without it — LR confidence must be the sole required metric.
- What if the centroid for a topic has very few training examples (e.g., 2-3)? The centroid may be unreliable — the system should require a minimum number of examples before trusting centroid distance.
- What if a message is equidistant from two centroids? The system should treat this as ambiguous and not trigger a false topic switch.
- What if the LR weights file is missing on startup? The system must throw a clear error on the first classification attempt (existing behavior), not silently fall back to KNN.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: All confidence tier routing decisions (HIGH/MEDIUM/LOW) MUST use LR sigmoid confidence, not KNN cosine similarity.
- **FR-002**: The judge's skip conditions MUST use LR confidence as the primary metric, with KNN similarity available only for logging.
- **FR-003**: The operator reinforcement threshold check MUST compare against LR confidence, not KNN similarity.
- **FR-004**: All UI labels, comments, log messages, and OPUS report text MUST accurately describe LR as the primary classifier.
- **FR-005**: The frontend dashboard MUST default to "LR" engine display mode, not "KNN".
- **FR-006**: The topic state cache MUST detect topic switches using centroid distance when centroids are available from the trained model.
- **FR-007**: Centroid-based topic switch detection MUST fall back to keyword-only detection when centroids are unavailable (no trained model).
- **FR-008**: The system MUST NOT break or degrade if KNN diagnostic code is later removed — no decision path may depend on KNN-only fields.

### Key Entities

- **Classifier Result**: The output of message classification. Primary fields: `labels`, `confidence` (LR sigmoid), `tier`. Diagnostic fields: `knnDiagnostic` (kept for observability, not decisions).
- **Topic State Cache**: Per-conversation in-memory cache of the active topic. Enhanced with centroid distance checking for topic switch detection.
- **Centroids**: Per-category mean embeddings computed during LR training. Stored in the weights file alongside LR coefficients.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After deployment, 100% of tier routing decisions use LR confidence — verifiable by checking that no log line shows "tier=tier1" when LR confidence is below the HIGH threshold.
- **SC-002**: Zero references to "KNN" as the primary/active engine in any user-facing UI label or log message — KNN only appears under explicit "diagnostic" or "observability" labels.
- **SC-003**: Semantic topic switch detection catches at least 80% of cross-topic follow-ups that keyword detection misses — testable with a batch of 20 known topic-switch messages without switch keywords.
- **SC-004**: No regression in end-to-end message handling — all existing messages continue to be classified and responded to correctly after the migration.

## Assumptions

- The KNN diagnostic code will be kept for now as an observability tool (pipeline visualization), but will no longer influence any decisions.
- Centroids are already computed and stored in `classifier-weights.json` during training — no changes to the Python training pipeline are needed.
- The centroid distance threshold for topic switch detection will need tuning; a reasonable starting default is 0.60 cosine similarity (below this = topic switch). 0.70 was too aggressive (too many false switches); 0.60 is a conservative starting point.
- This migration does not affect the Tier 2 (Intent Extractor) or Tier 3 (Topic State Cache re-injection) logic — only which metric drives routing and how topic switches are detected.

## Out of Scope

- Removing the KNN diagnostic code entirely — it stays for observability in the pipeline display.
- Changes to the Python training pipeline or the LR model architecture.
- Changes to the Tier 2 intent extractor prompt or behavior.
- Full frontend redesign of the pipeline visualization layout — the engine toggle and old KNN display branch are removed, but the overall page structure stays the same.
