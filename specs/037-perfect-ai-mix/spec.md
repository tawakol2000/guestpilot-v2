# Feature Specification: Perfect AI Mix

**Feature Branch**: `037-perfect-ai-mix`  
**Created**: 2026-04-07  
**Status**: Draft  
**Input**: Perfect mix of old and new AI architecture — restore old schema simplicity and prompt structure while keeping v4 infrastructure improvements

## User Scenarios & Testing

### User Story 1 - Guest receives high-quality, natural responses (Priority: P1)

A guest messages the AI through WhatsApp, Airbnb, or Booking.com. The AI responds with a concise, warm, and accurate message. If the guest writes in Arabic or Arabizi, the AI responds in Egyptian Arabic. The response follows the relevant SOP without the guest noticing any system behind it.

**Why this priority**: This is the core product. Every other feature is worthless if the guest message quality degrades.

**Independent Test**: Send 10 diverse guest messages (WiFi question, cleaning request, complaint, greeting, Arabic message) through the sandbox and evaluate response quality on a 1-5 scale for accuracy, tone, and conciseness.

**Acceptance Scenarios**:

1. **Given** a checked-in guest asks "What's the WiFi password?", **When** the AI processes the message, **Then** it responds with the correct WiFi credentials in 1-2 sentences without calling any unnecessary tools.
2. **Given** a guest writes in Egyptian Arabic "الواي فاي مش شغال", **When** the AI processes the message, **Then** it responds in Egyptian Arabic, acknowledges the issue, and escalates to the manager.
3. **Given** a guest sends "ok thanks 👍", **When** the AI processes the message, **Then** it produces an empty guest message and no escalation.
4. **Given** a guest reports "The AC isn't working and it's been 2 hours", **When** the AI processes the message, **Then** it escalates with urgency "immediate", an empathetic response, and a structured escalation note containing the guest's situation and suggested action.

---

### User Story 2 - Screening agent correctly screens guests without re-asking (Priority: P1)

A potential guest inquires about booking. The AI gathers nationality and party composition, applies screening rules, and escalates with the correct eligible/violation title. It never re-asks questions the guest already answered, never re-screens after a decision is made, and never calls property search before screening is complete.

**Why this priority**: Screening accuracy directly affects bookings and policy compliance. The v4 system introduced regressions (re-asking, re-screening, premature search) that this must fix.

**Independent Test**: Run a 4-turn screening conversation (greeting with question, nationality+composition in Arabic, follow-up question, pricing question) and verify no re-asking, correct screening decision, and no premature property search.

**Acceptance Scenarios**:

1. **Given** a new inquiry guest says "Hi, is there parking? We're from Amman, me and my wife", **When** the AI processes, **Then** it answers the parking question, identifies Jordanian married couple as eligible, creates document checklist, and escalates as "eligible-arab-couple-pending-cert".
2. **Given** a screening decision already exists in open tasks, **When** the guest asks a follow-up question, **Then** the AI answers normally without re-screening or creating duplicate escalations.
3. **Given** a guest has provided nationality but not composition, **When** application code computes screening state, **Then** it injects a hint saying "Missing: party composition" and the AI asks only for the missing piece.
4. **Given** an inquiry guest asks "what apartments do you have?", **When** the AI processes, **Then** it answers from the property-info SOP and does NOT call the property search tool (tool not available during screening).

---

### User Story 3 - Manager receives consistent, actionable escalation notes (Priority: P2)

When the AI escalates, the manager sees a note that immediately tells them what happened, what the guest wants, and what action to take. No guessing, no re-reading the conversation.

**Why this priority**: Managers waste time re-reading conversations when AI notes are vague or inconsistent. Structured notes improve response time.

**Independent Test**: Trigger 5 different escalation types (complaint, maintenance, pricing, screening, info request) and verify each note contains situation context, guest request, and suggested action.

**Acceptance Scenarios**:

1. **Given** a guest reports a broken AC, **When** the AI escalates, **Then** the escalation note includes the situation, what the guest wants (using their words when emotionally charged), and a suggested action.
2. **Given** a screening decision is made for an Egyptian family, **When** the AI escalates, **Then** the manager note includes nationality, party composition, and the screening recommendation.

---

### User Story 4 - Code-tracked screening state replaces model self-report (Priority: P2)

