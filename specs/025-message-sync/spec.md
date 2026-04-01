# Feature Specification: Hostaway Message Sync

**Feature Branch**: `025-message-sync`
**Created**: 2026-04-01
**Status**: Draft
**Input**: Sync messages from Hostaway to catch manager replies sent outside GuestPilot, ensuring AI has full conversation context before responding

## Problem Statement

Multiple managers respond to guests directly through Hostaway or Airbnb, bypassing GuestPilot entirely. When the AI assistant needs to respond, it has no visibility into these external messages. The AI sees guest replies without knowing what the manager already told them, leading to confused, duplicate, or contradictory responses.

**Current gap**: The system only receives messages through Hostaway's incoming message webhook. There is no webhook for outgoing (manager-sent) messages. Messages sent by managers directly through Hostaway dashboard or channel apps are invisible to the AI and the GuestPilot inbox.

## Clarifications

### Session 2026-04-01

- Q: What should the background sync interval be? → A: Every 2 minutes — meets 5-minute SLA with headroom, ~3% rate limit budget usage.
- Q: In copilot mode, should the system still cancel AI suggestion when manager already responded? → A: Cancel in all modes — no suggestion or response if manager already handled it.
- Q: Which reservation statuses should background sync cover? → A: All active statuses — INQUIRY, PENDING, CONFIRMED, CHECKED_IN.
- Q: Should synced messages push to the frontend in real-time? → A: Yes — broadcast via existing SSE channel so the inbox updates live.
- Q: Should on-demand sync block conversation loading? → A: Non-blocking — load local messages instantly, append synced messages. Show a small circular countdown indicator (iPhone timer style) for next sync; clicking it triggers immediate resync.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - AI Responds With Full Context (Priority: P1)

A manager responds to a guest directly through the Hostaway dashboard (e.g., confirming an early check-in). Later, the guest sends a follow-up message (e.g., "thanks, what time can I arrive?"). The AI must see the manager's earlier response before generating its reply, so it can answer coherently.

**Why this priority**: This is the core problem. Without this, the AI gives confused/duplicate responses that damage guest experience and create more work for managers.

**Independent Test**: Send a message as a manager through Hostaway directly, then send a guest follow-up. Verify the AI's response acknowledges the manager's message and responds appropriately.

**Acceptance Scenarios**:

1. **Given** a manager replied to a guest via Hostaway directly, **When** the guest sends a follow-up message and the AI prepares to respond, **Then** the AI sees the manager's message in its conversation history and responds with full awareness of what was already communicated.
2. **Given** a manager replied via Hostaway but the system has not yet seen this message, **When** a sync occurs before the AI generates its response, **Then** the manager's message appears in the conversation timeline with correct attribution (marked as sent by the manager, not by the AI).
3. **Given** a manager already fully addressed a guest's question via Hostaway, **When** the AI prepares to respond to the same question, **Then** the system detects the manager already handled it and cancels/skips the AI response to avoid duplication.

---

### User Story 2 - Background Conversation Sync (Priority: P2)

Active conversations are periodically synced in the background so that the GuestPilot inbox always reflects the true state of the conversation, even before the AI needs to respond. Managers opening a conversation in the inbox see all messages, including those sent by other managers through external channels.

**Why this priority**: Keeps the inbox as the single source of truth. Without this, managers must check both GuestPilot and Hostaway to see the full picture.

**Independent Test**: Have a manager send a message through Hostaway directly, wait for the next background sync cycle, then open the conversation in GuestPilot and verify the message appears.

**Acceptance Scenarios**:

1. **Given** an active conversation where a manager sent a message via Hostaway 3 minutes ago, **When** the background sync runs, **Then** the message appears in the GuestPilot inbox timeline with the correct sender, timestamp, and content.
2. **Given** a conversation that was last synced recently (within 30 seconds), **When** another sync is requested, **Then** the system skips the sync to avoid unnecessary external calls.
3. **Given** the external messaging service is temporarily unavailable, **When** the background sync fails, **Then** the system logs a warning and retries on the next cycle without crashing or affecting other conversations.

