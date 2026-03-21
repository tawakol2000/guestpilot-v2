# Feature Specification: SOP Tool Routing

**Feature Branch**: `013-sop-tool-routing`
**Created**: 2026-03-21
**Status**: Draft
**Input**: Replace the entire 3-tier classifier system (embedding classifier, intent extractor, topic state cache) with a single SOP classification tool built into the AI assistant's native capabilities.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Tool-Based SOP Classification (Priority: P1)

When a guest sends a message, the AI assistant classifies it by selecting from a predefined set of SOP categories as part of its native response flow. The system retrieves the matching SOP procedure(s) and the AI uses them to formulate an accurate response. This replaces the current 3-tier pipeline (embedding classifier, separate classification call, topic state cache) with a single classification step that has full conversation context.

**Why this priority**: This is the core feature. Without tool-based classification, no SOP routing happens. Every other story depends on this.

**Independent Test**: Send a guest message about a broken dishwasher. AI classifies as "maintenance" with high confidence and reasoning. System returns the maintenance SOP. AI responds following the maintenance procedure.

**Acceptance Scenarios**:

1. **Given** a guest asks for extra towels, **When** the AI processes the message, **Then** it classifies as "amenity_request" and responds with the amenity request procedure
2. **Given** a guest says "hi" or "thanks", **When** the AI processes the message, **Then** it classifies as "none" and responds naturally without SOP retrieval
3. **Given** a guest asks for towels AND the WiFi password in one message, **When** the AI processes it, **Then** it returns both "amenity_request" and "wifi" categories, retrieves both SOPs, and addresses both requests
4. **Given** a guest sends an ambiguous message, **When** the AI classifies with low confidence, **Then** the system logs the classification with reasoning for operator review
5. **Given** a guest continues a previous topic with a short reply like "2pm", **When** the AI has full conversation history, **Then** it correctly classifies to the ongoing topic (e.g., "cleaning") without special handling
6. **Given** a guest message indicates a safety concern or billing dispute, **When** the AI classifies as "escalate", **Then** the system creates an escalation task for the operator

---

### User Story 2 - Remove Legacy Classification Infrastructure (Priority: P1)

Remove the entire 3-tier classification system: embedding classifier (LR/KNN), intent extractor (separate AI classification call), topic state cache, training data management, and the retraining pipeline. This eliminates multiple services, reduces operational complexity, and removes embedding model dependencies from the classification path.

**Why this priority**: Without removal, the system has two competing classification paths. Both US1 and US2 are needed together for a clean cutover.

**Independent Test**: After removal, verify no code references the old classification services. Verify the AI pipeline processes every message correctly end-to-end using only the new tool-based classification.

**Acceptance Scenarios**:

1. **Given** the legacy classifier services are removed, **When** a guest message arrives, **Then** it routes through the new tool-based classification only
2. **Given** the training data management UI is removed, **When** an operator visits the settings page, **Then** they no longer see classifier sliders, ghost mode toggles, or retraining buttons
3. **Given** the topic state cache is removed, **When** a guest sends a follow-up message, **Then** the AI classifies it correctly using conversation context alone
4. **Given** the embedding-based classifier is removed, **When** the system starts, **Then** no embedding model calls are required for classification (embeddings may still be used for property knowledge retrieval)

---

### User Story 3 - SOP Classification Monitoring (Priority: P2)

Replace the current classifier settings page (KNN sliders, ghost mode toggles, training data) with an SOP classification monitoring view. Display classification distribution across categories, confidence breakdown, and the AI's reasoning for each classification. This gives operators visibility into routing quality and helps them identify categories that may need description refinement.

**Why this priority**: Monitoring is important but not blocking. The system works without it. Operators need this to tune and validate classification quality over time.

**Independent Test**: View the monitoring dashboard after processing several guest messages. See a breakdown of classifications by category, confidence levels, and reasoning text.

**Acceptance Scenarios**:

1. **Given** multiple guest messages have been processed, **When** the operator views the monitoring dashboard, **Then** they see classification distribution across SOP categories
2. **Given** a message was classified with low confidence, **When** the operator reviews it, **Then** they see the reasoning and can assess correctness
3. **Given** the operator wants recent activity, **When** they view the classification log, **Then** they see recent classifications with category, confidence, and reasoning

---

### User Story 4 - Quality Evaluation Adaptation (Priority: P3)

Adapt the existing quality evaluation service to work with tool-based classification. Instead of evaluating classifier accuracy across three tiers, evaluate whether the AI's classification matched the expected category using the confidence and reasoning fields. Low-confidence classifications become the primary input for quality review.

**Why this priority**: Quality monitoring is valuable long-term but not needed for launch. The confidence field provides basic quality signals immediately.

**Independent Test**: Process several messages, including some with low confidence. Verify the quality service flags low-confidence classifications for review with reasoning.

**Acceptance Scenarios**:

1. **Given** a message classified with low confidence, **When** the quality service evaluates it, **Then** it flags the classification for review with reasoning
2. **Given** the quality service is running, **When** it processes classifications over time, **Then** it tracks accuracy trends

---

### Edge Cases