Application code scans conversation history to determine what screening information has been mentioned by the guest. It computes a screening phase (GATHER, DECIDE, or POST_DECISION) and injects it as a content block. The AI reads the phase and acts accordingly without self-tracking.

**Why this priority**: The v4 system's self-report booleans were unreliable. Code-tracked state is deterministic.

**Independent Test**: Run a multi-turn screening conversation where the guest mentions nationality in turn 1 and composition in turn 3. Verify the screening state service correctly tracks mentions and the AI doesn't re-ask.

**Acceptance Scenarios**:

1. **Given** a guest previously said "I'm from Egypt" in the conversation, **When** the screening state service runs, **Then** it detects nationality as mentioned and the hint reflects this.
2. **Given** a screening task exists in open tasks, **When** the screening state service runs, **Then** it returns POST_DECISION phase with a hint telling the AI not to re-screen.
3. **Given** the guest has not mentioned nationality or composition, **When** the screening state service runs, **Then** it returns GATHER phase with a hint listing what's missing.

---

### User Story 5 - Pre-computed context prevents date arithmetic errors (Priority: P2)

The system computes temporal facts (within 2 days of check-in, back-to-back bookings, business hours) in application code and injects them as a content block. The AI reads facts instead of doing date math.

**Why this priority**: Date arithmetic is a known LLM failure mode. Pre-computation eliminates it.

**Independent Test**: Set up a reservation with check-in tomorrow and verify the AI correctly handles an early check-in request without doing date math.

**Acceptance Scenarios**:

1. **Given** a guest's check-in is tomorrow, **When** the AI receives an early check-in request, **Then** the pre-computed context tells it check-in is within 2 days and the AI escalates accordingly.
2. **Given** it's 9pm Cairo time, **When** the AI receives a cleaning request, **Then** the pre-computed context shows it's outside business hours.

---

### User Story 6 - AI can chain multiple tools per response (Priority: P3)

When the AI needs information from multiple tools (e.g., SOP lookup then FAQ lookup), it can call them in sequence across multiple rounds without being blocked by schema enforcement.

**Why this priority**: The old system enforced schema during tool rounds, preventing tool chaining. This caused the AI to miss FAQ answers and availability checks.

**Independent Test**: Send a message that requires both SOP and FAQ lookups. Verify both tools are called and the response uses both results.

**Acceptance Scenarios**:

1. **Given** a guest asks about early check-in within 2 days of arrival, **When** the AI calls the SOP tool, **Then** it can subsequently call the extend-stay availability tool without being forced to output final JSON.
2. **Given** a guest asks a property question not fully covered by the SOP, **When** the AI calls the SOP tool first, **Then** it can call the FAQ tool as a follow-up.

---

### User Story 7 - Reasoning visibility for debugging (Priority: P3)

The manager can toggle a setting to see the AI's internal reasoning in the inbox. This uses the model's internal reasoning parameter, not a schema field. Off by default.

**Why this priority**: Debugging tool for monitoring AI behavior. Not guest-facing.

**Independent Test**: Enable the reasoning toggle, send a message, and verify reasoning information appears in the inbox UI.

**Acceptance Scenarios**:

1. **Given** the reasoning toggle is enabled, **When** the AI responds, **Then** the inbox shows reasoning context alongside the response.
2. **Given** the reasoning toggle is disabled (default), **When** the AI responds, **Then** no reasoning is visible.

---

### Edge Cases

- What happens when a guest changes their party composition after screening is complete? The AI escalates as "escalation-unclear" for manager re-review.
- What happens when the manager responds before the AI? Pre-response sync detects this and cancels the AI reply.
- What happens when WiFi SOP is requested for an INQUIRY guest? Status-specific variant shares only "WiFi available, details after check-in" — no credentials leaked.
- What happens when the AI's JSON output is malformed after tool calls? Post-tool schema enforcement makes a final call with strict schema to get valid JSON.
- What happens when conversation has 50+ messages? Summary service compresses older messages; AI sees 10 recent messages plus a summary of earlier context.
- What happens when the screening state regex misses a nationality mention? The AI asks again; the guest says "I already told you"; the AI sees it in conversation history and corrects. Worst case: one redundant ask.

## Requirements

### Functional Requirements

