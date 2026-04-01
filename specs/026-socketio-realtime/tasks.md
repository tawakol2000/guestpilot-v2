# Tasks: Socket.IO Real-Time Messaging

**Input**: Design documents from `/specs/026-socketio-realtime/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/socket-events.md, quickstart.md

**Organization**: Tasks grouped by user story. The migration preserves the `broadcastToTenant` function signature — 6 backend files only need an import path change.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3, US4)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Dependencies & Infrastructure)

**Purpose**: Install packages and prepare the HTTP server for Socket.IO attachment

- [x] T001 Install backend dependencies: `cd backend && npm install socket.io@^4.8.3 @socket.io/redis-streams-adapter` in backend/package.json
- [x] T002 Install frontend dependency: `cd frontend && npm install socket.io-client@^4.8.3` in frontend/package.json
- [x] T003 Refactor backend/src/server.ts to use explicit HTTP server creation — replace `app.listen(PORT)` with `const httpServer = createServer(app); httpServer.listen(PORT)`. Import `createServer` from `http`. Ensure the debounce job timer and sync job timer still reference the same shutdown handler. Export `httpServer` so Socket.IO can attach to it.

---

## Phase 2: Foundational (Socket.IO Server + Auth + Rooms)

**Purpose**: Core Socket.IO infrastructure that ALL user stories depend on. MUST complete before any story work begins.

**CRITICAL**: No user story work can begin until this phase is complete.

- [x] T004 Create backend/src/services/socket.service.ts — the Socket.IO server service that replaces sse.service.ts. Must export: `initSocketIO(httpServer: HttpServer): void` (called once from server.ts to attach Socket.IO), `broadcastToTenant(tenantId: string, event: string, data: unknown): void` (IDENTICAL signature to current sse.service.ts — uses `io.to('tenant:${tenantId}').emit(event, data)` internally), `getSocketStats(): { connections: number, tenants: number }` for monitoring. Internally: create `new Server(httpServer, { cors: { origin: CORS_ORIGINS, credentials: true }, transports: ['websocket'], pingInterval: 25000, pingTimeout: 20000, connectionStateRecovery: { maxDisconnectionDuration: 60 * 60 * 1000, skipMiddlewares: true } })` (1-hour recovery window — covers lunch breaks, meetings, laptop sleep). If REDIS_URL is set, attach `@socket.io/redis-streams-adapter` with a new ioredis client (separate from BullMQ). If Redis unavailable, log warning and continue in single-instance mode (graceful degradation per §I).
- [x] T005 Add JWT authentication middleware in backend/src/services/socket.service.ts — `io.use((socket, next) => { ... })` that extracts token from `socket.handshake.auth.token`, verifies with `jwt.verify(token, JWT_SECRET)`, sets `socket.data.tenantId` and `socket.data.userId`, calls `next()` on success or `next(new Error('...'))` on failure. On successful connection: join room `tenant:${socket.data.tenantId}`, log `[Socket.IO] Client connected tenantId=X userId=Y totalConnections=Z`. On disconnect: log `[Socket.IO] Client disconnected tenantId=X remainingConnections=Y`.
- [x] T006 Wire Socket.IO into server startup in backend/src/server.ts — import `initSocketIO` from socket.service, call `initSocketIO(httpServer)` after creating the HTTP server but before `httpServer.listen()`. Add Socket.IO graceful shutdown: `io.close()` in the shutdown handler (get io instance via export or callback).
- [x] T007 Update all 6 backend files that import `broadcastToTenant` from `./sse.service` or `../services/sse.service` to import from `./socket.service` or `../services/socket.service` instead. Files: backend/src/services/ai.service.ts, backend/src/services/debounce.service.ts, backend/src/services/message-sync.service.ts, backend/src/controllers/webhooks.controller.ts, backend/src/controllers/conversations.controller.ts, backend/src/controllers/messages.controller.ts (dynamic import — change path string)
- [x] T008 Remove the SSE endpoint (`GET /api/events`) from backend/src/app.ts — delete the entire endpoint handler (lines ~192-225 including JWT verification, SSE headers, heartbeat interval, registerSSEClient call). Remove the `import { registerSSEClient } from './services/sse.service'` line. KEEP the `import { getMessageSyncStats } from './services/message-sync.service'` and its usage in the `/health` endpoint — that's from feature 025 and is unrelated to SSE.
- [x] T009 Delete backend/src/services/sse.service.ts — the entire file (SSE Response registry, Redis pub/sub subscriber, in-memory fallback). All callers now import from socket.service.ts.
- [x] T010 Remove the dead `ai_typing` event broadcast from backend/src/services/debounce.service.ts — find the `broadcastToTenant(tenantId, 'ai_typing', ...)` call and delete it (dead event — broadcast but never consumed by frontend per SSE audit).
- [x] T010b Add `broadcastCritical` function to backend/src/services/socket.service.ts — export alongside `broadcastToTenant`. Uses Socket.IO acknowledgment: `io.to('tenant:${tenantId}').timeout(5000).emit(event, data, (err, responses) => { if (err) { console.warn('[Socket.IO] ACK timeout for event=${event} — retrying once'); io.to('tenant:${tenantId}').emit(event, data); } })`. Fire-and-forget retry — if the second attempt also fails, the event is in the buffer for recovery.
- [x] T010c Update callers to use `broadcastCritical` instead of `broadcastToTenant` for `message` and `ai_suggestion` events ONLY. Files to update: backend/src/services/ai.service.ts (AI reply message broadcast + ai_suggestion broadcast), backend/src/controllers/webhooks.controller.ts (guest/host message broadcast), backend/src/controllers/conversations.controller.ts (approved suggestion message broadcast), backend/src/services/message-sync.service.ts (synced message broadcast). Import `broadcastCritical` alongside `broadcastToTenant` — other events in these files stay on `broadcastToTenant`.
- [x] T011 Create frontend/lib/socket.ts — Socket.IO client singleton. `'use client'` directive. Export a `socket` instance: `io(NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_API_URL, { transports: ['websocket'], autoConnect: false, auth: { token: '' } })`. Export helper functions: `connectSocket(token: string)` — sets `socket.auth = { token }` and calls `socket.connect()`. `disconnectSocket()` — calls `socket.disconnect()`. The socket URL should use the same `API_URL` / `NEXT_PUBLIC_API_URL` environment variable used by the REST API client.

**Checkpoint**: Socket.IO server running, JWT auth working, rooms active, all broadcasts go through Socket.IO, SSE fully removed. Backend compiles clean.

---

## Phase 3: User Story 1 + User Story 4 — Instant Delivery + Tenant Isolation (Priority: P1)

**Goal**: All real-time events deliver instantly via Socket.IO. Multi-tenant isolation enforced via rooms.

**Independent Test**: Open inbox, send a guest message via Hostaway, verify it appears within 1 second. Connect two tenants simultaneously, verify isolation.

### Implementation

- [x] T012 [US1] [US4] Replace the EventSource connection in frontend/components/inbox-v5.tsx with Socket.IO — find the SSE effect (Effect 3, the `new EventSource(...)` block with all `addEventListener` handlers). Replace entirely: import `socket, connectSocket, disconnectSocket` from `../lib/socket`. In the useEffect: get token from localStorage, call `connectSocket(token)`. On `socket.recovered`: skip (events already replayed). On `!socket.recovered`: call `apiGetConversation` to refresh state. Replace all `es.addEventListener('eventName', handler)` with `socket.on('eventName', handler)`. The handler logic stays IDENTICAL — same state updates, same `setConversations`, same notification sounds. IMPORTANT for ACK: the `message` and `ai_suggestion` handlers receive an acknowledgment callback as the last argument from `broadcastCritical`. The handler MUST call it: `socket.on('message', (data, ack) => { /* process message */ if (typeof ack === 'function') ack(); })`. Same for `ai_suggestion`. Other event handlers don't need ACK (fire-and-forget). On cleanup: `disconnectSocket()`. Remove the `EventSource` type references and reconnect timer logic (Socket.IO handles reconnection automatically).
- [x] T013 [US1] Remove the 15-second conversation detail polling from frontend/components/inbox-v5.tsx — find the `setInterval(() => refreshDetail(false), 15000)` in Effect 2 and remove the interval. Keep the initial `refreshDetail(true)` call on conversation selection. Keep the on-open sync (`apiSyncConversation`) call. Socket.IO replaces the poll for real-time updates. Also remove the `SyncIndicator` component import and usage (from feature 025) — it's replaced by the `ConnectionStatus` component in T017/T018. Remove the `isSyncing`, `lastSyncedAt`, and `handleSync` state/handler that powered the sync indicator. Keep the `apiSyncConversation` on-open call (Hostaway sync is still needed).
- [x] T014 [US1] Handle the `socket.recovered` vs fresh connection case in frontend/components/inbox-v5.tsx — in the Socket.IO connect handler: if `socket.recovered === false`, re-fetch the currently selected conversation via `apiGetConversation(selectedId)` and merge into state. This handles the >1 hour outage fallback. If `socket.recovered === true`, missed events were already replayed — no action needed.
- [x] T014b [US1] Add client-side message deduplication in frontend/components/inbox-v5.tsx — maintain a `Set<string>` ref (`seenMessageIds`) that tracks message IDs already rendered. In every `message` event handler (both Socket.IO and REST fallback), check `if (seenMessageIds.current.has(msg.id)) return` before appending. Add to set after appending. Reset the set when `selectedId` changes (switching conversations). This prevents duplicate messages during recovery when Socket.IO replay and REST fetch overlap.
- [x] T014c [US1] Add smart degraded mode in frontend/components/inbox-v5.tsx — track WebSocket connection failures via a counter (`wsFailCount` ref). On each `connect_error` event, increment the counter. If `wsFailCount >= 3`, switch to degraded polling mode: start a 5-second `setInterval` that calls `apiGetConversation(selectedId)` and merges new messages (with dedup). Set `connectionStatus` to `'delayed'` (new state). If WebSocket later connects successfully, clear the polling interval and reset the counter. The user sees "Live (delayed)" instead of "Offline" — the app still works.

**Checkpoint**: US1 + US4 complete — messages appear instantly, tenant isolation enforced by rooms, dedup prevents duplicates, degraded mode ensures app works even without WebSocket.

---

## Phase 4: User Story 2 — Automatic Reconnection with State Recovery (Priority: P2)

**Goal**: Connection drops are recovered automatically — missed events replayed, no manual refresh needed.

**Independent Test**: Disconnect network for 30 seconds, reconnect, verify all missed messages appear automatically.

### Implementation

- [x] T015 [US2] Add reconnection event handlers in frontend/components/inbox-v5.tsx — listen for `socket.on('disconnect', (reason) => { ... })` to detect drops (set a `disconnectedAt` timestamp in state). Listen for `socket.on('connect', () => { ... })` to detect recovery. On recovery: if `socket.recovered` is true, events were replayed automatically. If false (outage > 1 hour or server restart), fetch current state via REST. Log reconnection events: `console.log('[Socket.IO] Reconnected, recovered:', socket.recovered)`.
- [x] T016 [US2] Add exponential backoff jitter for reconnection in frontend/lib/socket.ts — configure the socket with `reconnectionDelay: 1000, reconnectionDelayMax: 10000, randomizationFactor: 0.5` to prevent thundering herd on server deploys. These are Socket.IO client built-in options.

**Checkpoint**: US2 complete — network drops and server deploys are handled automatically.

---

## Phase 5: User Story 3 — Connection Status Visibility (Priority: P3)

**Goal**: Manager sees a clear connection indicator. Knows if their inbox is live or stale.

**Independent Test**: Disconnect network, verify "disconnected" indicator appears. Reconnect, verify "connected" indicator and "Back online" toast.

### Implementation

- [x] T017 [P] [US3] Create frontend/components/ui/connection-status.tsx — small component that shows connection state: green dot + "Live" when connected, blue dot + "Live (delayed)" when in smart polling fallback mode, yellow dot + "Reconnecting..." when disconnected (Socket.IO is auto-reconnecting), red dot + "Offline" if truly offline (no network). Props: `status: 'connected' | 'delayed' | 'reconnecting' | 'disconnected'`. Size: compact, fits in the inbox header. Tailwind styled.
- [x] T018 [US3] Add connection status state and integrate indicator in frontend/components/inbox-v5.tsx — add `connectionStatus` state (`'connected' | 'delayed' | 'reconnecting' | 'disconnected'`). Set it from Socket.IO events: `connect` → `'connected'`, `disconnect` → `'reconnecting'`, smart poll fallback (from T014c) → `'delayed'`, `connect_error` after all retries exhausted + no network → `'disconnected'`. Place `<ConnectionStatus status={connectionStatus} />` in the inbox header area. On transition from `reconnecting`/`delayed` → `connected`: show a brief inline banner "Back online — messages synced" as a simple `<div>` with CSS fade-in/fade-out animation, auto-dismiss after 3 seconds via `setTimeout` + state toggle. No external toast library — use a local `showReconnectedBanner` boolean state. Position it as a small green bar below the inbox header.

**Checkpoint**: US3 complete — managers always know if their inbox is live.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Cleanup, monitoring, validation

- [x] T018b Delete frontend/components/ui/sync-indicator.tsx — replaced by connection-status.tsx. The sync indicator was part of feature 025's message sync but is superseded by the Socket.IO connection status indicator.
- [x] T019 Add socket stats to the health endpoint in backend/src/app.ts — import `getSocketStats` from socket.service, add `socket: getSocketStats()` to the `/health` response (alongside existing stats). Returns `{ connections: number, tenants: number }`.
- [x] T020 Add `NEXT_PUBLIC_API_URL` or equivalent env var documentation — verify the frontend Socket.IO client uses the same backend URL as the REST API client. Check frontend/.env or frontend/lib/api.ts for the existing API URL pattern and ensure frontend/lib/socket.ts uses the same variable.
- [x] T021 Run all 8 quickstart.md test scenarios manually and verify each passes. Also verify NFR-003: open 5+ browser tabs simultaneously to confirm multiple concurrent connections work without degradation. Full 200+ connection load testing deferred to post-deploy monitoring.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — install packages first
- **Foundational (Phase 2)**: Depends on Phase 1 — BLOCKS all user stories
- **US1+US4 (Phase 3)**: Depends on Phase 2 (Socket.IO server must be running)
- **US2 (Phase 4)**: Depends on Phase 3 (needs the Socket.IO client in place)
- **US3 (Phase 5)**: Depends on Phase 3 (needs connection events in place) — can run in parallel with US2
- **Polish (Phase 6)**: Depends on all stories being complete

### User Story Dependencies

- **US1 + US4 (P1)**: Combined — instant delivery requires tenant isolation. Depends only on Foundational.
- **US2 (P2)**: Depends on US1 (needs the Socket.IO client connection established in Phase 3)
- **US3 (P3)**: Depends on US1 (needs connection events). Can run in parallel with US2.

### Within Each Phase

- Backend before frontend
- Service before callers
- Infrastructure before business logic

### Parallel Opportunities

- T001 and T002 are parallel (different package.json files)
- T007 (import path updates) can be parallelized across the 6 files
- T017 (connection status component) is parallel with T015-T016 (reconnection logic)
- US2 and US3 can run in parallel after US1+US4

---

## Parallel Example: Phase 2

```bash
# Sequential dependency chain:
T004 → T005 → T006 (Socket.IO server must exist before wiring)

