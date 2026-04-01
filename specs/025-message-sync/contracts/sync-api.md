# API Contract: Conversation Sync

## POST /api/conversations/:id/sync

Triggers an on-demand message sync for a specific conversation. Non-blocking — returns immediately while sync happens in the background. Synced messages are broadcast via SSE.

**Auth**: Required (JWT — `tenantId` extracted from token)

### Request

```
POST /api/conversations/:id/sync
Authorization: Bearer <JWT>
```

No request body.

### Response

**200 OK** — Sync completed successfully

```json
{
  "ok": true,
  "newMessages": 3,
  "backfilled": 0,
  "syncedAt": "2026-04-01T14:30:00.000Z"
}
```

**200 OK** — Sync skipped (recently synced)

```json
{
  "ok": true,
  "skipped": true,
  "reason": "recently-synced",
  "lastSyncedAt": "2026-04-01T14:29:45.000Z"
}
```

**404 Not Found** — Conversation not found or not owned by tenant

```json
{
  "error": "Conversation not found"
}
```

**500 Internal Server Error** — Sync failed

```json
{
  "error": "Sync failed"
}
```

### Side Effects

- New messages inserted into the database
- SSE `message` events broadcast for each new message
- `conversation.lastSyncedAt` updated
- If host-already-responded detected: pending AI reply cancelled, SSE `ai_typing_clear` broadcast

### Notes

- The 30-second cooldown (FR-008) is bypassed when the sync indicator is clicked (FR-014). The endpoint should accept an optional `force` query parameter to skip cooldown: `POST /api/conversations/:id/sync?force=true`
- Rate limiting is handled at the service level — the endpoint itself does not rate limit

---

## SSE Events (Existing — Reused)

### Event: `message`

Broadcast for each newly synced message. Same shape as webhook-originated messages.

```json
{
  "conversationId": "clxyz123",
  "message": {
    "id": "clxyz456",
    "role": "HOST",
    "content": "Hi! Yes, early check-in at 1pm is fine.",
    "sentAt": "2026-04-01T10:30:00.000Z",
    "channel": "AIRBNB",
    "imageUrls": []
  },
  "lastMessageRole": "HOST",
  "lastMessageAt": "2026-04-01T10:30:00.000Z"
}
```

### Event: `ai_typing_clear`

Broadcast when sync detects manager already responded and cancels pending AI reply.

```json
{
  "conversationId": "clxyz123"
}
```
