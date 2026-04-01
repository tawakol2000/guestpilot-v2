# Feature Specification: Socket.IO Real-Time Messaging

**Feature Branch**: `026-socketio-realtime`
**Created**: 2026-04-01
**Status**: Draft
**Input**: Replace SSE with Socket.IO for real-time messaging — WebSocket-based real-time communication with automatic reconnection, heartbeat detection, missed-message recovery, and room-based tenant isolation.

## Problem Statement

The current real-time messaging system uses Server-Sent Events (SSE), a one-way HTTP connection that fails silently and frequently. Managers must manually refresh the page to see new messages. Connections drop due to proxy timeouts, network switches, browser throttling, and server deployments — and the system has no mechanism to detect these drops or recover missed messages.

**Current failures:**
- SSE connections die silently — no error event fires, no reconnection for seconds or indefinitely
- When a connection drops, all messages during the outage are lost permanently — no recovery mechanism
- Browser limits (6 connections per domain) can exhaust SSE slots
- Proxy/CDN layers (Railway, Vercel edge) terminate long-lived HTTP connections unpredictably
- Tab backgrounding on mobile/desktop throttles or kills the connection
- Server deployments drop all existing SSE connections simultaneously

**Impact:** Managers miss guest messages, AI responses, typing indicators, and task notifications. They rely on manual page refreshes, which defeats the purpose of a real-time communication platform.

## Clarifications

### Session 2026-04-01

- Q: Should the event buffer work without Redis? → A: In-memory buffer per instance, upgraded to Redis-backed when Redis is available. Most production-ready approach.
- Q: Remove polling fallbacks after Socket.IO migration? → A: Remove the 15s detail polling (replaced by Socket.IO). Keep the 2-min Hostaway sync (catches external manager messages — different purpose).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Instant Message Delivery (Priority: P1)

A manager has the GuestPilot inbox open. A guest sends a message. The message appears in the conversation instantly — within 1 second — without any page refresh. This works for all event types: guest messages, AI responses, typing indicators, copilot suggestions, task updates, and reservation changes.

**Why this priority**: This is the core value proposition. If messages don't appear instantly, the platform cannot function as a real-time communication tool.

**Independent Test**: Open the inbox, send a guest message through Hostaway, verify it appears in the inbox within 1 second without any user action.

**Acceptance Scenarios**:

1. **Given** a manager has the inbox open, **When** a guest sends a message, **Then** the message appears in the conversation within 1 second.
2. **Given** a manager has the inbox open, **When** the AI generates a response (autopilot), **Then** the AI message appears within 1 second of generation.
3. **Given** a manager has the inbox open, **When** the AI generates a copilot suggestion, **Then** the suggestion appears in the suggestion bar within 1 second.
4. **Given** a manager has the inbox open, **When** a new reservation is created, **Then** the new conversation appears in the sidebar within 1 second.

---

### User Story 2 - Automatic Reconnection with State Recovery (Priority: P2)

The connection drops (network switch, server deploy, browser background tab). When the connection is restored, the system automatically reconnects and delivers all messages that were missed during the outage. The manager sees no gap in the conversation — it's as if the connection never dropped.

**Why this priority**: Connections will always drop. The system's reliability depends entirely on how it recovers from drops, not on preventing them.

**Independent Test**: Open the inbox, disconnect the network for 30 seconds, reconnect, verify all messages sent during the outage appear automatically without a page refresh.

**Acceptance Scenarios**:

1. **Given** a manager's connection drops for 10 seconds, **When** the connection is restored, **Then** the system reconnects automatically within 2 seconds and all missed messages appear in the correct chronological order.
2. **Given** a manager's connection drops for 5 minutes, **When** the connection is restored, **Then** the system recovers all missed events and updates the UI without requiring a page refresh.
3. **Given** the server deploys (all connections drop simultaneously), **When** all clients reconnect, **Then** each client recovers its missed events without manual intervention.
4. **Given** a manager's browser tab is backgrounded for 10 minutes, **When** the tab is foregrounded, **Then** the connection is re-established and missed messages appear within 2 seconds.

---

### User Story 3 - Connection Status Visibility (Priority: P3)

The manager can see the current connection status at a glance. If the connection is down, they see a clear indicator. When it reconnects, the indicator updates. This eliminates the uncertainty of "is my inbox up to date?"

**Why this priority**: Visibility into connection health builds trust. Without it, managers never know if they're seeing the latest messages or stale data.

**Independent Test**: Disconnect network, verify a "disconnected" indicator appears. Reconnect, verify it changes to "connected."

**Acceptance Scenarios**:

