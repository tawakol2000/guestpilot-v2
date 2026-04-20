# API Contracts: Calendar View

**Feature**: 028-calendar-view | **Date**: 2026-04-02

## Endpoint 1: GET /api/reservations

Bulk fetch reservations for a tenant within a date range. Returns reservation data with guest and property references for calendar rendering.

### Request

```
GET /api/reservations?startDate=2026-04-01&endDate=2026-04-30
Authorization: Bearer <JWT>
```

**Query Parameters**:

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `startDate` | string (YYYY-MM-DD) | Yes | Range start (inclusive) |
| `endDate` | string (YYYY-MM-DD) | Yes | Range end (inclusive) |
| `propertyId` | string | No | Filter to a single property |
| `status` | string | No | Comma-separated statuses (default: INQUIRY,PENDING,CONFIRMED,CHECKED_IN) |

### Response (200)

```json
{
  "reservations": [
    {
      "id": "clx1abc...",
      "propertyId": "clx2def...",
      "hostawayReservationId": "12345",
      "checkIn": "2026-04-05T00:00:00.000Z",
      "checkOut": "2026-04-10T00:00:00.000Z",
      "guestCount": 2,
      "channel": "AIRBNB",
      "status": "CONFIRMED",
      "totalPrice": 650.00,
      "hostPayout": 585.00,
      "cleaningFee": 50.00,
      "currency": "EUR",
      "guest": {
        "id": "clx3ghi...",
        "name": "Ahmed Al-Rashid"
      },
      "conversationId": "clx4jkl..."
    }
  ]
}
```

**Notes**:
- Range overlap query: `checkIn <= endDate AND checkOut >= startDate`
- Excludes CANCELLED and CHECKED_OUT by default (unless explicitly requested via `status`)
- `conversationId` is the primary conversation for click-to-navigate (nullable if no conversation exists)
- Results sorted by `checkIn ASC`

### Error Responses

| Code | Condition |
|------|-----------|
| 400 | Missing startDate or endDate, invalid date format, startDate > endDate |
| 401 | Invalid or missing JWT |

---

## Endpoint 2: GET /api/properties/:id/calendar

Fetch per-night pricing and availability for a property from Hostaway. Cached in-memory for 15 minutes.

### Request

```
GET /api/properties/clx2def.../calendar?startDate=2026-04-01&endDate=2026-04-30
Authorization: Bearer <JWT>
```

**Query Parameters**:

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `startDate` | string (YYYY-MM-DD) | Yes | Range start |
| `endDate` | string (YYYY-MM-DD) | Yes | Range end |

### Response (200)

```json
{
  "propertyId": "clx2def...",
  "currency": "EUR",
  "days": [
    {
      "date": "2026-04-01",
      "price": 95.00,
      "available": true,
      "minimumStay": 2
    },
    {
      "date": "2026-04-02",
      "price": 95.00,
      "available": true,
      "minimumStay": 2
    },
    {
      "date": "2026-04-05",
      "price": null,
      "available": false,
      "minimumStay": null
    }
  ],
  "cached": true,
  "cachedAt": "2026-04-02T14:30:00.000Z"
}
```

**Notes**:
- `price: null` + `available: false` for booked dates (frontend should not show price for these since reservation bar covers them)
- `cached: true` indicates result came from cache (not a fresh Hostaway call)
- Date range must not exceed 6 months

### Error Responses

| Code | Condition |
|------|-----------|
| 400 | Missing dates, invalid format, range > 6 months |
| 401 | Invalid or missing JWT |
| 404 | Property not found or doesn't belong to tenant |
| 502 | Hostaway API unavailable (return partial/empty with error flag) |

---

## Endpoint 3: GET /api/properties/calendar-bulk

Fetch calendar pricing for ALL tenant properties in one request. Backend fetches from Hostaway in parallel (concurrency limit: 5) and returns combined results.

### Request

```
GET /api/properties/calendar-bulk?startDate=2026-04-01&endDate=2026-04-14
Authorization: Bearer <JWT>
```

### Response (200)

```json
{
  "properties": [
    {
      "propertyId": "clx2def...",
      "currency": "EUR",
      "days": [
        { "date": "2026-04-01", "price": 95.00, "available": true },
        { "date": "2026-04-02", "price": 95.00, "available": true }
      ]
    },
    {
      "propertyId": "clx5mno...",
      "currency": "EUR",
      "days": [
        { "date": "2026-04-01", "price": 120.00, "available": true }
      ]
    }
  ],
  "errors": [
    {
      "propertyId": "clx6pqr...",
      "error": "Hostaway API timeout"
    }
  ]
}
```

**Notes**:
- Partial success: if some properties fail, return successful ones + errors array
- Frontend shows "---" for properties in the errors array
- Each property result is individually cached (15min TTL)
- This is the primary endpoint the calendar page calls on load and navigation
