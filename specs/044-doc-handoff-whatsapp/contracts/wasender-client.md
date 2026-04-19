# Contract: WAsender Client Service

`backend/src/services/wasender.service.ts` — internal-only, callable only by `doc-handoff.service.ts` (v1). Kept standalone so other features can reuse it later without extraction work.

---

## Env

| Var | Required? | Default |
|---|---|---|
| `WASENDER_API_KEY` | No (feature disables silently if missing) | — |
| `WASENDER_BASE_URL` | No | `https://wasenderapi.com` |
| `WASENDER_TIMEOUT_MS` | No | `15000` |

If `WASENDER_API_KEY` is unset, `isWasenderEnabled()` returns `false` and callers skip all network work. This satisfies constitution §I and FR-024.

---

## Exports

```ts
export function isWasenderEnabled(): boolean;

export interface SendTextInput {
  to: string;        // E.164 ('+...') or group JID ('...@g.us')
  text: string;
}

export interface SendImageInput {
  to: string;
  text?: string;     // optional caption
  imageUrl: string;  // publicly reachable JPEG/PNG, ≤5MB
}

export interface SendResult {
  providerMessageId: string;
  raw: unknown;      // full response body, for log
}

export async function sendText(input: SendTextInput): Promise<SendResult>;
export async function sendImage(input: SendImageInput): Promise<SendResult>;
```

Both `send*` functions throw on non-2xx responses. Caller is responsible for catching + recording failure.

---

## HTTP request shape

```
POST {WASENDER_BASE_URL}/api/send-message
Authorization: Bearer {WASENDER_API_KEY}
Content-Type: application/json

// sendText:
{ "to": "...", "text": "..." }

// sendImage:
{ "to": "...", "text": "...", "imageUrl": "https://..." }
```

Response (both):
```json
{ "success": true, "data": { "msgId": 12345, "jid": "...", "status": "in_progress" } }
```

`providerMessageId` is stringified `data.msgId`. If the shape differs (shape drift), the raw body is stored as `lastError` and the call counts as a failure.

---

## Error taxonomy

| Thrown error | Meaning | Retryable? |
|---|---|---|
| `WasenderDisabledError` | `WASENDER_API_KEY` missing | no (caller marks `SKIPPED_NO_PROVIDER`) |
| `WasenderRequestError` (4xx) | recipient invalid, image URL rejected, quota exceeded | no |
| `WasenderServerError` (5xx) | provider transient | yes (attemptCount++) |
| `WasenderTimeoutError` | axios timeout | yes |

The polling job treats any non-`WasenderDisabledError` the same: bump `attemptCount`, capture `lastError`, move to `FAILED` after 3 attempts.

---

## Logging

- One `console.log` on success: `[WAsender] sent msgId=X to=Y (Nms)`.
- One `console.warn` on failure with error class + status: `[WAsender] FAIL to=Y status=400 body=...`.
- Request bodies logged only in dev (guarded by `NODE_ENV !== 'production'`) because they contain recipient numbers and image URLs (which may point at PII).

---

## Test hooks

The service exposes a test-only `__setHttpClient(client)` function used by `tsc`-clean unit smoke checks if any are written. Not exported from the package root.
