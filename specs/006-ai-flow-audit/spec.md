# Feature Specification: AI Flow System Audit & Fix

**Feature Branch**: `006-ai-flow-audit`
**Created**: 2026-03-20
**Status**: Draft
**Input**: Full system audit of AI pipeline — fix all production bugs found across Tier 1, 2, 3, system prompts, and frontend display.

## Clarifications

### Session 2026-03-20

- Q: When a host sends a message, should the system cancel any pending AI reply? → A: Yes — cancel pending AI reply immediately when host message is detected. Human reply always takes priority.
- Q: Should detected escalation signals be injected into Claude's prompt? → A: Yes — inject as a hint (e.g., "SYSTEM SIGNAL: refund_request detected") so Claude can factor them into its response.
- Q: Should getSopContent receive propertyAmenities in all confidence paths? → A: Yes — fix it. Pass propertyAmenities in HIGH and MEDIUM paths too, not just Tier 2/3.
- Q: How to fix poll job + BullMQ double-fire? → A: Add atomic claim guard to poll job (same pattern as BullMQ worker). Keep both — Redis is optional, poll job is fallback.
- Q: How to fix keyword topic switch false positives? → A: Replace keyword detection with centroid-only detection. Keep minimal keyword fallback only when centroids are unavailable (no trained model).

## Problem Statement

The AI pipeline has multiple critical production bugs discovered during live testing on 2026-03-19/20. Guests are receiving wrong SOPs, duplicate instructions, and in one case a door code was exposed to an unconfirmed guest. A full codebase audit uncovered 10 open issues spanning every tier of the classification pipeline, the prompt building system, topic switch detection, and the frontend visualization.

**Bugs verified in production:**
- Same SOP injected 2-3 times into Claude's prompt (duplicate content)
- AI ignores check-in date context when applying SOP rules (says "2 days before" when guest checks in tomorrow)
- Topic switch detection clears cache but doesn't re-classify — old SOP context persists
- Pipeline visualization shows no Tier 1 scoring data (empty display)
- No numeric feedback for topic switch detection (centroid distance not shown)
- Centroid-based topic switch skipped when Tier 1 is confident (defeating its purpose)
- Pipeline log truncates chunk content to 200 chars — makes debugging impossible
- Missing fields in pipeline feed (LLM override data not passed to frontend)

**Already fixed (deployed):**
- Door code exposed to PENDING guest (fixed: allowlist gate + INQUIRY default)
- Pipeline feed missing classifierConfidence/confidenceTier fields

## User Scenarios & Testing *(mandatory)*

### User Story 1 — No Duplicate SOPs in AI Prompt (Priority: P1)

When the AI generates a response, each SOP appears at most once in the prompt — regardless of whether Tier 1, Tier 2, or Tier 3 identified it.

**Why this priority**: Duplicate SOPs bloat the prompt, waste tokens, and confuse Claude into giving less focused responses. This affects every single AI reply.

**Independent Test**: Send a message that triggers both Tier 1 and Tier 2 with the same SOP label. Verify the prompt contains the SOP exactly once. Check the pipeline visualization shows "chunks: 1" not "chunks: 2".

**Acceptance Scenarios**:

1. **Given** Tier 1 classifies a message as `sop-early-checkin` with MEDIUM confidence, **When** Tier 2 also returns `sop-early-checkin`, **Then** the final prompt contains only one copy of the early check-in SOP.
2. **Given** Tier 3 re-injects `sop-cleaning` from cache, **When** the RAG pipeline already retrieved `sop-cleaning`, **Then** the re-injection is skipped (no duplicate).
3. **Given** any combination of tiers identifies the same SOP, **When** the prompt is built, **Then** the SOP content appears exactly once and "chunks" count reflects the deduplicated count.

---

### User Story 2 — Topic Switch Triggers Re-Classification (Priority: P2)

When the system detects a topic switch (keyword or centroid), it re-classifies the message from scratch instead of continuing with stale SOP context from the previous topic.

**Why this priority**: Currently, topic switch clears the cache but doesn't trigger re-classification. The guest's new topic gets the old SOP context, leading to wrong responses.

**Independent Test**: Start a conversation about cleaning, then send a message about WiFi without switch keywords. Verify the system detects the topic switch AND re-classifies to get the correct SOP.

**Acceptance Scenarios**:

