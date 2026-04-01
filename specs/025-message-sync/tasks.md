# Tasks: Hostaway Message Sync

**Input**: Design documents from `/specs/025-message-sync/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/sync-api.md, quickstart.md

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Schema & Infrastructure)

**Purpose**: Database schema changes and dependency setup required before any sync logic

- [x] T001 Add `partialIndexes` preview feature to Prisma generator block in backend/prisma/schema.prisma (SKIPPED — Prisma 5.22 doesn't support partialIndexes; index already exists in DB via raw SQL)
- [x] T002 Add `lastSyncedAt DateTime?` field to Conversation model in backend/prisma/schema.prisma
- [x] T003 Add partial unique index `@@unique([conversationId, hostawayMessageId], map: "Message_conv_hostaway_msg_unique", where: raw("\"hostawayMessageId\" != ''"))` on Message model in backend/prisma/schema.prisma (replace the existing TODO comment — IMPORTANT: the index already exists in DB from a prior raw SQL migration in `prisma/migrations/add_audit_constraints.sql`, so the `map:` name must match exactly to avoid conflict on `db push`)
- [x] T004 Run `npx prisma db push` and `npx prisma generate` to apply schema changes (generate done locally; db push deferred to deploy)

---

## Phase 2: Foundational (Core Sync Service)

**Purpose**: The shared sync function that ALL user stories depend on. MUST complete before any story work begins.

**CRITICAL**: No user story work can begin until this phase is complete.

- [x] T005 Add `retryWithBackoff` wrapper to `listConversationMessages()` in backend/src/services/hostaway.service.ts (currently calls `client.get()` directly without retry — wrap it like `sendMessageToConversation` uses)
- [x] T006 Create `backend/src/services/message-sync.service.ts` with core `syncConversationMessages(prisma, conversationId, hostawayConversationId, tenantId, hostawayAccountId, hostawayApiKey, options?)` function implementing: cooldown check (skip if lastSyncedAt < 30s, bypassable via `force` option), fetch messages from Hostaway via `listConversationMessages(accountId, apiKey, hostawayConvId, 100)` with a 2-second axios timeout (on timeout, return early with `{ skipped: true, reason: 'timeout' }` — graceful degradation per FR-006/NFR-001), load local messages and build `Set<string>` of existing hostawayMessageIds, diff and insert missing messages with correct role (GUEST if isIncoming=1, HOST otherwise), fuzzy AI match for outgoing messages (check local AI messages within ±60s with matching content first 100 chars — backfill hostawayMessageId instead of creating duplicate; if inconclusive, default to HOST attribution), for synced GUEST messages: increment `conversation.unreadCount`, if any synced message has sentAt newer than conversation.lastMessageAt: update `conversation.lastMessageAt`, update `conversation.lastSyncedAt`, SSE broadcast each new message using existing `broadcastToTenant(tenantId, 'message', payload)` pattern, return `{ newMessages, backfilled, skipped, hostRespondedAfterGuest }` stats. Note: credentials are passed as params (not resolved internally) to avoid extra DB queries — callers resolve them from tenant context
- [x] T007 Add `getMessageSyncStats()` export to backend/src/services/message-sync.service.ts for operational monitoring (call count, messages synced, errors, avg duration — same pattern as task-manager.service.ts)
- [x] T008 Add `apiSyncConversation(conversationId: string, force?: boolean)` function to frontend/lib/api.ts — POST to `/api/conversations/${id}/sync?force=${force}`

**Checkpoint**: Core sync function ready — all three triggers (pre-response, background, on-demand) can now be built.

---

## Phase 3: User Story 1 — AI Responds With Full Context (Priority: P1) MVP

**Goal**: Before the AI generates any response, sync messages from Hostaway to ensure the AI sees manager replies sent outside GuestPilot. If a manager already responded, cancel the AI reply.

**Independent Test**: Send a host message via Hostaway directly, then a guest follow-up. Verify the AI's response acknowledges the manager's message. Also verify that if a manager already fully handled it, the AI reply is cancelled.

### Implementation for User Story 1

- [x] T009 [US1] Inject pre-response sync into `generateAndSendAiReply()` in backend/src/services/ai.service.ts — right before the `prisma.message.findMany` call (around line 1291), add: load conversation's `hostawayConversationId` from context, call `syncConversationMessages(prisma, conversationId, hostawayConversationId, tenantId, hostawayAccountId, hostawayApiKey)` wrapped in try/catch (graceful failure — log warning, proceed with local messages), credentials come from the AiReplyContext (added in T011)
- [x] T010 [US1] Add host-already-responded detection in backend/src/services/ai.service.ts — after sync completes and messages are loaded, check if the most recent non-GUEST message (by sentAt) is a HOST message that arrived after the earliest GUEST message in the current pending batch. If so: cancel the PendingAiReply (`updateMany({ where: { conversationId, fired: false }, data: { fired: true, suggestion: null } })`), broadcast `ai_typing_clear` SSE event, log `[AI] Manager responded directly — skipping AI reply`, return early (do not generate AI response)
- [x] T011 [US1] Ensure the AiReplyContext type and context-building code in both backend/src/jobs/aiDebounce.job.ts and backend/src/workers/aiReply.worker.ts includes `hostawayConversationId` and tenant Hostaway credentials (`hostawayAccountId`, `hostawayApiKey`) so the sync service can make API calls

**Checkpoint**: US1 complete — AI now sees full conversation context and cancels when manager already responded.

---

## Phase 4: User Story 2 — Background Conversation Sync (Priority: P2)

**Goal**: Active conversations are synced every 2 minutes in the background so the GuestPilot inbox stays current without waiting for an AI response trigger.

**Independent Test**: Send a host message via Hostaway, wait up to 2 minutes, verify it appears in the GuestPilot inbox.

### Implementation for User Story 2

- [x] T012 [US2] Create `backend/src/jobs/messageSync.job.ts` with `startMessageSyncJob(prisma: PrismaClient): NodeJS.Timeout` — follows aiDebounce.job.ts pattern: `setInterval` at 120000ms (2 min), queries active conversations needing sync (status OPEN, reservation status in INQUIRY/PENDING/CONFIRMED/CHECKED_IN, lastMessageAt > now-24h, lastSyncedAt null or > 2min ago), ordered by lastSyncedAt ASC, take 5 per cycle, resolves tenant Hostaway credentials for each conversation (if tenant lacks `hostawayAccountId` or `hostawayApiKey`, skip that conversation with a debug log), calls `syncConversationMessages()` for each with try/catch per conversation (one failure must not stop the cycle), logs cycle stats (`[MessageSync] Synced X conversations, Y new messages, Z skipped`)
- [x] T013 [US2] Register background sync job in backend/src/server.ts — import `startMessageSyncJob`, call it after `startAiDebounceJob(prisma)`, store the timer handle, add `clearInterval(syncJobTimer)` to the shutdown handler

**Checkpoint**: US2 complete — inbox stays current via background polling.

---

## Phase 5: User Story 3 — On-Demand Sync & Sync Indicator (Priority: P3)

**Goal**: When a manager opens a conversation, the system syncs immediately. A circular countdown indicator shows time until next auto-sync; clicking it triggers an immediate resync.

**Independent Test**: Send a host message via Hostaway, open that conversation in GuestPilot, verify the message appears within 2 seconds. Click the sync indicator to trigger a manual resync.

### Implementation for User Story 3

- [x] T014 [P] [US3] Add `syncConversation` method to conversations controller in backend/src/controllers/conversations.controller.ts — handler for POST /:id/sync, extracts conversationId and tenantId, looks up conversation (with reservation and tenant), calls `syncConversationMessages()` with `force: req.query.force === 'true'`, returns JSON per sync-api.md contract (ok/newMessages/backfilled/syncedAt or skipped/reason/lastSyncedAt), 404 if conversation not found, 500 on failure
- [x] T015 [P] [US3] Register sync route in backend/src/routes/conversations.ts — add `router.post('/:id/sync', ...)` pointing to `convCtrl.syncConversation`, following existing handler pattern with AuthenticatedRequest cast
- [x] T016 [US3] Create `frontend/components/ui/sync-indicator.tsx` — small circular countdown component (iPhone timer style): receives `lastSyncedAt` timestamp and `syncIntervalMs` (default 120000) as props, calculates and displays countdown to next auto-sync as a circular progress ring with remaining time text, animates the ring as time counts down, onClick calls the `onSync` callback prop, shows a spinning state while sync is in progress, tooltip on hover: "Next sync in X:XX — click to sync now"
- [x] T017 [US3] Integrate sync indicator into conversation view in frontend/components/inbox-v5.tsx — add sync indicator component to the conversation header area (near the conversation title/status), pass `lastSyncedAt` from conversation state, wire onClick to call `apiSyncConversation(conversationId, true)` (force=true bypasses cooldown), on sync response: if new messages were found, they arrive via SSE `message` events (already handled), update `lastSyncedAt` in local state from response
- [x] T018 [US3] Add on-open sync trigger in frontend/components/inbox-v5.tsx — when a conversation is selected (the `selectedConversation` changes), fire `apiSyncConversation(conversationId)` in the background (no force, respects cooldown), update `lastSyncedAt` in local state from response, do NOT block conversation loading (fire-and-forget)

**Checkpoint**: US3 complete — managers get fresh messages on open, visual sync indicator with manual resync.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Observability, edge case hardening, validation

- [x] T019 Add sync stats to the existing stats/health endpoint — include `getMessageSyncStats()` output alongside existing `getTaskManagerStats()` in backend/src/routes/ai-config.ts health endpoint
- [x] T020 Run all 7 quickstart.md test scenarios manually and verify each passes (pre-response sync, manager-already-responded cancel, background sync, on-demand sync, sync indicator click, deduplication, graceful failure)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 (schema must be applied first) — BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Phase 2 (needs sync service)
- **US2 (Phase 4)**: Depends on Phase 2 (needs sync service) — can run in parallel with US1
- **US3 (Phase 5)**: Depends on Phase 2 (needs sync service) — can run in parallel with US1 and US2
- **Polish (Phase 6)**: Depends on all user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Depends only on Foundational — no dependency on other stories
- **User Story 2 (P2)**: Depends only on Foundational — no dependency on other stories
- **User Story 3 (P3)**: Depends only on Foundational — frontend API function (T008) is in Foundational phase

### Within Each User Story

- Models/schema before services
- Services before controllers/endpoints
- Backend before frontend integration
- Core implementation before SSE/UI integration

### Parallel Opportunities

- T001, T002, T003 can be done in one schema edit (sequential but same file)
- T005 and T006 are parallel (different files)
- T012 and T014+T015 are parallel (different files, both depend only on Phase 2)
- T016 (frontend component) is parallel with T014+T015 (backend endpoint)
- US1, US2, US3 can all be worked on in parallel after Phase 2

---

## Parallel Example: Phase 2

```bash
# These can run in parallel (different files):
Agent 1: "T005 — Add retry wrapper to listConversationMessages in hostaway.service.ts"
Agent 2: "T006 — Create message-sync.service.ts with core sync function"
Agent 3: "T008 — Add apiSyncConversation to frontend/lib/api.ts"
```

## Parallel Example: User Stories After Phase 2

```bash
# All three stories can start simultaneously:
Agent 1: "US1 — T009-T011: Pre-response sync in ai.service.ts"
Agent 2: "US2 — T012-T013: Background sync job in messageSync.job.ts + server.ts"
Agent 3: "US3 — T014-T018: Sync endpoint + sync indicator component"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Schema changes (T001-T004)
2. Complete Phase 2: Core sync service (T005-T008)
3. Complete Phase 3: Pre-response sync + host-already-responded detection (T009-T011)
4. **STOP and VALIDATE**: Test US1 independently — send host message via Hostaway, verify AI sees it
5. Deploy if ready — this alone solves the core problem

### Incremental Delivery

1. Setup + Foundational → Sync service ready
2. Add US1 → AI has full context → Deploy (MVP!)
3. Add US2 → Inbox stays current in background → Deploy
4. Add US3 → On-demand sync + visual indicator → Deploy
5. Polish → Stats, validation → Deploy

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story is independently completable and testable
- The core sync function (T006) is the most complex task — it handles dedup, fuzzy matching, attribution, SSE broadcast, and cooldown in one function
- All sync operations are idempotent and gracefully degrade on failure
- Commit after each phase completion
