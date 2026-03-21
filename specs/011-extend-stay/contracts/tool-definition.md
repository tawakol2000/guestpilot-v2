# Contract: Tool Definition — check_extend_availability

**Feature**: 011-extend-stay
**Date**: 2026-03-21

## Tool Schema (Anthropic Tool Use Format)

```json
{
  "name": "check_extend_availability",
  "description": "Check if the guest's current property is available for extended or modified dates, and calculate the price for additional nights. Use this when a guest asks to extend their stay, shorten their stay, change dates, or asks how much extra nights would cost. Do NOT use for guests who haven't booked yet (inquiries).",
  "input_schema": {
    "type": "object",
    "properties": {
      "new_checkout": {
        "type": "string",
        "description": "The requested new checkout date in YYYY-MM-DD format. Required for extensions and date shifts."
      },
      "new_checkin": {
        "type": "string",
        "description": "The requested new check-in date in YYYY-MM-DD format. Only needed if the guest wants to arrive earlier or later."
      },
      "reason": {
        "type": "string",
        "description": "Brief reason for the request, e.g. 'guest wants to stay 2 more nights', 'guest leaving early'. Used for logging."
      }
    },
    "required": ["new_checkout", "reason"]
  }
}
```

## Server-Side Context Injection

The tool handler receives these from the request context (NOT from Claude):
- `listingId`: from `property.hostawayListingId`
- `currentCheckIn`: from `reservation.checkIn`
- `currentCheckOut`: from `reservation.checkOut`
- `channel`: from `reservation.channel`
- `numberOfGuests`: from `reservation.guestCount`
- `hostawayAccountId` / `hostawayApiKey`: from tenant record

## Response Flow

Same as 010 — uses existing `createMessage()` tool loop:

```
Guest: "Can I stay 2 more nights?"
  → Claude calls check_extend_availability({ new_checkout: "2026-03-27", reason: "extend 2 nights" })
  → Handler: check calendar availability → calculate price → resolve channel instructions
  → tool_result returned to Claude
  → Claude: "Great news! The apartment is available until March 27. The 2 extra nights would be approximately $300. To extend, please submit an alteration request through Airbnb and we'll approve it."
```
