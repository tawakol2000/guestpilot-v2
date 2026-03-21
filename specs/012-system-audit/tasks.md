# Tasks: Full System Audit & Cleanup

**Input**: Design documents from `/specs/012-system-audit/`
**Prerequisites**: plan.md, spec.md, quickstart.md

**Organization**: Tasks grouped by user story — security first, then bugs, then hardening.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: User Story 1 — Fix Tenant Isolation Vulnerabilities (Priority: P1) MVP

**Goal**: All database update/delete operations include tenantId in the WHERE clause.

**Independent Test**: Generate JWT for fake tenant → try to update a real conversation → should get 404.

- [ ] T001 [P] [US1] Fix `markRead` in `backend/src/controllers/conversations.controller.ts` (line 75): change `prisma.conversation.update({ where: { id } })` to verify tenantId first with `findFirst({ where: { id, tenantId } })` then update, OR use `updateMany({ where: { id, tenantId }, data: ... })` and check count === 0 for 404
- [ ] T002 [P] [US1] Fix `updateLastMessage` in `backend/src/controllers/conversations.controller.ts` (line 448): add tenantId to where clause
- [ ] T003 [P] [US1] Fix `toggleStar` in `backend/src/controllers/conversations.controller.ts` (line 488): add tenantId to where clause
- [ ] T004 [P] [US1] Fix `resolve` in `backend/src/controllers/conversations.controller.ts` (line 520): add tenantId to where clause
- [ ] T005 [P] [US1] Fix `update` in `backend/src/controllers/task.controller.ts` (line 115): add tenantId to where clause
- [ ] T006 [P] [US1] Fix `approve suggestion` in `backend/src/controllers/knowledge.controller.ts` (line 71): add tenantId to where clause on the update call
- [ ] T007 [P] [US1] Fix `delete suggestion` in `backend/src/controllers/knowledge.controller.ts` (line 102): add tenantId to where clause on the delete call
- [ ] T008 [P] [US1] Fix `update` in `backend/src/controllers/automated-messages.controller.ts` (line 48): add tenantId to where clause
- [ ] T009 [P] [US1] Fix `toggle` in `backend/src/controllers/automated-messages.controller.ts` (line 72): add tenantId to where clause
- [ ] T010 [P] [US1] Fix `delete` in `backend/src/controllers/automated-messages.controller.ts` (line 87): add tenantId to where clause
- [ ] T011 [US1] Full grep: search ALL controllers for `.update({`, `.delete({`, `.deleteMany({` without tenantId — verify no other vulnerable operations remain across the entire `backend/src/controllers/` and `backend/src/routes/` directories
- [ ] T012 [US1] Fix webhook auth grace period in `backend/src/middleware/webhook-auth.ts`: if tenant has webhookSecret configured AND request has no valid Basic Auth → return 401 (remove grace period)
- [ ] T013 [US1] Fix `getSettings` in `backend/src/controllers/auth.controller.ts` (line 133): change `req.user?.tenantId` to `(req as any).tenantId`

**Checkpoint**: All write operations are tenant-scoped. Webhook rejects unauthenticated requests.

---

## Phase 2: User Story 2b — Fix SSE Tab-Switching Bug (Priority: P1)

**Goal**: SSE reconnection does not switch the active dashboard tab.

**Independent Test**: Open Classifier tab, wait 60s for SSE reconnect, verify tab doesn't change.

- [ ] T014 [US2b] Read `frontend/components/inbox-v5.tsx` and trace how SSE events are handled. Find where `navTab` state is set. Identify if any SSE event handler (ai_typing, new_task, ai_suggestion, connected) calls `setNavTab()` or triggers a state update that resets the tab
- [ ] T015 [US2b] Fix the SSE handler in `frontend/components/inbox-v5.tsx`: ensure SSE events update data (conversation list, task list, typing indicators) WITHOUT modifying the `navTab` state. If the SSE reconnection handler re-fetches initial data and that data triggers a tab change, isolate the tab state from data refreshes