1. **Given** a topic switch is detected (keyword or centroid), **When** the pipeline processes the message, **Then** a fresh classification runs and the correct SOP for the new topic is retrieved.
2. **Given** centroid-based switch detection fires, **When** the pipeline display shows the result, **Then** the centroid similarity score and threshold are shown numerically (e.g., "sim: 0.35 < threshold: 0.60").
3. **Given** the guest sends "what's the WiFi?" after discussing cleaning (no switch keywords), **When** Tier 1 classifies with high confidence as `sop-wifi-doorcode`, **Then** the centroid check still runs and detects the topic change from the previous cleaning context.

---

### User Story 3 — AI Contextualizes SOP Rules with Reservation Data (Priority: P3)

When the AI applies an SOP that contains conditional logic (e.g., "within 2 days of check-in → escalate"), it cross-references the SOP rules with the actual reservation data in the prompt (check-in date, guest count, booking status) rather than parroting the SOP text verbatim.

**Why this priority**: The AI told a guest "we can only confirm early check-in 2 days before your date" when the guest was checking in the next day. The SOP had the correct conditional logic but Claude picked the wrong branch.

**Independent Test**: Send an early check-in request for a reservation checking in tomorrow. Verify the AI escalates ("let me check on that") instead of giving the generic "2 days before" response.

**Acceptance Scenarios**:

1. **Given** a guest asks for early check-in and their check-in date is tomorrow, **When** the AI processes the SOP, **Then** it follows the "within 2 days" branch (escalate) not the ">2 days" branch (generic response).
2. **Given** a guest asks for early check-in and their check-in date is next week, **When** the AI processes the SOP, **Then** it follows the ">2 days" branch (tell them to wait).

---

### User Story 4 — Pipeline Visualization Shows Complete Data (Priority: P4)

The pipeline visualization dashboard displays all classification data: Tier 1 LR confidence and labels, Tier 3 centroid distance scores, and LLM override detection — with no empty sections or missing fields.

**Why this priority**: Operators cannot debug AI behavior when the pipeline display shows empty Tier 1 sections and no numeric data for topic switches.

**Independent Test**: Open the pipeline page after a message is processed. Verify Tier 1 shows LR confidence percentage, tier badge, and classified labels. Verify Tier 3 shows centroid similarity score when applicable.

**Acceptance Scenarios**:

1. **Given** a message is classified by the LR classifier, **When** the pipeline display renders, **Then** Tier 1 shows the confidence percentage, confidence tier badge (high/medium/low), and classified labels.
2. **Given** a topic switch is detected via centroid distance, **When** the pipeline display renders, **Then** Tier 3 shows the centroid similarity score, the threshold used, and which topic centroid was compared.
3. **Given** an LLM override occurs in MEDIUM confidence tier, **When** the pipeline display renders, **Then** it shows the override badge with the LLM's picked SOP vs the classifier's suggestion.

---

### User Story 5 — Accurate Pipeline Logs for Debugging (Priority: P5)

Pipeline logs and ragContext stored in the database contain the full untruncated SOP content, full user message, and full reservation details — so operators can see exactly what Claude received.

**Why this priority**: Currently ragContext truncates chunk content to 200 characters, making it impossible to debug what Claude actually saw in the prompt.

**Independent Test**: Check an AiApiLog entry in the database. Verify the ragContext chunks contain full SOP text, not truncated to 200 chars.

**Acceptance Scenarios**:

1. **Given** an AI reply is generated, **When** the ragContext is stored in AiApiLog, **Then** chunk content is stored in full (not truncated to 200 characters).
2. **Given** the pipeline visualization loads a past entry, **When** it displays the retrieved chunks, **Then** the full SOP text is visible (with UI-level truncation/expand, not data-level truncation).

---

### Edge Cases

