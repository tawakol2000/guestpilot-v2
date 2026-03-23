# Tasks: Document Checklist

**Input**: Design documents from `/specs/017-document-checklist/`
**Prerequisites**: plan.md, spec.md

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Foundational — Checklist Service

**Purpose**: Core CRUD service for document checklists. All user stories depend on this.

- [X] T001 Create `backend/src/services/document-checklist.service.ts` with functions: `createChecklist(reservationId, data, prisma)` — writes `documentChecklist` JSON into `Reservation.screeningAnswers`, `updateChecklist(reservationId, updates, prisma)` — partial update (increment passports, mark marriage cert), `getChecklist(reservationId, prisma)` — reads and returns checklist or null. Include validation: passportsNeeded ≥ 1, passportsReceived capped at passportsNeeded, updatedAt auto-set on every write.
- [X] T002 Create `backend/src/routes/document-checklist.ts` with two endpoints: `GET /api/conversations/:id/checklist` — returns checklist for the conversation's reservation (or null), `PUT /api/conversations/:id/checklist` — manual update from manager (passportsReceived, marriageCertReceived). Both tenant-scoped via auth middleware.
- [X] T003 Register the document-checklist router in `backend/src/app.ts`

**Checkpoint**: Checklist CRUD works via REST. Can create, read, and update checklists on reservations.

---

## Phase 2: User Story 1 — Screening Agent Creates Checklist (P1)

**Goal**: Screening agent calls `create_document_checklist` tool when escalating with acceptance recommendation.

**Independent Test**: In sandbox as screening agent, complete screening. Verify tool is called with correct passport count and marriage cert flag.

- [X] T004 [US1] Add `create_document_checklist` tool definition to the screening agent's tools array in `backend/src/services/ai.service.ts` — alongside `search_available_properties`. Use strict schema: `passports_needed` (number), `marriage_certificate_needed` (boolean), `reason` (string). All required, additionalProperties false.
- [X] T005 [US1] Add tool handler for `create_document_checklist` in the screening agent's `toolHandlersForCall` Map in `backend/src/services/ai.service.ts` — calls `createChecklist()` from the service, passing reservation ID from context. Returns JSON confirmation string.
- [X] T006 [US1] Add the same tool definition and handler to the sandbox screening path in `backend/src/routes/sandbox.ts`
- [X] T007 [US1] Add one line to the screening system prompt (DB-backed via Configure AI): "When you escalate with a booking acceptance recommendation, also call the create_document_checklist tool to record what documents the guest will need to submit after acceptance." Add this in `backend/src/services/ai.service.ts` SEED_SCREENING_PROMPT, before the OUTPUT FORMAT section.

**Checkpoint**: Screening agent creates checklists on acceptance escalations. Sandbox works identically.

---

## Phase 3: User Story 2 — Coordinator Sees Checklist (P2)

**Goal**: Coordinator sees `### DOCUMENT CHECKLIST ###` in context when items are pending.

**Independent Test**: With a checklist on a CONFIRMED reservation, send a message. Verify AI mentions pending documents.

- [X] T008 [US2] Pass `screeningAnswers` from the reservation into `AiReplyContext` in both `backend/src/workers/aiReply.worker.ts` and `backend/src/jobs/aiDebounce.job.ts` — add `screeningAnswers` field to the context object built when loading reservation data.
- [X] T009 [US2] In `generateAndSendAiReply` in `backend/src/services/ai.service.ts`, after building `propertyInfo`, inject `### DOCUMENT CHECKLIST ###` section if checklist exists and has pending items. Format: "Passports: 1/2 received\nMarriage Certificate: pending". Do NOT inject if checklist is complete or absent.
- [X] T010 [US2] Add one line to the coordinator system prompt (DB-backed): "If the DOCUMENT CHECKLIST shows pending items, ask the guest to send their documents through the chat on your first message. On subsequent messages, only remind when natural — don't repeat on every message." Add in SEED_COORDINATOR_PROMPT before the OUTPUT FORMAT section.

**Checkpoint**: Coordinator mentions pending documents on first message. Doesn't mention when complete.

---

## Phase 4: User Story 3 — Coordinator Tracks Documents from Images (P3)

**Goal**: Coordinator calls `mark_document_received` when guest sends a recognized document image. Tool only available when checklist has pending items.

