# Research: Socket.IO Real-Time Messaging

## R1: Socket.IO with Express on Shared Port

**Decision**: Attach Socket.IO to the existing Express HTTP server on the same port
**Rationale**: Socket.IO wraps the HTTP server, handling WebSocket upgrade requests on the same port Express uses. No new port needed. Use `createServer(app)` explicitly instead of `app.listen()`.
**Alternatives considered**:
- Separate WebSocket server on different port → Adds CORS complexity, Railway only exposes one port
- Standalone WebSocket (no Socket.IO) → Lose reconnection, rooms, fallback, state recovery

## R2: Redis Adapter Selection

**Decision**: Use `@socket.io/redis-streams-adapter` (not `@socket.io/redis-adapter`)
**Rationale**: The Streams adapter uses Redis Streams + Pub/Sub and is the only adapter that supports Socket.IO's built-in Connection State Recovery. The standard Pub/Sub adapter does not support recovery. The Streams adapter also handles Redis disconnections gracefully (resumes stream, no packet loss). Requires only one Redis client instance (vs two for Pub/Sub adapter).
**Alternatives considered**:
- `@socket.io/redis-adapter` (Pub/Sub only) → No connection state recovery support
- No adapter (single instance only) → Would work for now but blocks horizontal scaling

## R3: Transport Configuration for Railway

**Decision**: WebSocket-only transport (`transports: ['websocket']`) on both server and client
**Rationale**: Railway does not support sticky sessions, which are required for Socket.IO's HTTP long-polling transport with multiple instances. WebSocket-only eliminates the sticky session requirement since WebSocket uses a single persistent TCP connection. Railway fully supports WebSocket upgrades.
**Trade-off**: No automatic fallback to HTTP long-polling if WebSocket is blocked by corporate firewalls. Acceptable for GuestPilot — it's an operator dashboard, not public-facing.
**Alternatives considered**:
- Allow both transports → Requires sticky sessions which Railway doesn't provide
- HTTP long-polling only → Higher latency, more server load, defeats the purpose

## R4: JWT Authentication Pattern

**Decision**: Authenticate on connection via `io.use()` middleware with JWT from `socket.handshake.auth.token`
**Rationale**: Socket.IO's middleware system runs once on connection (not per-event). The JWT is passed via the `auth` option (not headers, since browsers can't set custom headers on WebSocket connections). Token claims (`tenantId`) are stored in `socket.data` and persist for the connection lifetime.
**Alternatives considered**:
- Per-event authentication → Too expensive, adds latency to every event
- Cookie-based auth → Doesn't work well cross-origin (Vercel → Railway)
- Query param token → Visible in logs, security risk

## R5: Connection State Recovery

**Decision**: Use Socket.IO v4.6+ built-in Connection State Recovery with `maxDisconnectionDuration: 600000` (10 minutes)
**Rationale**: Built-in recovery automatically replays missed packets on reconnection. Combined with the Redis Streams adapter, it works across multiple server instances. For disconnections longer than 10 minutes or server restarts, the client falls back to a REST API call to fetch current state.
**Alternatives considered**:
- Custom event buffer with manual replay → Duplicates what Socket.IO already provides
- No recovery (just reconnect) → Loses messages during outages, the core problem we're solving

## R6: Room-Based Tenant Isolation

**Decision**: Join `tenant:${tenantId}` room on connection. Broadcast via `io.to('tenant:${tenantId}').emit(event, data)`.
**Rationale**: Rooms are server-side only (clients never see room names). Sockets auto-leave on disconnect. Broadcasting to rooms works across instances via the Redis adapter. The `broadcastToTenant` function signature stays identical — just the internal implementation changes from SSE Response writes to Socket.IO room emits.
**Alternatives considered**:
- Namespace-per-tenant (`io.of('/tenant-abc')`) → More complex, harder to manage dynamically
- Filter-on-receive (send to all, filter client-side) → Security violation, leaks data

## R7: Migration Strategy — Minimal Surface Area

