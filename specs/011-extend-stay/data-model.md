# Data Model: Extend Stay Tool

**Feature**: 011-extend-stay
**Date**: 2026-03-21

## Existing Entities (No Changes)

### Reservation
Already has all needed fields:
- `checkIn` (DateTime): current arrival date
- `checkOut` (DateTime): current departure date
- `channel` (Channel enum): AIRBNB | BOOKING | DIRECT | OTHER | WHATSAPP
- `status` (ReservationStatus enum): CONFIRMED | CHECKED_IN

### Task
Reused for extension escalations:
- `title`: "stay-extension-request" or "date-modification-request"
- `note`: structured text with current dates, requested dates, price quote, channel
- `urgency`: "scheduled" (routine) or "immediate" (same-day)
- `source`: "ai"

## New Entities

### None

No schema changes. All data flows through the tool result → Claude → JSON response → existing escalation system.

## Tool Input Schema

```json
{
  "action": "extend" | "shorten" | "shift",
  "new_checkout": "YYYY-MM-DD",
  "new_checkin": "YYYY-MM-DD",
  "reason": "Brief reason for the change"
}
```

Server-side context (injected, not from Claude):
- `listingId`: from property.hostawayListingId
- `currentCheckIn`: from reservation.checkIn
- `currentCheckOut`: from reservation.checkOut
- `channel`: from reservation.channel
- `numberOfGuests`: from reservation.guestCount
- `hostawayAccountId` / `hostawayApiKey`: from tenant

## Tool Result Schema

```json
{
  "available": true,
  "current_dates": "Mar 25-30",
  "requested_dates": "Mar 25-Apr 2",
  "additional_nights": 3,
  "price_per_night": 150,
  "total_additional_cost": 450,
  "currency": "USD",
  "channel": "AIRBNB",
  "channel_instructions": "Please submit an alteration request through Airbnb for the new checkout date (Apr 2). We'll approve it right away.",
  "max_available_extension": null
}
```

### When unavailable:
```json
{
  "available": false,
  "current_dates": "Mar 25-30",
  "requested_dates": "Mar 25-Apr 2",
  "conflict_starts": "Mar 31",
  "max_available_extension": 1,
  "channel_instructions": null,
  "message": "Property is booked starting Mar 31. Maximum extension is 1 night (until Mar 31)."
}
```

## AiApiLog Metadata Extension

Same pattern as 010 — `ragContext` gets:
- `toolUsed`: true
- `toolName`: "check_extend_availability"
- `toolInput`: the action + dates
- `toolResults`: availability + pricing + channel instructions
- `toolDurationMs`: execution time
