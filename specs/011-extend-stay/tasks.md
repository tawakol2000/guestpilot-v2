# Tasks: Extend Stay Tool

**Input**: Design documents from `/specs/011-extend-stay/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Organization**: Tasks grouped by user story. Reuses tool infrastructure from 010 — no foundational phase needed.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Hostaway API Functions)

**Purpose**: Add calendar and price calculation functions to Hostaway service — prerequisites for the tool handler

- [x] T001 [P] Add `getListingCalendar(accountId, apiKey, listingId, startDate, endDate)` function to `backend/src/services/hostaway.service.ts` — calls `GET /v1/listings/${listingId}/calendar?startDate=${startDate}&endDate=${endDate}&includeResources=1`, returns calendar day objects. Use existing `retryWithBackoff()` and `getClient()` patterns
- [x] T002 [P] Add `calculateReservationPrice(accountId, apiKey, listingId, arrivalDate, departureDate, numberOfGuests)` function to `backend/src/services/hostaway.service.ts` — calls `POST /v1/reservations/calculatePrice` with `{ listingMapId: listingId, arrivalDate, departureDate, numberOfGuests }`, returns price object. Wrapped in try/catch — returns null on failure (graceful degradation per FR-006). Use existing patterns

---

## Phase 2: User Story 1 + 3 — Extend Stay with Pricing (Priority: P1) MVP

**Goal**: When a confirmed guest asks to extend their stay, the AI checks availability, quotes a price, and provides channel-specific instructions.

**Independent Test**: In the Sandbox, set status to CONFIRMED, send "Can I stay 2 more nights?" — verify the AI responds with availability, price, and channel instructions.

### Implementation for User Story 1 + 3

- [x] T003 [US1] Create `backend/src/services/extend-stay.service.ts` with `checkExtendAvailability(input, context)` function: (1) parse new_checkout/new_checkin dates, (2) determine if extension/shortening/shift, (3) for extensions: call `getListingCalendar()` to check if each day between current checkout and new checkout is free — if any day has a reservation, it's unavailable, (4) calculate max available extension if partially blocked, (5) for extensions: call `calculateReservationPrice()` for the additional nights — if it fails, set price to null, (6) generate channel-specific instructions based on `context.channel` (AIRBNB → "submit alteration through Airbnb", BOOKING → "modify through Booking.com", DIRECT/WHATSAPP → "I'll arrange it" + note to escalate), (7) return JSON string per data-model.md tool result schema. Never include access codes
- [x] T004 [US1] Define the `check_extend_availability` tool schema in `backend/src/services/ai.service.ts` (per contracts/tool-definition.md). Add to the guest coordinator's tools — include in `toolsForCall` when `!isInquiry` (CONFIRMED/CHECKED_IN only). Register handler in `toolHandlersForCall` map, passing reservation context: listingId (from `context.propertyId` → look up `hostawayListingId`), currentCheckIn, currentCheckOut, channel, numberOfGuests, hostawayAccountId, hostawayApiKey
- [x] T005 [US1] Look up `property.hostawayListingId` in the tool handler setup in `backend/src/services/ai.service.ts` — the context has `propertyId` but the calendar API needs `hostawayListingId`. Load the property from DB (or pass it through the context). Simplest: add `hostawayListingId` to the context passed to the handler
- [x] T006 [US1] Add extend-stay tool instruction to the guest coordinator system prompt (`OMAR_SYSTEM_PROMPT`) in `backend/src/services/ai.service.ts`: section about the `check_extend_availability` tool — when to use it (guest asks to extend, shorten, change dates, or asks about pricing for extra nights), when NOT to use it (unrelated questions), and to always include the price and channel instructions from the tool result in the response. Add example JSON output showing price + channel instructions inline

**Checkpoint**: US1+US3 complete. Confirmed guests get availability + pricing + channel instructions in one response.

---

## Phase 3: User Story 2 — Shorten Stay / Change Dates (Priority: P2)

**Goal**: Handle early checkouts and date shifts — same tool, different input.

**Independent Test**: Send "Can I leave a day early?" — verify the AI confirms the shortened stay without requiring an availability check. Send "Can I arrive Thursday instead of Wednesday?" — verify the AI checks availability for the new arrival date.

### Implementation for User Story 2

- [x] T007 [US2] Update `checkExtendAvailability()` in `backend/src/services/extend-stay.service.ts` to handle shortened stays: if `new_checkout` is BEFORE `currentCheckOut`, skip availability check (property becomes more available), calculate any refund/pricing difference if possible, return result with `available: true` and channel instructions for modification
- [x] T008 [US2] Update `checkExtendAvailability()` in `backend/src/services/extend-stay.service.ts` to handle date shifts: if `new_checkin` is provided and different from `currentCheckIn`, check availability for the new check-in period (days between new_checkin and currentCheckIn if arriving earlier, or the gap if arriving later)
- [x] T009 [US2] Update the extend-stay prompt section in `OMAR_SYSTEM_PROMPT` in `backend/src/services/ai.service.ts` to cover shortened stays and date shifts — AI should use the tool for these scenarios too, and understand that shortened stays don't need availability checks

**Checkpoint**: US2 complete. Early checkouts, late arrivals, and date shifts all handled.

---

## Phase 4: User Story 4 — Manager Visibility (Priority: P3)

**Goal**: Tool usage shows up in pipeline view and escalation tasks have full details.

**Independent Test**: Trigger an extend-stay request, check pipeline view for tool details, check tasks for escalation with dates/price/channel.

### Implementation for User Story 4

- [ ] T010 [US4] Verify tool usage metadata appears in the pipeline view from 010 — no code changes needed if `ragContext.toolUsed/toolName/toolInput/toolResults` are set correctly. Test with a real request and check the AI pipeline tab
- [ ] T011 [US4] Verify escalation tasks created by the AI contain: current dates, requested new dates, price quote, and channel. The AI writes these into the `escalation.note` field based on the tool result — this is prompt-driven (T006), no extra code needed. Verify with a test

**Checkpoint**: US4 complete. Pipeline and tasks show full extend-stay details.

---

## Phase 5: Polish & Edge Cases

**Purpose**: Validation and edge case handling

- [ ] T012 Test edge case: guest asks for vague dates ("a few more days") — verify AI asks for specific dates before calling the tool
- [ ] T013 Test edge case: property partially available (3 of 5 requested nights free) — verify AI reports the maximum extension
- [ ] T014 Test edge case: same-day extension (checkout is today) — verify availability check works for today onwards
- [ ] T015 Test edge case: price calculation fails — verify AI still confirms availability and says "I'll check pricing with the team"
- [ ] T016 Test edge case: INQUIRY guest asks to extend — verify tool does NOT fire (guest coordinator only)
- [ ] T017 Run quickstart.md full validation workflow

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **US1+US3 (Phase 2)**: Depends on Setup (needs Hostaway functions)
- **US2 (Phase 3)**: Depends on US1 (extends the same handler)
- **US4 (Phase 4)**: Depends on US1 (needs tool to be wired — verification only)
- **Polish (Phase 5)**: Depends on all user stories

### Within Each Phase

- T001 ‖ T002 (different functions, same file but independent)
- T003 → T004 → T005 → T006 (sequential — service before wiring before prompt)
- T007 ‖ T008 (different branches in same function, but sequential is safer)

### Parallel Opportunities

```
Phase 1: T001 ‖ T002 (independent Hostaway functions)
Phase 2: T003 → T004 → T005 → T006 (sequential)
Phase 3: T007 → T008 → T009 (sequential, same files)
Phase 4: T010 ‖ T011 (independent verification)
```

---

## Implementation Strategy

### MVP First (US1 + US3)

1. Complete Phase 1: Setup (T001-T002) — Hostaway API functions
2. Complete Phase 2: US1+US3 (T003-T006) — extend-stay tool + pricing + prompt
3. **STOP and VALIDATE**: Test in Sandbox with CONFIRMED status
4. Deploy if working — extensions with pricing + channel flow

### Incremental Delivery

1. Setup → Hostaway functions ready
2. US1+US3 → Extensions with pricing (MVP!)
3. US2 → Shortened stays + date shifts
4. US4 → Verify pipeline/task visibility
5. Polish → Edge case validation

---

## Notes

- Total: 17 tasks across 5 phases
- MVP is 6 tasks (Phase 1 + Phase 2)
- No schema changes, no frontend changes
- Reuses 010 tool infrastructure entirely — new tool is just definition + handler
- US4 is verification only — no code changes expected
- Pipeline view + Tools section from 010 display this tool automatically
