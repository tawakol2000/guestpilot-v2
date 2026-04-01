# Feature Specification: Smart Conversation Context Summarization

**Feature Branch**: `024-smart-context-summary`
**Created**: 2026-04-01
**Status**: Draft
**Input**: Reduce conversation history from 20 messages to 10 recent messages + an intelligent summary of older messages. Summary captures only critical context (guest identity, special arrangements, key decisions) while excluding routine operational details already tracked in open tasks. Must be efficient — not regenerated on every message.

## Clarifications

### Session 2026-04-01

- Q: Should summary generation happen synchronously (during AI call) or asynchronously (background, ready for next message)? → A: Asynchronous — fire-and-forget after AI response is sent. Zero latency impact. Use the cheapest available model for summarization.
- Q: What message roles count toward the 10-message window? → A: GUEST + AI only. AI_PRIVATE messages (internal notes, delivery failures) are excluded from both the window count and the history provided to the AI.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Intelligent Context Window with Summary (Priority: P1)

Currently, every AI response includes the last 20 raw messages as conversation history. This wastes token budget on repetitive operational exchanges ("what time for cleaning?" / "10am please" / "confirmed") while sometimes losing critical context from earlier in long conversations (e.g., "I'm booking for my brother, not for myself" from message 5 of a 40-message conversation).

The system should include the last 10 raw messages plus a compact summary of everything before that. The summary captures only information the AI needs to maintain continuity — guest identity details, special arrangements, key decisions, unresolved commitments — while excluding routine service exchanges that are already tracked in the open tasks system.

**Why this priority**: This is the core feature. Without it, the AI either wastes tokens on redundant history or loses critical context in long conversations. Directly improves response quality and reduces per-message cost.

**Independent Test**: Send 15+ messages in a conversation. On message 16, the AI receives only the last 10 raw messages plus a summary. The AI's response demonstrates awareness of critical context from early messages (e.g., guest's special requests, identity details) without having seen them in the raw history.

**Acceptance Scenarios**:

1. **Given** a conversation with 25 messages, **When** the AI processes message 26, **Then** it receives the last 10 messages verbatim plus a summary covering messages 1-16 that includes critical context (guest preferences, identity details, special arrangements).
2. **Given** a conversation with 8 messages, **When** the AI processes message 9, **Then** it receives all 8 messages verbatim with no summary (summary is unnecessary when history fits within the 10-message window).
3. **Given** a conversation where the guest said "I'm booking for my brother Ahmed, he'll be the one staying" in message 3, **When** the AI processes message 20, **Then** the summary includes this critical identity context even though message 3 is no longer in the raw history window.
4. **Given** a conversation with routine cleaning/WiFi exchanges in messages 5-10, **When** the summary is generated, **Then** these routine exchanges are omitted from the summary because they are tracked in open tasks.
5. **Given** a summary already exists for messages 1-10, **When** messages 11-20 arrive and the window shifts, **Then** the summary is extended to cover messages 1-20 without re-summarizing messages 1-10 from scratch.

---

### User Story 2 - Efficient Summary Generation (Priority: P2)

