# Tasks: Deep Code Cleanup

**Input**: Design documents from `/specs/022-deep-code-cleanup/`
**Prerequisites**: plan.md, spec.md, research.md

**Organization**: Tasks grouped by user story (US1=Frontend, US2=Backend, US3=Schema). Each is independently deployable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 (frontend), US2 (backend), US3 (schema)

---

## Phase 1: Setup

**Purpose**: No setup needed — this is a deletion task on an existing codebase.

- [ ] T001 Create a git checkpoint: ensure all current changes are committed before cleanup begins

---

## Phase 2: Foundational

**Purpose**: No foundational work needed — deletions are independent.

**Checkpoint**: Skip directly to user stories.

---

## Phase 3: User Story 1 - Remove Dead Frontend Code (Priority: P1)

**Goal**: Delete 4 dead component files, 2 dead hooks, 24+ dead API functions, 3 dead types, and dead state variables from active components.

**Independent Test**: `cd frontend && npm run build` succeeds with zero errors. All 11 inbox tabs render.

### Implementation for User Story 1

- [ ] T002 [P] [US1] Delete dead component file `frontend/components/ai-pipeline-v5.tsx`
- [ ] T003 [P] [US1] Delete dead component file `frontend/components/opus-v5.tsx`
- [ ] T004 [P] [US1] Delete dead component file `frontend/components/sop-monitor-v5.tsx`
- [ ] T005 [P] [US1] Delete dead component file `frontend/components/theme-provider.tsx`
- [ ] T006 [P] [US1] Delete dead hook file `frontend/hooks/use-mobile.ts`
- [ ] T007 [P] [US1] Delete dead hook file `frontend/hooks/use-toast.ts`
- [ ] T008 [US1] Remove 24 dead API functions from `frontend/lib/api.ts`: apiCancelPendingAi, apiSendAiNow, apiTranslateMessage, apiGetAutomatedMessages, apiCreateAutomatedMessage, apiUpdateAutomatedMessage, apiToggleAutomatedMessage, apiDeleteAutomatedMessage, apiGetConversationChecklist, apiGetProperty, apiInquiryAction, apiGetSopData, apiCreateConversationTask, apiReindexPropertyKnowledge, apiGenerateOpusReport, apiGetOpusReports, apiGetOpusReport, apiGetOpusReportRaw, apiGetSopClassifications, apiGetSopStats, apiFetchAccuracy, apiGenerateSnapshot, mapCheckInStatus, mapReservationStatus
- [ ] T009 [US1] Remove 3 dead type definitions from `frontend/lib/api.ts`: OpusReportSummary, OpusReportDetail, AccuracyMetrics
- [ ] T010 [P] [US1] Remove dead state variables from `frontend/components/analytics-v5.tsx`: tooltip state (~line 225) and hoveredDay (~line 234)
- [ ] T011 [P] [US1] Remove dead state variable from `frontend/components/ai-logs-v5.tsx`: showRaw (~line 225)
- [ ] T012 [P] [US1] Remove dead state variable from `frontend/components/sandbox-chat-v5.tsx`: reasoningEffort (~line 93) and its usage (~line 160)
- [ ] T013 [US1] Remove dead import comments from `frontend/components/inbox-v5.tsx` (lines ~83-89: AiPipelineV5, ExamplesEditorV5, OpusV5, SopMonitorV5 removal comments)
- [ ] T014 [US1] Verify frontend build: run `cd frontend && npm run build` — must succeed with zero errors

**Checkpoint**: Frontend is clean. All 11 tabs render. Build passes.

---

## Phase 4: User Story 2 - Remove Dead Backend Code + Orphaned Routes (Priority: P2)

**Goal**: Delete 2 dead service files, 3 dead route/controller files, remove orphaned endpoints from active routes, remove dead code from ai.service.ts and other files.

**Independent Test**: `cd backend && npx tsc --noEmit` succeeds with zero errors. AI pipeline processes a guest message.

### Implementation for User Story 2

#### Delete dead files

- [ ] T015 [P] [US2] Delete dead service file `backend/src/services/memory.service.ts`
- [ ] T016 [P] [US2] Delete dead service file `backend/src/services/snapshot.service.ts`
- [ ] T017 [P] [US2] Delete dead route file `backend/src/routes/ai-pipeline.ts`
- [ ] T018 [P] [US2] Delete dead route file `backend/src/routes/automated-messages.ts`
- [ ] T019 [P] [US2] Delete dead controller file `backend/src/controllers/automated-messages.controller.ts`

#### Remove route mounts from app.ts

- [ ] T020 [US2] Remove route mounts for deleted routes from `backend/src/app.ts`: ai-pipeline router import + mount, automated-messages router import + mount

#### Remove orphaned endpoints from active routes

- [ ] T021 [P] [US2] Remove orphaned `POST /api/ai-config/sandbox-chat` endpoint from `backend/src/routes/ai-config.ts`
- [ ] T022 [P] [US2] Remove orphaned `GET /api/knowledge/sop-classifications` and `GET /api/knowledge/evaluation-stats` endpoints from `backend/src/routes/knowledge.ts`

#### Clean dead code in ai.service.ts

