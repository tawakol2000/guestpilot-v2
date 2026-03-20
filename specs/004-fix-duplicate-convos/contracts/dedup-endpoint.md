# Contract: Deduplication Endpoint

**Route**: `POST /api/knowledge/dedup-conversations`
**Auth**: Required (JWT — tenant-scoped)
**Purpose**: One-time cleanup of duplicate conversations for the authenticated tenant. Idempotent — safe to call multiple times.

---

## Request

```
POST /api/knowledge/dedup-conversations
Authorization: Bearer <token>
Content-Type: application/json

{} (empty body — no parameters)
```

---

## Response: 200 OK

```json
{
  "duplicatesFound": 3,
  "conversationsRemoved": 3,
  "details": [
    {
      "reservationId": "clxxx1",
      "winnerId": "clyyy1",
      "removedIds": ["clzzz1"],
      "winnerMessageCount": 12,
      "removedMessageCounts": [0]
    },
    {
      "reservationId": "clxxx2",
      "winnerId": "clyyy2",
      "removedIds": ["clzzz2"],
      "winnerMessageCount": 5,
      "removedMessageCounts": [0]
    },
    {
      "reservationId": "clxxx3",
      "winnerId": "clyyy3",
      "removedIds": ["clzzz3"],
      "winnerMessageCount": 0,
      "removedMessageCounts": [0]
    }
  ]
}
```

## Response: 200 OK (no duplicates found)

```json
{
  "duplicatesFound": 0,
  "conversationsRemoved": 0,
  "details": []
}
```

---

## Behaviour

1. Finds all `(tenantId, reservationId)` pairs with more than one conversation for the authenticated tenant.
2. For each duplicate set, selects winner by: most messages → most recent `createdAt`.
3. Cancels any `PendingAiReply` records on the conversations to be removed.
4. Deletes the non-winner conversations (cascades to their related records).
5. Returns a summary report.

**Tenant isolation**: Only operates on the authenticated tenant's data. Never touches other tenants' conversations.

**Idempotent**: Calling this endpoint when no duplicates exist returns `duplicatesFound: 0` with no side effects.

---

## Error Responses

| Status | Condition |
|--------|-----------|
| 401 | Missing or invalid JWT |
| 500 | Unexpected database error (logged server-side) |
