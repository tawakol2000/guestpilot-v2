# Research: Calendar View

**Date**: 2026-04-02 | **Feature**: 028-calendar-view

## Decision 1: Reservation Financial Data Storage

**Decision**: Add `totalPrice`, `currency`, `hostPayout`, and `cleaningFee` fields to the Prisma Reservation model. Sync them from Hostaway during the existing reservation sync job.

**Rationale**: The Hostaway API already returns `totalPrice` and `currency` on every reservation response, but the sync job (`reservationSync.job.ts`) currently ignores them. Adding 4 Decimal/String fields to the Reservation model is trivial (non-destructive `prisma db push`), and the sync job already runs every 2 minutes. This avoids per-request Hostaway API calls for tooltip price data.

**Alternatives considered**:
- Fetch prices on-demand from Hostaway per reservation — adds latency and API rate limit risk for 50+ properties
- Store prices in the existing `screeningAnswers` JSON field — queryable but untyped, harder to use in aggregations
- Create a separate ReservationFinancial model — unnecessary complexity for 4 fields

## Decision 2: Calendar Pricing API Endpoint

**Decision**: Create a new `GET /api/properties/:id/calendar` endpoint that wraps the existing `hostawayService.getListingCalendar()` function. Cache results in-memory for 15 minutes per property+date-range.

**Rationale**: The `getListingCalendar` function already exists in `hostaway.service.ts` and fetches per-night pricing from `GET /v1/listings/{listingId}/calendar`. It returns an array of date objects with pricing, availability, and minimum stay data. The frontend needs this for empty cells. Caching avoids hitting Hostaway's API on every page navigation — calendar pricing rarely changes within 15 minutes.

**Alternatives considered**:
- Bulk fetch all properties in one API call — Hostaway doesn't support multi-listing calendar fetch
- Store calendar pricing in the database — adds schema complexity for data that changes daily; in-memory cache with TTL is simpler
- Proxy through a Redis cache — overkill for this; Redis is optional in this project

## Decision 3: Bulk Reservations Endpoint

**Decision**: Create a new `GET /api/reservations` endpoint that returns all reservations for a tenant within a date range, with guest and property data included. Filter by `checkIn <= endDate AND checkOut >= startDate` for range overlap.

**Rationale**: No bulk reservation endpoint exists. The current conversations endpoint returns denormalized reservation data but doesn't support date range filtering or include financial fields. A dedicated endpoint enables efficient calendar data loading with a single request (reservations + guest names + property mapping).

**Alternatives considered**:
- Extend the conversations endpoint — conversations have a different lifecycle from reservations; mixing concerns
- Create a dedicated `/api/calendar` endpoint that combines reservations + pricing — combines two data sources with different caching needs; better to keep them separate

## Decision 4: Frontend Calendar Component Architecture

**Decision**: Build a single `calendar-v5.tsx` component (matching existing naming: `inbox-v5.tsx`, `listings-v5.tsx`, etc.) with CSS Grid for the timeline layout. Use `position: sticky` for the sidebar and header. No external calendar library.

**Rationale**: The Gantt-style timeline grid is a specific layout that doesn't map well to standard calendar libraries (which are designed for month/week views, not multi-resource timelines). CSS Grid with `position: sticky` handles the frozen row/column pattern natively. The existing frontend uses no calendar libraries, and adding one for a custom Gantt layout would fight the library's opinions.

**Alternatives considered**:
- Use a library like FullCalendar's resource timeline — heavy dependency (100KB+), difficult to customize to match the Dribbble design aesthetic
- Use a virtualized grid library (e.g., react-window) — premature for ~50 rows × 30 columns; adds complexity without performance benefit at this scale
- Canvas-based rendering — maximum performance but no accessibility, no DOM interaction, no CSS styling

## Decision 5: Calendar Pricing Cache Strategy

**Decision**: Use an in-memory Map cache (same pattern as `tenant-config.service.ts` and `tool-definition.service.ts`) with a 15-minute TTL. Cache key: `${tenantId}:${propertyId}:${startDate}:${endDate}`.

**Rationale**: The project already uses this pattern for tenant config (5min TTL) and tool definitions (5min TTL). Calendar pricing changes infrequently (operators set prices days/weeks in advance), so 15 minutes is safe. The cache invalidates naturally as users navigate to different date ranges. No Redis dependency needed.

**Alternatives considered**:
- No caching — each page load fetches pricing for all properties from Hostaway; for 20 properties × 2 navigations = 40 API calls per minute per user
- Redis cache — adds a hard dependency; the project's Redis is optional (queue only)
- Database cache table — adds schema complexity for ephemeral data; in-memory is simpler and faster

## Decision 6: Hostaway API Rate Limit Mitigation

**Decision**: Fetch calendar pricing for all properties in parallel with a concurrency limit of 5 (using Promise pool). Combined with 15-minute caching, this keeps API usage well within Hostaway limits.

**Rationale**: Hostaway's API has undocumented rate limits but empirically handles ~60 requests/minute per account. For 20 properties, 5 concurrent requests complete in ~4 batches (< 2 seconds). With caching, this only happens once per 15 minutes. Sequential fetching would take 20× the time.

**Alternatives considered**:
- Fetch all properties sequentially — too slow (20 × 500ms = 10 seconds)
- Fetch all properties fully parallel — risks hitting rate limits for large portfolios (50 properties)
- Background sync job (pre-fetch daily) — adds complexity; on-demand with caching is simpler and more responsive to price changes