**Checkpoint**: Tab state is stable regardless of SSE lifecycle.

---

## Phase 3: User Story 2c + 2d — Backend Bug Fixes (Priority: P2)

**Goal**: Fix auth/settings endpoint, sandbox tool context, ai-config performance, analytics calculation.

- [ ] T016 [P] [US2d] Read `backend/src/routes/sandbox.ts` and compare tool wiring with `backend/src/services/ai.service.ts` (the `toolsForCall` and `toolHandlersForCall` sections). Identify why sandbox doesn't pass tools. Fix: add the same tool definitions + handlers for INQUIRY (property search) and CONFIRMED (extend-stay) to the sandbox chat handler
- [ ] T017 [P] [US2d] Read `backend/src/controllers/ai-config.controller.ts` sandboxChat method and apply the same tool fix if it also handles sandbox requests
- [ ] T018 [US2d] Fix Analytics 600% bug: read `frontend/components/analytics-v5.tsx` (or `backend/src/routes/analytics.ts`) and find the AI Resolution Rate calculation. Cap at 100% or fix the formula (likely dividing sent by received instead of AI-sent by received)
- [ ] T019 [US2d] Fix ai-config slow endpoint: read `backend/src/controllers/ai-config.controller.ts` GET handler. Profile what's slow (file reads, prompt assembly, DB queries). Add caching or lazy loading. Target: <500ms response time

**Checkpoint**: Sandbox tools fire, analytics is accurate, ai-config is fast.

---

## Phase 4: User Story 3 — Database Schema Cleanup (Priority: P2)

**Goal**: Add missing indexes, review unused fields.

- [ ] T020 [US3] Add `@@index([tenantId, status])` to Conversation model in `backend/prisma/schema.prisma`
- [ ] T021 [US3] Add `@@index([tenantId, category])` to PropertyKnowledgeChunk model in `backend/prisma/schema.prisma`
- [ ] T022 [US3] Add `@@index([tenantId, status])` to Task model in `backend/prisma/schema.prisma`
- [ ] T023 [US3] Review unused fields: grep for `screeningAnswers`, `triggerType`, `triggerOffset`, `embedding_cohere` across entire codebase. For each: if zero references in code, add a `// UNUSED — candidate for removal` comment in schema. Do NOT remove fields in this audit (backwards compatibility risk)
- [ ] T024 [US3] Run `npx prisma db push` to apply new indexes

**Checkpoint**: Indexes added, unused fields documented.

---

## Phase 5: User Story 4 — Remove Dead Code (Priority: P2)

**Goal**: Clean up deprecated functions and debug logging.

- [ ] T025 [P] [US4] Remove deprecated `getLastClassifierResult()` function from `backend/src/services/rag.service.ts` — verify with grep that no callers exist (only `getAndClearLastClassifierResult` should remain)
- [ ] T026 [P] [US4] Remove debug URL logging from `backend/src/services/import.service.ts` (the `console.log` block that dumps URL-related fields from the first listing)
- [ ] T027 [US4] Add a comment to `backend/src/config/ai-config.json` header or a README note explaining this file is a fallback template — runtime config comes from the TenantAiConfig database table

**Checkpoint**: Dead code removed, config file documented.

---

## Phase 6: User Story 5 — Frontend Error Handling (Priority: P2)

**Goal**: Replace silent catches with user feedback, add error boundary, add aria-labels.

- [ ] T028 [US5] Create an ErrorBoundary component in `frontend/components/error-boundary.tsx` (or inline in inbox-v5.tsx) that catches React errors and shows "Something went wrong" with a retry button instead of blank screen. Wrap the main dashboard content with it
- [ ] T029 [US5] Audit `frontend/components/settings-v5.tsx` for all `.catch(() => {})` calls — replace each with `.catch(err => setErrorMsg(err.message))` or a toast notification pattern. Count before and after
- [ ] T030 [P] [US5] Audit `frontend/components/opus-v5.tsx` for silent catches — add error state display
- [ ] T031 [P] [US5] Audit `frontend/components/tasks-v5.tsx` for `.catch(console.error)` — add user-visible error display
- [ ] T032 [US5] Add `aria-label` attributes to all icon-only buttons in `frontend/components/inbox-v5.tsx` — search for `<button` elements that contain only an `<img>` or icon component with no text

