# REST API Contracts: Autopilot Shadow Mode

All endpoints require JWT auth and inject `tenantId` from the token. Every query is scoped to the caller's tenant per constitution §II.

---

## 1. `PATCH /api/tenant-config` — extended

Existing endpoint. Accepts the existing update shape plus one new optional field.

**Request body (new field only shown)**:
```json
{
  "shadowModeEnabled": true
}
```

**Response**: the full updated `TenantAiConfig` (existing response shape), now including `shadowModeEnabled`.

**Side effects**: invalidates the tenant-config cache; the next AI generation picks up the new value within the 60s TTL at worst.

---

## 2. `POST /api/shadow-previews/:messageId/send` — new

Send (or send-edited) a shadow preview. The caller MUST be authenticated to the tenant that owns the message.

**Path params**:
- `messageId` — id of a `Message` currently in `PREVIEW_PENDING` state

**Request body**:
```json
{
  "editedText": "optional — if omitted, original AI text is sent unchanged"
}
```

**Response (200)**:
```json
{
  "ok": true,
  "message": {
    "id": "...",
    "content": "...",           // final sent text (may differ from original if edited)
    "previewState": null,       // cleared on success
    "originalAiText": "...",    // preserved
    "editedByUserId": "...",    // populated if edited
    "hostawayMessageId": "...", // populated on successful Hostaway delivery
    "sentAt": "2026-04-10T..."
  },
  "analyzerQueued": true        // true IFF content differs from originalAiText
}
```

**Response (409 Conflict)**:
```json
{ "error": "PREVIEW_NOT_PENDING", "detail": "This preview is no longer the latest unsent preview." }
```
Raised when the atomic state transition from `PREVIEW_PENDING` to `PREVIEW_SENDING` affects zero rows — i.e. the preview was locked by a newer preview, already sent, or currently sending.

**Response (502 Bad Gateway)**:
```json
{ "error": "HOSTAWAY_DELIVERY_FAILED", "detail": "..." }
```
When Hostaway returns a non-2xx. State is rolled back to `PREVIEW_PENDING` before returning.

**Behavior**:
1. Load Message by id; verify `tenantId` matches caller; verify `previewState === 'PREVIEW_PENDING'`.
2. Conditional UPDATE: set `previewState='PREVIEW_SENDING'`, and if `editedText` is provided, also set `content=editedText` and `editedByUserId=caller`. `WHERE id = ? AND previewState = 'PREVIEW_PENDING'`. If 0 rows affected → 409.
3. Call `hostawayService.sendMessageToConversation(...)` with the final content.
4. On success: update `previewState=null`, fill `hostawayMessageId` and `sentAt`. Broadcast `'message'` with the final state so all inbox clients refresh. Return 200.
5. On failure: roll `previewState` back to `PREVIEW_PENDING`, return 502.
6. If the final `content !== originalAiText`, fire-and-forget `tuningAnalyzer.analyzePreview(messageId)`. This call does not affect the HTTP response.

---

## 3. `GET /api/tuning-suggestions` — new

List tuning suggestions for the current tenant.

**Query params**:
- `status` — optional filter: `PENDING` (default if omitted) | `ACCEPTED` | `REJECTED` | `ALL`
- `limit` — default 50, max 200
- `cursor` — optional `createdAt` cursor for pagination

**Response (200)**:
```json
{
  "suggestions": [
    {
      "id": "...",
      "status": "PENDING",
      "actionType": "EDIT_SYSTEM_PROMPT",
      "rationale": "Prompt lacks guidance on...",
      "beforeText": "...",
      "proposedText": "...",
      "systemPromptVariant": "coordinator",
      "sopCategory": null,
      "sopStatus": null,
      "sopPropertyId": null,
      "sopToolDescription": null,
      "faqEntryId": null,
      "faqCategory": null,
      "faqScope": null,
      "faqPropertyId": null,
      "faqQuestion": null,
      "faqAnswer": null,
      "sourceMessageId": "...",
      "sourceConversationId": "...",    // resolved server-side for client navigation
      "createdAt": "2026-04-10T..."
    }
  ],
  "nextCursor": null
}
```

**Grouping**: the frontend groups the returned list by `sourceMessageId` for display. The server returns a flat list ordered by `createdAt DESC`.

---

