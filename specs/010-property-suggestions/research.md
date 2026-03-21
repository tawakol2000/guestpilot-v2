# Research: Cross-Sell Property Suggestions (Tool Use)

**Feature**: 010-property-suggestions
**Date**: 2026-03-21

## R1: Claude Tool Use Implementation

**Decision**: Add `tools` parameter to the existing `createMessage()` function in `ai.service.ts`, with a tool-use response loop.

**Rationale**: The Anthropic SDK (`@anthropic-ai/sdk@^0.30.1`) fully supports tool_use. The current `createMessage()` sends a single request and extracts text. For tool use, the flow becomes:
1. Initial request with `tools` array → response may have `stop_reason: 'tool_use'`
2. Extract `tool_use` content blocks → execute tool handlers
3. Send `tool_result` back → get final `end_turn` response with text

The existing function returns `Promise<string>`. Rather than changing its signature (which would break all callers), create a wrapper or extend with an optional tool-use loop that resolves to the final text response.

**Alternatives considered**:
- Separate `createMessageWithTools()` function — rejected because it duplicates retry logic, logging, prompt caching, and observability. Better to extend the existing function.
- Pre-populating portfolio in system prompt — rejected because it wastes tokens on every message and requires querying availability for all properties on every call.

## R2: Listing URLs Not Currently Stored

**Decision**: Extend the Hostaway import to capture `airbnbListingUrl`, `vrboListingUrl`, and `bookingEngineUrls` from listing data. Store in `customKnowledgeBase` JSON (no schema migration needed).

**Rationale**: The Hostaway API returns these fields on listing objects, but the current import service discards them. Adding them to `customKnowledgeBase` avoids a Prisma schema change and keeps the flexible JSON approach consistent with other property metadata.

**Fields to capture**:
- `listing.airbnbListingUrl` → `kb.airbnbListingUrl`
- `listing.vrboListingUrl` → `kb.vrboListingUrl`
- `listing.bookingEngineUrls` (array) → `kb.bookingEngineUrl` (first entry or primary)

**Alternatives considered**:
- Adding columns to Property model — rejected because it requires a Prisma migration for a simple string field. The JSON approach is consistent with existing pattern (amenities, bedTypes, etc.).

## R3: Availability Check via Hostaway API

**Decision**: Use Hostaway's `GET /v1/listings?availabilityDateStart=YYYY-MM-DD&availabilityDateEnd=YYYY-MM-DD` to check availability, rather than querying local reservations.

**Rationale**: Hostaway is the authoritative source across all booking channels. Local reservation data may have sync gaps (a booking made directly on Airbnb that hasn't been imported yet). The 3-second latency budget in SC-005 accommodates this API call.

**Implementation**:
- Add a new function `listAvailableListings(accountId, apiKey, startDate, endDate)` to `hostaway.service.ts`
- Filter results to same-city properties, exclude current property
- Match amenities locally (Hostaway API doesn't support amenity filtering)

**Alternatives considered**:
- Local reservation table query — faster (~10ms) but may miss external bookings, violating SC-002 (90% accuracy target).
- Hybrid (local first, verify top matches via API) — adds complexity without clear benefit given the 3s budget.

## R4: Amenity Matching Strategy

**Decision**: Use string-based semantic matching against `customKnowledgeBase.amenities` (CSV string). The AI extracts the amenity keyword from the guest message; the tool handler does case-insensitive substring matching with common synonym mapping.

**Rationale**: Amenities are stored as human-readable CSV strings like "WiFi, Kitchen, Pool, AC, Parking". Exact-match would miss "swimming pool" vs "pool" or "Wi-Fi" vs "WiFi". A small synonym map handles common variations without needing embeddings.

**Synonym examples**:
- "pool" → matches "pool", "swimming pool", "outdoor pool", "indoor pool"
- "wifi" → matches "wifi", "wi-fi", "internet", "wireless"
- "parking" → matches "parking", "garage", "car park"
- "gym" → matches "gym", "fitness", "fitness center", "workout"

**Alternatives considered**:
- Embedding-based amenity matching — overkill for 20-30 common amenity terms. String matching with synonyms is simpler and deterministic.

## R5: Channel-Aware Link Selection

**Decision**: Select the booking link based on the guest's reservation channel. The `channel` field on the Reservation model (enum: AIRBNB | BOOKING | DIRECT | OTHER | WHATSAPP) determines which URL to return.

**Mapping**:
- AIRBNB → `customKnowledgeBase.airbnbListingUrl`
- BOOKING → `customKnowledgeBase.vrboListingUrl` (Booking.com URL if available, fallback to booking engine)
- DIRECT / WHATSAPP / OTHER → `customKnowledgeBase.bookingEngineUrl`
- Fallback: if channel-specific URL is missing, use booking engine URL. If that's also missing, omit link and say "contact the team for details."

**Rationale**: Airbnb TOS prohibits directing guests to competitor platforms. Using channel-matched links prevents compliance violations.

## R6: Escalation Reuse for Property Switch

**Decision**: Reuse the existing Task model for property-switch escalations. No schema changes needed.

**Task fields for a switch request**:
- `title`: `"property-switch-request"`
- `note`: `"Guest [Name] wants to switch from [Current Property] to [Target Property] for dates [checkIn]–[checkOut]. Reason: [guest's reason]. Guest channel: [Airbnb/Booking/etc]."`
- `urgency`: `"scheduled"` (not immediate — manager needs to coordinate)
- `source`: `"ai"`
- `conversationId`: linked to the guest's conversation

The existing `handleEscalation()` flow in `ai.service.ts` handles Task creation, deduplication (via task-manager), SSE broadcast, and AI_PRIVATE note — all reusable.

## R7: Tool Definition Design

**Decision**: Define a single `search_available_properties` tool for the initial implementation. Future tools can be added independently.

**Tool schema**:
```json
{
  "name": "search_available_properties",
  "description": "Search for alternative properties in the same city that match specific criteria and are available for the guest's dates. Use this when a guest asks about amenities or features their current property doesn't have, wants to switch properties, or expresses a preference for different property attributes.",
  "input_schema": {
    "type": "object",
    "properties": {
      "amenities": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Amenities or features the guest is looking for (e.g., ['pool', 'parking'])"
      },
      "min_capacity": {
        "type": "number",
        "description": "Minimum guest capacity needed (optional)"
      },
      "reason": {
        "type": "string",
        "description": "Brief reason for the search (for logging)"
      }
    },
    "required": ["amenities"]
  }
}
```

Guest dates, current property, and city are injected server-side from the reservation context — not passed by Claude (prevents hallucination of dates).

**Rationale**: A single tool keeps the initial implementation simple. The `reason` field aids observability (FR-015). Dates/city are NOT tool parameters because Claude might hallucinate them — the backend always uses the authoritative reservation data.