**Independent Test**: With pending checklist, send a passport image. Verify tool is called, count increments, AI confirms receipt.

- [X] T011 [US3] Add `mark_document_received` tool definition to the coordinator's tools array in `backend/src/services/ai.service.ts` — BUT only when a pending checklist exists. Check `context.screeningAnswers?.documentChecklist` for pending items before adding the tool. Use strict schema: `document_type` (enum: passport, marriage_certificate), `notes` (string). All required, additionalProperties false.
- [X] T012 [US3] Add tool handler for `mark_document_received` in the coordinator's `toolHandlersForCall` Map in `backend/src/services/ai.service.ts` — calls `updateChecklist()` from the service. For "passport": increment passportsReceived (capped). For "marriage_certificate": set marriageCertReceived true. Returns updated checklist state as JSON string for the AI to use in its response.
- [X] T013 [US3] Add the same conditional tool definition and handler to the sandbox coordinator path in `backend/src/routes/sandbox.ts`
- [X] T014 [US3] Update the IMAGE HANDLING section in SEED_COORDINATOR_PROMPT in `backend/src/services/ai.service.ts`: add "If the DOCUMENT CHECKLIST has pending items and the guest sends an image that is clearly a government-issued ID (passport, national ID, driver's license) or marriage certificate, call the mark_document_received tool instead of escalating. For unclear images, escalate as usual."

**Checkpoint**: Document images update the checklist. Tool not available when checklist complete. Unclear images still escalate.

---

## Phase 5: User Story 4 — Operator Sidebar Display (P4)

**Goal**: Manager sees checklist in inbox sidebar with manual override toggles.

**Independent Test**: Open conversation with checklist. Verify sidebar shows status. Toggle a passport to received. Verify update.

- [X] T015 [US4] Add `documentChecklist` field to the conversation detail API response in `backend/src/controllers/conversations.controller.ts` — read from the reservation's screeningAnswers JSON field, return as part of the response.
- [X] T016 [US4] Add `ApiDocumentChecklist` type to `frontend/lib/api.ts`: `{ passportsNeeded: number, passportsReceived: number, marriageCertNeeded: boolean, marriageCertReceived: boolean }`. Add `apiGetChecklist(convId)` and `apiUpdateChecklist(convId, data)` functions.
- [X] T017 [US4] Add a "Documents" section in the inbox right sidebar in `frontend/components/inbox-v5.tsx` — below TASKS. Show passport progress (e.g., "1/2") and marriage cert status with toggle buttons for manual override. Only show when checklist exists.

**Checkpoint**: Manager sees and can override checklist. Changes reflect in AI context on next message.

---

## Phase 6: Polish & Verify

- [X] T018 Verify TypeScript compilation for backend: `cd backend && npx tsc --noEmit`
- [X] T019 Verify frontend build: `cd frontend && npx next build`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1** (Foundational): No dependencies — start immediately
- **Phase 2** (US1 — Screening creates): Depends on Phase 1 (needs checklist service)
- **Phase 3** (US2 — Coordinator sees): Depends on Phase 1 (needs checklist reader)
- **Phase 4** (US3 — Coordinator tracks): Depends on Phase 1 + Phase 3 (needs context injection + service)
- **Phase 5** (US4 — Sidebar): Depends on Phase 1 (needs service + REST endpoints)
- **Phase 6** (Polish): Depends on all previous phases

### Parallel Opportunities

- **Phase 2 and Phase 3** can run in parallel after Phase 1 (different agents, different code sections)
- **Phase 5** can run in parallel with Phase 2/3 (frontend only, depends only on Phase 1 REST endpoints)
- Within Phase 2: T004 and T007 are parallel (tool definition vs prompt edit)
- Within Phase 5: T016 and T017 are sequential (types before UI)

### Execution Order

T001 → T002 → T003 (sequential — service, routes, registration)
T004 → T005 (sequential — tool definition then handler)
T006 (parallel with T004-T005 — different file)
T007 (parallel — prompt edit)
T008 → T009 → T010 (sequential — context passing, injection, prompt)
T011 → T012 (sequential — tool definition then handler)
T013 (parallel with T011-T012 — different file)
T014 (parallel — prompt edit)
T015 → T016 → T017 (sequential — API, types, UI)
T018, T019 (parallel — backend and frontend checks)
