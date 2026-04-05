# Feature Specification: SOP Library v4 Rewrite

**Feature Branch**: `034-sop-v4-rewrite`  
**Created**: 2026-04-06  
**Status**: Draft  
**Depends on**: `033-coordinator-prompt-rework` (reasoning field, system prompt structure)

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Structured Markdown SOPs with Status Splitting (Priority: P1)

All 22 SOP categories are rewritten in structured Markdown with XML section tags (`<sop>`, `<description>`, `<inputs>`, `<paths>`, `<rules>`, `<example>`). Multi-status SOPs are split into separate documents per (category, status) pair — the model only ever sees the one relevant to the current booking status. Each SOP includes numbered paths with trigger conditions and action sequences, positive-directive rules, and at least one worked example showing exact JSON output.

**Why this priority**: The SOP content is the core of the feature. Without it, nothing else works.

**Independent Test**: Call get_sop for a cleaning request with CHECKED_IN status. Verify the returned content is the `sop-cleaning:checked-in` variant (not a multi-status document), follows the structured Markdown format, and includes paths, rules, and an example.

**Acceptance Scenarios**:

1. **Given** a checked-in guest asks for cleaning, **When** get_sop returns content, **Then** only the checked-in variant is returned with paths A-D, rules as positive directives, and a worked example.
2. **Given** a pre-booking guest asks about amenities, **When** get_sop returns content, **Then** only the pre-booking variant is returned — no checked-in paths visible.
3. **Given** maintenance is reported, **When** get_sop returns content, **Then** a single `:all` variant is returned with safety/comfort-critical/non-critical paths.
4. **Given** the classifier returns "none", **When** the pipeline processes it, **Then** no get_sop content is fetched — the system prompt handles greetings/acknowledgments directly.

---

### User Story 2 — Action Enum and SOP Step in Output Schema (Priority: P1)

The coordinator JSON schema adds two fields: `action` (enum: reply, ask, offer, escalate, none) and `sop_step` (string, format `{sop_name}:{path_identifier}`, null if no SOP consulted). The `action` field makes the model's intent explicit and enables post-parse validation. The `sop_step` field enables debugging and eval — every response is traceable to a specific SOP path.

**Why this priority**: Without `action` and `sop_step`, we can't validate responses or debug SOP routing. These fields are referenced by every SOP's worked examples.

**Independent Test**: Send a message via sandbox. Verify the response includes `action` (valid enum value) and `sop_step` (matching the SOP path taken). Verify post-parse validation catches inconsistencies (e.g., action="reply" with escalation populated).

**Acceptance Scenarios**:

1. **Given** a guest asks "what's the WiFi?", **When** the AI responds, **Then** action is "reply", sop_step is null (answered from context), escalation is null.
2. **Given** a guest asks for cleaning, **When** the AI asks for a preferred time, **Then** action is "ask", sop_step is "cleaning_checked_in:path_a_awaiting_time", escalation is null.
3. **Given** a guest reports a safety issue, **When** the AI escalates, **Then** action is "escalate", escalation.urgency is "immediate", sop_step identifies the maintenance safety path.
4. **Given** action is "escalate" but escalation is null, **When** post-parse validation runs, **Then** it flags the inconsistency and logs an error.
5. **Given** action is "reply" but escalation is populated, **When** validation runs, **Then** it flags and logs.

---

### User Story 3 — Pre-Computed Context Variables (Priority: P1)

Application code computes temporal and calendar-based predicates before every AI call and injects them as a new content block. SOPs reference these variables by name in natural language (e.g., "When is_business_hours is true"). Variables include: is_business_hours, days_until_checkin, is_within_2_days_of_checkin, days_until_checkout, is_within_2_days_of_checkout, stay_length_nights, is_long_term_stay, has_back_to_back_checkin, has_back_to_back_checkout.

**Why this priority**: SOPs reference these variables. Without them, the model has to compute temporal logic from raw dates — which LLMs do unreliably.

**Independent Test**: Trigger an AI response for a guest checking in tomorrow. Verify the pre-computed context includes `days_until_checkin: 1`, `is_within_2_days_of_checkin: true`, and these values appear in AI Logs ragContext.