Summaries must not be generated on every single guest message — that would double the AI cost per conversation. The system should generate or extend a summary only when the conversation grows beyond the raw message window AND the existing summary is stale (doesn't cover the messages that have scrolled out of the window).

**Why this priority**: Without efficiency controls, the summarization feature could increase costs rather than reduce them. The trigger logic determines when summaries are generated.

**Independent Test**: Monitor AI API costs across a 20-message conversation. The summary generation triggers at most 2-3 times (not 20 times), and the total cost is lower than the current 20-message raw history approach.

**Acceptance Scenarios**:

1. **Given** a conversation with 9 messages and no summary, **When** message 10 arrives, **Then** no summary is generated (the 10-message window still covers all history).
2. **Given** a conversation with 12 messages and no summary, **When** message 13 arrives, **Then** a summary is generated covering messages 1-3 (the messages that have scrolled out of the 10-message window).
3. **Given** a conversation with a summary covering messages 1-5, **When** message 16 arrives (window is now 7-16), **Then** the summary is extended to cover messages 1-6, incorporating message 6 which just scrolled out.
4. **Given** a conversation with a summary covering messages 1-10, **When** messages 11 and 12 arrive rapidly (within the debounce window), **Then** the summary update runs only once for both messages, not twice.
5. **Given** a conversation with 50 messages over 7 days, **When** reviewing summary generation history, **Then** summaries were generated no more than 8-10 times total across the entire conversation.

---

### User Story 3 - Summary Quality and Content Rules (Priority: P3)

The summary must capture the right information and exclude the wrong information. It is not a transcript — it is a brief intelligence report for the AI agent about what it needs to know to continue the conversation effectively.

**Why this priority**: A bad summary is worse than no summary. If the summary includes irrelevant details or misses critical ones, the AI's responses will degrade.

**Independent Test**: Generate summaries for 5 different conversation types (short stay, long stay, complaint-heavy, document-heavy, simple booking). Review each summary for inclusion of critical context and exclusion of operational noise.

**Acceptance Scenarios**:

1. **Given** a conversation where the guest mentioned "my wife is pregnant, we need a quiet room," **When** the summary is generated, **Then** this preference is included because it affects service decisions.
2. **Given** a conversation where the guest requested cleaning at 2pm and it was escalated, **When** the summary is generated, **Then** the cleaning request is NOT included because it is tracked in open tasks.
3. **Given** a conversation where the guest said "I'm actually Egyptian but I hold a British passport," **When** the summary is generated, **Then** this identity detail is included because it affects screening rules.
4. **Given** a conversation where the AI asked for WiFi password and the manager resolved it, **When** the summary is generated, **Then** this routine exchange is NOT included.
5. **Given** a conversation where the guest expressed dissatisfaction ("the apartment wasn't clean when we arrived"), **When** the summary is generated, **Then** this sentiment is included because it affects the AI's tone and escalation decisions.
6. **Given** a conversation summary, **When** reviewing its length, **Then** it is no longer than 150 words regardless of how many messages it covers.

---

### Edge Cases

- What happens when a conversation has exactly 10 messages? No summary needed — the raw window covers everything.
- What happens when a conversation has 100+ messages? The summary covers messages 1 through (N-10). Summary is still capped at 150 words — the summarization model must be aggressive about what to keep.
- What happens when the summary generation fails (API error, timeout)? The AI falls back to the last 10 raw messages without a summary. Conversation continues normally.
- What happens when a guest comes back after days of silence? The existing summary still applies — it covers all messages before the current window.
- What happens when a reservation changes status (INQUIRY to CONFIRMED)? The summary is retained — status transitions don't invalidate conversation context.
- What happens to existing conversations with no summary when this feature launches? They start with no summary. A summary is generated the next time a message arrives and the conversation has more than 10 messages.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST include the last 10 GUEST + AI messages (verbatim) as the conversation history provided to the AI, reduced from the current 20. AI_PRIVATE messages (internal notes, delivery failures) are excluded from both the count and the history.
- **FR-002**: System MUST generate a compact summary of all messages before the 10-message window when the conversation exceeds 10 messages.
- **FR-003**: System MUST store the summary persistently so it is available for subsequent AI calls without regeneration.
- **FR-004**: System MUST NOT regenerate the summary on every guest message. Summaries are generated or extended only when new messages scroll out of the 10-message window AND no current summary covers them. Summary generation runs asynchronously (fire-and-forget after the AI response is sent) so it adds zero latency to guest responses. The summary is ready for the next AI call.
- **FR-004a**: Summary generation MUST use the cheapest available model to minimize cost, since it runs frequently across all conversations.
- **FR-005**: Summary MUST include critical context: guest identity details (who they are, who they're booking for, nationality nuances), special arrangements, guest preferences that affect service, expressed dissatisfaction, and key decisions made.
- **FR-006**: Summary MUST exclude routine operational exchanges that are already tracked in open tasks (cleaning requests, WiFi issues, amenity deliveries, resolved escalations).
- **FR-007**: Summary MUST be no longer than 150 words regardless of conversation length.
- **FR-008**: System MUST extend an existing summary incrementally when new messages scroll out of the window, rather than re-summarizing the entire conversation from scratch.
- **FR-009**: System MUST fall back gracefully to the last 10 raw messages (without summary) if summary generation fails.
- **FR-010**: System MUST work correctly for new conversations (no summary needed until message count exceeds 10) and existing conversations (summary generated on next AI call if needed).
- **FR-011**: Summary MUST be injected into the AI's context as a clearly labeled section separate from the raw message history.

### Key Entities

- **Conversation Summary**: A compact text summary of conversation history before the current message window. Stored per conversation. Includes a marker indicating which messages it covers. Updated incrementally as the conversation grows.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: AI responses in conversations with 20+ messages demonstrate awareness of critical context from early messages that are no longer in the raw 10-message window.
- **SC-002**: Token usage per AI call is reduced by at least 30% compared to the current 20-message raw history approach for conversations with 15+ messages.
- **SC-003**: Summary generation occurs no more than once per 5 new messages on average across all conversations.
- **SC-004**: Summary length never exceeds 150 words regardless of conversation length.
- **SC-005**: AI response quality does not degrade compared to the current 20-message approach.
- **SC-006**: Summary generation failures do not cause any disruption to the AI pipeline — the AI continues to respond using the last 10 raw messages.

## Assumptions

- The summarization model is fast and cheap enough that occasional calls (every 5-10 messages) do not meaningfully impact per-conversation costs.
- 10 raw messages provide sufficient immediate context for most guest interactions (cleaning, WiFi, check-in/out, amenities).
- Open tasks already capture all actionable items, so the summary does not need to duplicate task tracking.
- The summary is text-only — image descriptions from earlier messages are not included.
- AI_PRIVATE messages (delivery failures, internal escalation notes) are not useful conversational context and are excluded from both the message window and summarization input.
