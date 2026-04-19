# Contract: Doc-Handoff Tenant Settings API

All routes are mounted under `/api/tenant-config/doc-handoff` on the existing `tenantConfigRouter` (`backend/src/routes/tenant-config.ts`). All routes require the auth middleware — `tenantId` resolves from the JWT.

---

## `GET /api/tenant-config/doc-handoff`

**Request:** none.

**200 response:**
```json
{
  "enabled": false,
  "managerRecipient": "+971501234567",
  "securityRecipient": "+971509999999",
  "reminderTime": "22:00",
  "handoffTime": "10:00"
}
```

Null fields serialize as `null`, not omitted, so the frontend can detect "explicitly empty" vs missing.

---

## `PUT /api/tenant-config/doc-handoff`

**Request body (all fields optional, only provided fields change):**
```json
{
  "enabled": true,
  "managerRecipient": "+971501234567",
  "securityRecipient": "+971509999999",
  "reminderTime": "22:00",
  "handoffTime": "10:00"
}
```

**Validation:**
| Field | Rule | Error `field` |
|---|---|---|
| `managerRecipient` | `null` OR `/^\+[1-9]\d{7,14}$/` OR contains `@g.us` | `managerRecipient` |
| `securityRecipient` | same as above | `securityRecipient` |
| `reminderTime` | `/^([01][0-9]\|2[0-3]):[0-5][0-9]$/` | `reminderTime` |
| `handoffTime` | same | `handoffTime` |
| `enabled` | boolean | `enabled` |

**200 response:** full settings object (same as GET).

**400 response:**
```json
{ "error": "Invalid manager recipient", "field": "managerRecipient", "message": "Invalid manager recipient" }
```

Consistent with existing `/api/tenant-config` PUT error shape.

---

## `GET /api/tenant-config/doc-handoff/recent-sends`

Read-only audit list for the Settings UI.

**Query params (all optional):**
- `limit` — default 20, max 100.

**200 response:**
```json
{
  "items": [
    {
      "id": "cl...",
      "reservationId": "cl...",
      "messageType": "HANDOFF",
      "status": "SENT",
      "scheduledFireAt": "2026-04-19T07:00:00.000Z",
      "sentAt":          "2026-04-19T07:00:12.000Z",
      "recipientUsed":   "+971509999999",
      "messageBodyUsed": "103\n19/04 - 25/04",
      "imageUrlCount":   2,
      "lastError":       null,
      "providerMessageId": "12345"
    }
  ]
}
```

- `imageUrlCount` rather than the full URLs — the operator doesn't need to re-download images from this view and we avoid re-leaking them through an unnecessary endpoint.
- Ordering: `updatedAt desc` (covers both "recent sent" and "recent failed" naturally).
- Scoped by `tenantId` via the auth middleware — no cross-tenant leakage possible.

---

## Errors

| HTTP | When | Body |
|---|---|---|
| 401 | Missing/invalid JWT | `{ "error": "Unauthorized" }` (existing auth middleware) |
| 400 | Validation fail on PUT | `{ error, field, message }` |
| 500 | Unexpected | `{ "error": "Failed to ..." }` |

No 404 paths — settings always exist (null-filled on new tenants).
