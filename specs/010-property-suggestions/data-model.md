# Data Model: Cross-Sell Property Suggestions

**Feature**: 010-property-suggestions
**Date**: 2026-03-21

## Existing Entities (No Changes)

### Property
Already stores all needed metadata in `customKnowledgeBase` JSON:
- `amenities` (string, CSV): "WiFi, Kitchen, Pool, AC, Parking"
- `personCapacity` (number): guest capacity
- `address` (string): full address including city
- `name` (string): property display name

**New fields added to `customKnowledgeBase` during import** (no schema migration):
- `airbnbListingUrl` (string | null): Airbnb listing page URL
- `vrboListingUrl` (string | null): Booking.com / VRBO listing URL
- `bookingEngineUrl` (string | null): Direct booking engine URL

### Reservation
Already has all needed fields:
- `checkIn` (DateTime): guest arrival date
- `checkOut` (DateTime): guest departure date
- `channel` (Channel enum): AIRBNB | BOOKING | DIRECT | OTHER | WHATSAPP
- `status` (ReservationStatus enum): INQUIRY | CONFIRMED | CHECKED_IN | CHECKED_OUT | CANCELLED

### Task
Reused as-is for property-switch escalations:
- `title`: "property-switch-request"
- `note`: structured text with guest, properties, dates, reason
- `urgency`: "scheduled"
- `source`: "ai"

## New Entities

### None

No new database tables or Prisma models required. All data fits within existing structures:
- Listing URLs → `customKnowledgeBase` JSON (Property)
- Search metadata → `ragContext` JSON (AiApiLog)
- Switch escalations → Task model

## Data Flow

### Property Search Flow
```
1. Claude calls search_available_properties({ amenities: ["pool"] })
2. Backend reads all Property records for tenant (already cached from import)
3. Backend filters:
   a. Same city as current property (from property.address)
   b. Has requested amenities (substring match on customKnowledgeBase.amenities)
   c. Excludes current property (by id)
4. Backend calls Hostaway API: GET /v1/listings?availabilityDateStart=YYYY-MM-DD&availabilityDateEnd=YYYY-MM-DD
5. Backend intersects: local amenity matches ∩ Hostaway available listings
6. Backend selects channel-appropriate URL based on reservation.channel
7. Returns top 3 results to Claude as tool_result
```

### Tool Result Schema (returned to Claude)
```json
{
  "results": [
    {
      "name": "Beach Villa",
      "highlights": "Pool, Sea view, Sleeps 6",
      "booking_link": "https://airbnb.com/rooms/12345",
      "capacity": 6
    }
  ],
  "search_criteria": { "amenities": ["pool"], "city": "Dubai" },
  "total_matches": 2,
  "message": "Found 2 available properties with pool in Dubai for Mar 25-30"
}
```

### AiApiLog Metadata Extension
The existing `ragContext` JSON field on AiApiLog gets new keys:
- `toolUsed`: boolean — whether a tool was called
- `toolName`: string — "search_available_properties"
- `toolInput`: object — the search criteria Claude sent
- `toolResults`: array — properties returned
- `toolDurationMs`: number — how long the tool execution took

## Amenity Synonym Map
```json
{
  "pool": ["pool", "swimming pool", "outdoor pool", "indoor pool", "plunge pool"],
  "wifi": ["wifi", "wi-fi", "internet", "wireless"],
  "parking": ["parking", "garage", "car park", "covered parking"],
  "gym": ["gym", "fitness", "fitness center", "workout room"],
  "balcony": ["balcony", "terrace", "patio", "outdoor space"],
  "kitchen": ["kitchen", "kitchenette", "cooking"],
  "washer": ["washer", "washing machine", "laundry"],
  "ac": ["ac", "air conditioning", "air conditioner", "cooling"],
  "sea_view": ["sea view", "ocean view", "beach view", "water view"],
  "bbq": ["bbq", "barbecue", "grill"]
}
```

This map is used by the tool handler for FR-007 (semantic amenity matching). It's a static config file, not a database entity.
