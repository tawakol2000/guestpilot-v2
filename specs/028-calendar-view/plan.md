# Implementation Plan: Calendar View

**Branch**: `028-calendar-view` | **Date**: 2026-04-02 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/028-calendar-view/spec.md`

## Summary

Add a Gantt-style calendar view page to GuestPilot showing all properties as rows with reservation bars spanning check-in to check-out dates. Includes per-night pricing in empty cells (fetched from Hostaway Calendar API with 15-minute cache), rich hover tooltips with financial data, channel-colored bars, and smooth navigation. Requires: 4 new fields on Reservation model, 3 new API endpoints, 1 new frontend component, and nav integration.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+ (backend), Next.js 16 + React 19 (frontend)
**Primary Dependencies**: Express 4.x, Prisma ORM, Hostaway API, Tailwind 4, shadcn/ui
**Storage**: PostgreSQL + Prisma ORM (schema changes: 4 new fields on Reservation model)
**Testing**: Manual testing via frontend + sandbox
**Target Platform**: Web application (desktop browsers, 13"+ screens)
**Project Type**: Full-stack web application
**Performance Goals**: < 2s initial load for 50 properties, < 300ms navigation transitions
**Constraints**: Hostaway API rate limits (~60 req/min), parallel fetch with concurrency limit of 5
**Scale/Scope**: ~50 properties per tenant, ~200 reservations per date range view

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Graceful Degradation | PASS | Calendar is a new page, doesn't touch messaging flow. Pricing fetch failure shows "---" placeholder. |
| II. Multi-Tenant Isolation | PASS | All queries scoped by tenantId from JWT. |
| III. Guest Safety & Access Control | PASS | Calendar is manager-facing only, no guest interaction. |
| IV. Structured AI Output | N/A | No AI involved in this feature. |
| V. Escalate When In Doubt | N/A | No AI involved. |
| VI. Observability | PASS | Standard request logging. No new AI calls to trace. |
| VII. Self-Improvement | N/A | No classifier involved. |
| Security | PASS | Uses existing JWT auth. Hostaway API keys stay server-side. |
| Database Changes | PASS | Adding 4 nullable fields to Reservation — non-destructive. |

**Post-design re-check**: All principles remain PASS. No violations.

## Project Structure

### Documentation (this feature)

```text
specs/028-calendar-view/
├── spec.md              # Feature specification
├── plan.md              # This file
├── research.md          # Phase 0: technical decisions
├── data-model.md        # Phase 1: schema changes
├── design-system.md     # UI/UX design tokens and component structure
├── quickstart.md        # Phase 1: integration scenarios
├── contracts/
│   └── api.md           # Phase 1: API endpoint contracts
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (via /speckit.tasks)
```

### Source Code (repository root)

```text
backend/
├── prisma/
│   └── schema.prisma           # MODIFY: Add 4 fields to Reservation model
├── src/
│   ├── routes/
│   │   └── reservations.ts     # NEW: GET /api/reservations
│   ├── controllers/
│   │   └── properties.controller.ts  # MODIFY: Add calendar + calendar-bulk endpoints
│   ├── services/
│   │   └── calendar.service.ts # NEW: Calendar pricing cache + bulk fetch logic
│   ├── jobs/
│   │   └── reservationSync.job.ts    # MODIFY: Sync financial fields
│   └── app.ts                  # MODIFY: Register new reservations route

frontend/
├── components/
│   └── calendar-v5.tsx         # NEW: Full calendar view component
├── app/
│   └── page.tsx                # MODIFY: Add Calendar tab to navigation
└── lib/
    └── api.ts                  # MODIFY: Add calendar API client functions
```

**Structure Decision**: Follows existing project conventions — v5 component naming, controller-route-service pattern, Prisma model changes via schema.prisma.

## Key Implementation Notes

### Backend (5 changes)

1. **Schema** (`prisma/schema.prisma`): Add `totalPrice Decimal?`, `hostPayout Decimal?`, `cleaningFee Decimal?`, `currency String?` to Reservation model. Run `prisma db push`.

2. **Reservation Sync** (`reservationSync.job.ts`): Map 4 new Hostaway fields in the existing upsert create/update paths.

3. **Calendar Service** (`calendar.service.ts`): New service wrapping `hostawayService.getListingCalendar()` with in-memory cache (15min TTL, same pattern as tenant-config cache). Handles parallel fetch for bulk endpoint (concurrency limit: 5).

4. **Reservations Route** (`reservations.ts`): New route file with `GET /api/reservations` — date range query with guest/property includes.

5. **Properties Controller** (`properties.controller.ts`): Add `GET /api/properties/:id/calendar` and `GET /api/properties/calendar-bulk` endpoints.

### Frontend (3 changes)

1. **API Client** (`api.ts`): Add `apiGetReservations(startDate, endDate)`, `apiGetCalendarBulk(startDate, endDate)`.

2. **Calendar Component** (`calendar-v5.tsx`): Full component with:
   - CSS Grid layout (sticky sidebar + sticky header)
   - Reservation bars with channel colors and status patterns
   - Nightly price cells
   - Navigation toolbar (Today, arrows, view toggle, search)
   - Hover tooltips
   - Click-to-inbox navigation
   - Design tokens from `design-system.md`

3. **Navigation** (`page.tsx`): Add Calendar as a new tab in the existing tab navigation.

## Complexity Tracking

No constitution violations to justify. Feature is straightforward CRUD + read-only visualization.
