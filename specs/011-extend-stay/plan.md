# Implementation Plan: Extend Stay Tool

**Branch**: `011-extend-stay` | **Date**: 2026-03-21 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/011-extend-stay/spec.md`

## Summary

Add a `check_extend_availability` tool to the **guest coordinator** agent (CONFIRMED/CHECKED_IN) that checks property availability for date extensions, calculates pricing, and provides channel-aware instructions. Reuses the tool use infrastructure from 010 — no changes to `createMessage()` or the tool loop. Just a new tool definition + handler + 2 Hostaway API functions.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+
**Primary Dependencies**: Express 4.x, Prisma ORM, Anthropic SDK, Hostaway API
**Storage**: PostgreSQL + Prisma ORM (no schema changes)
**Target Platform**: Railway (backend)
**Project Type**: Web service (multi-tenant SaaS)
**Performance Goals**: <3s additional latency when tool is invoked (SC-004)
**Constraints**: Hostaway API rate limits (15 req/10s per IP)
**Scale/Scope**: 1 new tool definition, 1 new service file, 2 new Hostaway functions, prompt update

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Graceful Degradation | PASS | FR-006: if price calculation fails, AI still confirms availability and escalates pricing to manager |
| II. Multi-Tenant Isolation | PASS | Calendar/price checks use per-tenant Hostaway credentials. Tool only accesses the guest's own property |
| III. Guest Safety & Access Control | PASS | No access codes exposed. Price quotes come from Hostaway, not AI guesses. AI never commits to price changes — escalates to manager |
| IV. Structured AI Output | PASS | Final output is same JSON format (guest_message, escalation). Tool use is intermediate |
| V. Escalate When In Doubt | PASS | FR-011: every date modification creates an escalation task |
| VI. Observability by Default | PASS | FR-015: tool usage logged to ragContext (same as 010) |
| VII. Self-Improvement | N/A | Tool use doesn't interact with classifier |
| Cost Awareness | PASS | Same cost model as 010 — extra Haiku call only when tool fires |

## Project Structure

### Source Code (repository root)

```text
backend/
├── src/
│   ├── services/
│   │   ├── ai.service.ts              # MODIFY: add tool definition + handler for guest coordinator
│   │   ├── extend-stay.service.ts     # NEW: tool handler — availability + pricing + channel instructions
│   │   └── hostaway.service.ts        # MODIFY: add getListingCalendar() + calculateReservationPrice()
```

**No frontend changes** — the pipeline view and tools section from 010 already display tool usage generically. The extend-stay tool will show up automatically.

## Implementation Phases

### Phase A: Hostaway API Functions

1. **Add `getListingCalendar()` to `hostaway.service.ts`**:
   - `GET /v1/listings/{listingId}/calendar?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&includeResources=1`
   - Returns calendar day objects with reservation data
   - Used to check if specific dates are free for the guest's property

2. **Add `calculateReservationPrice()` to `hostaway.service.ts`**:
   - `POST /v1/reservations/calculatePrice` with listingId, arrivalDate, departureDate, numberOfGuests
   - Returns price breakdown
   - Wrapped in try/catch — returns null on failure (graceful degradation)

### Phase B: Extend Stay Service

1. **Create `extend-stay.service.ts`**:
   - `checkExtendAvailability(input, context)` function
   - Check calendar for requested dates
   - Calculate price for additional nights (or full new period)
   - Determine max available extension if partially available
   - Generate channel-specific instructions
   - Return tool result JSON string

### Phase C: Wire Tool into Guest Coordinator

1. **Add tool definition to `ai.service.ts`**:
   - Define `check_extend_availability` tool schema (per contracts/tool-definition.md)
   - Register handler in toolHandlers Map
   - Only include when `reservationStatus !== 'INQUIRY'` (guest coordinator)
   - Pass reservation context (dates, channel, listing ID, tenant credentials)

2. **Add prompt instruction to `OMAR_SYSTEM_PROMPT`**:
   - Brief section about the extend-stay tool
   - When to use it (guest asks about extending, shortening, changing dates, pricing extra nights)
   - When NOT to use it (guest asking about something else)
   - Always include the price and channel instructions from the tool result