# Then parallel:
Agent 1: "T007 — Update imports in 6 backend files"
Agent 2: "T008 — Remove SSE endpoint from app.ts"
Agent 3: "T009 — Delete sse.service.ts"
Agent 4: "T011 — Create frontend Socket.IO client singleton"
```

## Parallel Example: After Phase 3

```bash
# US2 and US3 can start simultaneously:
Agent 1: "US2 — T015-T016: Reconnection handlers + backoff config"
Agent 2: "US3 — T017-T018: Connection status component + integration"
```

---

## Implementation Strategy

### MVP First (US1 + US4)

1. Complete Phase 1: Install packages (T001-T002)
2. Complete Phase 2: Socket.IO server, auth, rooms, import migration, SSE removal (T003-T011)
3. Complete Phase 3: Frontend Socket.IO client, event handlers (T012-T014)
4. **STOP and VALIDATE**: Send a guest message, verify instant delivery via WebSocket. Test two tenants.
5. Deploy if ready — this alone fixes the core "messages don't appear" problem

### Incremental Delivery

1. Setup + Foundational → Socket.IO infrastructure ready
2. US1+US4 → Instant delivery + tenant isolation → Deploy (MVP!)
3. US2 → Reconnection with state recovery → Deploy
4. US3 → Connection status indicator → Deploy
5. Polish → Stats, validation → Deploy

---

## Notes

- The `broadcastToTenant` signature is preserved — 6 backend files only change import paths
- SSE is fully removed (no dual systems) — clean migration
- Socket.IO handles reconnection, heartbeat, and state recovery automatically — no custom code needed
- The 2-minute Hostaway message sync (feature 025) is KEPT — it serves a different purpose
- The 15-second conversation polling is REMOVED — Socket.IO replaces it
- WebSocket-only transport (no HTTP long-polling fallback) due to Railway's lack of sticky sessions
