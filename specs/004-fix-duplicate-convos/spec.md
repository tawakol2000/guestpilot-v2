# Feature Specification: Fix Duplicate Conversations

**Feature Branch**: `004-fix-duplicate-convos`
**Created**: 2026-03-19
**Status**: Draft
**Input**: User description: "Duplicate conversations appearing in inbox — one created when reservation is created and another when conversation is created via Hostaway webhook. Same guest, same property, two separate chat entries."

## Problem Statement

When a new booking or inquiry arrives from Hostaway, the inbox shows two separate conversation entries for the same guest and property — one created by the reservation event and one created by the first message event. Both appear independently in the inbox, causing hosts to manage the wrong thread and AI auto-replies to potentially miss or duplicate responses.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Single Conversation Per Booking (Priority: P1)

A host receives a new guest inquiry or booking. Exactly one conversation entry appears in the inbox for that guest, regardless of the order or timing of the underlying notification events from the booking platform.

**Why this priority**: Duplicates directly break the host workflow — AI replies go into one conversation while the host reads the other, meaning guests receive inconsistent or missing responses. This is the core defect.

**Independent Test**: Create a test booking through Hostaway and confirm only one conversation entry appears in the inbox for that guest and property.

**Acceptance Scenarios**:

1. **Given** a new booking is created in Hostaway, **When** Hostaway sends both a reservation event and a message event nearly simultaneously, **Then** only one conversation entry appears in the inbox for that guest.
2. **Given** a message event from Hostaway arrives before the reservation event for the same booking, **Then** only one conversation entry exists after both events are processed.
3. **Given** a reservation event arrives first and creates a conversation, **When** a subsequent message event arrives for the same reservation, **Then** the message is added to the existing conversation — no new conversation is created.

---

### User Story 2 — Messages Routed to Correct Conversation (Priority: P2)

All messages — both guest-sent and AI-generated — are saved in the single canonical conversation for a reservation, not split across duplicates.

**Why this priority**: Even if duplicates are prevented going forward, messages must never land in a ghost/empty conversation where the host won't see them.

**Independent Test**: Trigger a guest message on an existing reservation and verify the message count increases in the correct conversation thread.

**Acceptance Scenarios**:

1. **Given** an existing conversation for a reservation, **When** a new guest message arrives, **Then** the message is attached to the existing conversation — not a newly created one.
2. **Given** a conversation exists without a Hostaway conversation identifier, **When** a message arrives with that identifier for the same reservation, **Then** the identifier is updated on the existing conversation and no second conversation is created.

---

### User Story 3 — Cleanup of Existing Duplicates (Priority: P3)

For reservations that already have two conversations, the empty/ghost conversation can be safely removed without affecting message history.

**Why this priority**: Existing duplicates need resolution but this is lower priority than preventing new ones.

**Independent Test**: Identify a reservation with two conversations, remove the empty one, and verify all messages remain intact in the surviving conversation.

**Acceptance Scenarios**:

1. **Given** a reservation has two conversations (one with messages, one empty), **When** the empty conversation is removed, **Then** the conversation with messages remains fully intact.
2. **Given** a duplicate empty conversation has a pending AI reply scheduled, **When** the duplicate is removed, **Then** no AI reply fires against the removed conversation.

---

### Edge Cases

- What if both reservation and message events arrive at exactly the same time (concurrent processing)? The system must guarantee exactly one conversation is created.
- What if a guest books twice at the same property (two genuine reservations)? Two separate conversations are correct and must not be blocked.
- What if the reservation event is never received and only message events arrive? A conversation must still be created via the existing fallback path.
- What if an existing duplicate already has AI replies sent in it? Removal of the duplicate must not re-trigger any AI responses.
- What if the message event payload is missing the reservation identifier? The fallback conversation lookup must still work via the Hostaway conversation identifier.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST ensure at most one conversation exists per reservation at any time.
- **FR-002**: When a reservation event and a message event for the same booking arrive simultaneously, the system MUST create exactly one conversation — not two.
- **FR-003**: When a message event arrives for a reservation that already has a conversation, the system MUST attach the message to the existing conversation instead of creating a new one.
- **FR-004**: When a conversation exists without a Hostaway conversation identifier and a message arrives with that identifier for the same reservation, the system MUST update the existing conversation's identifier rather than create a new one.
- **FR-005**: The system MUST handle out-of-order events gracefully — message before reservation, reservation before message, or both simultaneously — and always result in a single conversation.
- **FR-006**: Existing duplicate conversations MUST be safely removable (the ghost/empty one) without affecting message history or triggering additional AI actions.
- **FR-007**: AI replies MUST only fire against the single canonical conversation for a reservation — never against an empty duplicate.

### Key Entities

- **Conversation**: Belongs to one reservation. Each reservation must have at most one active conversation. Has a Hostaway conversation identifier (may be empty until the first message arrives and then must be backfilled).
- **Reservation**: A booking record. One-to-one relationship with its active conversation. The unique reservation identifier from Hostaway is the source of truth for deduplication.
- **Message**: Belongs to exactly one conversation. Must never be routed to a duplicate ghost conversation for the same reservation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After the fix is deployed, zero new duplicate conversations appear over a 7-day observation window across all active tenants.
- **SC-002**: For any new booking, exactly one conversation entry appears in the inbox within 5 seconds of the booking being created in Hostaway.
- **SC-003**: 100% of guest messages from Hostaway are routed to the correct single conversation for their reservation — no messages dropped or misrouted.
- **SC-004**: All existing duplicate conversations (ghost/empty entries) are identifiable and removable without any loss of message history.

## Assumptions

- Hostaway fires both `reservation.created` and `message.received` events close together in time for new inquiries and bookings — this timing gap is the primary trigger for duplicates.
- The Hostaway `message.received` payload includes both a conversation identifier and a reservation identifier in most cases.
- The root cause involves a race condition in concurrent async event processing combined with no database-level uniqueness guarantee on conversations per reservation.
- Deduplication of existing duplicates is a one-time data cleanup, not an ongoing automated process.
- No message history should be lost during any fix or cleanup procedure.

## Out of Scope

- Merging message history from two duplicate conversations — the ghost conversation typically has no messages so this is unnecessary.
- Changes to how Hostaway sends webhooks or their payload structure.
- Supporting multiple active conversations per reservation (e.g., WhatsApp + Airbnb as separate threads) — this is an existing design decision and is not affected by this fix.
