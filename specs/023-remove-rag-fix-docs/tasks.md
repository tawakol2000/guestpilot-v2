# Tasks: Remove RAG/Classifier Dead Code + Fix Document Checklist

**Input**: Design documents from `/specs/023-remove-rag-fix-docs/`
**Prerequisites**: plan.md (required), spec.md (required for user stories)

**Tests**: Not requested — no test tasks included.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: Branch verification and pre-flight checks

- [x] T001 Verify on branch `023-remove-rag-fix-docs` and up to date with `advanced-ai-v7`
- [x] T002 Run `npx tsc --noEmit` to capture baseline compilation state in `backend/`

---

## Phase 2: User Story 1 — Remove Dead RAG/Classifier/Embeddings Code (Priority: P1) 🎯 MVP

**Goal**: Delete ~1,500 lines of dead RAG, classifier, and embeddings code across 14 files. Drop 3 database tables. Remove all related imports, function calls, and API endpoints.

**Independent Test**: After removal, `npx tsc --noEmit` compiles clean. The `get_sop` tool pipeline, escalation system, and all AI features work unchanged. No references to RAG/classifier/embedding services remain in backend source.

### Step 1: Delete Service Files (FR-001)

- [x] T003 [P] [US1] Delete `backend/src/services/rag.service.ts` (662 lines)
- [x] T004 [P] [US1] Delete `backend/src/services/embeddings.service.ts` (207 lines)
- [x] T005 [P] [US1] Delete `backend/src/services/rerank.service.ts` (78 lines)

### Step 2: Schema Changes (FR-002, FR-003)

- [x] T006 [US1] Remove `PropertyKnowledgeChunk` model and its relations from `backend/prisma/schema.prisma`
- [x] T007 [US1] Remove `ClassifierExample` model and its relations from `backend/prisma/schema.prisma`
- [x] T008 [US1] Remove `ClassifierEvaluation` model and its relations from `backend/prisma/schema.prisma`
- [x] T009 [US1] Remove fields `ragEnabled`, `classifierVoteThreshold`, `classifierContextualGate`, `embeddingProvider` from `TenantAiConfig` in `backend/prisma/schema.prisma`

### Step 3: Remove Imports and Calls (FR-004, FR-006, FR-007, FR-008)

- [x] T010 [P] [US1] Remove RAG retrieval imports/calls and `evaluateAndImprove` fire-and-forget from `backend/src/services/ai.service.ts`
- [x] T011 [P] [US1] Remove `retrieveRelevantKnowledge` import/call from `backend/src/routes/sandbox.ts`
- [x] T012 [P] [US1] Remove `seedTenantSops`, `ingestPropertyKnowledge`, `setEmbeddingProvider` imports and embedding init block from `backend/src/server.ts`
- [x] T013 [P] [US1] Remove `ingestPropertyKnowledge` import/call from `backend/src/routes/properties.ts`
- [x] T014 [P] [US1] Remove `reindex-knowledge` endpoint from `backend/src/app.ts`
- [x] T015 [P] [US1] Remove `appendLearnedAnswer` import/call, `rateMessage` endpoint, and ClassifierEvaluation/ClassifierExample queries from `backend/src/controllers/knowledge.controller.ts`

### Step 4: Remove API Endpoints (FR-005)

- [x] T016 [US1] Remove RAG/classifier endpoints from `backend/src/routes/knowledge.ts`: seed-sops, chunk-stats, chunks CRUD, evaluations, classifier-thresholds, gap-analysis

### Step 5: Clean Up Remaining References

- [x] T017 [US1] Search entire `backend/src/` for any remaining imports or references to deleted services/models and remove them

**Checkpoint**: All RAG/classifier/embeddings code removed. `npx tsc --noEmit` should compile clean (may have errors from judge service — addressed in US3).

---

## Phase 3: User Story 2 — Fix Marriage Certificate Requirement (Priority: P2)

**Goal**: Ensure the screening AI always sets `marriage_certificate_needed: true` for Arab married couples in the document checklist.

**Independent Test**: When an Arab married couple inquires, `create_document_checklist` is called with `marriage_certificate_needed: true` every time. Non-Arab or unmarried guests get `false`.