- **SOP file missing**: If a classified category has no corresponding SOP file, the AI responds using general knowledge and the system logs the error
- **Non-English messages**: Classification works for any language since the AI is multilingual and classification happens within the same model
- **Partial SOP availability**: If multiple categories are returned but only some SOPs exist, retrieve available SOPs, skip missing ones, and respond with what's available
- **SOP retrieval failure**: If SOP content is missing for a valid category (code bug — content is an in-memory dictionary), the AI receives a fallback tool_result and responds from general knowledge. The system silently creates an operator task flagging the system configuration issue.
- **Contextual follow-ups**: Short replies like "ok", "2pm", "yes" are classified correctly because the AI sees full conversation history (no separate topic cache needed)
- **Escalation**: Messages clearly needing human intervention (safety, legal, billing disputes, angry guests) classify as "escalate" and create an operator task
- **Escalation + SOP overlap**: When `escalate` appears alongside other categories (e.g., `["escalate", "sop-maintenance"]`), the system creates the escalation task AND retrieves the other SOP(s) for the response. The guest still gets a procedure-based answer while the operator is alerted.
- **Existing tools coexistence**: The property search tool (screening agent) and extend-stay tool (guest coordinator) continue to work alongside the new classification tool

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST classify every guest message into one or more SOP categories before generating a response
- **FR-002**: System MUST support the existing 20 operational SOP categories covering all guest service scenarios
- **FR-003**: System MUST include a "none" category for messages that don't need SOP guidance (greetings, thanks, acknowledgments, questions answered by general knowledge)
- **FR-004**: System MUST include an "escalate" category for messages requiring human intervention
- **FR-005**: System MUST support multi-intent messages by returning up to 3 categories per message, ordered by priority
- **FR-006**: System MUST provide a confidence level (high, medium, or low) for each classification
- **FR-007**: System MUST provide a brief reasoning explanation (1 sentence) for each classification
- **FR-008**: System MUST retrieve and deliver the matching SOP content to the AI before response generation
- **FR-009**: System MUST skip SOP retrieval when classification is "none" and let the AI respond from general knowledge
- **FR-010**: System MUST create an escalation task when classification is "escalate"
- **FR-011**: System MUST log every classification (categories, confidence, reasoning) for monitoring and auditing
- **FR-012**: System MUST remove all legacy classification services: embedding classifier, intent extractor, topic state cache
- **FR-013**: System MUST remove training data management UI, retraining pipeline, and related configuration
- **FR-014**: System MUST maintain full compatibility with existing property search and extend-stay tools
- **FR-015**: System MUST provide lean category descriptions: what each SOP covers + explicit negative boundaries (what it does NOT cover), without inline examples
- **FR-016**: System MUST work for both the screening agent (inquiry guests) and the guest coordinator (confirmed/checked-in guests)
- **FR-017**: System MUST display classification distribution, confidence breakdown, and recent classifications in the operator dashboard
- **FR-018**: System MUST gracefully degrade when SOP retrieval fails — respond without SOP, never crash

### Key Entities

- **SOP Category**: One of 20 predefined operational procedure categories, plus "none" and "escalate" (22 total)
- **Classification Result**: The output of classifying a guest message — contains categories (1-3), confidence level, and reasoning text
- **SOP Content**: The procedural text for a given category, retrieved after classification and provided to the AI for response generation

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 95% of guest messages are classified with high or medium confidence
- **SC-002**: Classification accuracy matches or exceeds the current 3-tier system on a benchmark of 100+ real guest messages
- **SC-003**: Per-message cost is at or below the current system cost (~$0.004/message)
- **SC-004**: End-to-end response time does not increase by more than 500ms compared to current system
- **SC-005**: Zero guest-facing service interruption during the transition
- **SC-006**: All 22 categories (20 SOPs + none + escalate) produce correct classifications on representative test messages
- **SC-007**: Multi-intent messages correctly identify all relevant categories at least 80% of the time
- **SC-008**: Operators can view classification monitoring data within 1 day of deployment
- **SC-009**: All legacy classification code is fully removed — no orphaned services, routes, or UI components

## Clarifications

### Session 2026-03-21

- Q: How should the transition from old classifier to new tool-based classification happen? → A: Big-bang replacement — remove old, add new, deploy together. Rollback = revert the deploy.
- Q: What should happen to the 3 classifier database tables (ClassifierExample, ClassifierEvaluation, ClassifierWeights)? → A: Keep tables read-only — stop writing, keep data for historical comparison and evaluation benchmarks.
- Q: When escalate appears alongside other SOP categories, what should happen? → A: Both — create escalation task AND retrieve the other SOP(s) for the response.
- Q: When confidence is "low", does the system do anything beyond normal logging? → A: No extra action. Logged like any message. Operator filters by "low" in monitoring dashboard to review.
- Q: What happens when SOP retrieval fails? → A: Send tool_result "SOP temporarily unavailable. Respond helpfully based on your general knowledge and system instructions." with is_error: false. Also silently create an operator task flagging the system issue. Note: SOP content is an in-memory dictionary lookup — failure is only possible from code bugs (missing content for a valid category).

## Assumptions

- The AI model's native language understanding is sufficient to classify guest messages without a separate embedding-based classifier
- Full conversation history provides enough context for classifying short follow-up messages, eliminating the need for a topic state cache
- The existing 20 SOP categories are comprehensive; only "none" and "escalate" need to be added
- SOP content files are maintained separately and are already correct — this feature only changes how they're selected, not their content
- The property search tool (feature 010) and extend-stay tool (feature 011) continue to work alongside the new classification tool
- The 373 existing training examples can serve as an evaluation benchmark for the new system
- Classification happens within the same AI model call, not as a separate service, making it inherently faster and context-aware
- Transition is big-bang: old classifier removed and new tool-based classification added in a single deploy. No feature flags or parallel running. Rollback strategy is reverting the deploy.
- Classifier database tables (ClassifierExample, ClassifierEvaluation, ClassifierWeights) are kept read-only — no new writes, but historical data preserved for benchmarking and comparison. Tables are NOT dropped.
