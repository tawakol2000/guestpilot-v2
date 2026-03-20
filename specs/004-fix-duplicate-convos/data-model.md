# Data Model: Fix Duplicate Conversations

**Branch**: `004-fix-duplicate-convos`
**Date**: 2026-03-19

---

## Schema Change: Conversation Unique Constraint

### Before

```prisma
model Conversation {
  id                     String   @id @default(cuid())
  tenantId               String
  reservationId          String
  // ... other fields

  @@index([tenantId])
  @@index([tenantId, lastMessageAt(sort: Desc)])
}
```

**Problem**: No uniqueness guarantee — multiple `Conversation` records can reference the same `reservationId` within a tenant.

### After

```prisma
model Conversation {
  id                     String   @id @default(cuid())
  tenantId               String
  reservationId          String
  // ... other fields

  @@unique([tenantId, reservationId])        ← NEW
  @@index([tenantId])
  @@index([tenantId, lastMessageAt(sort: Desc)])
}
```

**Effect**: Database enforces one conversation per reservation per tenant. Any attempt to create a second conversation for the same `(tenantId, reservationId)` pair fails with a unique constraint violation (Prisma error code `P2002`).

---

## Relationship Change

| Relationship | Before | After |
|-------------|--------|-------|
| Reservation → Conversation | One-to-many (schema allows, but conceptually one) | One-to-one (DB enforced) |
| Prisma field type | `conversations Conversation[]` | Unchanged (array field kept — Prisma doesn't require changing to optional relation for a unique constraint) |

The Prisma relation field `Reservation.conversations` remains as `Conversation[]` for backward compatibility with existing code that uses `findMany`. In practice it returns at most one element after the constraint is applied.

---

## State Invariants (Post-Fix)

| Invariant | Enforcement |
|-----------|------------|
| One conversation per reservation per tenant | `@@unique([tenantId, reservationId])` on Conversation |
| Conversation always has a reservation | `reservationId` is required (not nullable) |
| `hostawayConversationId` starts empty | `@default("")` — backfilled by G3 logic on first message |
| No orphan conversations | `onDelete: Cascade` on Tenant relation |

---

## Pre-Migration Data Cleanup

Before the unique constraint migration runs, existing duplicate conversations must be resolved. The cleanup logic:

```
For each (tenantId, reservationId) pair with count > 1:
  1. Rank conversations by message count DESC, then createdAt DESC
  2. Designate rank-1 as "winner" (keep)
  3. Cancel any PendingAiReply records on the losers
  4. Delete loser conversations
  5. Log: tenantId, reservationId, winner.id, deleted IDs, message counts
```

**Safety**: Conversations with messages are always ranked above empty ones. If two conversations both have messages (edge case), the most recently active one wins.

---

## No New Entities

This fix modifies one constraint on an existing entity. No new tables, columns, or relationships are introduced.
