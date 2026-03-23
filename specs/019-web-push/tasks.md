# Tasks: Web Push Notifications

**Input**: Design documents from `/specs/019-web-push/`
**Prerequisites**: plan.md, spec.md

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Foundational — Schema + Service + Routes

**Purpose**: New PushSubscription model, push service with VAPID, REST endpoints.

- [X] T001 Install `web-push` package and its types: `cd backend && npm install web-push && npm install -D @types/web-push`
- [X] T002 Add `PushSubscription` model to `backend/prisma/schema.prisma`: id, tenantId, endpoint, p256dh, auth, userAgent (default ""), createdAt. Unique constraint on [tenantId, endpoint]. Index on tenantId. Relation to Tenant. Add `pushSubscriptions PushSubscription[]` to Tenant model. Run `npx prisma db push`.
- [X] T003 Create `backend/src/services/push.service.ts` with: VAPID initialization (silently disabled if env vars missing), `sendPushToTenant(tenantId, payload, prisma)` — fetches all subscriptions for tenant, sends to each fire-and-forget, auto-deletes on 410/404. `subscribe(tenantId, subscription, userAgent, prisma)` — upsert by endpoint. `unsubscribe(tenantId, endpoint, prisma)` — delete.
- [X] T004 [P] Create `backend/src/routes/push.ts` with: `GET /api/push/vapid-public-key` (no auth, returns `{ publicKey }`), `POST /api/push/subscribe` (auth required, body: `{ subscription: { endpoint, keys: { p256dh, auth } } }`), `DELETE /api/push/subscribe` (auth required, body: `{ endpoint }`).
- [X] T005 Register push router in `backend/src/app.ts`: `app.use('/api/push', pushRouter(prisma))`

**Checkpoint**: VAPID key retrievable. Subscribe/unsubscribe work. Push service ready to send.

---

## Phase 2: US1 — Push for Guest Messages (P1)

**Goal**: Operator receives push notification when a guest sends a message.

**Independent Test**: Subscribe a device. Send a guest message via webhook. Verify push arrives.

- [X] T006 [US1] In `backend/src/controllers/webhooks.controller.ts` `handleNewMessage()`, after saving the guest message to DB (and only for `isGuest === true`), call `sendPushToTenant()` with payload: title `"{guestName} — {propertyName}"`, body: first 200 chars of message, data: `{ conversationId, type: 'message' }`. Import push service. Wrap in `.catch()` — fire-and-forget. Need to resolve guest name and property name from the conversation record (already loaded in the function).

**Checkpoint**: Guest messages trigger push to all subscribed devices.

---

## Phase 3: US2 — Push for Tasks/Escalations (P2)

**Goal**: Operator receives push when AI creates a task.

**Independent Test**: Trigger AI escalation. Verify push with task title.

- [X] T007 [US2] In `backend/src/services/ai.service.ts` `handleEscalation()`, after creating the task (the `createTask` call in the CREATE branch), call `sendPushToTenant()` with payload: title `"New Task: {urgency}"`, body: `"{title} — {note preview}"`, data: `{ conversationId, taskId: task.id, type: 'task' }`. Import push service. Wrap in `.catch()`.

**Checkpoint**: AI escalations trigger push.

---

## Phase 4: US3 — Push for Reservation Events (P3)

**Goal**: Operator receives push for reservation created/modified/cancelled.

**Independent Test**: Create a reservation via webhook. Verify push with booking details.

- [X] T008 [US3] In `backend/src/controllers/webhooks.controller.ts`, add push notifications for reservation events: In `handleNewReservation()` after creating the reservation, send push with title "New Booking", body: `"{guestName} — {propertyName}, {checkIn} to {checkOut}"`. In the resync section (reservation status change), send push for status changes: "Booking Modified" when dates/guests change, "Booking Cancelled" when status becomes CANCELLED. Import push service. All fire-and-forget.

**Checkpoint**: Reservation lifecycle events trigger push.

---

## Phase 5: Polish & Verify

- [X] T009 Add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` to `.env.example` (or document in CLAUDE.md under Environment Variables)
- [X] T010 Verify TypeScript compilation: `cd backend && npx tsc --noEmit`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1** (Foundational): No dependencies — start immediately
- **Phase 2** (US1): Depends on Phase 1 (needs push service)
- **Phase 3** (US2): Depends on Phase 1 (needs push service)
- **Phase 4** (US3): Depends on Phase 1 (needs push service)
- **Phase 5** (Polish): Depends on all previous

### Parallel Opportunities

- **Phases 2, 3, 4** can all run in parallel after Phase 1 (different files, independent trigger points)
- T003 and T004 are parallel (service vs routes)

### Execution Order

T001 → T002 → T003 (sequential — install, schema, service)
T004 (parallel with T003 — different file)
T005 (after T004 — route registration)
T006, T007, T008 (parallel — different files, after Phase 1)
T009 → T010 (sequential — docs then verify)