1. **Given** the real-time connection is active, **When** the manager looks at the inbox, **Then** a subtle "connected" indicator is visible (e.g., green dot).
2. **Given** the connection drops, **When** the manager looks at the inbox, **Then** a "disconnected" or "reconnecting" indicator appears within 5 seconds of the drop.
3. **Given** the connection is restored after a drop, **When** reconnection succeeds, **Then** the indicator changes back to "connected" and a brief toast notification confirms "Back online — messages synced."

---

### User Story 4 - Multi-Tenant Isolation (Priority: P1)

Multiple tenants use the platform simultaneously. Each tenant's real-time events are isolated — a tenant never receives another tenant's messages, typing indicators, or any other events.

**Why this priority**: Data isolation is a security requirement, not a feature. A tenant seeing another tenant's guest messages is a critical security breach.

**Independent Test**: Connect two different tenant accounts simultaneously. Send a message in tenant A's conversation. Verify tenant B receives nothing.

**Acceptance Scenarios**:

1. **Given** two tenants are connected simultaneously, **When** a message is sent in tenant A's conversation, **Then** only tenant A receives the event — tenant B's inbox is unaffected.
2. **Given** a tenant's authentication token expires, **When** the system attempts to reconnect, **Then** the connection is rejected and the user is redirected to login.

---

### Edge Cases

- What happens when the connection drops and recovers, but the missed-event buffer has been exceeded (e.g., 1000+ events missed during a long outage)? The system falls back to a full state refresh for the affected conversations rather than replaying individual events.
- What happens when two managers from the same tenant are viewing the same conversation? Both receive all events for that conversation simultaneously and independently.
- What happens when the real-time transport (WebSocket) is blocked by a corporate firewall? After 3 failed WebSocket attempts, the client automatically switches to smart polling mode (5-second REST API fetch for the active conversation). The connection status shows "Live (delayed)." The experience is slightly delayed but fully functional — no manual refresh needed.
- What happens during a server deployment when all connections drop at once? Each client reconnects independently with exponential backoff (jitter) to avoid a thundering herd. Missed events are recovered per client.
- What happens when the backend has multiple instances (horizontal scaling)? Events broadcast on one instance are delivered to clients connected to any instance via a shared message bus.
- What happens when a manager opens multiple browser tabs? Each tab maintains its own connection and receives events independently. No cross-tab interference.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST deliver real-time events (messages, typing indicators, AI suggestions, task updates, reservation changes, status toggles) to connected clients within 1 second of the event occurring on the server.
- **FR-002**: The system MUST automatically reconnect when the connection drops, without requiring any user action. Reconnection MUST begin within 2 seconds of detecting a drop.
- **FR-003**: The system MUST recover all events missed during a connection outage. On reconnection, the client sends the timestamp of the last received event, and the server replays all events since that timestamp.
- **FR-004**: The system MUST isolate events by tenant — a client MUST only receive events for their authenticated tenant. Connections MUST be authenticated using the existing JWT token.
- **FR-005**: The system MUST detect dead connections via heartbeat. If no heartbeat is received within 30 seconds, the connection MUST be considered dead and reconnection MUST begin.
- **FR-006**: The system MUST support horizontal scaling — events broadcast on one server instance MUST be delivered to clients connected to any instance via a shared message bus.
- **FR-007**: The system uses WebSocket as the primary transport. If WebSocket connection fails after 3 attempts (e.g., corporate firewall), the client MUST automatically fall back to a smart polling mode — fetching the selected conversation every 5 seconds via REST API. The connection status indicator shows "Live (delayed)" in this degraded mode. The user never sees "Offline" unless they are truly without network.
- **FR-008**: The system MUST maintain a server-side event buffer (1 hour of events per tenant) to support missed-event recovery on reconnection. The buffer MUST operate in-memory per instance when Redis is unavailable, and upgrade to a shared Redis-backed buffer when Redis is available — ensuring missed-event recovery works in both single-instance and multi-instance deployments. One hour covers lunch breaks, meetings, laptop sleep, and extended server deploys.
- **FR-009**: The system MUST display a visible connection status indicator showing the current state: connected (green — live WebSocket), delayed (blue — smart polling fallback active), reconnecting (yellow — WebSocket reconnecting), or disconnected (red — no network).
- **FR-010**: The system MUST show a brief notification when recovering from a disconnection, confirming that missed events have been synced.
- **FR-011**: The system MUST support all 15 active event types without changing their payload structure: message, ai_typing_clear, ai_typing_text, ai_suggestion, ai_toggled, ai_mode_changed, property_ai_changed, conversation_starred, conversation_resolved, reservation_created, reservation_updated, task_updated, new_task, knowledge_suggestion, knowledge_suggestion_updated. (The dead `ai_typing` event is removed as part of this migration.)
- **FR-012**: The system MUST replace the existing real-time infrastructure completely — no dual SSE/WebSocket systems running simultaneously after migration.
- **FR-013**: The system MUST handle server deployments gracefully — when a deployment drops all connections, clients reconnect with backoff and recover missed events without flooding the server.
- **FR-014**: The client MUST deduplicate events by message ID before rendering. During recovery, the same message may arrive via both the event replay and the REST API fallback — duplicates MUST be silently dropped so the user never sees the same message twice.
- **FR-015**: For critical events (new messages, AI responses), the server MUST request delivery acknowledgment from the client. If no acknowledgment is received within 5 seconds, the server MUST retry delivery once. This catches silently dropped events on degraded connections.

