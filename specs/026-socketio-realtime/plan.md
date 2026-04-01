# Implementation Plan: Socket.IO Real-Time Messaging

**Branch**: `026-socketio-realtime` | **Date**: 2026-04-01 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/026-socketio-realtime/spec.md`

## Summary

Replace the SSE-based real-time system with Socket.IO WebSockets. The migration preserves the `broadcastToTenant()` function signature so only 2 files need major rewrites (the real-time service and the frontend client). Socket.IO provides automatic reconnection, built-in connection state recovery (missed-event replay), room-based tenant isolation, and WebSocket transport with Redis Streams adapter for multi-instance support.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+
**Primary Dependencies**: Express 4.x, socket.io@^4.8.3, socket.io-client@^4.8.3, @socket.io/redis-streams-adapter, ioredis
**Frontend**: Next.js 16 + React 19 + socket.io-client
**Storage**: Redis (shared with BullMQ — separate client instances, different key prefixes)
**Testing**: Manual integration testing
**Target Platform**: Railway (backend — WebSocket support confirmed), Vercel (frontend)
**Project Type**: Web service + web application
**Performance Goals**: <500ms event delivery (p95), <5s reconnection (p99), 200+ concurrent connections
**Constraints**: Railway has no sticky sessions → WebSocket-only transport (no HTTP long-polling fallback). Cross-origin (Vercel → Railway) requires CORS config on Socket.IO server.
**Scale/Scope**: Multi-tenant, estimated 10-50 concurrent connections per tenant, 200+ total

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| §I Graceful Degradation | PASS | NFR-005: single-instance delivery works without Redis. Socket.IO falls back gracefully. Connection drops trigger automatic reconnection with state recovery. |
| §II Multi-Tenant Isolation | PASS | Room-based isolation: `tenant:${tenantId}` room joined on connection. JWT auth middleware verifies tenantId. No cross-tenant event leakage. |
| §III Guest Safety & Access Control | PASS | No change to access control logic. Real-time transport only — auth stays JWT-based. |
| §IV Structured AI Output | N/A | No AI prompt changes. |
| §V Escalate When In Doubt | N/A | No escalation logic changes. |
| §VI Observability by Default | PASS | Socket.IO connection/disconnection events logged. Connection count tracked. Redis adapter status logged. |
| §VII Self-Improvement with Guardrails | N/A | No classifier changes. |
| Security & Data Protection | PASS | JWT verified on connection (not per-event). Token passed via `auth` option (not URL query — more secure than current SSE). WebSocket uses TLS in production. |

**Gate Result**: PASS — no violations.

## Project Structure

### Documentation (this feature)

```text
specs/026-socketio-realtime/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── socket-events.md # Event contract catalog
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── services/
│   │   ├── socket.service.ts             # NEW: replaces sse.service.ts
│   │   └── sse.service.ts               # DELETE after migration
│   ├── app.ts                            # MODIFY: remove /api/events endpoint
│   ├── server.ts                         # MODIFY: create httpServer, attach Socket.IO, pass io globally
│   ├── services/ai.service.ts            # MODIFY: import from socket.service instead of sse.service
│   ├── services/debounce.service.ts      # MODIFY: import from socket.service
│   ├── services/message-sync.service.ts  # MODIFY: import from socket.service
│   ├── controllers/webhooks.controller.ts    # MODIFY: import from socket.service
│   ├── controllers/conversations.controller.ts # MODIFY: import from socket.service
│   └── controllers/messages.controller.ts     # MODIFY: import from socket.service

frontend/
├── lib/
│   └── socket.ts                         # NEW: Socket.IO client singleton
├── components/
│   ├── inbox-v5.tsx                      # MODIFY: replace EventSource with socket.io-client, remove 15s polling
│   └── ui/
│       └── connection-status.tsx         # NEW: connection status indicator
```

**Structure Decision**: The migration replaces infrastructure (transport layer) without changing business logic. The `broadcastToTenant` signature is preserved — 6 backend files just change their import path from `./sse.service` to `./socket.service`. The frontend replaces `EventSource` listeners with `socket.on()` handlers.

## Key Architecture Decisions

### 1. Same `broadcastToTenant` Signature

```typescript
// Before (sse.service.ts)
export function broadcastToTenant(tenantId: string, event: string, data: unknown): void

// After (socket.service.ts) — IDENTICAL signature
export function broadcastToTenant(tenantId: string, event: string, data: unknown): void
```

Internally: `io.to('tenant:${tenantId}').emit(event, data)` instead of writing to SSE Response objects.

6 caller files need only an import path change. Zero business logic changes.

### 2. HTTP Server Explicit Creation

Current `server.ts` uses `app.listen()`. Socket.IO requires explicit `createServer(app)`:

```typescript
import { createServer } from 'http';
const httpServer = createServer(app);
// Attach Socket.IO to httpServer
httpServer.listen(PORT);
```

Same port, same Express app — just wrapped in an HTTP server.

### 3. Connection State Recovery (1 hour)

```typescript
const io = new Server(httpServer, {
  connectionStateRecovery: {
    maxDisconnectionDuration: 60 * 60 * 1000, // 1 hour
    skipMiddlewares: true,
  },
});
```

On reconnect within 1 hour: Socket.IO automatically replays all missed events. Covers lunch breaks, meetings, laptop sleep, extended deploys. Beyond 1 hour: client falls back to REST API fetch.

### 4. Redis Streams Adapter

```typescript
import { createAdapter } from '@socket.io/redis-streams-adapter';
const redisClient = new Redis(REDIS_URL);
io.adapter(createAdapter(redisClient));
```

Separate Redis client from BullMQ (different connection, same Redis instance). If Redis unavailable, Socket.IO falls back to in-memory (single-instance only).

### 5. Frontend Socket Singleton

```typescript
// lib/socket.ts
'use client';
import { io } from 'socket.io-client';

export const socket = io(SOCKET_URL, {
  transports: ['websocket'],
  autoConnect: false,
  auth: { token: '' },
});
```

Connected once on app mount with JWT token. All inbox event handlers use `socket.on()` instead of `es.addEventListener()`.

### 6. Connection Status Indicator

Small component showing 4 states: green dot "Live" (connected via WebSocket), blue dot "Live (delayed)" (smart polling fallback active), yellow dot "Reconnecting..." (WebSocket reconnecting), red dot "Offline" (no network). Replaces the sync indicator's role as a "is my data fresh?" signal.

### 7. Remove 15s Polling

The 15-second conversation detail polling (added as a workaround for unreliable SSE) is removed. Socket.IO's automatic reconnection + state recovery makes it unnecessary.

### 8. Smart Degraded Mode (WebSocket Blocked → Auto-Poll)

If WebSocket fails after 3 connection attempts, the client detects this via `connect_error` events and switches to smart polling mode: fetches the selected conversation via REST API every 5 seconds. The connection status shows "Live (delayed)." This ensures the app works everywhere — even behind strict corporate firewalls — without manual intervention.

### 9. Client-Side Message Deduplication

During recovery, the same message can arrive twice (Socket.IO replay + REST fallback fetch). The frontend maintains a `Set<string>` of seen message IDs. Before appending any message to the conversation, it checks the set. Duplicates are silently dropped. The set resets when switching conversations.

### 10. Delivery Acknowledgment for Critical Events

For `message` and `ai_suggestion` events, the server uses Socket.IO's built-in acknowledgment callbacks: `io.to(room).timeout(5000).emit('message', data, (err, responses) => { ... })`. If the client doesn't ACK within 5 seconds, the server retries once. This catches silently dropped events on connections that appear healthy but are degraded.