- What if Tier 1, Tier 2, and Tier 3 all identify different SOPs? Each unique SOP should appear once.
- What if centroid distance check and keyword detection disagree? Keyword detection takes priority (explicit signal).
- What if the ragContext for a long conversation exceeds reasonable storage size? Implement a configurable max length for logging (separate from what Claude actually receives).
- What if the SOP content contains `###` markers that interfere with content block parsing? Content blocks should be built safely without relying on marker-based splitting of user content.
- What if a topic switch is detected but re-classification returns the same SOP as before? This is fine — the point is that the classification was re-run fresh, and the result happens to be the same topic.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Each SOP label MUST appear at most once in the final prompt to Claude, regardless of how many tiers identified it.
- **FR-002**: When a topic switch is detected (keyword or centroid), the system MUST trigger a fresh classification of the current message instead of using stale cached context.
- **FR-003**: The early check-in SOP MUST include an explicit instruction for the AI to cross-reference the check-in date from reservation details and choose the correct conditional branch.
- **FR-004**: The pipeline visualization MUST display Tier 1 LR confidence score, confidence tier badge, and classified labels for every processed message.
- **FR-005**: The pipeline visualization MUST display centroid similarity score and threshold when topic switch detection runs.
- **FR-006**: The `getReinjectedLabels()` return value MUST include the centroid similarity score used for the topic switch decision.
- **FR-007**: ragContext stored in AiApiLog MUST contain full chunk content (not truncated to 200 characters).
- **FR-008**: The pipeline feed endpoint MUST include LLM override data when applicable (classifier pick vs LLM pick).
- **FR-009**: Centroid-based topic switch detection MUST run independently of Tier 1 confidence — even when Tier 1 is HIGH confidence, the system MUST check if the new classification differs from the cached topic.
- **FR-010**: Content block building MUST be safe against SOP or property content containing markdown heading markers.
- **FR-011**: When a host sends a message in a conversation, the system MUST immediately cancel any pending AI reply for that conversation. Human replies always take priority over AI.
- **FR-012**: Detected escalation signals (refund_request, complaint, emergency, etc.) MUST be injected into Claude's prompt as system hints so the AI can factor them into its response and escalation decision.
- **FR-013**: `getSopContent()` MUST receive the property amenities data in ALL confidence paths (HIGH, MEDIUM, LOW) so the `{PROPERTY_AMENITIES}` placeholder is correctly populated — not just in Tier 2/3.
- **FR-014**: The poll job MUST use an atomic claim guard (conditional update where `fired: false`) before processing a PendingAiReply, preventing double-fire with the BullMQ worker when Redis is enabled.
- **FR-015**: Topic switch detection MUST use centroid distance as the primary method, replacing keyword substring matching. Keyword detection is kept ONLY as a fallback when centroids are unavailable (no trained model).

### Key Entities

- **Retrieved Chunks**: The set of SOP and property knowledge chunks injected into Claude's prompt. Must be deduplicated by category/sourceKey across all tiers before prompt assembly.
- **Topic State**: Per-conversation cache of the active topic. Enhanced with centroid similarity score and re-classification trigger on switch detection.
- **ragContext**: The diagnostic snapshot of the RAG pipeline run, stored in AiApiLog. Must contain full (not truncated) data for debugging.
- **Pipeline Feed Entry**: The per-message data served to the frontend visualization. Must include all tier scores, centroid distance, and LLM override data.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Zero duplicate SOP chunks in any AI prompt — verifiable by checking that no AiApiLog entry has duplicate categories in its ragContext chunks.
- **SC-002**: 100% of topic switch detections (keyword or centroid) result in a fresh classification — verifiable by checking logs show re-classification after every topic switch event.
- **SC-003**: AI correctly applies conditional SOP logic in at least 90% of cases where reservation data is available — testable with a batch of 10 early check-in messages with varying check-in dates.
- **SC-004**: Pipeline visualization shows non-empty Tier 1 data (confidence, tier, labels) for 100% of new messages processed after deployment.
- **SC-005**: ragContext chunks stored in AiApiLog contain full SOP text (not truncated) — verifiable by querying any recent log entry.

## Assumptions

- The door code exposure bug (mapReservationStatus defaulting to CONFIRMED) is already fixed and deployed.
- The pipeline feed classifierConfidence/confidenceTier fix is already deployed.
- The SOP dedup fix in intent-extractor.service.ts and rag.service.ts is deployed but insufficient — the duplicate comes from ai.service.ts adding chunks from multiple tiers without cross-tier dedup.
- The early check-in SOP content update is a text change, not a code change — the SOP text needs to be more explicit about cross-referencing the reservation date.
- Centroid topic switch detection code is deployed but has a design gap (skipped when Tier 1 confident).

## Out of Scope

- Retraining the LR classifier (training data quality is a separate concern)
- Changes to the Python training pipeline
- Redesigning the three-tier routing architecture
- Adding new SOPs or changing SOP assignment logic
- Frontend redesign beyond adding missing data fields to existing components
