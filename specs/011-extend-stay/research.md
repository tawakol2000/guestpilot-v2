# Research: Extend Stay Tool

**Feature**: 011-extend-stay
**Date**: 2026-03-21

## R1: Hostaway Price Calculation Endpoint

**Decision**: Use `POST /v1/reservations/calculatePrice` for price quotes. If unavailable or undocumented, fall back to `GET /v1/listings/{listingId}/calendar` to read per-day rates and calculate manually.

**Rationale**: The Hostaway API changelog confirms a `calculatePrice` endpoint exists. However, the exact parameters and response schema aren't publicly documented. We'll attempt the endpoint with standard params (`listingId`, `arrivalDate`, `departureDate`, `numberOfGuests`) and handle errors gracefully. If it fails, we can read the calendar to get daily rates.

**Alternatives considered**:
- Hardcoded nightly rate from property data — rejected because rates vary by season, day of week, and occupancy
- Not quoting prices at all — rejected because the user specifically wants price transparency (US3)

## R2: Availability Check for Extensions

**Decision**: Use `GET /v1/listings/{listingId}/calendar` to check if specific dates are available for the guest's current property. This is more targeted than the `listAvailableListings()` endpoint (which searches ALL listings) since we only need to check one property.

**Rationale**: For extensions, we know which property — we just need to check if the dates after checkout are free. The calendar endpoint returns per-day availability for a single listing, which is exactly what we need.

**Implementation**:
- `GET /v1/listings/{listingId}/calendar?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`
- Check each day in the response for availability (no conflicting reservations)
- If `includeResources=1`, reservation objects are included so we can see what's blocking

**Alternatives considered**:
- `listAvailableListings` with date filter — works but returns all listings, wasteful when checking one property
- Local reservation table — might miss external bookings (same issue as 010)

## R3: Channel-Aware Alteration Flow

**Decision**: The tool result includes a `channel_instructions` field that tells Claude exactly what to say to the guest based on their booking channel.

**Channel flows**:
- **AIRBNB**: "Please submit an alteration request through Airbnb for [new dates]. We'll approve it promptly."
- **BOOKING**: "Please modify your reservation dates through Booking.com to [new dates]."
- **DIRECT / WHATSAPP / OTHER**: "I'll arrange the extension for you. Our team will confirm shortly." + escalation task

**Rationale**: The tool handler resolves the channel and generates the appropriate instruction text, so Claude doesn't have to figure out channel rules. This ensures 100% correctness (SC-003).

## R4: Tool Scope — Guest Coordinator Only

**Decision**: This tool is available to the guest coordinator (CONFIRMED/CHECKED_IN) only. The screening agent (INQUIRY) does NOT get this tool.

**Rationale**: Only booked guests can extend stays. Inquiries don't have reservations to modify. The property search tool (010) handles inquiry-phase needs.

**Implementation**: In `generateAndSendAiReply()`, the extend-stay tool is included in the `tools` array when `reservationStatus !== 'INQUIRY'` — the inverse of the property search tool.

## R5: Reusing Tool Infrastructure from 010

**Decision**: Reuse everything from 010 — same `createMessage()` tool loop, same `ToolHandler` type, same `toolHandlers` Map, same `ragContext` logging.

**What's new**: Just a new tool definition + handler function. No infrastructure changes.

**Files to create/modify**:
- `backend/src/services/extend-stay.service.ts` — NEW: tool handler
- `backend/src/services/hostaway.service.ts` — ADD: `getListingCalendar()` and `calculateReservationPrice()` functions
- `backend/src/services/ai.service.ts` — ADD: tool definition + handler registration for guest coordinator
