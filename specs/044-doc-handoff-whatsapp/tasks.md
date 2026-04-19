# Tasks: Check-in Document Handoff via WhatsApp

**Feature**: 044-doc-handoff-whatsapp
**Branch**: `044-doc-handoff-whatsapp`
**Based on**: [plan.md](./plan.md), [spec.md](./spec.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [research.md](./research.md)

---

## Phase 1 — Setup (blocking prerequisites)

- [X] T001 Add new `Tenant` fields (`docHandoffManagerRecipient`, `docHandoffSecurityRecipient`, `docHandoffReminderTime`, `docHandoffTime`, `docHandoffEnabled`) and the new `DocumentHandoffState` model to `backend/prisma/schema.prisma` per [data-model.md](./data-model.md). Add relations on both `Tenant` and `Reservation`.
- [X] T002 Apply schema changes via `cd backend && npx prisma db push` and regenerate the client.
- [X] T003 [P] Create `backend/src/config/doc-handoff-defaults.ts` exporting `DEFAULT_REMINDER_TIME='22:00'`, `DEFAULT_HANDOFF_TIME='10:00'`, `TIMEZONE='Africa/Cairo'`, `PHONE_REGEX`, `GROUP_JID_MARKER='@g.us'`, `MAX_ATTEMPTS=3`, `BACKOFF_MS=[5*60_000, 15*60_000]`.
- [X] T004 [P] Add env entries to `backend/.env.example` (if present) or document in `specs/044-doc-handoff-whatsapp/README.md`: `WASENDER_API_KEY`, `WASENDER_BASE_URL`, `WASENDER_TIMEOUT_MS`.

## Phase 2 — Foundational (blocking prerequisites for all user stories)

- [X] T005 Create `backend/src/services/wasender.service.ts` implementing the contract in [contracts/wasender-client.md](./contracts/wasender-client.md): `isWasenderEnabled`, `sendText`, `sendImage`. Axios-based, bearer auth, 15s timeout, throws typed errors (`WasenderDisabledError`, `WasenderRequestError`, `WasenderServerError`, `WasenderTimeoutError`).
- [X] T006 Create `backend/src/services/doc-handoff.service.ts` skeleton with exports: `scheduleOnReservationUpsert(reservationId, prisma)`, `rescheduleOnReservationChange(reservationId, prisma)`, `onCancelled(reservationId, prisma)`, `onChecklistUpdated(reservationId, prisma)`, `evaluateDueRows(prisma)` (stubs that write console logs only — real logic in Phase 3/4).
- [X] T007 [P] Extend `DocumentChecklist` interface in `backend/src/services/document-checklist.service.ts` with optional `receivedDocs?: ReceivedDocRef[]` array. Add exported type `ReceivedDocRef`. No behavior change yet — just the interface.
- [X] T008 [P] Add new tenantId-scoped type `DocHandoffSettings` in `backend/src/types.ts` (or equivalent) used by the controller contract.

## Phase 3 — User Story 1: Security handoff with media (P1)

**Story goal**: Security receives a WhatsApp message with unit, dates, and captured document images on check-in day.
**Independent test**: Scenario 3 in [quickstart.md](./quickstart.md).

### Image capture (required for handoff media)

- [X] T009 [US1] Modify `backend/src/services/document-checklist.service.ts::updateChecklist()` to accept an optional `context: { sourceMessageId: string; imageUrls: string[] }` argument. When provided, append a `ReceivedDocRef` to `checklist.receivedDocs` with `slot/slotIndex/hostawayMessageId/imageUrls/capturedAt/source='ai_tool'`. Passport slotIndex = the new `passportsReceived` value; marriage cert has no slotIndex.
- [X] T010 [US1] Modify `backend/src/services/document-checklist.service.ts::manualUpdateChecklist()` to accept the same optional `context` argument. Also: when a count is decremented (un-mark), pop the most recently appended `ReceivedDocRef` for that slot from the array.
- [X] T011 [US1] Update the AI pipeline call site for `mark_document_received` in `backend/src/services/ai.service.ts` so it passes `sourceMessageId` (the guest message the tool is reacting to) and `imageUrls` (from that Message) into `updateChecklist`. Locate via `grep -n "mark_document_received\|updateChecklist" backend/src/services/ai.service.ts`.
- [X] T012 [US1] Update the manager manual-checklist endpoint handler (wherever `manualUpdateChecklist` is called — likely `backend/src/routes/document-checklist.ts` or controller) to accept `sourceMessageId` and `imageUrls` in the PATCH body and pass them through.

### Scheduling and eligibility (handoff only — reminder added in Phase 4)

- [X] T013 [US1] Implement `doc-handoff.service.ts::scheduleOnReservationUpsert(reservationId, prisma)`: compute handoff `scheduledFireAt` from reservation checkIn + tenant.docHandoffTime + Africa/Cairo. Handle walk-in path: if check-in is today and handoff time is past, set `scheduledFireAt = NOW()` with status `SCHEDULED` (if checklist complete or no checklist) else `DEFERRED`. Upsert the HANDOFF row (unique `(reservationId, 'HANDOFF')`). Skip if check-in is in the past.
- [X] T014 [US1] Implement `rescheduleOnReservationChange` and `onCancelled` per [data-model.md](./data-model.md) reschedule rules table. Terminal rows untouched.
- [X] T015 [US1] Implement `onChecklistUpdated`: for any HANDOFF row in `DEFERRED`, re-check checklist completeness; if complete, flip to `SCHEDULED` with `scheduledFireAt=NOW()`.
- [X] T016 [US1] Wire `doc-handoff.service.ts::scheduleOnReservationUpsert` into the reservation-creation path (webhook handler / reservation-sync). Locate by grepping for where `prisma.reservation.create` is called from the webhook or sync flow.
- [X] T017 [US1] Wire `rescheduleOnReservationChange` / `onCancelled` into the reservation-update path.
- [X] T018 [US1] Wire `onChecklistUpdated` into both `updateChecklist` and `manualUpdateChecklist` (fire-and-forget — catch errors, log).

### Polling + send (handoff)

- [X] T019 [US1] Implement `evaluateDueRows(prisma)` per [data-model.md](./data-model.md) polling-tick algorithm: fetch `SCHEDULED|DEFERRED` rows with `scheduledFireAt <= now`, run the guard chain, render + send via wasender, update status.
- [X] T020 [US1] Implement `renderHandoff(reservation, property, checklist)` helper returning `{ text, imageUrls, recipient }`. Text = `{UNIT_IDENTIFIER}\n{DD/MM} - {DD/MM}`. Image URLs = flat distinct list from `checklist.receivedDocs`.
- [X] T021 [US1] Implement `sendHandoff(state, rendered, prisma)`: if images empty, single `sendText`; if images present, `sendText` for caption then `sendImage` per URL (bail on first image failure, log partial state in `lastError`).
- [X] T022 [US1] Create `backend/src/jobs/docHandoff.job.ts` with `startDocHandoffJob(prisma)` on 2-min interval. Inside, try/catch wrapper around `evaluateDueRows`. Log per-tick summary.
- [X] T023 [US1] Wire `startDocHandoffJob(prisma)` into `backend/src/server.ts` alongside the other `startXJob()` calls.

## Phase 4 — User Story 2: Manager reminder day before (P1)

**Story goal**: Manager receives `{UNIT}; all documents received` or `{UNIT}; N missing X` the day before check-in.
**Independent test**: Scenario 2 in [quickstart.md](./quickstart.md).

- [X] T024 [US2] Extend `scheduleOnReservationUpsert` in `doc-handoff.service.ts` to also upsert the REMINDER row. Compute `scheduledFireAt` = check-in minus 1 day at tenant.docHandoffReminderTime Africa/Cairo. Only create the row if a checklist currently exists OR will plausibly exist (implementation: always create; the eligibility check at fire time handles the `SKIPPED_NO_CHECKLIST` case). Walk-in path (check-in today): do NOT create reminder row at all.
- [X] T025 [US2] Extend `evaluateDueRows` guard chain to branch on `messageType`. Reminder branch: if no checklist → `SKIPPED_NO_CHECKLIST`.
- [X] T026 [US2] Implement `renderReminder(reservation, property, checklist)` returning `{ text, recipient }`. Complete: `{UNIT}; all documents received`. Incomplete: `{UNIT}; {missingList}` where missingList = pluralized passport count missing + optional `, marriage cert missing` if needed.
- [X] T027 [US2] Implement `sendReminder(state, rendered)`: single `sendText`; no media path.
- [X] T028 [US2] Plumb `sendReminder` into `evaluateDueRows` behind the `messageType==='REMINDER'` branch.

## Phase 5 — User Story 3: Settings UI (P2)

**Story goal**: Tenant admin configures recipients + times + toggle in Settings; sees recent sends.
**Independent test**: Scenario 1 in [quickstart.md](./quickstart.md).

### Backend

- [X] T029 [US3] Create `backend/src/controllers/doc-handoff.controller.ts` exporting `makeDocHandoffController(prisma)` with methods `getSettings(req, res)`, `putSettings(req, res)`, `listRecentSends(req, res)` per [contracts/settings-api.md](./contracts/settings-api.md).
- [X] T030 [US3] Add validation helpers in the controller (phone/JID, HH:MM). Return `{ error, field, message }` shape on validation failure.
- [X] T031 [US3] Mount new routes on `backend/src/routes/tenant-config.ts`: `GET/PUT /doc-handoff`, `GET /doc-handoff/recent-sends`.

### Frontend

- [X] T032 [P] [US3] Add API client methods to `frontend/lib/api.ts`: `apiGetDocHandoffConfig()`, `apiPutDocHandoffConfig(patch)`, `apiListDocHandoffSends(limit?)`.
- [X] T033 [P] [US3] Create `frontend/components/settings/doc-handoff-section.tsx` with controlled inputs for the two recipients, two time pickers (HH:MM text inputs with regex mask), enabled toggle, Save button with inline error surfacing. Below: read-only "Recent sends" table (status badge, timestamp, recipient, image count, body preview).
- [X] T034 [US3] Mount `<DocHandoffSection />` on the existing Settings page (`frontend/app/settings/page.tsx` — locate and read first to pick the correct insertion point near other tenant-config sections like AutomatedRepliesSection).

### Realtime (optional/nice-to-have)

- [X] T035 [P] [US3] Emit `doc_handoff_updated` Socket.IO event per [contracts/handoff-state-events.md](./contracts/handoff-state-events.md) from the evaluator whenever a row's status changes. Frontend section subscribes and patches the list by id.

## Phase 6 — Polish & cross-cutting

- [X] T036 Run `cd backend && npx tsc --noEmit` and `cd frontend && npx tsc --noEmit`. Fix any regressions. Both must be clean on the feature's touched files.
- [X] T037 Run quickstart Scenario 8 (regression) against a dev session to verify existing doc-checklist flow still increments counts correctly.
- [X] T038 Commit with detailed message and push to `origin 044-doc-handoff-whatsapp`.

## Dependency graph

- T001 → T002 → (Phase 2+)
- T005 blocks T021, T027 (wasender calls)
- T006 blocks T013–T018, T024–T028
- T007 blocks T009, T010
- T009, T010 block T011, T012 (call-site updates need new signature)
- T013–T018 block T019 (evaluator needs rows + eligibility semantics)
- T019–T023 = US1 complete (handoff sends)
- T024–T028 depend on T019 (evaluator shared with reminder branch)
- T029–T034 can start after T001 applied (schema fields exist)
- T035 after T019 (evaluator must emit)
- T036 before T038

## Parallelisation hints

- T003, T004 can run in parallel with T001 (config-only).
- T007, T008 run alongside T005/T006.
- T032, T033, T035 parallel-safe once schema/controller are up.
- T009+T010 share a file (`document-checklist.service.ts`) — run sequentially.
- T013–T018 touch the same service file and are sequential.

## MVP scope

Phases 1+2+3 alone (through T023) = security handoff fires. That is a demoable slice if the user wants an early ship.