**Acceptance Scenarios**:

1. **Given** a guest with check-in in 5 days, **When** the AI call is prepared, **Then** pre-computed context includes `days_until_checkin: 5`, `is_within_2_days_of_checkin: false`.
2. **Given** a guest checking in tomorrow with a back-to-back booking, **When** early check-in SOP is retrieved, **Then** the SOP correctly routes to the "back-to-back detected" path using the pre-computed `has_back_to_back_checkin: true`.
3. **Given** current time is 3pm Cairo time, **When** a cleaning request is processed, **Then** `is_business_hours: true` and the SOP routes to "within hours" path.

---

### User Story 4 — Post-Parse Validation (Priority: P2)

After the model returns a response, application code validates consistency between `action` and other fields. Catches semantically invalid outputs that pass schema validation (e.g., action="reply" with escalation populated, action="escalate" with escalation null, action="none" with non-empty guest_message).

**Why this priority**: Defense-in-depth. The schema enforces structure, validation enforces semantics. Important but the system works without it (we already handle edge cases in the current pipeline).

**Independent Test**: Feed malformed responses through the validator. Verify it catches all inconsistency types and logs them.

**Acceptance Scenarios**:

1. **Given** action="escalate" and escalation=null, **When** validation runs, **Then** it returns an error and the system falls back to a generic escalation.
2. **Given** action="none" and guest_message="Hello!", **When** validation runs, **Then** it returns an error.
3. **Given** a valid response, **When** validation runs, **Then** it returns no errors and the response proceeds normally.

---

### User Story 5 — System Prompt Updates for SOP v4 (Priority: P2)

The coordinator system prompt is updated with: (a) "How to read SOPs and produce output" section explaining the action enum and SOP path structure, (b) hard constraints restated as positive directives and bookended (placed near top AND bottom of prompt), (c) v3 grammar legend removed.

**Why this priority**: The system prompt needs to teach the model how to read the new SOP format. Without this, the model might misparse the structured paths.

**Independent Test**: Verify the system prompt contains the SOP reading instructions and bookended constraints. Send a test message and verify the model correctly follows an SOP path.

**Acceptance Scenarios**:

1. **Given** the updated system prompt, **When** get_sop returns a v4 SOP, **Then** the model follows the path structure (reads trigger, executes steps, produces matching JSON with action and sop_step).
2. **Given** bookended constraints, **When** the model processes a refund request, **Then** it escalates (constraint retained from both prompt positions).

---

### Edge Cases

- What happens when the classifier returns a category that has no status-specific variant for the current status? Fall back to the `:all` variant. If no variant exists, return "No SOP content available."
- What happens when sop_step is null but get_sop was called? Log a warning but don't crash — the model may have determined no specific path applied.
- What happens when action is a valid enum value but doesn't match the SOP's expected action for that path? Log the mismatch for debugging but deliver the response — the action enum is informational for now, not blocking.
- What happens when pre-computed context variables can't be computed (e.g., missing check-in date)? Use sensible defaults (is_business_hours: false, days_until_checkin: 999, etc.) and log the gap.
- What happens when "none" classification fires but the guest actually needs help? The system prompt instructions for "none" include "answered by reservation details" — the model can still answer from context without SOP content.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: All 22 SOP categories MUST be rewritten in structured Markdown with XML section tags (`<sop>`, `<description>`, `<inputs>`, `<paths>`, `<rules>`, `<example>`).

- **FR-002**: SOPs with status-dependent behavior MUST be split into separate documents per (category, status) pair. The SOP service returns only the variant matching the current booking status.

- **FR-003**: The coordinator output schema MUST include an `action` enum field with values: "reply", "ask", "offer", "escalate", "none". This field is required.

- **FR-004**: The coordinator output schema MUST include a `sop_step` field (string or null) in format `{sop_name}:{path_identifier}`. Null when no SOP was consulted.

- **FR-005**: Application code MUST compute pre-computed context variables before every coordinator AI call: is_business_hours, days_until_checkin, is_within_2_days_of_checkin, days_until_checkout, is_within_2_days_of_checkout, stay_length_nights, is_long_term_stay, has_back_to_back_checkin, has_back_to_back_checkout. These MUST be injected as a content block visible to the model.

