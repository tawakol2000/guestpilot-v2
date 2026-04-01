# Implementation Plan: Hostaway Message Sync

**Branch**: `025-message-sync` | **Date**: 2026-04-01 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/025-message-sync/spec.md`

## Summary

Sync messages from Hostaway to catch manager replies sent outside GuestPilot. Three sync triggers: pre-response (before AI generates), background (every 2 min for active conversations), and on-demand (when manager opens conversation or clicks sync indicator). Core sync service fetches messages from Hostaway API, diffs against local DB, inserts missing messages with correct attribution, and broadcasts via SSE.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+
**Primary Dependencies**: Express 4.x, Prisma ORM 5.22, ioredis, BullMQ, axios (Hostaway API client)
**Frontend**: Next.js 16 + React 19 + Tailwind 4 + shadcn/ui
**Storage**: PostgreSQL + Prisma ORM (schema changes: `lastSyncedAt` field, partial unique index)
**Testing**: Manual integration testing against Hostaway sandbox
**Target Platform**: Railway (backend), Vercel (frontend)
**Project Type**: Web service + web application
**Performance Goals**: Pre-response sync < 2s, background sync < 10% of Hostaway rate limit budget
**Constraints**: Hostaway API rate limit 15 req/10s per IP, no outgoing message webhook, max 100 messages per API call, no cursor-based pagination
**Scale/Scope**: Multi-tenant, estimated 10-50 active conversations per tenant

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| §I Graceful Degradation | PASS | FR-006: sync failures never block AI. Pre-response sync wrapped in try/catch with graceful fallback to local-only messages. |
| §II Multi-Tenant Isolation | PASS | Background sync resolves tenant context from conversation→reservation→tenant chain. Hostaway API calls use per-tenant credentials. SSE broadcasts scoped to tenant. All queries filter by tenantId. |
| §III Guest Safety & Access Control | PASS | No change to access-code gating or reservation-status rules. Sync only adds messages to timeline. |
| §IV Structured AI Output | N/A | No new AI prompts or output schemas. |
| §V Escalate When In Doubt | N/A | No changes to escalation logic. |
| §VI Observability by Default | PASS | NFR-004: all sync operations logged (messages found, inserted, failures). Stats tracking for monitoring. |
| §VII Self-Improvement with Guardrails | N/A | No changes to classifier or judge. |
| Security & Data Protection | PASS | Per-tenant Hostaway API keys already handled. No new secrets. No new public endpoints (sync route is behind auth middleware). |

**Gate Result**: PASS — no violations.

## Project Structure

### Documentation (this feature)

```text
specs/025-message-sync/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── sync-api.md      # Sync endpoint contract
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root)

```text
backend/
├── prisma/
│   └── schema.prisma                     # MODIFY: add lastSyncedAt, partial unique index
├── src/
│   ├── services/
│   │   ├── message-sync.service.ts       # NEW: core sync logic
│   │   ├── ai.service.ts                 # MODIFY: inject pre-response sync
│   │   ├── hostaway.service.ts           # MODIFY: add retry to listConversationMessages
│   │   └── debounce.service.ts           # MODIFY: cancel logic for host-already-responded
│   ├── jobs/
│   │   └── messageSync.job.ts            # NEW: background sync polling job
│   ├── controllers/
│   │   └── conversations.controller.ts   # MODIFY: add sync endpoint
│   ├── routes/
│   │   └── conversations.ts              # MODIFY: register POST /:id/sync route
│   └── server.ts                         # MODIFY: register background sync job

frontend/
├── components/
│   ├── inbox-v5.tsx                      # MODIFY: add sync indicator, handle SSE sync events
│   └── ui/
│       └── sync-indicator.tsx            # NEW: circular countdown sync indicator component
└── lib/
    └── api.ts                            # MODIFY: add apiSyncConversation function
```

**Structure Decision**: This is a backend-heavy feature with a small frontend addition. All new backend code follows existing patterns (service + job + controller). The frontend adds one new component (sync indicator) and modifies the inbox to handle synced messages via the existing SSE `message` event type.

## Key Architecture Decisions

### 1. Sync Service as Single Function

All three triggers (pre-response, background, on-demand) call the same `syncConversationMessages()` function. This ensures consistent behavior and a single code path to maintain.

### 2. Dedup Strategy: Set-Based In-Memory Diff

- Load all local `hostawayMessageId` values for the conversation in one query
- Build a `Set<string>` for O(1) lookup
- Compare each Hostaway message against the Set
- Insert only missing messages

This avoids N+1 queries and handles races gracefully.

### 3. Fuzzy AI Match for Attribution

When sync finds an unmatched outgoing message:
1. Check if a local `role: AI` message exists within ±60 seconds with matching content (first 100 chars)
2. If match → backfill the `hostawayMessageId` on the existing AI message (don't create duplicate)
3. If no match → insert as `role: HOST` (manager sent directly)

### 4. SSE Reuse

Synced messages are broadcast using the existing `message` SSE event type with the same payload shape. The frontend already handles this event — no new event handler needed. Synced messages appear seamlessly in the inbox.

### 5. Background Job Pattern

Follows the exact pattern of `aiDebounce.job.ts`:
- `startMessageSyncJob(prisma): NodeJS.Timeout`
- `setInterval` at 120,000ms (2 minutes)
- Registered in `server.ts`, cleared on shutdown
- Processes max 5 conversations per cycle (rate limit safe: 5 calls per 2 min = 2.5 calls/min)

### 6. Partial Unique Index

Prisma 5.22 supports `@@unique` with `where: raw(...)` via the `partialIndexes` preview feature. The index already exists in the database from a prior raw SQL migration. Adding it to the schema formalizes it and makes `prisma db push` aware of it.

### 7. Host-Already-Responded Detection

After pre-response sync completes, check if the most recent non-GUEST message (by `sentAt`) is a HOST message that arrived after the last GUEST message in the pending batch. If so, the manager already handled it → cancel the AI reply in both autopilot and copilot modes.
