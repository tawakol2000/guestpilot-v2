# Batch B Handoff — Backend Critical Fixes

**Date:** 2026-04-13
**Branch:** `040-autopilot-shadow-mode`
**Commits:** 8 (56358e5..2a6f1d3)
**Files changed:** 14 (212 insertions, 35 deletions)

---

## Fixes delivered

### B1 — Hostaway send failures become visible

**Problem:** `messages.controller.ts:58-60` swallowed Hostaway errors. Client got 201 even when Hostaway rejected. User thought message was delivered.

**What changed:**
- `schema.prisma`: Added `deliveryStatus`, `deliveryError`, `deliveredAt` nullable fields to Message model
- `messages.controller.ts`: HOST message sends now track delivery state — `pending` on create, `sent` after Hostaway success, `failed` with error message on Hostaway failure
- `ai.service.ts`: AI outbound messages also track delivery state — `pending` on write-ahead create, `sent`/`failed` after Hostaway response
- Socket event `message_delivery_status` broadcast on failure with `{ messageId, conversationId, status, error }`
- POST /messages response now includes `deliveryStatus`, `deliveryError`, `source`

**Verified:** `tsc --noEmit` clean; all 11 `prisma.message.create()` sites audited — HOST/AI sends set delivery fields, inbound messages default to null (safe).

### B2 — Rate limit on POST messages

**Problem:** No server-side cap on message sends. Send-loop bug could spam real guests.

**What changed:**
- `rate-limit.ts`: Added `messageSendLimiter` (10/min/tenant) and `reservationActionLimiter` (5/min/tenant)
- Applied `messageSendLimiter` to: POST messages, notes, translate, approve-suggestion, shadow-preview send
- Applied `reservationActionLimiter` to: POST reservation approve, reject
- Uses Redis store if `REDIS_URL` set, falls back to in-memory (same pattern as existing limiters)

**Verified:** Rate limiters created with correct key generators using `req.tenantId`. All route files import and apply the middleware.

### B3 — Verify current password on change-password

**Problem:** `POST /auth/change-password` accepted `{ newPassword }` without verifying old password. Anyone with JWT could change password.

**What changed:**
- `auth.controller.ts`: Now requires `{ currentPassword, newPassword }`. Fetches tenant, `bcrypt.compare` on `currentPassword`. Returns 401 if mismatch.
- `frontend/lib/api.ts`: Updated `apiChangePassword(currentPassword, newPassword)` signature
- `frontend/components/settings-v5.tsx`: Added "Current password" input field to the change-password form

**Verified:** Backend requires both fields; frontend sends both fields. Frontend TS errors are all pre-existing (calendar, sandbox, tools) — none from this change.

**Breaking change caught:** The web frontend previously sent only `{ newPassword }`. Without the frontend fix, every password change attempt would have returned 400. Fixed in commit `ac4bd8b`.

### B4 — Reservation sync job inherits property AI mode

**Problem:** `reservationSync.job.ts:115` hardcoded `aiMode: 'copilot'`. Properties set to autopilot/off saw new reservations revert to copilot.

**What changed:**
- `reservationSync.job.ts`: Before creating a new reservation, looks up the most recent reservation for the same `propertyId` and inherits its `aiMode` and `aiEnabled`. Falls back to `copilot`/`true` if no prior reservation exists.
- Matches the existing webhook path pattern at `webhooks.controller.ts:853-862`.

**Verified:** Logic mirrors the webhook path. Logs which path was taken ("Inherited from prior reservation" vs default).

### B5 — Task mutations broadcast socket events

**Problem:** `task.controller.ts` POST/PATCH/DELETE didn't emit socket events. Multi-device task sync broken for manual actions.

**What changed:**
- `task.controller.ts`: All mutations now broadcast:
  - POST (conversation-scoped): `new_task` with `{ conversationId, task }`
  - POST (global): `new_task` with `{ conversationId: null, task }`
  - PATCH: `task_updated` with `{ conversationId, task }`
  - DELETE: `task_deleted` with `{ taskId, conversationId }`
- `task.service.ts`: `deleteTask` now returns the deleted task (needed for broadcast payload) and throws with `status: 404` instead of generic Error (fixes audit item H-5)

**Verified:** Broadcasts use `broadcastToTenant` (fire-and-forget), matching the existing AI task creation pattern. Only one caller of `deleteTask` — it now uses the return value for the broadcast.

### B6 — Content length validation on POST messages

**Problem:** No length limit beyond Express 10MB body parser. Allows degenerate/abuse input.

**What changed:**
- `messages.controller.ts`: Zod schema now enforces `.max(4000, 'Message too long (max 4000 characters)')` on `content` field
- Applies to POST messages, notes, and translateAndSend (all use same schema)

**Verified:** 4000 chars is safe for Airbnb (4000 limit) and WhatsApp (4096 limit).

### B7 — X-Client-Source header tracking

**Problem:** No audit trail distinguishing iOS/web/AI sends. If iOS misbehaves, can see what was sent but not by which client.

**What changed:**
- `schema.prisma`: Added `source` nullable field to Message model
- `messages.controller.ts`: Reads `X-Client-Source` header, whitelists `web`/`ios`, saves to Message row. Rejects unknown values silently (defaults to null).
- `ai.service.ts`: Sets `source: 'ai'` on all AI-created messages (private notes, outbound, shadow previews)
- POST /messages response includes `source` field

**Verified:** Header whitelisting prevents injection of arbitrary values. Null default means existing code without the header works unchanged.

---

## Files changed

| File | Changes |
|---|---|
| `backend/prisma/schema.prisma` | +4 fields on Message (deliveryStatus, deliveryError, deliveredAt, source) |
| `backend/src/controllers/messages.controller.ts` | Delivery tracking, source tracking, content limit, socket broadcast |
| `backend/src/controllers/auth.controller.ts` | Current password verification |
| `backend/src/controllers/task.controller.ts` | Socket broadcasts on all mutations |
| `backend/src/services/task.service.ts` | 404 error + return deleted row |
| `backend/src/services/ai.service.ts` | source='ai' + delivery tracking on AI sends |
| `backend/src/middleware/rate-limit.ts` | 2 new rate limiters |
| `backend/src/routes/conversations.ts` | Apply messageSendLimiter |
| `backend/src/routes/shadow-preview.ts` | Apply messageSendLimiter |
| `backend/src/routes/reservations.ts` | Apply reservationActionLimiter |
| `backend/src/jobs/reservationSync.job.ts` | AI mode inheritance from property |
| `frontend/lib/api.ts` | apiChangePassword signature update |
| `frontend/components/settings-v5.tsx` | Current password input field |

---

## Build verification

```
npx tsc --noEmit          → clean (backend)
npx prisma validate       → valid
npx prisma db push        → dev DB synced
npx tsc --noEmit          → frontend has pre-existing errors only (none from this batch)
```

## Not deployed

Schema pushed to dev DB only. Production migration and deploy are separate steps.