---

### User Story 3 - On-Demand Sync When Opening a Conversation (Priority: P3)

When a manager opens a specific conversation in the GuestPilot inbox, the system fetches the latest messages for that conversation so the manager immediately sees the complete thread.

**Why this priority**: Nice-to-have UX improvement. The background sync handles most cases, but this ensures real-time freshness when a manager actively looks at a conversation.

**Independent Test**: Send a manager message via Hostaway, immediately open that conversation in GuestPilot, and verify the message appears without waiting for a background cycle.

**Acceptance Scenarios**:

1. **Given** a manager opens a conversation in the inbox, **When** there are messages in Hostaway not yet in GuestPilot, **Then** the conversation loads immediately with local messages and synced messages appear within 2 seconds (non-blocking).
2. **Given** a manager opens a conversation that is already fully synced, **When** no new messages exist externally, **Then** the conversation loads instantly with no visible delay from the sync check.
3. **Given** a conversation is open, **When** a sync is in progress, **Then** a small circular countdown indicator (similar to an iPhone timer) displays the time until next automatic sync.
4. **Given** a manager sees the sync indicator, **When** they click it, **Then** the system triggers an immediate resync for that conversation regardless of the 30-second cooldown.

---

### Edge Cases

- What happens when the external service returns more messages than the system can fetch in one call (conversations with 100+ messages)? The system syncs the most recent batch; older messages beyond the fetch limit are unaffected.
- What happens when the same message arrives via both the webhook and the sync? The system deduplicates by external message ID, ensuring only one copy exists.
- What happens when the AI sent a message but the external ID was not recorded? The system matches outgoing messages by content and timestamp proximity to avoid creating duplicate entries attributed to the wrong sender.
- What happens when a missed incoming (guest) message is discovered during sync? It is inserted into the timeline at the correct chronological position based on its original timestamp.
- What happens when sync discovers a manager already responded but the AI has a pending reply? The system detects the manager's response and cancels the pending AI reply.
- What happens when multiple managers respond through different channels simultaneously? Each message is synced independently; the timeline reflects the true chronological order regardless of source.
- What happens during an initial sync when no sync history exists for a conversation? The first sync fetches the maximum batch of messages and establishes the baseline; subsequent syncs only need to find new messages.
- What happens when the fuzzy content match for outgoing message attribution is inconclusive? The system defaults to HOST attribution — it is safer to show the message as manager-sent than to risk hiding a manager response by misattributing it to the AI.
- What happens when sync discovers many new messages at once (e.g., 10+)? Each message is broadcast individually via the existing event channel. The frontend already handles rapid message events gracefully.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST fetch messages from the external messaging service and compare them against locally stored messages before the AI generates any response.
- **FR-002**: The system MUST insert any messages found externally but missing locally into the conversation timeline, preserving the original sender attribution (guest vs. manager), timestamp, channel, and content.
- **FR-003**: The system MUST deduplicate messages using the external message identifier, ensuring no message appears twice regardless of how it was received (webhook, sync, or import).
- **FR-004**: The system MUST detect when a manager has already responded to a guest's message (discovered via sync) and cancel any pending AI response for that conversation, regardless of AI mode (autopilot or copilot).
- **FR-005**: The system MUST never modify or remove locally-created messages (AI responses, AI drafts, private manager notes) during sync — sync only adds missing external messages.
- **FR-006**: The system MUST handle sync failures gracefully — if the external service is unavailable, the AI proceeds with locally available messages and the system retries on the next cycle.
- **FR-007**: The system MUST run a background sync for active conversations (open status, guests with INQUIRY/PENDING/CONFIRMED/CHECKED_IN reservation status, recent activity within 24 hours) every 2 minutes.
- **FR-008**: The system MUST skip sync for conversations that were synced within the last 30 seconds to avoid excessive external calls.
- **FR-009**: The system MUST enforce uniqueness on external message identifiers at the storage level to prevent race conditions between concurrent webhook delivery and sync operations.
- **FR-010**: The system MUST correctly attribute synced outgoing messages — distinguishing between messages sent by the AI (by matching against existing local AI messages) and messages sent by managers directly through external channels.
- **FR-011**: The system MUST respect the external service's rate limits, ensuring sync operations do not interfere with normal message sending, reservation lookups, or other critical operations.
- **FR-012**: The system MUST provide a way to trigger sync for a specific conversation on demand, usable when a manager opens that conversation in the inbox.
- **FR-013**: The system MUST broadcast newly synced messages to connected frontends in real-time via the existing event channel, so the inbox updates live without requiring a page refresh.
- **FR-014**: The conversation view MUST display a small circular sync countdown indicator showing time until the next automatic sync. Clicking the indicator MUST trigger an immediate resync, bypassing the 30-second cooldown.
- **FR-015**: On-demand sync (opening a conversation or clicking the sync indicator) MUST be non-blocking — the conversation loads instantly with local messages and synced messages append as they arrive.

