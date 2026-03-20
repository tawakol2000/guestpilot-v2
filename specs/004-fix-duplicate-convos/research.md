# Research: Fix Duplicate Conversations

**Branch**: `004-fix-duplicate-convos`
**Date**: 2026-03-19

---

## Root Cause Analysis

### Decision: Two-layer fix — DB unique constraint + application P2002 handling

**Rationale**: The duplicate conversations are caused by a race condition between two concurrent async webhook handlers (`reservation.created` and `message.received`) that both pass a "does a conversation exist?" check before either has committed, then both execute a `create`. The fix requires eliminating this at both the database level (unique constraint as hard stop) and the application level (replace check-then-act with try/catch on the create).

**Alternatives considered**:
- Application-level mutex/lock: Rejected — doesn't work across multiple server instances (Railway can spin up multiple containers). Also adds operational complexity.
- Database-level advisory locks: Rejected — overkill, Prisma doesn't expose this cleanly, and unique constraints achieve the same result more idiomatically.
- Retry loop in `handleNewMessage`: Rejected as the sole fix — addresses symptoms not root cause. Adding a retry without the constraint means duplicates can still be created.

---

## Finding 1: Race Condition Location

**Decision**: The race originates in `handleNewReservation()` at lines 519–535 of `webhooks.controller.ts`.

**Rationale**: The existing code uses a classic TOCTOU (time-of-check-time-of-use) pattern:
```
findFirst(where: {tenantId, reservationId}) → if not found → create(...)
```
Both `reservation.created` and `message.received` handlers run fire-and-forget via `processWebhook(...).catch(...)`. Hostaway fires both events within milliseconds of each other for new bookings/inquiries. Both handlers can pass the `findFirst` check before either's `create` commits.

**Alternatives considered**: N/A — this is an observed fact from code inspection.

---

## Finding 2: No Unique Constraint on Conversation

**Decision**: `model Conversation` has no `@@unique([tenantId, reservationId])` constraint — only indexes.

**Rationale**: The schema allows `Reservation.conversations` to be a one-to-many relation. In practice, only one conversation per reservation is ever intended, but nothing enforces this. Adding `@@unique([tenantId, reservationId])` makes the database the authority on this invariant.

**Implications of adding the constraint**:
- Existing duplicate conversations must be cleaned up BEFORE the migration is applied (migration will fail if duplicates exist).
- `handleReservationUpdated()` uses `findMany` for conversation lookups — this continues to work correctly with at most one result.
- The `Reservation.conversations` relation type changes semantically (one-to-one in practice) but the Prisma schema can keep it as a one-to-many relation field — the unique constraint enforces the invariant at the DB level.

---

## Finding 3: Auto-Create Path in handleNewMessage

**Decision**: The auto-create path (lines 228–258 of `webhooks.controller.ts`) is a secondary race surface that also needs hardening.

**Rationale**: When `message.received` arrives and finds no conversation (because `reservation.created` hasn't committed yet), it calls `handleNewReservation()` to auto-create. After `handleNewReservation()` completes, the retry lookup at line 233 searches by `hostawayConversationId` — but the just-created conversation has `hostawayConversationId: ''`, so the lookup fails. It then tries by `reservationId` (lines 239–252) which should find it. However, with P2002 handling added to `handleNewReservation()`, if `reservation.created` and `message.received` race, exactly one will create the conversation and the other will catch P2002 and silently succeed. The retry lookup then always finds the winning conversation.

---

## Finding 4: Cleanup Strategy for Existing Duplicates

**Decision**: For each reservation with two conversations, keep the one with the most messages. If both have zero messages, keep the most recently created one. Delete the losers after first cancelling any pending AI replies on them.

**Rationale**: The duplicate "ghost" conversations consistently have zero messages based on the observed screenshot (Inquiry status, no message preview). Keeping the conversation with messages is safe and non-destructive.

**Implementation**: A one-time cleanup endpoint `POST /api/knowledge/dedup-conversations` (added to the existing `knowledge.ts` router which already handles maintenance operations like `seed-sops` and `classifier-reinitialize`). This is preferred over a raw migration script because it can be called interactively, returns a report, and is idempotent.

---

## Finding 5: Migration Sequencing

**Decision**: Deploy in two steps — code changes first, schema migration second.

**Rationale**:
1. Deploy code with P2002 handling (backward-compatible — doesn't require the constraint to exist yet).
2. Call `POST /api/knowledge/dedup-conversations` to clean existing duplicates.
3. Apply schema migration to add `@@unique([tenantId, reservationId])` via `prisma migrate deploy` on next deploy.

This avoids a failed migration due to existing duplicate data. The P2002 handling in step 1 is a no-op until step 3 adds the constraint, but makes the code correct and ready.

---

## Summary of Changes Required

| File | Change |
|------|--------|
| `backend/prisma/schema.prisma` | Add `@@unique([tenantId, reservationId])` to `Conversation` |
| `backend/src/controllers/webhooks.controller.ts` | Replace `findFirst + create` with `create + P2002 catch` in `handleNewReservation()` |
| `backend/src/routes/knowledge.ts` | Add `POST /dedup-conversations` cleanup endpoint |
| `backend/src/app.ts` | No changes needed |
| `backend/prisma/migrations/` | New migration file generated by `prisma migrate dev` |