**Decision**: Keep `broadcastToTenant(tenantId, event, data)` function signature identical. Only rewrite the internals of `sse.service.ts` → `socket.service.ts` and the frontend EventSource code.
**Rationale**: The SSE audit found 8 backend files that call `broadcastToTenant`. If the function signature stays the same, 6 of those files need zero changes — only the service implementation and the frontend client need rewriting. This minimizes risk and testing surface.
**Alternatives considered**:
- Full event system refactor → Higher risk, more files to change, more testing needed
- Gradual migration (run SSE + Socket.IO side by side) → Complexity, two systems to maintain

## R8: Package Versions

**Decision**: `socket.io@^4.8.3` (server), `socket.io-client@^4.8.3` (client), `@socket.io/redis-streams-adapter` (latest)
**Rationale**: v4.8.3 includes a security fix (CVE-2026-33151). Server and client versions must match major.minor. The Redis Streams adapter is a separate package.

## R9: Recovery Window Duration

**Decision**: 1 hour (maxDisconnectionDuration: 3,600,000ms)
**Rationale**: 10 minutes was too conservative — doesn't cover lunch breaks, long meetings, laptop sleep, or extended deploys. 1 hour covers all common scenarios. Redis Streams memory cost is minimal (~5-10 MB for 1 hour of events across all tenants). Beyond 1 hour, the client falls back to REST API fetch.
**Alternatives considered**:
- 10 minutes (original) → Too short, misses common scenarios
- 24 hours → Excessive Redis memory usage, diminishing returns
- Unlimited (persistent event log) → Requires Kafka or persistent storage, overkill for this scale

## R10: Smart Degraded Mode

**Decision**: After 3 failed WebSocket attempts, auto-switch to 5-second REST polling
**Rationale**: WebSocket-only transport means corporate firewalls can block the connection entirely. Instead of showing "Offline" (useless), the client detects the failure pattern and switches to aggressive REST polling. The user sees "Live (delayed)" — the app works everywhere, just slightly slower. If WebSocket later becomes available (e.g., user leaves the corporate network), the client upgrades back to WebSocket automatically.
**Alternatives considered**:
- Show "Offline" and do nothing → Poor UX, app appears broken
- HTTP long-polling via Socket.IO → Requires sticky sessions (Railway doesn't support)
- Immediate polling without detection → Wastes resources when WebSocket works fine

## R11: Client-Side Message Deduplication

**Decision**: Maintain a `Set<string>` of seen message IDs in a React ref, check before rendering
**Rationale**: During recovery, Socket.IO replays missed events AND the REST fallback fetches current state. The same message can arrive from both sources. Without dedup, users see duplicate messages — confusing and unprofessional. A Set lookup is O(1) and adds negligible overhead.
**Alternatives considered**:
- Server-side dedup (don't send if already in replay) → Server doesn't know what REST returned
- No dedup (rely on timing) → Race conditions make this unreliable

## R12: Delivery Acknowledgment

**Decision**: Use Socket.IO's built-in ACK callbacks for `message` and `ai_suggestion` events with 5-second timeout and single retry
**Rationale**: A connection can appear healthy (heartbeat passing) but silently drop individual events due to network congestion, proxy buffering, or client-side JS errors. ACK callbacks let the server verify the client received the event. Only used for critical events — typing indicators and status toggles are fire-and-forget (missing one is not harmful).
**Alternatives considered**:
- ACK all events → Too much overhead for non-critical events
- No ACK (rely on state recovery) → Recovery only works on disconnect, not on silently dropped events during an active connection
- Client-side "pull" model → Higher latency, more complex

## R13: Dead Event Cleanup (formerly R9)

**Decision**: Remove the `ai_typing` event (broadcast but never consumed). Keep `task_updated`, `new_task`, `knowledge_suggestion`, `knowledge_suggestion_updated` broadcasts even though the frontend doesn't listen yet — they may be consumed by future UI features.
**Rationale**: The SSE audit found `ai_typing` is broadcast by debounce.service but has no frontend listener. The typing indicator is set optimistically. The 4 backend-only events are low-cost to broadcast and provide future extensibility.
