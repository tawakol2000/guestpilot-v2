# Data Model: Calendar View

**Feature**: 028-calendar-view | **Date**: 2026-04-02

## Schema Changes

### Modified: Reservation Model

Add financial fields to the existing Reservation model:

```
Reservation (MODIFIED — add fields)
├── totalPrice        Decimal?     Total reservation price from booking platform
├── hostPayout        Decimal?     Host payout amount (after platform fees)
├── cleaningFee       Decimal?     Cleaning fee component
├── currency          String?      ISO 4217 currency code (e.g., "EUR", "USD")
```

**Notes**:
- All new fields are nullable (existing reservations won't have them until next sync)
- `totalPrice` is the gross booking amount (what the guest pays)
- `hostPayout` is the net amount (what the host receives after platform commission)
- `cleaningFee` is separated because it's not a per-night charge
- `currency` is per-reservation (not per-tenant) because Hostaway supports multi-currency
- No new indexes needed — financial fields are display-only, not queried

### Unchanged: Property Model

Used as-is. The `hostawayListingId` field is the key for fetching calendar pricing from Hostaway.

### Unchanged: Guest Model

Used as-is. The `name` field provides the guest name displayed on reservation bars.

## Entity Relationships (Calendar Context)

```
Tenant (1) ──→ (N) Property
Property (1) ──→ (N) Reservation
Reservation (N) ──→ (1) Guest
```

The calendar view queries:
1. All Properties for a tenant (sidebar rows)
2. All Reservations overlapping the visible date range (bars)
3. Guest name for each Reservation (bar label + tooltip)
4. Calendar pricing per Property from Hostaway API (empty cell prices)

## Derived Data (Not Stored)

### Calendar Day Pricing

Fetched on-demand from Hostaway Calendar API, cached in-memory (15min TTL).

```
CalendarDayPrice (NOT A MODEL — in-memory only)
├── date              String       YYYY-MM-DD
├── price             Number       Nightly price in property's currency
├── available         Boolean      Whether the date is available for booking
├── minimumStay       Number?      Minimum stay requirement for this date
├── currency          String       ISO 4217 currency code
```

### Occupancy Metrics

Calculated client-side from reservation data for the visible date range.

```
PropertyOccupancy (NOT A MODEL — computed in frontend)
├── propertyId        String
├── totalNights       Number       Total nights in visible range
├── bookedNights      Number       Nights with active reservations
├── occupancyPercent  Number       (bookedNights / totalNights) * 100
├── activeBookings    Number       Count of overlapping reservations
```

## Sync Mapping Updates

### reservationSync.job.ts — New Field Mappings

| Hostaway Field | Prisma Field | Type | Default |
|----------------|-------------|------|---------|
| `res.totalPrice` | `totalPrice` | Decimal | null |
| `res.hostPayout` | `hostPayout` | Decimal | null |
| `res.cleaningFee` | `cleaningFee` | Decimal | null |
| `res.currency` | `currency` | String | null |

These fields should be included in both the `create` and `update` paths of the upsert operation.

## Validation Rules

- `totalPrice` must be >= 0 when present
- `currency` must be a valid ISO 4217 code when present (3 uppercase letters)
- `cleaningFee` must be >= 0 when present
- Calendar pricing date range must not exceed 6 months (API constraint)
