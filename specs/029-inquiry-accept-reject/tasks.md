# Tasks: Inquiry Accept/Reject

**Input**: Design documents from `/specs/029-inquiry-accept-reject/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/api.md

**Tests**: Not explicitly requested — no test tasks generated.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: Schema changes and shared utilities that all stories depend on

- [x] T001 Add dashboard connection fields (`dashboardJwt`, `dashboardJwtIssuedAt`, `dashboardJwtExpiresAt`, `dashboardConnectedBy`) to Tenant model and add InquiryActionLog model with enums (`InquiryActionType`, `InquiryActionStatus`) in `backend/prisma/schema.prisma`
- [x] T002 Run `npx prisma db push` to apply schema changes
- [x] T003 Create `backend/src/lib/` directory and AES-256-GCM encryption utility (encrypt/decrypt functions using `JWT_SECRET` via PBKDF2) in `backend/src/lib/encryption.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Hostaway dashboard API service and route registration — MUST complete before any user story

**CRITICAL**: No user story work can begin until this phase is complete

- [x] T004 Create `backend/src/services/hostaway-dashboard.service.ts` with: base URL `https://platform.hostaway.com`, JWT auth via `jwt` header, functions for `approveReservation(jwt, reservationId)`, `rejectReservation(jwt, reservationId)`, `cancelReservation(jwt, reservationId)`, and `validateDashboardJwt(jwt)` (decode and check exp)
- [x] T005 [P] Create `backend/src/routes/hostaway-connect.ts` with endpoints: `GET /api/hostaway-connect/callback` (validate token, encrypt, store on tenant), `GET /api/hostaway-connect/status` (return connection status + days remaining), `DELETE /api/hostaway-connect` (disconnect). Follow contract in `specs/029-inquiry-accept-reject/contracts/api.md`
- [x] T006 [P] Add reservation action endpoints to `backend/src/routes/reservations.ts`: `POST /api/reservations/:reservationId/approve`, `POST /api/reservations/:reservationId/reject`, `POST /api/reservations/:reservationId/cancel`, `GET /api/reservations/:reservationId/last-action`. Each must check dashboard connection, validate reservation status, call hostaway-dashboard service, log to InquiryActionLog, and return result per contracts/api.md
- [x] T007 Register new routes in `backend/src/index.ts`: import and mount `hostaway-connect` routes

**Checkpoint**: Backend API fully functional — can test approve/reject/cancel via curl

---

## Phase 3: User Story 1 — Connect Hostaway Dashboard Account (Priority: P1) MVP

**Goal**: Property managers can connect their Hostaway dashboard account from the settings page using a bookmarklet flow

**Independent Test**: Navigate to settings, follow the bookmarklet instructions, verify "Connected — X days remaining" appears

### Implementation for User Story 1

- [x] T008 [US1] Add API client functions in `frontend/lib/api.ts`: `apiGetHostawayConnectStatus()`, `apiDisconnectHostaway()`, and the callback URL builder for the bookmarklet
- [x] T009 [US1] Add "Connect Hostaway Dashboard" section to `frontend/components/settings-v5.tsx`: display connection status with days-remaining countdown, "Connect" button that opens instructions modal with draggable bookmarklet, "Disconnect" button when connected, handle `?hostaway=connected` and `?hostaway=error` URL params for redirect feedback (success toast or error message). Generate bookmarklet JavaScript dynamically with environment-specific callback URL per `contracts/api.md` bookmarklet section

**Checkpoint**: Settings page shows connection flow. User can connect via bookmarklet and see "Connected — 90 days remaining"

---

## Phase 4: User Story 2 — Approve an Inquiry (Priority: P1)

**Goal**: Property managers can approve inquiries directly from GuestPilot with visual feedback

**Independent Test**: Open an inquiry in inbox, click Approve, see loading spinner then success confirmation, verify status updates

### Implementation for User Story 2

- [x] T010 [US2] Add API client functions in `frontend/lib/api.ts`: `apiApproveReservation(reservationId)`, `apiGetLastAction(reservationId)`
- [x] T011 [US2] Add action block component to the right panel in `frontend/components/inbox-v5.tsx`: render at top of right panel for reservations with inquiry/pending status, show "Approve" button with three-state feedback (idle → loading spinner with "Approving..." → success green flash or error with retry), show "last action" label (e.g., "Approved by Ahmed, 2 hours ago"), hide block when status is not actionable
- [x] T012 [US2] Add inline "Approve" button to conversation list items in `frontend/components/inbox-v5.tsx`: small approve icon button visible on inquiry/pending reservations in the inbox list, same three-state feedback pattern (idle → spinner → success/error)
- [x] T013 [US2] Wire approve action: on click call `apiApproveReservation`, on success update local reservation status and refresh conversation list, on 403 (not connected) show reconnect prompt linking to settings, on 502 (Hostaway error) show error message with retry

**Checkpoint**: Can approve an inquiry from both inbox list and right panel. Visual feedback shows loading/success/error states.

---

## Phase 5: User Story 3 — Reject/Decline an Inquiry (Priority: P1)

**Goal**: Property managers can reject inquiries with confirmation dialog and channel-limitation handling

**Independent Test**: Open an inquiry, click Reject, confirm in dialog, see loading then success or channel limitation message

### Implementation for User Story 3

- [x] T014 [US3] Add API client function in `frontend/lib/api.ts`: `apiRejectReservation(reservationId)`
- [x] T015 [US3] Add "Reject" button to the right panel action block in `frontend/components/inbox-v5.tsx`: sits alongside Approve button for inquiry/pending reservations, clicking opens confirmation dialog ("Are you sure you want to reject this inquiry?"), on confirm: three-state feedback (loading → success/error), on 422 (channel limitation): show message with suggestion (e.g., "Please decline this inquiry directly on Airbnb")
- [x] T016 [US3] Add inline "Reject" button to conversation list items in `frontend/components/inbox-v5.tsx`: small reject icon button next to approve, same confirmation dialog and feedback pattern

