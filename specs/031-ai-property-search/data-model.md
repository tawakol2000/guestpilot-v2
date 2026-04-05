# Data Model: AI-Powered Semantic Property Search

## Schema Changes

**None.** This feature modifies the property search logic only — no new database models, no new fields, no schema migrations. All existing data structures are sufficient.

## Entities Used (Read-Only)

### Property (existing)
- `id`: Unique identifier
- `tenantId`: Tenant scope
- `hostawayListingId`: External listing reference
- `name`: Internal property name
- `address`: Full address (used for city filtering)
- `listingDescription`: Full property description text (NEW to search — previously ignored)
- `customKnowledgeBase` (JSON):
  - `personCapacity`: Guest count capacity
  - `bedroomsNumber`: Bedroom count
  - `bathroomsNumber`: Bathroom count
  - `amenities`: Comma-separated amenity list
  - `roomType`: Property type (entire_home, room, etc.)
  - `airbnbListingUrl`: Airbnb booking link
  - `vrboListingUrl`: Booking.com link
  - `bookingEngineUrl`: Direct booking link

### Property Profile (runtime — not persisted)
Assembled at search time from Property fields. Sent to the scoring model.
- `name`: Property name
- `bedrooms`: From customKnowledgeBase.bedroomsNumber
- `capacity`: From customKnowledgeBase.personCapacity
- `address`: From property.address
- `description`: First 500 characters of listingDescription
- `amenities`: From customKnowledgeBase.amenities

### Scored Property Result (runtime — not persisted)
Returned by the scoring model, enriched with booking links.
- `index`: Position in candidate list (maps back to property)
- `score`: 0-10 match score
- `met`: Array of met requirements (strings)
- `unmet`: Array of unmet requirements (strings)
- `note`: Human-readable summary
- `is_current_property`: Boolean flag
- `booking_link`: Channel-appropriate URL (null for current property)
