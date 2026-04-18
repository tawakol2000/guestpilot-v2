# Contract — Task Actions API

All routes are mounted under `/api/tasks`. Authentication: JWT via existing `authMiddleware`. Tenant scope: every query uses `{ id, tenantId }` to prevent cross-tenant access (Constitution §II).

---

## `GET /api/tasks/:taskId/preview`

Returns the rendered approval or rejection body for the task, with template variables substituted. Used by the Actions card to pre-fill the editable preview textarea when the manager clicks Accept or Reject.

### Query parameters

| Name | Type | Required | Constraints |
|---|---|---|---|
| `decision` | `'approve' \| 'reject'` | yes | Which template to render. |

### Responses

**200 OK**:
```json
{
  "body": "Hi Noah — confirmed, you can check out at 1:00 PM. Safe travels!"
}
```

**400**: missing or invalid `decision`.
**404**: task not found, or belongs to another tenant.
**409**: task is already resolved — no preview served.
**500**: template-render failure (logged).

---

## `POST /api/tasks/:taskId/accept`

Resolves a task in the affirmative: sends the supplied message body to the guest, writes the reservation scheduled-time override (for time-request tasks), marks the task resolved, and logs the action. Idempotent: if the task is already resolved, returns 409 without side effects.

### Request body

```json
{
  "body": "Hi Noah — confirmed, you can check out at 1:00 PM. Safe travels!"
}
```

| Field | Type | Required | Constraints |
|---|---|---|---|
| `body` | `string` | yes | Non-empty. Max 4000 chars. The delivered message; may differ from the preview text if the manager edited. |

### Behavior

1. Resolve task via `{ id: taskId, tenantId }`. If missing → 404. If `status='resolved'` → 409.
2. Validate the task is of a supported type (`late_checkout_request`, `early_checkin_request`, or any newly-registered action-card type). Other task types use the existing resolve flow; 400 for unsupported types here.
3. Send `body` to the guest via Hostaway using the conversation's active channel.
   - On failure: return 502, no state changes.
4. Record the delivered message in the conversation thread (Message row, role=`HOST`, via existing send logic).
5. For time-request types: write `Reservation.scheduledCheckInAt` or `scheduledCheckOutAt` from `task.metadata.requestedTime`. One Prisma update.
6. Mark the task resolved (`status='resolved'`, `completedAt=now()`).
7. Append a `TaskActionLog` row with `action='accepted'`, `actorKind='manager'`, `deliveredBody=body`, `requestedTime=task.metadata.requestedTime`, `appliedTime=task.metadata.requestedTime`.
8. Broadcast two Socket.IO events to the tenant room:
   - `task_resolved` `{ taskId, conversationId, action: 'accepted' }`
   - `reservation_scheduled_updated` `{ reservationId, conversationId, scheduledCheckInAt, scheduledCheckOutAt }`
9. Return the updated reservation row so the client can merge it into local state without a refetch.

### Responses

**200 OK**:
```json
{
  "message": {
    "id": "cmz…",
    "content": "Hi Noah — confirmed…",
    "sentAt": "2026-04-19T09:15:22.000Z",
    "deliveryStatus": "sent"
  },
  "reservation": {
    "id": "cmz…",
    "scheduledCheckInAt": null,
    "scheduledCheckOutAt": "13:00"
  }
}
```

**400**: empty body / oversize body / unsupported task type for this endpoint.
**404**: task not found or other-tenant.
**409**: task already resolved.
**502**: Hostaway send failed — no state changes.
**500**: internal error — no state changes.

---

## `POST /api/tasks/:taskId/reject`

Resolves a task negatively: sends the supplied rejection body to the guest, marks the task resolved, does NOT change any reservation data, and logs the action.

### Request body

```json
{
  "body": "Hi Noah — unfortunately we're unable to accommodate a late checkout this time…"
}
```

### Behavior

1. Same validation as `accept` (existence, tenant, not resolved, supported type).
2. Send `body` to the guest via Hostaway.
   - On failure: return 502, no state changes.
3. Record message in thread.
4. Mark task resolved.
5. Append `TaskActionLog` with `action='rejected'`, `actorKind='manager'`, `deliveredBody=body`, `requestedTime=task.metadata.requestedTime`, `appliedTime=null`.
6. Broadcast `task_resolved` `{ taskId, conversationId, action: 'rejected' }`.

### Responses

**200 OK**:
```json
{
  "message": {
    "id": "cmz…",
    "content": "Hi Noah — unfortunately…",
    "sentAt": "2026-04-19T09:16:05.000Z",
    "deliveryStatus": "sent"
  }
}
```

Error responses identical to `accept`.

---

## Idempotency

- Both endpoints are safe under retry: a client that submits `accept` twice on the same resolved task gets `409` on the second call — no duplicate reservation update, no duplicate message sent.
- The controller uses the task's `status='resolved'` transition as the idempotency lock.

## Rate limiting

Both endpoints use the existing `messageSendLimiter` middleware (the same one applied to `POST /api/conversations/:id/messages`). A runaway client that spam-clicks Accept is rate-limited before hitting Hostaway.

## Observability

One structured log line per call:
```
[TaskActions] accept taskId=<id> tenantId=<id> type=<type> ms=<dur> ok=<bool>
[TaskActions] reject taskId=<id> tenantId=<id> type=<type> ms=<dur> ok=<bool>
```

Plus the `TaskActionLog` row is the durable audit record.
