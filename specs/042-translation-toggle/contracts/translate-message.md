# Contract — `POST /api/messages/:messageId/translate`

**Purpose**: Given an inbound guest message, return its English translation. Computes + persists on first call; serves from cache (`Message.contentTranslationEn`) on subsequent calls. This is the only endpoint the frontend calls for inbound translation.

## Route

- **Method**: `POST`
- **Path**: `/api/messages/:messageId/translate`
- **Auth**: JWT (existing auth middleware). Request MUST carry a valid tenant-scoped JWT.
- **Route file**: `backend/src/routes/messages.ts` (new if missing; otherwise appended).

## Path parameters

| Name | Type | Constraints |
|---|---|---|
| `messageId` | `cuid` | MUST refer to a Message owned by the authenticated tenant. |

## Request body

None. The controller reads the message's `content` server-side; the client never sends text over the wire.

```json
{}
```

## Responses

### 200 OK — translation returned (from cache or freshly computed)

```json
{
  "messageId": "clz9a7xk00001abcdwxyz",
  "translated": "How far is the apartment from the metro station?",
  "cached": true,
  "sourceLanguage": "es"
}
```

| Field | Type | Notes |
|---|---|---|
| `messageId` | `string` | Echoed for client bookkeeping. |
| `translated` | `string` | The English translation. If the source is already English, this will equal `message.content`; the client is responsible for suppressing the redundant block (FR-006). |
| `cached` | `boolean` | `true` = served from `contentTranslationEn`; `false` = freshly computed and persisted this call. |
| `sourceLanguage` | `string?` | Optional — the language code the provider detected (e.g., `"es"`, `"ar"`). Omitted if the provider does not surface it. |

### 400 Bad Request — message not translatable

Returned when the message exists but is not eligible (e.g., `role !== 'GUEST'`, or `content` is empty).

```json
{ "error": "Only inbound guest messages can be translated" }
```

### 404 Not Found — message does not exist or belongs to another tenant

Deliberately generic to avoid leaking existence of other tenants' messages (Constitution §II).

```json
{ "error": "Message not found" }
```

### 502 Bad Gateway — translation provider failed

Provider unreachable, returned a non-2xx, or returned an empty/unparseable response. Client renders the inline "Translation unavailable — retry" chip for this message (FR-008).

```json
{ "error": "Translation provider unavailable" }
```

### 500 Internal Server Error

Unexpected exception in the controller. Logged.

```json
{ "error": "Internal server error" }
```

## Behavior

1. Resolve `Message` by `{ id: messageId, tenantId }`. If missing → 404.
2. If `message.role !== 'GUEST'` → 400.
3. If `!message.content?.trim()` → 400.
4. If `message.contentTranslationEn` is non-null → return `{ translated: message.contentTranslationEn, cached: true, messageId }` with HTTP 200.
5. Else call `translationService.translate(message.content, { targetLang: 'en' })`.
   - On provider error → log, return 502.
   - On success: persist via `prisma.message.update({ where: { id: messageId }, data: { contentTranslationEn: translated } })`. If this write fails (e.g., transient DB issue), still return 200 with the translated text — log the write failure (§I graceful degradation: don't block the user on best-effort persistence).
6. Return `{ translated, cached: false, sourceLanguage, messageId }`.

## Observability

One structured log line per call:

```
[Messages] translate messageId=<id> tenantId=<id> ms=<duration> cached=<true|false> ok=<true|false> [err=<message>]
```

No `AiApiLog` entry — this is not an AI call (see Constitution §VI decision in plan.md).

## Removed route

The current ad-hoc route is **removed** as part of this feature:

```
POST /api/conversations/:id/translate-message
body: { content: string }
returns: { translated: string }
```

It is replaced entirely by `POST /api/messages/:messageId/translate`. The client helper `apiSendThroughAI` in `frontend/lib/api.ts` (oddly named; it actually calls that translate route) is renamed to `apiTranslateMessage` and updated to the new path.

## Client usage pattern

Called from the inbox whenever the Translate toggle is active AND:
- The conversation first loads with toggle on: one request per inbound `GUEST` message whose `contentTranslationEn` is `null`, capped at 4 in-flight (research §Decision 6).
- A new inbound message arrives via Socket.IO while toggle is on: one request immediately for that message.
- The user clicks "retry" on a previously-failed translation: one request for that message.

## Out of scope

- **Batch translation endpoint** (`POST /api/messages/translate` with `ids: string[]`): deferred per research §Decision 6.
- **Translations into target languages other than English**: this endpoint hardcodes `targetLang: 'en'` per FR-004 and the spec's single-target scope.
- **Translating outbound (HOST / AI) messages for the manager's reference**: explicitly excluded by the spec's Edge Cases section ("outbound host messages keep their sent form").