- [x] T018 [US2] Locate the `create_document_checklist` tool definition and screening system prompt in `backend/src/config/ai-config.json` or SOP/tool-definition table
- [x] T019 [US2] Update the screening prompt or tool description to explicitly enforce: "For Arab married couples, ALWAYS set marriage_certificate_needed to true"

**Checkpoint**: Marriage certificate enforcement is in the prompt/tool definition. Independently verifiable via battle test with Arab married couple persona.

---

## Phase 4: User Story 3 — Clean Up Judge Service (Priority: P3)

**Goal**: Remove or update the judge service to eliminate ClassifierEvaluation/ClassifierExample writes that reference dropped tables.

**Independent Test**: AI pipeline processes messages without errors. No writes to non-existent tables occur.

- [x] T020 [US3] Read `backend/src/services/judge.service.ts` and identify ClassifierEvaluation/ClassifierExample dependencies
- [x] T021 [US3] Remove ClassifierEvaluation create call and ClassifierExample update call from `backend/src/services/judge.service.ts`
- [x] T022 [US3] If judge service body is empty/useless after removal, delete `backend/src/services/judge.service.ts` entirely and remove its import from `backend/src/services/ai.service.ts`

**Checkpoint**: Judge service cleaned up or removed. No references to dropped tables remain.

---

## Phase 5: Verification & Polish

**Purpose**: Confirm everything compiles, schema applies, and the system works end-to-end.

- [x] T023 Run `npx tsc --noEmit` in `backend/` — must compile clean with zero errors
- [x] T024 Run `npx prisma generate` in `backend/` — Prisma client regenerated
- [x] T025 Grep `backend/src/` for "rag", "classifier", "embedding", "rerank" — confirm zero references in source code (excluding comments/config field names like `ragContext` in AiApiLog)
- [x] T026 Review `backend/src/services/ai.service.ts` to confirm `ragContext` field in AiApiLog writes is kept (still used for pipeline metadata)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **US1 (Phase 2)**: Depends on Setup — BLOCKS US3 (judge service references dropped tables)
- **US2 (Phase 3)**: Depends on Setup only — can run in parallel with US1
- **US3 (Phase 4)**: Depends on US1 completion (tables must be removed first to know what to clean)
- **Verification (Phase 5)**: Depends on US1 + US2 + US3 completion

### Within User Story 1

- Step 1 (T003-T005): Delete files first — parallel
- Step 2 (T006-T009): Schema changes — sequential within schema.prisma
- Step 3 (T010-T015): Remove imports/calls — parallel (different files)
- Step 4 (T016): Remove endpoints — after Step 3
- Step 5 (T017): Final sweep — after Step 4

### Parallel Opportunities

- T003, T004, T005 can run in parallel (different files being deleted)
- T010, T011, T012, T013, T014, T015 can run in parallel (different source files)
- US2 (T018-T019) can run in parallel with US1 (completely independent files)

---

## Parallel Example: User Story 1 Step 1

```bash
# Delete all 3 service files together:
Task: "Delete backend/src/services/rag.service.ts"
Task: "Delete backend/src/services/embeddings.service.ts"
Task: "Delete backend/src/services/rerank.service.ts"
```

## Parallel Example: User Story 1 Step 3

```bash
# Remove imports/calls from 6 different files together:
Task: "Clean ai.service.ts"
Task: "Clean sandbox.ts"
Task: "Clean server.ts"
Task: "Clean properties.ts"
Task: "Clean app.ts"
Task: "Clean knowledge.controller.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: User Story 1 (RAG/classifier removal)
3. **STOP and VALIDATE**: `npx tsc --noEmit` compiles clean
4. Commit the removal

### Incremental Delivery

1. US1 → Remove dead code → Compile check → Commit (~1,500 lines removed)
2. US2 → Fix marriage cert → Commit (prompt/tool update)
3. US3 → Clean judge service → Compile check → Commit
4. Verification → Final sweep + prisma generate → Commit
5. Deploy to Railway → Run battle test agent with Arab married couple persona

---

## Notes

- **Keep `ragContext`**: The `ragContext Json?` field in `AiApiLog` is still used for pipeline metadata (tool calls, SOP classification, cost tracking). Do NOT remove it.
- **Zero downtime**: Production guests must not be affected. The `get_sop` tool pipeline is completely independent of the removed code.
- **prisma db push**: Run on Railway after deployment to drop the 3 tables. Existing data in those tables will be lost (expected — it's dead data).
- Total tasks: 26
