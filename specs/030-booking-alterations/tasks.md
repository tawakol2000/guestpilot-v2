# Tasks: Booking Alteration Accept/Reject

**Branch**: `030-booking-alterations`  
**Input**: Design documents from `/specs/030-booking-alterations/`  
**Prerequisites**: plan.md ✓ | spec.md ✓ | data-model.md ✓ | contracts/ ✓ | research.md ✓

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this belongs to (US1, US2, US3)

---

## Phase 1: Setup

**Purpose**: Minimal — this feature extends an existing project. No new project init needed.

- [X] T001 Confirm `npx prisma db push` is available locally and Railway deployment pipeline is working before starting schema changes

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Database schema and router skeleton that ALL user stories depend on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T002 Add `BookingAlteration` model, `AlterationActionLog` model, `AlterationStatus` enum, `AlterationActionType` enum, `AlterationActionStatus` enum to `backend/prisma/schema.prisma` — include all fields from data-model.md, `@unique` on `BookingAlteration.reservationId`, `@index([tenantId])`, cascade deletes
- [X] T003 Add `alteration BookingAlteration?` and `alterationActionLogs AlterationActionLog[]` relations to the `Reservation` model in `backend/prisma/schema.prisma`
- [X] T004 Add `bookingAlterations BookingAlteration[]` and `alterationActionLogs AlterationActionLog[]` relations to the `Tenant` model in `backend/prisma/schema.prisma`
- [X] T005 Run `npx prisma generate` to regenerate Prisma client after schema changes (run from `backend/`)
- [X] T006 Create `backend/src/routes/alterations.ts` — full implementation with GET alteration, POST accept, POST reject endpoints
- [X] T007 Register the alterations router in `backend/src/app.ts` — mounted at `/api/reservations`

**Checkpoint**: Schema applies cleanly, Prisma client regenerated, router mounts without errors.

---

## Phase 3: User Story 1 — View Alteration Details (Priority: P1) 🎯 MVP

**Goal**: When a Hostaway alteration system message arrives, GuestPilot fetches alteration details and displays them in the inbox conversation panel.

**Independent Test**: Simulate an alteration webhook (see quickstart.md Scenario 1), open the affected conversation — alteration panel appears at the top of the right panel showing original and proposed dates/guest count.

### Implementation

- [X] T008 [US1] Create `backend/src/services/hostaway-alterations.service.ts` — implement `fetchAlteration(dashboardJwt, hostawayReservationId)` calling `GET /reservations/{id}/alterations` on `platform.hostaway.com`
- [X] T009 [US1] Extend the `isAlterationRequest` block in `backend/src/controllers/webhooks.controller.ts` — after task creation, fire-and-forget fetch alteration details and upsert `BookingAlteration` record; task note updated to reference GuestPilot inbox
- [X] T010 [US1] Implement `GET /api/reservations/:reservationId/alteration` endpoint in `backend/src/routes/alterations.ts`
- [X] T011 [P] [US1] Add `apiGetAlteration(reservationId)` function and `BookingAlteration` TypeScript interface to `frontend/lib/api.ts`
- [X] T012 [US1] Add `AlterationPanel` component inside `frontend/components/inbox-v5.tsx` — replaces old `AlterationRequestCard`; shows original vs proposed values, pending/accepted/rejected states, fetchError fallback

**Checkpoint**: Alteration panel is visible in inbox for conversations with a pending alteration.

---

## Phase 4: User Story 2 — Accept a Booking Alteration (Priority: P2)

**Goal**: Host can click Accept in the alteration panel and the alteration is confirmed via Hostaway internal API.

**Independent Test**: With a pending alteration displayed, click Accept — panel transitions to accepted state, `AlterationActionLog` record exists with `status: SUCCESS`.

### Implementation

- [X] T013 [US2] Add `acceptAlteration(dashboardJwt, hostawayReservationId, hostawayAlterationId)` to `backend/src/services/hostaway-alterations.service.ts`
- [X] T014 [US2] Implement `POST /api/reservations/:reservationId/alteration/accept` in `backend/src/routes/alterations.ts` — full 029 pattern: JWT validation, audit log, Hostaway API call, status update, error handling
- [X] T015 [P] [US2] Add `apiAcceptAlteration(reservationId)` to `frontend/lib/api.ts`
- [X] T016 [US2] Accept button with loading/success/error states in `AlterationPanel` — implemented as part of T012

**Checkpoint**: Accept button works end-to-end. Panel shows accepted state on success.

---

## Phase 5: User Story 3 — Reject a Booking Alteration (Priority: P3)

**Goal**: Host can click Reject (with confirmation) and the alteration is declined via Hostaway internal API.

**Independent Test**: With a pending alteration displayed, click Reject, confirm the dialog — panel transitions to rejected state.

### Implementation

- [X] T017 [US3] Add `rejectAlteration(dashboardJwt, hostawayReservationId, hostawayAlterationId)` to `backend/src/services/hostaway-alterations.service.ts`
- [X] T018 [US3] Implement `POST /api/reservations/:reservationId/alteration/reject` in `backend/src/routes/alterations.ts` — handles 422 channel limitation
- [X] T019 [P] [US3] Add `apiRejectAlteration(reservationId)` to `frontend/lib/api.ts`
- [X] T020 [US3] Reject button with confirmation dialog in `AlterationPanel` — 422 channel error message, reconnect banner — implemented as part of T012

**Checkpoint**: All three user stories work end-to-end.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T021 Updated manager task note text in `backend/src/controllers/webhooks.controller.ts` — now references GuestPilot inbox instead of Airbnb/Booking.com dashboard
- [ ] T022 [P] Verify `AlterationPanel` handles all states without layout shift: `null`, `PENDING` with full data, `PENDING` with `fetchError`, `ACCEPTED`, `REJECTED` — test manually in inbox
- [ ] T023 [P] Verify `AlterationActionLog` records are created correctly for accept and reject actions — check via Prisma Studio

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies
- **Phase 2 (Foundational)**: Depends on Phase 1 — **BLOCKS all user stories**
- **Phase 3 (US1 — View)**: Depends on Phase 2 — MVP deliverable
- **Phase 4 (US2 — Accept)**: Depends on Phase 3
- **Phase 5 (US3 — Reject)**: Can run in parallel with Phase 4 after Phase 3
- **Phase 6 (Polish)**: Depends on Phase 3+4+5

### Notes

- Accept/reject service functions use **placeholder endpoints** — must be updated with real Hostaway URLs before launch (see quickstart.md Scenario 6)
- `BookingAlteration` uses `@unique` on `reservationId` — webhook extension uses upsert
- Follow the exact dashboard JWT validation pattern from `backend/src/routes/reservations.ts`
- T022 and T023 are manual verification tasks — run after deploying to Railway
