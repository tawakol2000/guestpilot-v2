# Feature Specification: Coordinator Prompt Rework with Reasoning

**Feature Branch**: `033-coordinator-prompt-rework`  
**Created**: 2026-04-05  
**Status**: Draft  
**Input**: Rework the coordinator system prompt, output schema, tool definitions, and add reasoning effort selector based on expert AI chatbot recommendations.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Chain-of-Thought Reasoning in Responses (Priority: P1)

The AI assistant produces an internal reasoning step before every response. This reasoning captures what the guest is asking, what context is available, which SOP or tool applies, and what the right response is. The reasoning is never shown to the guest — it is stripped before delivery and logged for debugging. This forces the model to think before committing to a response, reducing errors like skipping self-assessment or misrouting tool calls.

**Why this priority**: The reasoning field directly addresses the root cause of multiple production failures (e.g., the property search incident where the model responded without thinking). It's the highest-impact change with the lowest implementation risk.

**Independent Test**: Send a guest message via the sandbox. Verify the AI response includes a populated reasoning field in AI Logs, but the guest-facing message delivered to Hostaway does not contain the reasoning. Verify the reasoning shows logical steps (what's asked → what context exists → what action to take).

**Acceptance Scenarios**:

1. **Given** a guest asks "What's the WiFi password?", **When** the AI responds, **Then** the reasoning field says something like "WiFi credentials in reservation details, no tool needed" and the guest_message contains the password. The reasoning does not appear in the message sent to the guest.

2. **Given** a guest sends a complex multi-intent message (complaint + extension request), **When** the AI responds, **Then** the reasoning field identifies both intents, explains which is urgent, and justifies the escalation level chosen.

3. **Given** a guest sends "ok thanks 👍", **When** the AI responds, **Then** the reasoning field says "acknowledgment, no action needed" and guest_message is empty. No reasoning is leaked.

4. **Given** the reasoning field is missing or empty in the AI output (model failure), **When** the system processes the response, **Then** it still delivers the guest_message and logs the anomaly — it does not crash.

---

### User Story 2 — Improved Escalation Quality (Priority: P1)

The system prompt includes a numbered escalation decision ladder that the AI follows in priority order (safety → strong emotion → unauthorized action → SOP says → FAQ empty → uncertain). Escalation notes follow a structured format (Guest / Situation / Guest wants / Context / Suggested action / Urgency reason) so managers receive consistent, actionable handoff notes.

**Why this priority**: Escalation quality directly affects how quickly managers can act. Inconsistent or vague notes waste manager time. The structured format also enables future automation (auto-parsing escalation notes).

**Independent Test**: Send messages triggering different escalation types (safety concern, complaint, unknown question). Verify each escalation note follows the structured format and the urgency level matches the decision ladder.

**Acceptance Scenarios**:

1. **Given** a guest reports "there's smoke coming from the kitchen", **When** the AI processes this, **Then** it escalates with urgency "immediate" without calling any tools first, and the note follows the structured format.

2. **Given** a guest says "this is unacceptable, I want a refund", **When** the AI processes this, **Then** it escalates with urgency "immediate" (strong negative emotion), not "scheduled" (refund request), because emotion outranks unauthorized action in the ladder.

3. **Given** a guest asks "do you have a rooftop terrace?" and neither SOP nor FAQ has the answer, **When** the AI processes this, **Then** it escalates as "info_request" with a note that includes what was tried (SOP and FAQ both returned nothing).

4. **Given** an existing open task covers the same topic as the new escalation, **When** the AI processes this, **Then** it uses updateTaskId instead of creating a duplicate, and the note explains the update.

---

### User Story 3 — Enhanced Tone and Conversation Repair (Priority: P2)

The system prompt includes tone calibration guidance with good/bad examples, language matching rules (Arabic/English), and a conversation repair section for when the guest signals a misunderstanding. The AI matches response length to the situation — operational answers are one sentence, emotional situations get two to four sentences with acknowledgment first.

**Why this priority**: Tone failures (too cheerful during complaints, too cold during distress, filler padding) make the AI feel robotic. Conversation repair prevents the AI from ignoring "that's not what I meant" signals. Important for guest satisfaction but less critical than reasoning and escalation quality.

**Independent Test**: Send a complaint message and verify the tone is empathetic, not cheerful. Send a follow-up "that's not what I meant" and verify the AI acknowledges the correction in four words or fewer, then answers the actual question.

**Acceptance Scenarios**:

1. **Given** a guest sends an angry complaint about AC not working, **When** the AI responds, **Then** the response acknowledges the frustration before providing information or escalating. No cheerful greetings or filler.

2. **Given** a guest says "that's not what I meant, I asked about checkout time not check-in", **When** the AI responds, **Then** it acknowledges the correction briefly ("Got it — checkout time is 11am.") without referencing the mistake again.

3. **Given** a guest writes in Arabic, **When** the AI responds, **Then** it responds in Arabic. If the guest mixes Arabic and English, the AI follows the same pattern.

---

### User Story 4 — Tool Reasoning and Richer Descriptions (Priority: P2)

Every tool call includes a reasoning field explaining why the AI chose that tool and those parameters. Tool descriptions include explicit CALL/DO NOT CALL boundaries to reduce misrouting. The reasoning is logged for debugging — it is not shown to the guest.

**Why this priority**: Tool misrouting (calling search when SOP would suffice, calling get_faq before get_sop) was the root cause of the property search failure. Reasoning on tool calls makes misrouting visible and debuggable. CALL/DO NOT CALL boundaries reduce the likelihood of misrouting in the first place.

**Independent Test**: Send a guest message that requires a tool call. Verify the tool call in AI Logs includes a reasoning field explaining the choice. Send a message that should NOT trigger a specific tool and verify it doesn't.

**Acceptance Scenarios**:

1. **Given** a guest asks "can you clean tomorrow?", **When** the AI calls get_sop, **Then** the tool call includes reasoning like "Guest requesting cleaning service, maps to sop-cleaning category."

2. **Given** a guest asks "is there parking?", **When** the AI calls get_faq, **Then** the tool call includes reasoning like "Factual property question, SOP didn't cover it, trying FAQ for parking info."

3. **Given** a guest sends a passport image with pending documents, **When** the AI calls mark_document_received, **Then** the tool call includes reasoning like "Image shows passport photo page, matching pending passport requirement."

---

### User Story 5 — Dynamic Reasoning Effort (Priority: P3)

The system adjusts how much computational effort the AI model spends on reasoning based on message complexity. Simple messages (greetings, acknowledgments, basic questions) use minimal reasoning effort to save cost. Complex messages (distress signals, multi-intent, long messages, multiple open tasks) use higher reasoning effort for better response quality. This optimizes cost without sacrificing quality when it matters.

**Why this priority**: Cost optimization that doesn't affect response quality for simple messages. The 90% of messages that are simple run cheaper, while the 10% that are complex get the reasoning investment they need. Nice to have but not critical — the system works fine with a fixed reasoning effort.

**Independent Test**: Send a simple "what's the wifi?" message and verify low reasoning effort is used. Send an angry complaint message and verify medium reasoning effort is used. Check AI Logs to confirm the effort level.

**Acceptance Scenarios**:

1. **Given** a guest sends "ok thanks", **When** the system selects reasoning effort, **Then** it picks "low".

2. **Given** a guest sends "THIS IS UNACCEPTABLE!!!! THE AC HAS BEEN BROKEN FOR HOURS", **When** the system selects reasoning effort, **Then** it picks "medium" (distress signals + ALL CAPS).

3. **Given** a guest sends a 400-character message with two distinct requests, **When** the system selects reasoning effort, **Then** it picks "medium" (long message).

4. **Given** a conversation has 3 open tasks, **When** the system selects reasoning effort, **Then** it picks "medium" (multiple open tasks = complex state).

5. **Given** the reasoning effort selector fails or throws an error, **When** the system proceeds, **Then** it defaults to "low" and logs the error — it does not crash.

---

### Edge Cases

- What happens when the model produces a reasoning field longer than 80 words? The system logs it as-is (reasoning is for debugging, not enforced at a word count). The prompt instructs "under 80 words" but this is a soft guideline, not a hard schema constraint.
- What happens when the model omits the reasoning field despite the schema requiring it? With strict JSON schema enforcement, this cannot happen — the schema guarantees the field is present. If it's an empty string, the system logs the anomaly but delivers the response normally.
- What happens when distress signal detection produces a false positive (e.g., guest says "I love your review of the apartment")? The system uses medium reasoning effort unnecessarily — a minor cost increase with no quality impact. Acceptable tradeoff.
- What happens when the guest's message is in Arabic and contains distress signals? The selector includes Arabic distress terms (غاضب, مش معقول, بشتكي) in its detection list.
- What happens when the reasoning effort parameter is not supported by the model version? The system falls back to default behavior (no reasoning effort parameter sent). The response still works normally.
- What happens when multiple escalation ladder rules match? The ladder is evaluated in order — the first match wins. Safety always outranks emotion, emotion always outranks unauthorized action, etc.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The coordinator output schema MUST include a `reasoning` field as the first property (token-order chain-of-thought — the model writes reasoning before committing to guest_message). It MUST be a required string. The "under 80 words" guidance is a soft prompt instruction, not a schema constraint — the system logs whatever the model produces. If reasoning is an empty string, the system logs an anomaly but delivers the response normally.

- **FR-002**: The coordinator system prompt MUST include a numbered escalation decision ladder evaluated in strict priority order — stop at the first match: (1) safety → immediate, (2) strong negative emotion → immediate, (3) unauthorized action → scheduled, (4) SOP explicitly says escalate → use SOP's urgency, (5) FAQ returned nothing for factual question → info_request, (6) asking clarifying question → null, (7) answer available in context/SOP → null, (8) conversation-ending message → null with empty guest_message, (9) uncertain → info_request with note prefix "Omar uncertain:". When the ladder and SOP conflict (e.g., SOP says scheduled but emotion says immediate), the ladder wins — earlier rules outrank later ones.

- **FR-003**: Escalation notes MUST follow a structured format with all 6 fields required: Guest (name, unit), Situation (one sentence), Guest wants (quote the guest's words when possible, paraphrase only if the guest's message is too long or unclear), Context (2-3 relevant facts), Suggested action (what the AI would do if authorized), Urgency reason (why this urgency level was chosen over the level below it in the ladder). This is a prompt-enforced soft format, not schema-validated.

- **FR-004**: The system prompt MUST include a conversation repair section instructing the AI to: acknowledge a misunderstanding briefly (roughly four words — e.g., "Got it — you mean…"), restate the corrected understanding, answer the actual question, and not reference the miss again.

- **FR-005**: The system prompt MUST include tone calibration with good/bad examples covering: operational (WiFi/code), emotional (complaint), and Arabic scenarios. Response length guidance: one sentence for operational, two to four for emotional/complex. Language matching: respond in the guest's language. For Arabic, default to formal (حضرتك) on first contact, relax once the guest uses informal forms. For other languages (French, German, etc.), respond in the same language. Keep reasoning always in English.

- **FR-006**: The system prompt MUST include a tool routing table mapping guest intents to first-tool actions, maintaining the SOP-first pattern for operational requests. Multi-intent messages: call get_sop first with all relevant categories, then the secondary tool (e.g., check_extend_availability). The table MUST cover: cleaning, maintenance, WiFi, visitors, complaints, bookings, pricing, check-in/out, amenity requests, extend/shorten stay, property search, document images, greetings, acknowledgments, and multi-intent.

- **FR-007**: The system prompt MUST include worked examples demonstrating the reasoning field in different scenarios (direct answer, SOP-grounded with clarification, multi-intent with escalation, acknowledgment).

- **FR-008**: All tool definitions (get_faq, check_extend_availability, mark_document_received, search_available_properties) MUST include a `reasoning` parameter as the first property, explaining why the AI chose that tool and those parameters. The get_sop tool already has this. Tool reasoning MUST be logged in ragContext.tools alongside existing tool call data (name, input, results, durationMs).

- **FR-009**: All tool descriptions MUST include explicit CALL and DO NOT CALL boundaries listing what the tool is for and what it is NOT for, with redirection to the correct tool.

- **FR-010**: The system MUST select reasoning effort (low or medium) before each coordinator AI call based on the raw guest message text and open task count. Signals that trigger "medium": (a) distress keywords from a configurable list (English and Arabic — list can be expanded without code changes), (b) entire message is uppercase AND longer than 20 characters, (c) 2 or more open tasks for this conversation, (d) raw guest message text (not including injected context) exceeds 300 characters. Default is "low". The selected effort level MUST be logged in ragContext.reasoningEffort.

- **FR-011**: If the reasoning effort selector fails, the system MUST default to "low" and log the error.

- **FR-012**: The reasoning field MUST be stripped from the parsed JSON response before the guest_message is sent to Hostaway. The reasoning MUST NOT be stored in the Message database record (content field contains only guest_message). The reasoning IS preserved in AiApiLog.responseText (the full raw AI output). The reasoning MUST be included in the SSE broadcast as a `reasoning` field on the existing message object (not a separate event).

- **FR-013**: The system MUST provide a toggle in Settings (per-tenant, not per-user) to show or hide AI reasoning in the chat UI. Default is off. When enabled, reasoning is displayed as a collapsible/muted element above or below AI message bubbles in the inbox (e.g., small italic text with a "Reasoning" label). When disabled, reasoning is hidden from the chat UI but still available in AI Logs. Reasoning is only available for messages received while the SSE connection is active — historical messages do not retroactively show reasoning (it's not stored in the Message record).

- **FR-014**: The existing content block structure (RESERVATION_DETAILS, OPEN_TASKS, CONVERSATION_HISTORY, CURRENT_MESSAGES, CURRENT_LOCAL_TIME, DOCUMENT_CHECKLIST) MUST remain unchanged.

- **FR-015**: The SOP-first tool pattern (get_sop is always the first tool for operational requests) MUST be preserved.

- **FR-016**: The search_available_properties tool description MUST reflect the current semantic scoring behavior (scores current property and alternatives together, returns match breakdown).

### Key Entities

- **Reasoning Field**: Internal chain-of-thought text produced by the AI before every response. Under 80 words. Logged for debugging, never shown to guests.
- **Escalation Note**: Structured handoff to manager following a fixed format. Created when the AI cannot fully resolve a guest need.
- **Reasoning Effort Level**: Binary selector (low/medium) that adjusts model computation based on message complexity signals.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of coordinator AI responses include a non-empty reasoning field in AI Logs, demonstrating the model is thinking before responding.

- **SC-002**: Escalation notes follow the structured format (Guest/Situation/Guest wants/Context/Suggested action/Urgency reason) in at least 90% of escalations, measured by spot-checking AI Logs.

- **SC-003**: Zero instances of reasoning field content appearing in guest-facing messages (verified by auditing delivered messages).

- **SC-004**: Tool call misrouting rate decreases — measured by reduction in cases where the AI calls the wrong tool (e.g., search when SOP suffices). Baseline established from current AI Logs before deployment.

- **SC-005**: 90% of simple messages (greetings, acknowledgments, WiFi/code questions) use low reasoning effort, while 90% of complex messages (complaints, multi-intent, long messages) use medium.

- **SC-006**: Per-message cost for simple messages does not increase compared to baseline (reasoning effort "low" is at least as cheap as current behavior).

## Assumptions

- The AI model supports a reasoning effort parameter (low/medium/high). If not supported, the system degrades gracefully by not sending the parameter.
- The reasoning field adds ~20-50 tokens per response. At nano/mini pricing this is negligible cost impact.
- The structured escalation note format can be taught via the system prompt and worked examples without schema enforcement on the note field itself.
- The conversation repair behavior can be taught via prompt instructions — it does not require a separate detection mechanism.
- Arabic distress signals in the reasoning effort selector cover the most common expressions. The list can be expanded over time without code changes (configurable).
- The existing content block injection and template variable system is compatible with the new prompt structure.

## Clarifications

### Session 2026-04-05

- Q: Where is the reasoning field visible — only AI Logs, or also in the chat UI? → A: Strip from Hostaway send only. SSE broadcast includes reasoning. Add a toggle in Settings to show/hide AI reasoning in the chat UI. Default off.
- Q: Is "under 80 words" a hard schema constraint? → A: No — soft prompt guideline. System logs whatever the model produces.
- Q: What happens when SOP urgency conflicts with the escalation ladder? → A: Ladder wins. Earlier rules outrank later ones (e.g., emotion outranks SOP's "scheduled").
- Q: Is reasoning stored in the Message DB record? → A: No. Message.content has only guest_message. Reasoning is in AiApiLog.responseText and SSE broadcast only.
- Q: How does reasoning display in the inbox? → A: Collapsible/muted element near the AI message bubble. Only for live messages (SSE) — no retroactive display for historical messages.
- Q: Does ALL CAPS check mean the entire message is uppercase? → A: Yes — the entire message must be uppercase AND > 20 characters.
- Q: Is message length checked against raw guest text or full context? → A: Raw guest message text only, not including injected context.
- Q: Does reasoning field affect the screening agent? → A: No — added to coordinator schema only. Screening schema is separate and untouched.
- Q: Is the distress signal list hardcoded or configurable? → A: Configurable — can be expanded without code changes.
- Q: Multi-intent messages — which tool first? → A: get_sop first with all relevant categories, then secondary tools.

## Out of Scope

- Screening agent prompt changes (separate feature — screening has different schema and rules). The reasoning field is added to the coordinator schema ONLY. The screening agent schema is untouched and will not break — they use separate schema definitions.
- Conversation history as role-separated messages (deferred — currently stays as flat text block).
- get_faq dynamic category loading (categories remain as currently defined).
- get_faq query_terms parameter (deferred for future embedding-based retrieval).
- check_extend_availability change_type enum (current date inference works fine).
- Reasoning effort "high" level (only low and medium for now).
