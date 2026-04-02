# API Contracts: 029 Inquiry Accept/Reject

## Backend Endpoints

### 1. Connect Dashboard — Callback

```
GET /api/hostaway-connect/callback?token=<jwt>
```

Called by the bookmarklet redirect. Validates and stores the dashboard JWT.

> **Note:** GET is used intentionally because this endpoint is a bookmarklet redirect target. The browser navigates here via `window.location`, which only supports GET. The side effect (storing the token) is acceptable for this redirect-based flow.

**Query Parameters:**
- `token` (required): The dashboard JWT extracted from localStorage

**Response (redirect):**
- Success: `302` → `/settings?hostaway=connected`
- Invalid token: `302` → `/settings?hostaway=error&reason=invalid_token`
- Expired token: `302` → `/settings?hostaway=error&reason=token_expired`

---

### 2. Dashboard Connection Status

```
GET /api/hostaway-connect/status
```

Returns current dashboard connection status for the authenticated tenant.

**Headers:** `Authorization: Bearer <guestpilot-jwt>`

**Response 200:**
```json
{
  "connected": true,
  "connectedBy": "ab.tawakol@gmail.com",
  "issuedAt": "2026-04-02T21:41:51Z",
  "expiresAt": "2026-07-02T00:41:51Z",
  "daysRemaining": 87,
  "warning": false
}
```

**Response 200 (not connected):**
```json
{
  "connected": false,
  "connectedBy": null,
  "issuedAt": null,
  "expiresAt": null,
  "daysRemaining": 0,
  "warning": false
}
```

---

### 3. Disconnect Dashboard

```
DELETE /api/hostaway-connect
```

Removes the stored dashboard JWT.

**Headers:** `Authorization: Bearer <guestpilot-jwt>`

**Response 200:**
```json
{ "success": true }
```

---

### 4. Approve Reservation

```
POST /api/reservations/:reservationId/approve
```

Approves an inquiry or pending reservation via Hostaway dashboard API.

**Headers:** `Authorization: Bearer <guestpilot-jwt>`

**Response 200:**
```json
{
  "success": true,
  "action": "approve",
  "reservationId": 57205036,
  "previousStatus": "inquiry",
  "newStatus": "inquiryPreapproved"
}
```

**Response 400 (not applicable):**
```json
{
  "success": false,
  "error": "Reservation status 'confirmed' cannot be approved"
}
```

**Response 403 (not connected):**
```json
{
  "success": false,
  "error": "Hostaway dashboard not connected",
  "action": "reconnect"
}
```

**Response 502 (Hostaway error):**
```json
{
  "success": false,
  "error": "Hostaway API returned an error",
  "details": "Request failed with status 400"
}
```

---

### 5. Reject Reservation

```
POST /api/reservations/:reservationId/reject
```

Rejects/declines an inquiry or pending reservation.

**Headers:** `Authorization: Bearer <guestpilot-jwt>`

**Response 200:**
```json
{
  "success": true,
  "action": "reject",
  "reservationId": 57205036,
  "previousStatus": "inquiry",
  "newStatus": "inquiryDenied"
}
```

**Response 422 (channel limitation):**
```json
{
  "success": false,
  "error": "Rejection is not supported for Airbnb reservations through this integration",
  "suggestion": "Please decline this inquiry directly on the Airbnb app or website"
}
```

---

### 6. Cancel Reservation

```
POST /api/reservations/:reservationId/cancel
```

Cancels a reservation.

**Headers:** `Authorization: Bearer <guestpilot-jwt>`

**Response 200:**
```json
{
  "success": true,
  "action": "cancel",
  "reservationId": 57206447,
  "previousStatus": "confirmed",
  "newStatus": "cancelled"
}
```

---

### 7. Get Last Action for Reservation

```
GET /api/reservations/:reservationId/last-action
```

Returns the most recent inquiry action for display.

**Headers:** `Authorization: Bearer <guestpilot-jwt>`

**Response 200:**
```json
{
  "action": "approve",
  "initiatedBy": "Ahmed",
  "createdAt": "2026-04-03T10:30:00Z",
  "status": "success"
}
```

**Response 200 (no action):**
```json
null
```

## Bookmarklet

JavaScript executed in the context of `dashboard.hostaway.com`:

```
javascript:void((function(){
  var t=localStorage.getItem('jwt');
  if(!t){alert('Not logged in to Hostaway');return;}
  window.location='<GUESTPILOT_URL>/api/hostaway-connect/callback?token='+encodeURIComponent(t);
})())
```

The `<GUESTPILOT_URL>` is dynamically set based on the environment (from `CORS_ORIGINS` or `NEXT_PUBLIC_API_URL`).