**Checkpoint**: Can reject an inquiry from both locations. Confirmation dialog prevents accidental rejection. Channel limitations shown gracefully.

---

## Phase 6: User Story 4 — Cancel a Reservation (Priority: P1)

**Goal**: Property managers can cancel confirmed reservations with confirmation dialog

**Independent Test**: Open a confirmed reservation, click Cancel, confirm, see status change to cancelled

### Implementation for User Story 4

- [x] T017 [US4] Add API client function in `frontend/lib/api.ts`: `apiCancelReservation(reservationId)`
- [x] T018 [US4] Add "Cancel" button to the right panel action block in `frontend/components/inbox-v5.tsx`: shown for confirmed/new reservations (not inquiry/pending — those get approve/reject), clicking opens confirmation dialog ("Are you sure you want to cancel this reservation? This cannot be undone."), three-state feedback on confirm
- [x] T019 [US4] Add inline "Cancel" button to conversation list items in `frontend/components/inbox-v5.tsx`: shown for confirmed reservations, same confirmation and feedback pattern

**Checkpoint**: Can cancel a confirmed reservation. Confirmation dialog has stronger warning language. Status updates correctly.

---

## Phase 7: User Story 5 — Connection Health Monitoring (Priority: P2)

**Goal**: Users are warned when their dashboard connection is approaching expiry or has expired

**Independent Test**: Simulate expiry approaching, verify warning banner appears in inbox and settings

### Implementation for User Story 5

- [x] T020 [US5] Add expiry warning banner to `frontend/components/inbox-v5.tsx`: if dashboard connection expires within 7 days, show a dismissible warning banner at top of inbox ("Your Hostaway connection expires in X days — reconnect in Settings"), if expired, show blocking banner when user tries any action
- [x] T021 [US5] Add expiry warning to `frontend/components/settings-v5.tsx`: highlight days-remaining in amber when <=7 days, show red "Expired" badge when expired, auto-check connection status on settings page load

**Checkpoint**: Warning banners appear at 7-day threshold. Expired connection blocks actions with clear reconnect prompt.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Edge cases, error handling, and refinements across all stories

- [x] T022 Handle externally-changed reservations in `backend/src/routes/reservations.ts`: when Hostaway returns an error because action was already performed (e.g., already approved via dashboard), return a friendly message instead of generic error, re-sync reservation status from Hostaway
- [x] T023 Handle concurrent action attempts in `frontend/components/inbox-v5.tsx`: disable all action buttons for a reservation while any action is in-flight, prevent double-click
- [x] T024 Handle token invalidation in `backend/src/routes/reservations.ts`: if Hostaway returns 401 on an action, mark the dashboard connection as invalid, return 403 with reconnect prompt to frontend
- [x] T025 Validate quickstart flow end-to-end per `specs/029-inquiry-accept-reject/quickstart.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 (schema + encryption utility)
- **User Stories (Phase 3–7)**: All depend on Phase 2 (backend API must be ready)
  - US1 (Connect) should complete first — other stories need a connected account to test
  - US2, US3, US4 can proceed in parallel after US1
  - US5 (Health Monitoring) can proceed in parallel with US2–US4
- **Polish (Phase 8)**: Depends on all user stories being complete

### User Story Dependencies

- **US1 (Connect)**: After Phase 2 — no story dependencies. Must complete first for testing.
- **US2 (Approve)**: After Phase 2 + US1 connected for testing
- **US3 (Reject)**: After Phase 2 + US1 connected for testing. Shares UI patterns with US2.
- **US4 (Cancel)**: After Phase 2 + US1 connected for testing. Shares UI patterns with US2/US3.
- **US5 (Health)**: After Phase 2 — independent of US2–US4

### Within Each User Story

- API client functions before UI components
- Right panel action block before inline list buttons (same patterns, right panel is primary)
- Core implementation before edge case handling

### Parallel Opportunities

- T005 and T006 can run in parallel (different route files)
- T010 and T014 and T017 can run in parallel (API client additions, different functions)
- US2, US3, US4 frontend work shares patterns — implement US2 first as template, then US3/US4 follow same pattern

---

## Parallel Example: Phase 2 (Foundational)

```
# These can run in parallel (different files):
Agent 1: T005 — hostaway-connect.ts routes
Agent 2: T006 — reservation action routes
```

## Parallel Example: After US1 Complete

```
# These can start in parallel:
Agent 1: US2 (T010-T013) — Approve flow
Agent 2: US3 (T014-T016) — Reject flow
Agent 3: US4 (T017-T019) — Cancel flow
Agent 4: US5 (T020-T021) — Health monitoring
```

---

## Implementation Strategy

### MVP First (US1 Only)

1. Complete Phase 1: Setup (T001–T003)
2. Complete Phase 2: Foundational (T004–T007)
3. Complete Phase 3: US1 Connect (T008–T009)
4. **STOP and VALIDATE**: Connect to Hostaway, verify token stored, status shows correctly
5. Test approve/reject/cancel via curl to confirm backend works

### Incremental Delivery

1. Setup + Foundational → Backend ready
2. US1 (Connect) → Settings page functional → Can test backend via curl
3. US2 (Approve) → Primary action available in UI
4. US3 (Reject) → Second action available
5. US4 (Cancel) → Third action available
6. US5 (Health) → Expiry warnings active
7. Polish → Edge cases handled

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- The right panel action block (US2 T011) establishes the UI pattern — US3 and US4 follow it
- The reject endpoint is not fully confirmed — T004 includes a fallback strategy per research.md
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