## 4. `POST /api/tuning-suggestions/:id/accept` — new

Accept a tuning suggestion. Applies the proposed change (optionally after admin edit) to the referenced artifact.

**Path params**:
- `id` — tuning suggestion id

**Request body** (shape varies by the suggestion's `actionType`; any field is optional — if omitted, the analyzer's original proposal is used as-is):
```json
{
  // For EDIT_SYSTEM_PROMPT, EDIT_SOP_CONTENT, EDIT_SOP_ROUTING, EDIT_FAQ:
  "editedText": "optional — overrides the analyzer's proposedText",

  // For CREATE_SOP:
  "editedContent": "optional — overrides proposedText",
  "editedToolDescription": "optional — overrides sopToolDescription",

  // For CREATE_FAQ:
  "editedQuestion": "optional — overrides faqQuestion",
  "editedAnswer": "optional — overrides faqAnswer"
}
```

The server normalizes the incoming body into an `appliedPayload` object whose shape depends on `actionType`, and stores it in `TuningSuggestion.appliedPayload` for audit.

**Response (200)**:
```json
{
  "ok": true,
  "suggestion": {
    "id": "...",
    "status": "ACCEPTED",
    "appliedAt": "...",
    "appliedPayload": { /* action-type-specific shape */ }
  },
  "targetUpdated": {
    "kind": "system_prompt" | "sop_variant" | "sop_routing" | "sop_property_override" | "faq_entry" | "sop_definition_new" | "faq_entry_new",
    "id": "..."
  }
}
```

**Behavior per `actionType`**:
- `EDIT_SYSTEM_PROMPT`: write final text to `TenantAiConfig.systemPromptCoordinator` or `systemPromptScreening`, append a history entry to `systemPromptHistory`, bump `systemPromptVersion`. `appliedPayload = { text: finalText }`.
- `EDIT_SOP_CONTENT`: write to the exact SOP tier the suggestion targets (`SopVariant` matching category+status, OR `SopPropertyOverride` matching category+status+property). Uses existing SOP update service. `appliedPayload = { text: finalText }`.
- `EDIT_SOP_ROUTING`: write to `SopDefinition.toolDescription` by category. `appliedPayload = { text: finalText }`.
- `EDIT_FAQ`: write to `FaqEntry.question` / `FaqEntry.answer` by id (reuses existing FAQ update service). By default the final text replaces the answer field; if the suggestion's `beforeText` matched the question, it replaces the question instead. `appliedPayload = { text: finalText, field: 'question' | 'answer' }`.
- `CREATE_SOP`: insert `SopDefinition` (if category doesn't exist) and `SopVariant` (for the specified status), plus a `SopPropertyOverride` if `sopPropertyId` is set. Uses existing SOP create service. `appliedPayload = { content: finalContent, toolDescription: finalToolDescription }`.
- `CREATE_FAQ`: insert a new `FaqEntry` with `status='ACTIVE'` and **`source='MANUAL'`** — the admin has explicitly approved via the Tuning tab, so the entry is not "auto-suggested" in the Constitution §VIII sense. This preserves the literal Principle VIII rule ("auto-suggested entries MUST have status=SUGGESTED") since manually-approved tuning entries use a different `source` value. `appliedPayload = { question: finalQuestion, answer: finalAnswer }`.

Every Accept updates the `TuningSuggestion` row: `status='ACCEPTED'`, `appliedAt=now`, `appliedPayload=<normalized shape>`, `appliedByUserId=caller`.

**Response (409 Conflict)**:
```json
{ "error": "SUGGESTION_NOT_PENDING" }
```
When the suggestion is already accepted or rejected.

---

## 5. `POST /api/tuning-suggestions/:id/reject` — new

**Path params**: `id` — tuning suggestion id

**Request body**: none (or `{ "reason": "optional short note" }`)

**Response (200)**:
```json
{ "ok": true, "suggestion": { "id": "...", "status": "REJECTED" } }
```

**Behavior**: updates `status='REJECTED'` and `appliedByUserId=caller`. No artifact is modified.

---

## Authorization

All endpoints require an authenticated user with a tenant-scoped JWT. No new roles/permissions are introduced for v1; any authenticated user of the tenant may toggle Shadow Mode, Send previews, and Accept/Reject suggestions (mirroring how the existing `PATCH /api/tenant-config` route is gated).
