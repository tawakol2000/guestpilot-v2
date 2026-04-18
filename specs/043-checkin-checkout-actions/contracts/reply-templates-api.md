# Contract — Reply Templates API

Per-tenant CRUD for `AutomatedReplyTemplate`. Used by the new Settings > Automated Replies UI. Mounted under `/api/tenant-config`. Auth: JWT via existing middleware. Tenant scope: every query filters by JWT's `tenantId`.

---

## `GET /api/tenant-config/reply-templates`

Returns every configured template for the authenticated tenant, merged with the system defaults. Every `(escalationType, decision)` pair the system supports is returned — whether the tenant has edited it or is using the default.

### Responses

**200 OK**:
```json
{
  "templates": [
    {
      "escalationType": "late_checkout_request",
      "decision": "approve",
      "body": "Hi {GUEST_FIRST_NAME} — confirmed, you can check out at {REQUESTED_TIME}. Safe travels!",
      "isDefault": true,
      "updatedAt": null
    },
    {
      "escalationType": "late_checkout_request",
      "decision": "reject",
      "body": "Our custom tenant-edited rejection copy…",
      "isDefault": false,
      "updatedAt": "2026-04-18T14:22:10.000Z"
    },
    {
      "escalationType": "early_checkin_request",
      "decision": "approve",
      "body": "Hi {GUEST_FIRST_NAME} — confirmed, you can check in from {REQUESTED_TIME}. Looking forward to hosting you!",
      "isDefault": true,
      "updatedAt": null
    },
    {
      "escalationType": "early_checkin_request",
      "decision": "reject",
      "body": "Hi {GUEST_FIRST_NAME} — unfortunately we can't offer an earlier check-in this time. Standard check-in is {CHECK_IN_TIME}. Feel free to drop off luggage if helpful.",
      "isDefault": true,
      "updatedAt": null
    }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `escalationType` | `string` | Current supported values: `late_checkout_request`, `early_checkin_request`. Expanded as new escalation types register. |
| `decision` | `'approve' \| 'reject'` | |
| `body` | `string` | The current body — either the tenant's override or the system default. |
| `isDefault` | `boolean` | `true` = tenant has not saved a row; body is the system default. `false` = tenant has saved a row. |
| `updatedAt` | `string \| null` | Timestamp of the tenant's last save. Null when `isDefault=true`. |

---

## `PUT /api/tenant-config/reply-templates/:escalationType/:decision`

Upserts the template row for the given pair. Creates the row if absent, updates if present.

### Path parameters

| Name | Type | Constraints |
|---|---|---|
| `escalationType` | `string` | MUST be a registered escalation type. 400 if unknown. |
| `decision` | `'approve' \| 'reject'` | 400 if anything else. |

### Request body

```json
{
  "body": "Our new approval copy for {GUEST_FIRST_NAME}, valid from {REQUESTED_TIME}."
}
```

| Field | Type | Required | Constraints |
|---|---|---|---|
| `body` | `string` | yes | 1–4000 chars. Not validated for variable names — unknown variables silently render as empty at send time. |

### Responses

**200 OK**:
```json
{
  "escalationType": "late_checkout_request",
  "decision": "approve",
  "body": "Our new approval copy for {GUEST_FIRST_NAME}, valid from {REQUESTED_TIME}.",
  "isDefault": false,
  "updatedAt": "2026-04-19T14:22:10.000Z"
}
```

**400**: missing/invalid body, unknown `escalationType`, unknown `decision`.
**500**: internal error.

---

## `DELETE /api/tenant-config/reply-templates/:escalationType/:decision`

Reverts a tenant's edited template back to the system default by deleting their row. Safe if no row exists (returns 204 either way).

### Responses

**204 No Content** on success. No body.

---

## Rendering (internal; not a public endpoint)

The server-side render helper used by `GET /api/tasks/:taskId/preview` and both `/accept` + `/reject` endpoints:

```
renderTemplate(tenantId, escalationType, decision, context) → string
  1. Look up AutomatedReplyTemplate row for (tenantId, escalationType, decision).
     Fall back to system default from config/reply-template-defaults.ts if absent.
  2. Substitute variables:
       {GUEST_FIRST_NAME}  → conversation.guest.name split on space [0]
       {REQUESTED_TIME}    → friendly form of context.requestedTime (HH:MM → "1:00 PM")
       {PROPERTY_NAME}     → property.name
       {CHECK_IN_TIME}     → template-variable.service.resolveCheckInTime(reservation, property)
       {CHECK_OUT_TIME}    → template-variable.service.resolveCheckOutTime(reservation, property)
     Unknown variables  → empty string (FR-017).
  3. Return the rendered body.
```

## Observability

No structured per-call log required — Settings-page edits are low-volume and the existing Express request log is sufficient. The `updatedAt` on each row is the audit trail.