- **FR-006**: Post-parse validation MUST check consistency between `action` and other fields: escalate requires non-null escalation, non-escalate requires null escalation, none requires empty guest_message, reply/ask/offer require non-empty guest_message.

- **FR-007**: On validation failure, the system MUST log the full response, and either retry or fall back to a generic "let me check with the manager" escalation. It MUST NOT silently accept invalid responses.

- **FR-008**: Each SOP MUST include at least one worked example showing exact JSON output for a common path, including the action and sop_step fields.

- **FR-009**: All negative constraints (NEVER blocks) MUST be converted to positive directives ("Always X" instead of "Never Y").

- **FR-010**: The system prompt MUST include a "How to read SOPs" section explaining the action enum values and path structure.

- **FR-011**: Hard operating constraints MUST be bookended — placed both near the top (after identity) AND at the bottom of the system prompt.

- **FR-012**: When the classifier returns "none", the pipeline MUST skip the get_sop tool call and let the model respond directly from context and system prompt instructions.

- **FR-013**: Pre-computed context variables MUST be logged in ragContext for debugging.

- **FR-014**: The `action` and `sop_step` fields MUST be logged in ragContext and AiApiLog for every coordinator response.

- **FR-015**: Existing template variable interpolation ({PROPERTY_DESCRIPTION}, {AVAILABLE_AMENITIES}, {ON_REQUEST_AMENITIES}, {ACCESS_CONNECTIVITY}) MUST continue to work unchanged in the new SOP format.

- **FR-016**: The screening agent schema and prompt MUST NOT be affected by these changes.

### Key Entities

- **SOP Document**: A self-contained Markdown document keyed by (category, status). Contains description, inputs, numbered paths, rules, and worked examples.
- **Pre-Computed Context**: A set of boolean and numeric variables computed from reservation data and current time before each AI call.
- **Action Enum**: The discrete action the model is taking (reply, ask, offer, escalate, none).
- **SOP Step**: A traceable identifier of the SOP path taken, format `{sop_name}:{path_identifier}`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of coordinator responses include a valid `action` enum value and `sop_step` field (null or formatted string) in AI Logs.

- **SC-002**: Post-parse validation error rate is below 2% within the first week of deployment.

- **SC-003**: SOP content token count reduces by at least 40% compared to current prose SOPs (measured per-fetch average).

- **SC-004**: Multi-turn confirmation flows (cleaning, amenity requests) correctly use "ask" on first turn and "escalate" on second turn in at least 85% of cases.

- **SC-005**: Pre-computed context variables are present in ragContext for 100% of coordinator AI calls.

- **SC-006**: Zero regressions in escalation accuracy compared to the current system (measured by manual review of 50 production escalations before and after).

## Assumptions

- The `033-coordinator-prompt-rework` branch (reasoning field, escalation ladder, tool reasoning) is merged before this feature begins.
- The existing SopVariant architecture (per-status variants with property overrides) maps cleanly to the new status-split SOPs.
- GPT-5.4 Mini can reliably parse structured Markdown with XML tags — this is the format used by OpenAI's own GPT-5 cookbook and production platforms.
- The `action` enum with 5 values (not 7) is sufficient. Escalation urgency stays in the escalation object.
- Pre-computed context as a content block (template variable) works as well as a separate developer message for our pipeline.

## Deferred

- Programmatic confirmation gate (monitor multi-turn failure rate first, implement if > 10%)
- Persisting `sop_step` and `action` in message metadata (currently only in ragContext/AiApiLog)
- Eval harness with 40+ labeled test cases (important but separate tooling work)
- Wave-based rollout with feature flags per SOP (implement if regression detected)
- Conversation history as role-separated messages (deferred from 033)

## Out of Scope

- Screening agent changes (separate schema, separate prompt)
- Frontend changes (no UI impact — action/sop_step are backend-only)
- New SOP categories (only rewriting existing 22 categories)
- Custom tool webhook changes