- **FR-001**: System MUST use the existing 4-field coordinator schema (guest_message, escalation, resolveTaskId, updateTaskId) with no additional fields
- **FR-002**: System MUST use a 2-field screening schema (guest_message, manager) with the field name standardized to `guest_message`
- **FR-003**: System MUST use a single `<critical_rule>` XML tag per prompt as the primary behavioral anchor
- **FR-004**: System MUST use XML tags for prompt structure sections, providing strong structural signals for the model
- **FR-005**: System MUST serve status-specific SOP variants so the model receives only the relevant instruction for the current reservation status
- **FR-006**: System MUST NOT inject WiFi passwords or door codes into SOP content for INQUIRY-status guests — credentials are only available in post-booking variants
- **FR-007**: System MUST compute screening state in application code by scanning conversation history for nationality/composition mentions and checking open tasks for existing screening decisions
- **FR-008**: System MUST inject the computed screening state as a content block so the AI reads the determined phase rather than self-tracking
- **FR-009**: System MUST NOT include the property search tool in the tool set for INQUIRY/PENDING reservations
- **FR-010**: System MUST compute pre-computed context variables (business hours, days until check-in/out, back-to-back flags, screening state) in application code and inject as a content block
- **FR-011**: System MUST defer JSON schema enforcement until after tool rounds are complete, allowing the AI to chain multiple tool calls
- **FR-012**: System MUST sync with the booking platform before generating an AI response to detect if the manager already replied
- **FR-013**: System MUST inject conversation summaries for threads with more than 10 messages, using a 10-message recent window plus a summary for older context
- **FR-014**: System MUST derive action classification from the response structure in code, not from a model-reported schema field
- **FR-015**: System MUST derive SOP step tracking from tool call logs, not from a model-reported schema field
- **FR-016**: System MUST support multilingual responses via a single prompt instruction for language matching
- **FR-017**: System MUST include a FAQ retrieval tool for property-specific factual questions, with tool priority: SOP first, FAQ second, escalate third
- **FR-018**: System MUST prevent duplicate screening escalations when a screening task already exists
- **FR-019**: System MUST derive screening urgency from the escalation title pattern (eligible/violation titles get booking-decision urgency, others get info-request urgency)
- **FR-020**: System MUST use dynamic reasoning effort that increases for distressed/complex messages and stays low for routine ones
- **FR-021**: System MUST safely migrate existing SOP content, preserving any user-customized content and only updating content that still matches the previous default
- **FR-022**: System MUST provide a manager-facing toggle to show/hide AI reasoning in the inbox, off by default

### Key Entities

- **Screening State**: Computed phase (GATHER/DECIDE/POST_DECISION) with nationality/composition mention detection and existing screening task awareness — injected as a content block for the screening agent
- **Pre-Computed Context**: Temporal and calendar variables computed per-request in application code — eliminates model date arithmetic
- **SOP Variant**: Status-specific SOP content resolved by application code, keeping credential-sensitive content separate from pre-booking statuses

## Success Criteria

### Measurable Outcomes

- **SC-001**: Guest message quality is rated equal or higher than the pre-v4 system across 20 diverse test scenarios in a blind comparison
- **SC-002**: The AI never leaks WiFi passwords or door codes to pre-booking guests across all test scenarios
- **SC-003**: The screening agent never re-asks for information the guest already provided in the conversation across 10 multi-turn screening tests
- **SC-004**: The screening agent never re-screens after a screening decision already exists
- **SC-005**: The screening agent never calls property search before screening is complete
- **SC-006**: Escalation notes consistently contain situation context, guest request, and suggested action across all escalation types
- **SC-007**: Average response time is within 20% of the pre-v4 system
- **SC-008**: The AI successfully chains tools when needed in at least 90% of multi-tool scenarios
- **SC-009**: Per-response token cost is within 15% of the pre-v4 system

## Assumptions

- The pre-v4 system on the `main` branch is the quality baseline for response evaluation
- The AI model handles Egyptian Arabic, Arabizi, and code-switching naturally with a single prompt instruction
- The model's internal reasoning parameter provides sufficient chain-of-thought without an output schema field
- Status-specific SOP variants may have been customized by the user and must be preserved during migration
- A 10-message recent history window plus conversation summary provides better context than raw 20-message history