### Non-Functional Requirements

- **NFR-001**: Event delivery latency MUST be under 500ms (server event → client receives) for 95% of events under normal conditions.
- **NFR-002**: Reconnection after a drop MUST complete within 5 seconds for 99% of cases.
- **NFR-003**: The system MUST support at least 200 concurrent real-time connections per server instance.
- **NFR-004**: The missed-event recovery mechanism MUST handle outages of up to 1 hour without data loss.
- **NFR-005**: The real-time system MUST degrade gracefully if the shared message bus (Redis) is unavailable — single-instance delivery MUST continue to work.

### Key Entities

- **Connection**: A real-time link between a client (browser tab) and the server. Authenticated by JWT, scoped to a tenant. Tracks the timestamp of the last event delivered to the client.
- **Event**: A server-side occurrence (new message, typing indicator, etc.) that must be delivered to connected clients. Has a type, payload, tenant scope, timestamp, and a sequential or timestamp-based identifier for ordering.
- **Event Buffer**: A server-side store of recent events (per tenant) used to replay missed events on client reconnection. Retention: 1 hour.
- **Room**: A logical grouping of connections. Each tenant has a room; events are broadcast to the tenant's room ensuring isolation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 99% of real-time events are delivered to connected clients within 1 second.
- **SC-002**: After a connection drop, 99% of clients reconnect and recover missed events within 5 seconds.
- **SC-003**: Zero events are permanently lost during connection outages of 1 hour or less.
- **SC-004**: Zero cross-tenant event leakage over a 30-day period.
- **SC-005**: Managers report zero need for manual page refreshes to see new messages. The SSE-era 15-second polling workaround is removed. The 5-second smart polling for WebSocket-blocked scenarios (FR-007) is a distinct degraded mode, not a workaround — it activates automatically and the user sees "Live (delayed)."
- **SC-006**: The system handles 200+ concurrent connections without degradation.
- **SC-007**: Connection status is accurately displayed — the indicator reflects the true state within 5 seconds of a change.

## Assumptions

- The existing JWT authentication mechanism is sufficient for authenticating real-time connections — no new auth system is needed.
- Redis is available in production for cross-instance event broadcasting (already used for BullMQ). The system degrades gracefully to single-instance mode without Redis.
- All existing event types and their payload structures are preserved — the frontend event handlers only need to change how they connect, not how they process events.
- The 15-second conversation detail polling will be removed as part of this migration — Socket.IO replaces it entirely. The 2-minute Hostaway message sync (feature 025) will be kept — it serves a different purpose (catching manager messages sent outside GuestPilot via the Hostaway dashboard).
- Corporate firewalls that block WebSockets are rare. When detected, the client falls back to smart polling (5-second REST fetch) as a degraded but functional mode.

## Scope Boundaries

### In Scope
- Replace SSE with WebSocket-based real-time transport
- Automatic reconnection with exponential backoff and jitter
- Missed-event recovery via server-side event buffer and client-side last-event tracking
- Room-based tenant isolation for multi-tenant security
- Cross-instance event broadcasting via shared message bus
- Smart degraded mode: automatic fallback to 5-second REST polling when WebSocket is blocked
- Client-side message deduplication to prevent duplicates during recovery
- Delivery acknowledgment with retry for critical events (messages, AI responses)
- Connection status indicator in the frontend
- Migration of all 15 active event types to the new transport
- Removal of the old SSE endpoint, SSE service, and frontend EventSource code

### Out of Scope
- End-to-end encryption of real-time events (transport-level TLS is sufficient)
- Persistent event storage beyond the 1-hour buffer (long-term history is in the database)
- Client-to-client direct messaging (all events originate from the server)
- Mobile app push notifications (handled by a separate system)
- Changes to event payload structures or adding new event types
