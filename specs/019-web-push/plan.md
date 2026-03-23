# Implementation Plan: Web Push Notifications

**Branch**: `019-web-push` | **Date**: 2026-03-24 | **Spec**: [spec.md](./spec.md)

## Summary

Add Web Push notification support using the `web-push` npm package and VAPID keys. New `PushSubscription` DB model, push service, REST endpoints for subscribe/unsubscribe, and hooks into the existing webhook controller (guest messages, reservation events) and AI pipeline (task creation). Fire-and-forget delivery to all tenant devices, auto-cleanup of expired subscriptions.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+
**Primary Dependencies**: `web-push` npm package, Express 4.x, Prisma ORM
**Storage**: PostgreSQL + Prisma ORM (new PushSubscription model)
**Target Platform**: Railway (backend)
**Project Type**: Web service (backend only — mobile PWA handles frontend subscription)
**Constraints**: VAPID keys as env vars. Push delivery is fire-and-forget — never blocks pipeline.

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| §I Graceful Degradation | PASS | Missing VAPID keys → push silently disabled. Push failures → fire-and-forget. |
| §II Multi-Tenant Isolation | PASS | PushSubscription is tenant-scoped. |
| §III Guest Safety & Access | PASS | Push notifications go to operators only, not guests. No sensitive data in payloads (no access codes, no full messages). |
| §IV Structured AI Output | N/A | |
| §V Escalate When In Doubt | PASS | Escalation tasks trigger push — operators see them immediately. |
| §VI Observability | PASS | Push sends logged to console. |
| §VII Self-Improvement | N/A | |
| Security | PASS | Subscribe requires JWT auth. VAPID public key endpoint is unauthenticated (standard — public key is not secret). Message preview truncated to 200 chars in payload. |

No violations.

## Data Model

### New: `PushSubscription`

```prisma
model PushSubscription {
  id        String   @id @default(cuid())
  tenantId  String
  endpoint  String
  p256dh    String
  auth      String
  userAgent String   @default("")
  createdAt DateTime @default(now())

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([tenantId, endpoint])
  @@index([tenantId])
}
```

## Implementation Details

### New Files

```text
backend/src/services/push.service.ts          # Push notification sender + subscription CRUD
backend/src/routes/push.ts                    # REST endpoints (subscribe, unsubscribe, VAPID key)
```

### Modified Files

```text
backend/prisma/schema.prisma                  # New PushSubscription model + Tenant relation
backend/src/app.ts                            # Register push router
backend/src/controllers/webhooks.controller.ts # Send push on guest message + reservation events
backend/src/services/ai.service.ts            # Send push on task creation
```

### Phase 1: Push Service

**`backend/src/services/push.service.ts`**:

```typescript
import webpush from 'web-push';

// Initialize VAPID — silently disabled if env vars missing
const VAPID_OK = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
if (VAPID_OK) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT!,
    process.env.VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!
  );
}

// sendPushToTenant(tenantId, payload, prisma) — fire-and-forget to all devices
// subscribe(tenantId, subscription, prisma) — upsert by endpoint
// unsubscribe(tenantId, endpoint, prisma) — delete by endpoint
// cleanupExpired(endpoint, prisma) — called on 410/404 response
```

Notification types with standardized payloads:

| Event | Title | Body | Data |
|-------|-------|------|------|
| Guest message | `{guestName} — {propertyName}` | First 200 chars of message | `{ conversationId, type: 'message' }` |
| Task created | `New Task: {urgency}` | Task title + note preview | `{ conversationId, taskId, type: 'task' }` |
| Reservation created | `New Booking` | `{guestName} — {propertyName}, {checkIn} to {checkOut}` | `{ conversationId, type: 'reservation' }` |
| Reservation modified | `Booking Modified` | Same as above | `{ conversationId, type: 'reservation' }` |
| Reservation cancelled | `Booking Cancelled` | `{guestName} — {propertyName}` | `{ conversationId, type: 'reservation' }` |

### Phase 2: REST Endpoints

**`backend/src/routes/push.ts`**:

- `GET /api/push/vapid-public-key` — No auth. Returns `{ publicKey }`.
- `POST /api/push/subscribe` — Auth required. Body: `{ subscription: { endpoint, keys: { p256dh, auth } } }`. Upserts.
- `DELETE /api/push/subscribe` — Auth required. Body: `{ endpoint }`. Deletes.

### Phase 3: Hook into Existing Flows

**Guest messages** — in `webhooks.controller.ts` `handleNewMessage()`, after saving the message to DB, call `sendPushToTenant()` for GUEST messages only (not host messages).

**Reservation events** — in `webhooks.controller.ts` `handleNewReservation()` and the reservation update handler, call `sendPushToTenant()` with event-specific payloads.

**Task creation** — in `ai.service.ts` `handleEscalation()`, after creating the task, call `sendPushToTenant()` with task details.

All push calls are wrapped in `.catch()` — fire-and-forget, never block the pipeline.

### Environment Variables

```
VAPID_PUBLIC_KEY      # Generated once via web-push.generateVAPIDKeys()
VAPID_PRIVATE_KEY     # Same
VAPID_SUBJECT         # mailto:support@guestpilot.com
```

Add to Railway. Missing = push silently disabled.
