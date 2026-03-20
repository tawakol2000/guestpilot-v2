# Implementation Plan: Fix Duplicate Conversations

**Branch**: `004-fix-duplicate-convos` | **Date**: 2026-03-19 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/004-fix-duplicate-convos/spec.md`

## Summary

Prevent duplicate conversation entries in the inbox caused by a race condition between `reservation.created` and `message.received` Hostaway webhook events processing concurrently for the same booking.

**Root cause**: The `Conversation` model has no unique constraint on `(tenantId, reservationId)`. The `handleNewReservation()` function uses a check-then-act pattern (`findFirst` → `create`) that both concurrent handlers can pass before either commits. Fix: add `@@unique([tenantId, reservationId])` to the schema and replace the TOCTOU pattern with a `create + P2002 catch` in the webhook handler.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+
**Primary Dependencies**: Express 4.x, Prisma ORM, PostgreSQL
**Storage**: PostgreSQL (existing) — one schema constraint change only
**Testing**: Manual end-to-end via Hostaway test booking
**Target Platform**: Railway (Docker, `guestpilot-v2` service)
**Project Type**: Web service — backend only, no frontend changes
**Performance Goals**: No impact — constraint check is O(1) via index
**Constraints**: Must not cause data loss. Must not break existing webhook flow. Migration must succeed on a database that may have existing duplicates (requires pre-migration cleanup).
**Scale/Scope**: Single constraint change + ~40 lines of code in two files

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| §I Graceful Degradation | ✅ PASS | P2002 catch is silent + logged. Webhook handler still returns 200. No new hard dependencies. |
| §II Multi-Tenant Isolation | ✅ PASS | Unique constraint is on `(tenantId, reservationId)` — per-tenant. Cleanup endpoint scoped to authenticated tenant. |
| §III Guest Safety & Access Control | ✅ PASS | No change to access code logic, screening, or reservation status gating. |
| §IV Structured AI Output | ✅ PASS | No AI pipeline changes. |
| §V Escalate When In Doubt | ✅ PASS | No escalation logic changed. |
| §VI Observability | ✅ PASS | P2002 race events are logged. Cleanup endpoint returns structured report. |
| §VII Self-Improvement Guardrails | ✅ PASS | No classifier changes. |
| Security | ✅ PASS | Cleanup endpoint requires JWT auth. No new secrets. |
| DB Changes | ✅ NOTE | Requires data cleanup before migration. See deployment sequence in quickstart.md. |

**Gate result**: PASS — no violations.

## Project Structure

### Documentation (this feature)

```text
specs/004-fix-duplicate-convos/
├── plan.md                  # This file
├── spec.md                  # Feature specification
├── research.md              # Root cause analysis + fix approach
├── data-model.md            # Schema change details
├── quickstart.md            # Deployment sequence
├── contracts/
│   └── dedup-endpoint.md   # POST /api/knowledge/dedup-conversations contract
└── tasks.md                 # Phase 2 output (/speckit.tasks command)
```

### Source Code (affected files only)

```text
backend/
├── prisma/
│   └── schema.prisma                          # Add @@unique([tenantId, reservationId]) to Conversation
├── src/
│   ├── controllers/
│   │   └── webhooks.controller.ts             # Replace TOCTOU with create + P2002 catch
│   └── routes/
│       └── knowledge.ts                       # Add POST /dedup-conversations endpoint
└── prisma/migrations/
    └── <timestamp>_add_conversation_unique/   # Generated migration
```

**Structure Decision**: Backend-only change. No frontend modifications required. Uses existing route infrastructure (knowledge.ts for maintenance endpoints). No new files except the Prisma migration.

## Phase 0: Research

**Status**: ✅ Complete — see [research.md](research.md)

Key findings:
1. Race condition in `handleNewReservation()` lines 519–535 (`webhooks.controller.ts`)
2. No `@@unique` on Conversation (confirmed in schema.prisma lines 130–131)
3. Auto-create path in `handleNewMessage()` is secondary race surface, hardened by same fix
4. Cleanup endpoint placed in `knowledge.ts` (consistent with existing maintenance endpoints)
5. Two-step deployment required: code first, then schema migration

## Phase 1: Design & Contracts

**Status**: ✅ Complete

Artifacts generated:
- [data-model.md](data-model.md) — Schema constraint change, pre-migration cleanup logic
- [contracts/dedup-endpoint.md](contracts/dedup-endpoint.md) — Cleanup endpoint API contract
- [quickstart.md](quickstart.md) — Deployment sequence

## Implementation Approach

### Change 1: `backend/prisma/schema.prisma`

Add to `model Conversation` (after existing indexes):
```prisma
@@unique([tenantId, reservationId])
```

### Change 2: `backend/src/controllers/webhooks.controller.ts`

In `handleNewReservation()`, replace lines 519–535:

**Before (TOCTOU race)**:
```typescript
const existingConv = await prisma.conversation.findFirst({
  where: { tenantId, reservationId: reservation.id },
});
if (!existingConv) {
  await prisma.conversation.create({ data: { ... } });
}
```

**After (P2002 safe)**:
```typescript
try {
  await prisma.conversation.create({ data: { ... } });
} catch (err: any) {
  if (err?.code === 'P2002') {
    // Expected during concurrent reservation.created + message.received processing.
    // The other handler already created the conversation. Safe to continue.
    console.log(`[Webhook] [${tenantId}] Conversation for reservation ${reservation.id} already exists — skipping (concurrent creation)`);
  } else {
    throw err;
  }
}
```

### Change 3: `backend/src/routes/knowledge.ts`

Add after existing maintenance endpoints:

```typescript
// POST /api/knowledge/dedup-conversations
// One-time cleanup for duplicate conversations (same reservationId, same tenant).
router.post('/dedup-conversations', authMiddleware as any, async (req: any, res) => {
  const tenantId = req.tenantId;
  try {
    // Find all reservationIds with more than one conversation for this tenant
    const groups = await prisma.conversation.groupBy({
      by: ['reservationId'],
      where: { tenantId },
      _count: { id: true },
      having: { id: { _count: { gt: 1 } } },
    });

    const details = [];
    let totalRemoved = 0;

    for (const group of groups) {
      const convs = await prisma.conversation.findMany({
        where: { tenantId, reservationId: group.reservationId },
        include: { _count: { select: { messages: true } } },
        orderBy: [{ messages: { _count: 'desc' } }, { createdAt: 'desc' }],
      });

      const [winner, ...losers] = convs;
      const loserIds = losers.map(c => c.id);

      // Cancel pending AI replies on losers
      await prisma.pendingAiReply.deleteMany({
        where: { conversationId: { in: loserIds } },
      });

      // Delete loser conversations (cascades to messages, tasks, etc.)
      await prisma.conversation.deleteMany({
        where: { id: { in: loserIds } },
      });

      details.push({
        reservationId: group.reservationId,
        winnerId: winner.id,
        removedIds: loserIds,
        winnerMessageCount: winner._count.messages,
        removedMessageCounts: losers.map(c => c._count.messages),
      });
      totalRemoved += loserIds.length;
    }

    res.json({
      duplicatesFound: groups.length,
      conversationsRemoved: totalRemoved,
      details,
    });
  } catch (err) {
    console.error('[Dedup] Error:', err);
    res.status(500).json({ error: 'Dedup failed' });
  }
});
```

## Deployment Sequence

See [quickstart.md](quickstart.md) for the full two-step deployment procedure:
1. Deploy code changes (P2002 handling + cleanup endpoint) — no schema migration yet
2. Call `POST /api/knowledge/dedup-conversations` to clean existing duplicates
3. Deploy schema migration to add the unique constraint
