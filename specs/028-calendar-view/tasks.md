# Tasks: Calendar View

**Input**: Design documents from `/specs/028-calendar-view/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/api.md

**Tests**: Not requested — no test tasks included.

**Organization**: Tasks grouped by user story. US1+US2 are both P1 but separated for clarity — US1 is the core grid, US2 is navigation controls.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2)
- Exact file paths included in descriptions

---

## Phase 1: Setup

**Purpose**: Schema changes and database update

- [X] T001 Add `totalPrice Decimal?`, `hostPayout Decimal?`, `cleaningFee Decimal?`, `currency String?` fields to Reservation model in backend/prisma/schema.prisma
- [X] T002 Run `npx prisma db push` to apply schema changes and regenerate Prisma client

---

## Phase 2: Foundational (Backend APIs)

**Purpose**: All backend endpoints and services that user stories depend on — MUST complete before frontend work

**CRITICAL**: No user story work can begin until this phase is complete

- [X] T003 Update reservation sync to map `totalPrice`, `hostPayout`, `cleaningFee`, `currency` from Hostaway response in backend/src/jobs/reservationSync.job.ts (add fields to both create and update paths of the upsert)
- [X] T004 [P] Create calendar pricing service with in-memory cache (15min TTL, concurrency-limited parallel fetch) in backend/src/services/calendar.service.ts — wraps `hostawayService.getListingCalendar()`, exports `getCalendarPricing(tenantId, propertyId, startDate, endDate, prisma)` and `getCalendarPricingBulk(tenantId, startDate, endDate, prisma)`
- [X] T005 [P] Create reservations route with `GET /api/reservations?startDate=&endDate=&propertyId=&status=` in backend/src/routes/reservations.ts — query: `checkIn <= endDate AND checkOut >= startDate`, include guest name and conversationId, exclude CANCELLED/CHECKED_OUT by default
- [X] T006 Add `GET /api/properties/:id/calendar` and `GET /api/properties/calendar-bulk` endpoints to backend/src/controllers/properties.controller.ts — call calendar.service, validate date params, handle partial failures with errors array
- [X] T007 Register reservations route in backend/src/app.ts (import and mount at `/api/reservations` with auth middleware)
- [X] T008 [P] Add `apiGetReservations(startDate, endDate)`, `apiGetCalendarBulk(startDate, endDate)` functions to frontend/lib/api.ts

**Checkpoint**: All 3 API endpoints working — reservations list, per-property calendar, bulk calendar

---

## Phase 3: User Story 1 — View All Reservations on a Timeline (Priority: P1) MVP

**Goal**: Properties as rows, dates as columns, reservation bars spanning check-in to check-out, nightly prices in empty cells, today highlighted

**Independent Test**: Load Calendar page with 10+ properties and 20+ reservations. Bars render at correct positions, prices show in empty cells, today column highlighted.

- [X] T009 [US1] Create calendar-v5.tsx scaffold in frontend/components/calendar-v5.tsx — CSS Grid layout with sticky left sidebar (240px) and sticky top date header. Fetch reservations + calendar-bulk on mount. Define TypeScript types for CalendarReservation, CalendarDay, PropertyRow
- [X] T010 [US1] Implement date column generation in calendar-v5.tsx — render 14 columns (2-week default) with day number + weekday abbreviation (e.g., "M 6"), highlight today's column with 2px #2563EB vertical line, tint weekends with #F1F5FD background
- [X] T011 [US1] Implement reservation bar rendering in calendar-v5.tsx — position bars absolutely within property rows spanning check-in to check-out columns, show guest first name + guest count, apply pill-shaped styling (border-radius 6px), handle bars clipped at viewport edge (fade indicator)
- [X] T012 [US1] Implement nightly price display in calendar-v5.tsx — show price in muted text (#94A3B8, 11px, tabular-nums) in empty/available cells, show "---" when pricing data unavailable
- [X] T013 [US1] Handle edge cases in calendar-v5.tsx — back-to-back reservations (checkout bar ends at cell midpoint, checkin starts at midpoint), single-night reservations (minimum 32px bar width), auto-scroll to center today on initial load
- [X] T014 [US1] Add loading skeleton state in calendar-v5.tsx — shimmer animation matching grid structure (property rows + date columns) shown during data fetch
- [X] T015 [US1] Add Calendar tab to main navigation in frontend/app/page.tsx — new tab alongside existing Inbox/Listings/Tasks tabs, using calendar icon from Lucide

**Checkpoint**: Calendar page shows all properties with reservation bars and prices — core value delivered

---

## Phase 4: User Story 2 — Navigate and Explore the Timeline (Priority: P1)

**Goal**: Today button, forward/back arrows, 2-week/month toggle, property search filter

**Independent Test**: Click forward/back and verify dates shift by 7 days. Click Today to snap back. Type in filter to narrow properties. Switch to month view.

- [X] T016 [US2] Add navigation toolbar to calendar-v5.tsx — "Today" button, left/right arrow buttons, month/year label (e.g., "Apr '26"), positioned above the date header row
- [X] T017 [US2] Implement date range shifting in calendar-v5.tsx — forward/back arrows shift by 7 days, smooth slide transition (300ms ease-out on the grid content), refetch calendar-bulk pricing for new date range
- [X] T018 [US2] Add view mode toggle in calendar-v5.tsx — 2-week (14 days, 80px columns, default) and month (30 days, 48px columns), toggle buttons in toolbar, smooth column width transition
- [X] T019 [US2] Add property search filter in calendar-v5.tsx — text input in toolbar, client-side filter on property name (case-insensitive substring match), instant filtering as user types (no debounce needed for client-side)
- [X] T020 [US2] Implement navigation range limits in calendar-v5.tsx — disable back arrow when at 2-month-past limit, disable forward arrow at 6-month-future limit, grey out with reduced opacity + cursor-not-allowed

**Checkpoint**: Full navigation working — users can explore any date within range and filter properties

---

## Phase 5: User Story 3 — View Reservation Details (Priority: P2)

**Goal**: Rich hover tooltip with booking details, click bar to open inbox conversation

**Independent Test**: Hover 5 different bars and verify tooltip shows correct data. Click a bar and verify inbox opens to correct conversation.

- [X] T021 [US3] Create tooltip component in calendar-v5.tsx — portal-rendered tooltip showing: guest full name, channel icon + name, check-in/check-out dates, nights count, guest count, total price with currency. Smart positioning (flips left/right near viewport edge). Max-width 280px
- [X] T022 [US3] Add tooltip animations in calendar-v5.tsx — fade+slide in (150ms ease-out, 100ms hover delay before show), fade out (100ms ease-in on mouse leave)
- [X] T023 [US3] Implement click-to-inbox navigation in calendar-v5.tsx — clicking a reservation bar navigates to inbox page with conversation pre-selected (use conversationId from reservation data, set URL param or state to open that conversation)

**Checkpoint**: Managers can inspect any reservation's details without leaving calendar

---

## Phase 6: User Story 4 — Distinguish Booking Channels and Statuses (Priority: P2)

**Goal**: Channel-colored bars with icons, status patterns (solid/dashed/striped/accent)

**Independent Test**: View reservations from all 5 channels and 4 active statuses. Each visually distinct.

- [X] T024 [P] [US4] Implement channel color system in calendar-v5.tsx — define color map: Airbnb (#FEE2E2 bg, #991B1B text, #F87171 border), Booking.com (#DBEAFE, #1E3A8A, #60A5FA), Direct (#D1FAE5, #065F46, #34D399), WhatsApp (#DCFCE7, #166534, #4ADE80), Other (#F1F5F9, #334155, #94A3B8). Apply to reservation bars
- [X] T025 [US4] Add channel icons to reservation bars in calendar-v5.tsx — small icon (14px) at left edge of bar for each channel (Airbnb flame, Booking B, globe for Direct, WhatsApp icon, ellipsis for Other). Use Lucide or inline SVGs
- [X] T026 [US4] Implement status visual patterns in calendar-v5.tsx — CONFIRMED: solid fill, INQUIRY: transparent fill + 2px dashed border in channel color, PENDING: diagonal stripe pattern (CSS background repeating-linear-gradient 45deg 4px), CHECKED_IN: solid fill + 3px solid darker left border

**Checkpoint**: Visual scanning of channel mix and booking status is instant

---

## Phase 7: User Story 5 — Responsive Sidebar with Property Summary (Priority: P3)

**Goal**: Occupancy percentage and booking count per property in sidebar

**Independent Test**: Verify each property shows correct booking count and occupancy % matching visible date range.

- [X] T027 [US5] Calculate occupancy metrics in calendar-v5.tsx — for each property in the visible date range, compute: total nights, booked nights (from reservation data), occupancy percentage, active booking count. Recalculate when date range changes
- [X] T028 [US5] Display sidebar metrics in calendar-v5.tsx — show booking count and occupancy % below property name in muted text (12px #64748B). Truncate long property names with ellipsis (full name on hover). On screens < 1024px, hide metrics and show only property name

**Checkpoint**: All user stories complete and independently functional

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Visual refinements and accessibility

- [X] T029 [P] Add hover states to calendar-v5.tsx — bar hover: translateY(-1px) + box-shadow 0 2px 8px rgba(0,0,0,0.1) (150ms ease-out). Row highlight on sidebar hover: full row background shifts to #F1F5FD. Cursor pointer on bars
- [X] T030 [P] Add prefers-reduced-motion support to calendar-v5.tsx — disable slide transitions, tooltip animations, and skeleton shimmer when reduced motion is preferred. Use instant state changes instead
- [X] T031 Responsive layout adjustments in calendar-v5.tsx — verify usable on 13" screens (1280px width), sidebar stays 240px, day columns shrink proportionally, no horizontal scrollbar on the sidebar itself
- [X] T032 Run quickstart.md validation — manually verify all 10 scenarios from specs/028-calendar-view/quickstart.md pass

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 — BLOCKS all frontend work
- **US1 (Phase 3)**: Depends on Phase 2 — core calendar grid
- **US2 (Phase 4)**: Depends on US1 (extends same component)
- **US3 (Phase 5)**: Depends on US1 (adds tooltips to existing bars)
- **US4 (Phase 6)**: Can start after US1 (applies styling to bars). Can run in parallel with US2/US3
- **US5 (Phase 7)**: Depends on US1 (adds sidebar metrics)
- **Polish (Phase 8)**: Depends on all user stories

### User Story Dependencies

- **US1 (P1)**: Depends on Foundational only — MVP deliverable
- **US2 (P1)**: Depends on US1 — adds navigation to existing grid
- **US3 (P2)**: Depends on US1 — adds interaction to existing bars
- **US4 (P2)**: Depends on US1 for testing — visual-only changes that can be coded after Foundational but require US1 bars to verify
- **US5 (P3)**: Depends on US1 — adds computed data to sidebar

### Parallel Opportunities

Within Phase 2:
- T004 (calendar service) + T005 (reservations route) + T008 (API client) can run in parallel

Within US4:
- T024 (colors) + T025 (icons) can run in parallel

Phase 6 (US4) can run in parallel with Phase 4 (US2) and Phase 5 (US3) since it only touches CSS/styling.

---

## Implementation Strategy

### MVP First (US1 Only)

1. Complete Phase 1: Schema changes
2. Complete Phase 2: Backend APIs
3. Complete Phase 3: US1 — Timeline View
4. **STOP and VALIDATE**: Calendar shows properties, bars, prices, today marker
5. Deploy and demo

### Incremental Delivery

1. Setup + Foundational → Backend ready
2. US1 → Core calendar grid → Deploy (MVP!)
3. US2 → Navigation controls → Deploy
4. US3 + US4 (parallel) → Tooltips + visuals → Deploy
5. US5 → Sidebar metrics → Deploy
6. Polish → Final refinements → Deploy

---

## Notes

- All frontend work is in a single file (calendar-v5.tsx) — tasks within a user story are sequential
- Backend tasks in Phase 2 touch different files and can mostly run in parallel
- Design tokens are in specs/028-calendar-view/design-system.md — reference during implementation
- Channel colors, spacing, animation durations are all specified in design-system.md
- No new npm dependencies required — CSS Grid, Lucide icons, and existing Tailwind cover everything