**Checkpoint**: No silent failures, error boundary protects dashboard, buttons are accessible.

---

## Phase 7: User Story 6 — Infrastructure Hardening (Priority: P3)

**Goal**: Health check, startup validation, env docs, CORS warning.

- [ ] T033 [P] Add `GET /health` endpoint in `backend/src/app.ts` that returns `{ status: "ok", timestamp: new Date().toISOString() }`. Add healthCheckPath to `backend/railway.toml`
- [ ] T034 [P] Add startup validation in `backend/src/server.ts`: check `DATABASE_URL` and `JWT_SECRET` exist before `prisma.$connect()`. If missing, `console.error('[FATAL] ...')` and `process.exit(1)`
- [ ] T035 [P] Add `COHERE_API_KEY=` line to `backend/.env.example` with comment: `# Optional — enables Cohere embeddings + reranking. Falls back to OpenAI if missing.`
- [ ] T036 Add CORS production warning in `backend/src/app.ts`: if `process.env.NODE_ENV === 'production'` and `!process.env.CORS_ORIGINS`, log `console.warn('[CORS] CORS_ORIGINS not set in production — falling back to localhost. This is unsafe.')`

**Checkpoint**: Health check works, startup fails fast on missing required vars, env documented.

---

## Phase 8: Compile & Push

- [ ] T037 Run `npx tsc --noEmit` — verify zero TypeScript errors
- [ ] T038 Commit all changes and push to `012-system-audit` branch

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (US1)**: No dependencies — start immediately. All tasks are parallel (different files)
- **Phase 2 (US2b)**: No dependencies — can start parallel to Phase 1
- **Phase 3 (US2c+2d)**: No dependencies — can start parallel
- **Phase 4 (US3)**: No dependencies on code changes — can start parallel
- **Phase 5 (US4)**: No dependencies — parallel
- **Phase 6 (US5)**: No dependencies — parallel
- **Phase 7 (US6)**: No dependencies — parallel
- **Phase 8**: Depends on ALL phases complete

### Parallel Opportunities

```
Phase 1: T001-T010 ALL parallel (different lines in different files)
          T011 sequential (grep verification after all fixes)
          T012-T013 parallel (different files)
Phase 2: T014 → T015 (sequential — read then fix)
Phase 3: T016 ‖ T017 ‖ T018 ‖ T019 (different files)
Phase 4: T020-T023 parallel (same file but different models), T024 after all
Phase 5: T025 ‖ T026 ‖ T027 (different files)
Phase 6: T028 → T029, T030 ‖ T031 (different files), T032 last
Phase 7: T033 ‖ T034 ‖ T035 ‖ T036 (different files/sections)
```

**Maximum parallelism**: Phases 1-7 can ALL start simultaneously since they touch different files.

---

## Implementation Strategy

### MVP First (Security)

1. Phase 1: Fix all tenant isolation + webhook auth + auth/settings (T001-T013)
2. **STOP and VALIDATE**: Test with fake tenant JWT
3. Deploy — security fixes are the highest priority

### Incremental Delivery

1. Phase 1 → Security fixes (deploy immediately)
2. Phase 2 → SSE tab fix (deploy)
3. Phase 3 → Sandbox tools + analytics + performance (deploy)
4. Phase 4-5 → Schema indexes + dead code (deploy)
5. Phase 6-7 → Frontend hardening + infrastructure (deploy)

---

## Notes

- Total: 38 tasks across 8 phases
- MVP: 13 tasks (Phase 1 — security)
- Most tasks are parallel — can dispatch 10+ agents simultaneously
- No new files except ErrorBoundary component
- No schema migrations — indexes only (non-destructive)
- Python stays in Dockerfile (verified: retrain button uses it)
- System prompts NOT touched (another session)
