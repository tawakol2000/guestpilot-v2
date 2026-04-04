# API Contract: Booking Alteration Endpoints

All endpoints are authenticated (JWT required) and scoped to the requesting tenant.  
Base path: `/api/reservations/:reservationId`

---

## GET /api/reservations/:reservationId/alteration

Returns the current alteration for a reservation, if one exists.

**Response 200 — alteration found:**
```json
{
  "alteration": {
    "id": "cuid",
    "hostawayAlterationId": "12345",
    "status": "PENDING",
    "originalCheckIn": "2026-05-10T14:00:00.000Z",
    "originalCheckOut": "2026-05-15T11:00:00.000Z",
    "originalGuestCount": 2,
    "proposedCheckIn": "2026-05-12T14:00:00.000Z",
    "proposedCheckOut": "2026-05-17T11:00:00.000Z",
    "proposedGuestCount": 3,
    "fetchError": null,
    "createdAt": "2026-04-04T10:00:00.000Z"
  }
}
```

**Response 200 — no alteration:**
```json
{ "alteration": null }
```

**Response 200 — fetch failed (alteration message detected but details unavailable):**
```json
{
  "alteration": {
    "id": "cuid",
    "status": "PENDING",
    "fetchError": "Unable to retrieve alteration details from Hostaway",
    "originalCheckIn": null,
    "originalCheckOut": null,
    "originalGuestCount": null,
    "proposedCheckIn": null,
    "proposedCheckOut": null,
    "proposedGuestCount": null,
    "createdAt": "2026-04-04T10:00:00.000Z"
  }
}
```

---

## POST /api/reservations/:reservationId/alteration/accept

Accepts the pending alteration. Requires a valid Hostaway dashboard connection.

**Request body**: empty  
**Auth**: tenant JWT (header) + Hostaway dashboard JWT (stored on tenant record)

**Response 200 — success:**
```json
{
  "success": true,
  "action": "accept",
  "reservationId": "hostawayReservationId"
}
```

**Response 400 — no pending alteration:**
```json
{ "success": false, "error": "No pending alteration found for this reservation" }
```

**Response 403 — dashboard not connected:**
```json
{ "success": false, "error": "Hostaway dashboard not connected", "action": "reconnect" }
```

**Response 403 — dashboard token expired:**
```json
{ "success": false, "error": "Hostaway dashboard connection expired", "action": "reconnect" }
```

**Response 409 — already actioned externally:**
```json
{ "success": false, "error": "This alteration may have already been actioned. Please refresh to see the latest status." }
```

**Response 502 — Hostaway API error:**
```json
{ "success": false, "error": "Hostaway API error" }
```

---

## POST /api/reservations/:reservationId/alteration/reject

Rejects the pending alteration.

**Request body**: empty  
**Auth**: same as accept

**Response 200 — success:**
```json
{
  "success": true,
  "action": "reject",
  "reservationId": "hostawayReservationId"
}
```

**Response 422 — channel does not support rejection:**
```json
{
  "success": false,
  "error": "Rejection is not supported for this channel via the API. Please reject directly on Airbnb/Booking.com."
}
```

All other error responses mirror the accept endpoint above.

---

## Notes on Placeholder Endpoints

The GuestPilot backend calls the Hostaway internal dashboard API (`platform.hostaway.com`) with the `jwt` header. The exact accept/reject endpoint paths are placeholders and must be confirmed before launch by intercepting network traffic on the Hostaway dashboard with a real pending alteration.

Current placeholders:
- Accept: `PUT /reservations/{hostawayReservationId}/alterations/{alterationId}/accept`
- Reject: `PUT /reservations/{hostawayReservationId}/alterations/{alterationId}/decline`
- Fetch: `GET /reservations/{hostawayReservationId}/alterations` ← confirmed working
