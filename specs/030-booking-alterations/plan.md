# Implementation Plan: Booking Alteration Accept/Reject

**Branch**: `030-booking-alterations` | **Date**: 2026-04-04 | **Spec**: [spec.md](spec.md)

## Summary

When a guest submits a booking alteration request (date/guest count change), Hostaway already sends a system message that GuestPilot detects in the webhook handler — AI is skipped and a manager task is created. This feature extends that existing hook: on detection, GuestPilot also fetches the alteration details from Hostaway's internal API and persists them, then surfaces an action panel at the top of the inbox right-panel so the host can accept or reject without leaving GuestPilot.

The pattern mirrors feature 029 (inquiry accept/reject): same Hostaway dashboard JWT auth, same button/feedback UX, same audit log approach.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+ (backend), Next.js 16 + React 19 (frontend)  
**Primary Dependencies**: Express 4.x, Prisma ORM, axios (backend); React 19, Tailwind 4, shadcn/ui (frontend)  
**Storage**: PostgreSQL + Prisma ORM — 2 new models (BookingAlteration, AlterationActionLog), 2 new enums  
**Testing**: Manual via sandbox + Railway deployment  
**Target Platform**: Railway (backend), Vercel (frontend)  
**Project Type**: Web application (fullstack)  
**Performance Goals**: Accept/reject response within 5 seconds (SC-002)  
**Constraints**: Alteration accept/reject endpoints on platform.hostaway.com are TBD — placeholder endpoints used during development, swapped before launch. Feature must degrade gracefully if Hostaway API is unreachable.  
**Scale/Scope**: Per-tenant, per-reservation — low volume feature

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| §I Graceful Degradation | PASS | Alteration detail fetch failure → save `fetchError` on `BookingAlteration`, show error panel in UI. Accept/reject failures surface user-readable errors. Main messaging flow unaffected. |
| §II Multi-Tenant Isolation | PASS | All new models include `tenantId`. All queries filter by it. |
| §III Guest Safety | PASS | No AI involved. No access code exposure risk. |
| §IV Structured AI Output | N/A | No AI calls in this feature. |
| §V Escalate When In Doubt | PASS | Existing manager task creation for alteration requests preserved unchanged. |
| §VI Observability | PASS | `AlterationActionLog` records every accept/reject with outcome, initiator, and error detail. |
| §VII Tool-Based Architecture | N/A | No new tools needed. |
| §VIII FAQ Knowledge Loop | N/A | Not applicable. |

**Gate result: PASS** — no violations.

## Project Structure

### Documentation (this feature)

```text
specs/030-booking-alterations/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── alterations-api.md
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code

```text
backend/
├── prisma/
│   └── schema.prisma                          # +BookingAlteration, +AlterationActionLog, +2 enums
└── src/
    ├── controllers/
    │   └── webhooks.controller.ts             # Extend isAlterationRequest block to fetch & persist alteration
    ├── routes/
    │   └── alterations.ts                     # NEW: GET alteration, POST accept, POST reject
    ├── services/
    │   └── hostaway-alterations.service.ts    # NEW: Hostaway internal API calls for alterations
    └── app.ts                                 # Register alterations router

frontend/
├── lib/
│   └── api.ts                                 # +apiGetAlteration, +apiAcceptAlteration, +apiRejectAlteration
└── components/
    └── inbox-v5.tsx                           # +AlterationPanel at top of right panel
```

## Phase 0: Research

See [research.md](research.md).

## Phase 1: Design & Contracts

See [data-model.md](data-model.md), [contracts/alterations-api.md](contracts/alterations-api.md), [quickstart.md](quickstart.md).