- [ ] T023 [US2] Remove dead constant `REASONING_CATEGORIES` from `backend/src/services/ai.service.ts` (~line 141)
- [ ] T024 [US2] Remove unused imports from `backend/src/services/ai.service.ts`: `SOP_CATEGORIES` (~line 18), `getChecklist` (~line 24)
- [ ] T025 [US2] Remove dead variables from `backend/src/services/ai.service.ts`: `conversationTurns` (~line 1249), `knowledgeText` (~line 1302), `classificationInput` (~line 1360)
- [ ] T026 [US2] Remove unused parameter `retrievedChunks` from `buildPropertyInfo()` in `backend/src/services/ai.service.ts` (~line 970) and update all callers
- [ ] T027 [US2] Consolidate identical copilot/autopilot `currentMsgs` branches in `backend/src/services/ai.service.ts` (~lines 1258-1268) — remove the if/else, keep single code path

#### Clean dead code in other files

- [ ] T028 [P] [US2] Remove dead `PLAN_LIMITS` constant from `backend/src/services/import.service.ts` and its usage
- [ ] T029 [P] [US2] Remove unused `NextFunction` import from `backend/src/controllers/task.controller.ts`
- [ ] T030 [P] [US2] Remove stale TODO T027 comment from `backend/src/services/judge.service.ts`

#### Remove dead exports from active services

- [ ] T031 [P] [US2] Remove dead export `getQueueInstance()` from `backend/src/services/queue.service.ts`
- [ ] T032 [P] [US2] Remove dead export `getEmbeddingDimensions()` from `backend/src/services/embeddings.service.ts`
- [ ] T033 [P] [US2] Remove dead export `setRerankEnabled()` from `backend/src/services/rerank.service.ts`

#### Verify

- [ ] T034 [US2] Verify backend compilation: run `cd backend && npx tsc --noEmit` — must succeed with zero errors

**Checkpoint**: Backend is clean. Compilation passes. No dead services, routes, or exports remain.

---

## Phase 5: User Story 3 - Remove Dead Prisma Models (Priority: P3)

**Goal**: Drop OpusReport, ClassifierWeights, and AutomatedMessage models from Prisma schema and database.

**Independent Test**: `npx prisma db push` succeeds. Application starts. AI pipeline processes a message.

### Implementation for User Story 3

- [ ] T035 [US3] Verify AutomatedMessage model has zero remaining code references after T018-T020 (grep entire backend for `AutomatedMessage` and `automatedMessage`)
- [ ] T036 [US3] Remove `OpusReport` model from `backend/prisma/schema.prisma`
- [ ] T037 [US3] Remove `ClassifierWeights` model from `backend/prisma/schema.prisma`
- [ ] T038 [US3] Remove `AutomatedMessage` model from `backend/prisma/schema.prisma` (if T035 confirms zero references)
- [ ] T039 [US3] Remove the comment referencing ClassifierWeights in `backend/src/routes/knowledge.ts`
- [ ] T040 [US3] Run `npx prisma db push` to apply schema changes (drops tables)
- [ ] T041 [US3] Verify application starts and AI pipeline processes a test message end-to-end

**Checkpoint**: Schema is clean. Dead tables dropped. Application runs.

---

## Phase 6: Polish & Verification

**Purpose**: Final verification across entire system.

- [ ] T042 Verify all 11 frontend inbox tabs render correctly (overview, analytics, tasks, settings, configure, logs, sops, tools, sandbox, listings, inbox)
- [ ] T043 Verify copilot suggestion flow: guest message → suggestion generated → persists on refresh → approve sends
- [ ] T044 Verify autopilot flow: guest message → AI responds automatically
- [ ] T045 Commit all changes with descriptive message and push

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies
- **Phase 3 (US1 - Frontend)**: No dependencies on backend changes
- **Phase 4 (US2 - Backend)**: No dependencies on frontend changes
- **Phase 5 (US3 - Schema)**: Depends on Phase 4 (backend dead routes must be removed before dropping models)
- **Phase 6 (Polish)**: Depends on all phases complete

### User Story Dependencies

- **US1 (Frontend)**: Independent — can start immediately
- **US2 (Backend)**: Independent — can start immediately, can run parallel with US1
- **US3 (Schema)**: Depends on US2 completion (backend routes referencing models must be gone first)

### Parallel Opportunities

Frontend and backend cleanup (US1 + US2) can run in parallel — they touch completely different files.

Within US1: T002-T007 (file deletions) all run in parallel. T010-T012 (state variable cleanup) all run in parallel.

Within US2: T015-T019 (file deletions) all run in parallel. T021-T022 (orphaned endpoints) run in parallel. T028-T033 (dead code in various files) all run in parallel.

---

## Implementation Strategy

### Execution Plan

1. **US1 (Frontend)**: Delete files → clean api.ts → clean component state → build verify
2. **US2 (Backend)**: Delete files → clean app.ts mounts → clean ai.service.ts → clean other files → compile verify
3. **US3 (Schema)**: Verify refs → remove models → push schema → verify runtime
4. **Polish**: Full end-to-end verification

### Commit Strategy

- Commit 1: All frontend changes (US1)
- Commit 2: All backend changes (US2)
- Commit 3: Schema changes (US3)
- Push after each commit or all at once

---

## Notes

- Every deletion is verified by prior grep audit — no guessing
- shadcn/ui components are explicitly KEPT per user decision
- ClassifierExample and ClassifierEvaluation models are ACTIVE — do NOT touch
- Backend endpoints (except automated-messages + dead features) stay for mobile app compatibility
- Total estimated lines removed: ~4,500+
