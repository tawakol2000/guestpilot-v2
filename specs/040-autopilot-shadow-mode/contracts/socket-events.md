# Socket.IO Event Contracts: Autopilot Shadow Mode

All events are broadcast via `broadcastCritical(tenantId, eventName, payload)` — identical to the existing AI pipeline pattern in `backend/src/services/socket.service.ts`. Events are scoped to the tenant's socket room.

---

## 1. `'message'` — existing event, **extended payload**

The existing `'message'` event (emitted from `ai.service.ts:2137-2142` on every AI-generated message) gains three new optional fields on its nested `message` object. Backwards compatible — older frontend code ignores unknown fields.

**Extended payload**:
```ts
{
  conversationId: string,
  message: {
    id: string,                              // NEW — previously missing; now always present
    role: 'AI' | 'AI_PRIVATE' | 'GUEST' | 'HOST' | 'MANAGER_PRIVATE',
    content: string,
    sentAt: string,                          // ISO 8601
    channel: string,
    imageUrls: string[],
    previewState?: 'PREVIEW_PENDING'         // NEW — absent for normal sent/received messages
                   | 'PREVIEW_LOCKED'
                   | 'PREVIEW_SENDING',
    originalAiText?: string,                 // NEW — present IFF previewState is set
    editedByUserId?: string,                 // NEW — present on a successfully-sent edited preview
  },
  lastMessageRole: string,
  lastMessageAt: string                      // ISO 8601
}
```

**When fired under Shadow Mode**:
- On preview creation (shadow-mode branch in ai.service.ts): `previewState='PREVIEW_PENDING'`, `originalAiText=content`.
- On successful Send via `POST /api/shadow-previews/:id/send`: same event fires again with `previewState` absent (cleared) and `editedByUserId` set if the admin edited.
- On Send failure: no `'message'` event fires (state reverts to `PREVIEW_PENDING` silently — the client still sees the original preview).

**Frontend handling**:
- If `previewState === 'PREVIEW_PENDING'`: render as preview bubble with "Not sent to guest" label; show Send/Edit buttons iff this is the latest preview in the conversation (client-side computation).
- If `previewState === 'PREVIEW_LOCKED'`: render as inert preview bubble with the label but no buttons.
- If `previewState === 'PREVIEW_SENDING'`: render the preview with a brief loading spinner in place of the buttons (optional; the next `'message'` event will clear it).
- If `previewState` is absent: render as a normal message (current behavior).

---

## 2. `'shadow_preview_locked'` — new event

Fired when the shadow-mode branch locks one or more older previews before creating a new preview on a conversation. Lets the frontend clear an in-progress edit buffer the admin may have open on the now-locked preview (FR-011a).

**Payload**:
```ts
{
  conversationId: string,
  lockedMessageIds: string[]      // previews that just transitioned PREVIEW_PENDING → PREVIEW_LOCKED
}
```

**Fired at**: the new `shadow-preview.service.lockOlderPreviews()` helper, immediately after the bulk UPDATE succeeds, before the new preview Message is created.

**Frontend handling**:
- Iterate open conversations in the inbox client state.
- For any locked message id matching an in-progress edit buffer, discard the buffer and show a toast: "A newer preview replaced the one you were editing." (FR-011a).
- Update the client-side state to mark those messages as `PREVIEW_LOCKED` (the subsequent `'message'` event for the new preview does not carry lock info for the older ones, so this event is the only signal).

---

## 3. `'tuning_suggestion_created'` — new event

Fired when the tuning analyzer finishes a run and inserts one or more `TuningSuggestion` rows. Lets the Tuning tab live-update without polling.

**Payload**:
```ts
{
  sourceMessageId: string,
  suggestionIds: string[],             // all suggestions produced by this analyzer run (may be 1 or many)
  conversationId: string               // so clients can deep-link to the source preview
}
```

**Fired at**: the end of `tuning-analyzer.service.analyzePreview()`, after the DB insert transaction commits.

**Frontend handling**:
- If the Tuning tab is currently open, prepend the new suggestion(s) to the list without re-fetching.
- If any suggestion is shown inline on the inbox (v2 enhancement, not in scope for MVP), refresh the affected conversation panel.
- Otherwise, increment an unseen-count badge on the Tuning tab header.

---

## 4. `'tuning_suggestion_updated'` — new event

Fired when a suggestion is accepted or rejected by any user in the tenant. Lets multiple open browser tabs stay in sync.

**Payload**:
```ts
{
  suggestionId: string,
  status: 'ACCEPTED' | 'REJECTED',
  appliedByUserId?: string
}
```

**Fired at**: the Accept and Reject controllers, after the status update commits.

**Frontend handling**:
- Update the local copy of the suggestion in the Tuning tab state.
- If accepted, optionally refetch the target artifact editor (system prompt / SOP / FAQ) if it's currently open so the admin sees the applied change.

---

## Existing events — mostly unchanged

- `'ai_typing'`, `'ai_typing_text'`, `'ai_typing_clear'` — still fire during AI generation regardless of Shadow Mode (the generation pipeline is unchanged; only the delivery surfacing differs).
- `'ai_suggestion'` — **conditionally fires**: this is the legacy copilot suggestion-card event. When Shadow Mode is **OFF**, copilot reservations continue to fire this event unchanged (legacy path preserved). When Shadow Mode is **ON**, copilot reservations SKIP this event and instead fire an extended `'message'` event for the preview bubble. The legacy path is not deleted — only bypassed — so flipping the toggle off restores the old behavior immediately.
- `'task_created'`, escalation events — unchanged (FR-004).
- `'faq_suggested'` — unchanged and architecturally cannot fire from a shadow-preview Send because the new Send endpoint does not call `processFaqSuggestion` (FR-013b).