### Non-Functional Requirements

- **NFR-001**: Pre-response sync MUST complete within 2 seconds to avoid noticeably delaying AI responses.
- **NFR-002**: Background sync MUST consume no more than 10% of the available external service call budget.
- **NFR-003**: Sync operations MUST be idempotent — running the same sync twice produces the same result with no side effects.
- **NFR-004**: The system MUST log all sync operations (messages found, messages inserted, failures) for operational monitoring and debugging.

### Key Entities

- **Message**: A communication record in a conversation. Has content, sender role (guest, AI, manager), timestamp, channel, and an optional external message identifier linking to the source system.
- **Conversation**: A thread of messages tied to a guest reservation. Tracks the last time it was synced with the external system.
- **Pending AI Reply**: A scheduled AI response waiting to fire. Must be cancellable if sync reveals a manager already responded.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of manager messages sent via external channels appear in the GuestPilot conversation timeline within 5 minutes of being sent.
- **SC-002**: AI responses reference or acknowledge manager-sent messages at least 95% of the time when relevant context was provided by a manager externally.
- **SC-003**: Zero duplicate messages appear in the conversation timeline from sync operations over a 30-day period.
- **SC-004**: AI response time increases by no more than 2 seconds due to pre-response sync overhead.
- **SC-005**: Sync-related failures never prevent the AI from responding — 100% graceful degradation rate.
- **SC-006**: Reduction in confused/contradictory AI responses by at least 80% in conversations where managers also respond externally.
- **SC-007**: Background sync consumes less than 10% of the external service's rate limit budget during normal operations.

## Assumptions

- The external messaging service (Hostaway) does not provide outgoing message webhooks — polling their messages endpoint is the only way to discover manager-sent messages.
- The messages endpoint returns both incoming and outgoing messages with a direction indicator.
- The messages endpoint has a practical limit of ~100 messages per request with no cursor-based pagination.
- Rate limits are shared across all endpoint types (approximately 15 requests per 10-second window per IP).
- Active conversations (guests with INQUIRY/PENDING/CONFIRMED/CHECKED_IN status and recent activity) represent a small fraction of total conversations, making background sync feasible within rate limits.
- AI messages sent through the system are recorded in Hostaway with an external ID that can be matched during sync.
- The existing retry-with-backoff pattern used for other external service calls is suitable for sync operations.

## Scope Boundaries

### In Scope
- Syncing messages from Hostaway to GuestPilot (one-way: external to local)
- Pre-response sync to ensure AI has full context
- Background periodic sync for active conversations
- On-demand sync when opening a conversation
- Deduplication and correct sender attribution
- Cancelling pending AI replies when manager already responded

### Out of Scope
- Syncing messages from GuestPilot to Hostaway (messages sent through GuestPilot already go through Hostaway's send API)
- Real-time push notifications when synced messages arrive (background refresh is sufficient)
- Syncing messages from channels other than Hostaway (e.g., direct WhatsApp, email)
- Historical backfill of messages older than what the external API returns in a single call
- UI changes beyond the sync countdown indicator and displaying synced messages in the existing timeline format
