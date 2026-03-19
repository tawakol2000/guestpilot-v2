# Tasks: AI Pipeline Overhaul

**Input**: Design documents from `/specs/002-ai-pipeline-overhaul/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: No test framework in project. Verification via quickstart.md.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: Schema changes and shared infrastructure needed by multiple stories

- [x] T001 Add `judgeMode String @default("evaluate_all")` to TenantAiConfig in `backend/prisma/schema.prisma`
- [x] T002 Add `skipReason String?` to ClassifierEvaluation in `backend/prisma/schema.prisma`
- [x] T003 Run `npx prisma db push` via Railway to apply schema changes
- [x] T004 Add API client functions to `frontend/lib/api.ts`: `fetchAccuracy(period)`, `runGapAnalysis()`, `approveExample(id)`, `rejectExample(id)`, `batchClassify(messages, threshold)`, `generateSnapshot()`, `updateTenantConfig(updates)` — matching contracts/api.md

---

## Phase 2: Foundational (Backend APIs)

**Purpose**: Backend endpoints that multiple user stories depend on. MUST complete before frontend work.

- [x] T005 [P] Create `GET /api/ai-pipeline/accuracy` handler in `backend/src/routes/ai-pipeline.ts`
- [x] T006 [P] Add `judgeMode` to `backend/src/services/tenant-config.service.ts`
- [x] T007 [P] Create `backend/src/services/snapshot.service.ts`
- [x] T008 Add `POST /api/ai-pipeline/snapshot` route in `backend/src/routes/ai-pipeline.ts`

**Checkpoint**: All backend APIs ready. Frontend work can begin.

---

## Phase 3: User Story 1 — Enhance Pipeline Dashboard (Priority: P1)

- [x] T009 [US1] Add accuracy metrics section to `frontend/components/ai-pipeline-v5.tsx`
- [x] T010 [US1] Add per-category accuracy breakdown to `frontend/components/ai-pipeline-v5.tsx`
- [x] T011 [US1] Add self-improvement stats section to `frontend/components/ai-pipeline-v5.tsx`

**Checkpoint**: Pipeline page shows accuracy, categories, and growth stats.

---

## Phase 4: User Story 2 — Fix the Training Data Gap (Priority: P1)

- [x] T012 [US2] Create `POST /api/knowledge/gap-analysis` handler in `backend/src/controllers/knowledge.controller.ts`
- [x] T013 [US2] Add route for gap-analysis in `backend/src/routes/knowledge.ts`
- [x] T014 [P] [US2] Add `POST /api/knowledge/classifier-examples/:id/approve` route in `backend/src/routes/knowledge.ts`
- [x] T015 [P] [US2] Add `POST /api/knowledge/classifier-examples/:id/reject` route in `backend/src/routes/knowledge.ts`
- [x] T016 [US2] Add "Suggested" tab to `frontend/components/examples-editor-v5.tsx`
- [x] T017 [US2] Add "Run Gap Analysis" button to `frontend/components/examples-editor-v5.tsx`
- [x] T034 [US2] Add per-tenant SOP toggle to `backend/src/services/rag.service.ts`
- [x] T035 [US2] Add `sopOverrides` JSON field to TenantAiConfig in `backend/prisma/schema.prisma`
- [x] T036 [US2] Add SOP toggle UI section to `frontend/components/classifier-v5.tsx`

**Checkpoint**: Gap analysis generates suggested examples, operator reviews in UI, classifier improves. SOPs configurable per-tenant.

---

## Phase 5: User Story 3 — Make Self-Improvement Work (Priority: P1)

- [x] T018 [US3] Modify `backend/src/services/judge.service.ts` `evaluateAndImprove()`
- [x] T019 [US3] Add skip-reason logging to `backend/src/services/judge.service.ts`
- [x] T020 [US3] Add judge mode toggle to `frontend/components/classifier-v5.tsx`
- [x] T021 [US3] Display skip reasons in pipeline feed in `frontend/components/ai-pipeline-v5.tsx`

**Checkpoint**: Judge fires on every non-contextual response in evaluate_all mode. Training examples grow.

---

## Phase 6: User Story 4 — Threshold Tuning (Priority: P2)

- [x] T022 [US4] Add `batchClassify()` function to `backend/src/services/classifier.service.ts`
- [x] T023 [US4] Add `POST /api/knowledge/batch-classify` route in `backend/src/routes/knowledge.ts`
- [x] T024 [US4] Add threshold tuning section to `frontend/components/classifier-v5.tsx`

**Checkpoint**: Operator can test different thresholds against real messages and see accuracy impact.

---

## Phase 7: User Story 5 — Pipeline Snapshot (Priority: P2)

- [x] T025 [US5] Refine `backend/src/services/snapshot.service.ts` (created in T007)
- [x] T026 [US5] Add "Generate Snapshot" button to `frontend/components/ai-pipeline-v5.tsx`

**Checkpoint**: Snapshot file generated with full metrics + LLM health summary.

---

## Phase 8: User Story 6 — Operator Feedback Loop (Priority: P3)

- [x] T027 [P] [US6] Verify existing rating flow in `frontend/components/inbox-v5.tsx`
- [x] T028 [P] [US6] Add rating-to-training-example flow in backend
- [ ] T029 [US6] Add ratings display to pipeline dashboard in `frontend/components/ai-pipeline-v5.tsx`

**Checkpoint**: Operator ratings feed into training, visible in dashboard.

---

## Phase 9: Polish & Cross-Cutting Concerns

- [x] T030 Review system prompts for accuracy
- [ ] T031 Run through all 7 quickstart.md verification steps to validate fixes end-to-end
- [ ] T032 Generate initial pipeline snapshot via `POST /api/ai-pipeline/snapshot`
- [ ] T033 Run initial gap analysis via `POST /api/knowledge/gap-analysis` and review/approve suggested examples

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- No test framework — verification via quickstart.md
- All backend changes must preserve graceful degradation (Constitution Principle I)
- Arabic RTL support required in Suggested tab (use `dir="auto"`)
- Training examples are shared globally across tenants; SOP content is per-tenant
- Judge mode defaults to "evaluate_all" — operator manually switches to "sampling" when ready
- System prompt review (T030): both prompts verified accurate against SPEC.md. One gap noted: "Always respond in English" may need a multilingual spec in the future.
