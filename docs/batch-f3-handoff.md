# Batch F.3 Handoff — Backend Polish

**Date:** 2026-04-13
**Branch:** `040-autopilot-shadow-mode`
**Commits:** 2 (3b495a7, b0051f9)
**Files changed:** 4 new/modified

---

## Fixes delivered

### F3.1 — GET /api/me endpoint
Created `routes/me.ts` with auth-protected GET returning `{ id, email, name, plan, createdAt, lastSyncedAt }`.
**Verified:** Route mounted at `/api/me` in app.ts, tsc clean, handler fetches tenant by `req.tenantId` and returns profile shape.

### F3.2 — name field on Tenant + PATCH /api/me
Added `name String?` to Tenant model. PATCH /api/me accepts `{ name }` with zod validation (1-100 chars), returns updated profile.
**Verified:** Schema pushed to dev DB, PATCH handler validates input and updates tenant, GET returns the new name.

### F3.3 — Composite indexes on Reservation
Added `@@index([tenantId, checkIn])` and `@@index([tenantId, checkOut])` to Reservation model for calendar date-range query performance.
**Verified:** Schema pushed to dev DB with both indexes created.

### F3.4 — Sentry integration plan (docs only)
Created `docs/sentry-integration-plan.md` covering package, setup, key captures, privacy scrubbing, and env vars. No code changes.
**Verified:** Doc committed, no backend code modified.

---

## Files changed

| File | Changes |
|---|---|
| `backend/prisma/schema.prisma` | `name String?` on Tenant, 2 composite indexes on Reservation |
| `backend/src/routes/me.ts` | New file — GET + PATCH /api/me |
| `backend/src/app.ts` | Import + mount meRouter |
| `docs/sentry-integration-plan.md` | New file — Sentry plan (docs only) |

## Build verification

```
npx tsc --noEmit     → clean
npx prisma validate  → valid
npx prisma db push   → dev DB synced
```
