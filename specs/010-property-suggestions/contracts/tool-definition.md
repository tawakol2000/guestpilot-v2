# Contract: Tool Definition — search_available_properties

**Feature**: 010-property-suggestions
**Date**: 2026-03-21

## Tool Schema (Anthropic Tool Use Format)

```json
{
  "name": "search_available_properties",
  "description": "Search for alternative properties in the same city that match specific criteria and are available for the guest's dates. Use this when a guest asks about amenities or features their current property doesn't have, wants to switch properties, or expresses a preference for different property attributes (size, location, amenities). Do NOT use this when the guest is asking about their current property's existing amenities.",
  "input_schema": {
    "type": "object",
    "properties": {
      "amenities": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Amenities or features the guest is looking for, e.g. ['pool', 'parking', 'sea view']. Use simple English terms."
      },
      "min_capacity": {
        "type": "number",
        "description": "Minimum number of guests the property should accommodate. Only include if the guest mentioned needing more space or has a specific group size."
      },
      "reason": {
        "type": "string",
        "description": "Brief reason for the search, e.g. 'guest asked for pool', 'guest wants bigger place for 6 people'. Used for logging."
      }
    },
    "required": ["amenities", "reason"]
  }
}
```

## Server-Side Context Injection

The tool handler receives these from the request context (NOT from Claude's input):
- `checkIn` / `checkOut`: from `reservation.checkIn` / `reservation.checkOut`
- `currentPropertyId`: from conversation context
- `city`: parsed from current property's address
- `tenantId`: from authenticated request
- `channel`: from `reservation.channel` (for URL selection)
- `hostawayAccountId` / `hostawayApiKey`: from tenant record

## Tool Result Format

### Success (matches found)
```json
{
  "found": true,
  "count": 2,
  "properties": [
    {
      "name": "Beach Villa",
      "highlights": "Pool, Sea view, Sleeps 6",
      "booking_link": "https://airbnb.com/rooms/12345",
      "capacity": 6,
      "amenities_matched": ["pool"]
    },
    {
      "name": "Marina Tower 3BR",
      "highlights": "Pool, Gym, Parking, Sleeps 8",
      "booking_link": "https://airbnb.com/rooms/67890",
      "capacity": 8,
      "amenities_matched": ["pool"]
    }
  ],
  "dates_checked": "2026-03-25 to 2026-03-30",
  "city": "Dubai"
}
```

### Success (no matches)
```json
{
  "found": false,
  "count": 0,
  "properties": [],
  "dates_checked": "2026-03-25 to 2026-03-30",
  "city": "Dubai",
  "message": "No properties with pool are available in Dubai for these dates."
}
```

### Error (API failure)
```json
{
  "found": false,
  "count": 0,
  "properties": [],
  "error": "Could not check availability at this time. Please escalate to the property manager.",
  "should_escalate": true
}
```

## Response Flow

```
Guest Message
  → createMessage() with tools=[search_available_properties]
  → Claude decides:
     A) No tool needed → stop_reason: "end_turn" → normal JSON response
     B) Tool needed → stop_reason: "tool_use" → extract tool input
        → Execute search_available_properties handler
        → Send tool_result back to Claude
        → Claude generates final response incorporating results
        → stop_reason: "end_turn" → normal JSON response
```

## Notes

- `tool_choice: { type: "auto" }` — Claude decides when to call the tool
- Maximum 1 tool call loop per message (no recursive tool calls)
- If tool execution takes >5s, return a timeout error result
- Tool results are included in `ragContext` for AiApiLog observability
