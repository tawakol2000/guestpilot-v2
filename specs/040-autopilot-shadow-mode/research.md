# Phase 0 Research: Autopilot Shadow Mode

## Purpose

Resolve the architectural unknowns that would otherwise block Phase 1 (data model + contracts). Each decision below is load-bearing for the plan and was chosen after inspecting the current code paths cited in the plan.

---

## Decision 1: How are Shadow Previews stored — new table or extend `Message`?

**Decision**: Extend the existing `Message` model with four new nullable columns: `previewState`, `originalAiText`, `editedByUserId`, `aiApiLogId`.

**Rationale**:
- The inbox chat rendering path in `inbox-v5.tsx` already queries and displays `Message` rows. Adding nullable columns means preview bubbles go through exactly the same rendering pipeline, differentiated only by a client-side check on `previewState`. A separate table would require merging two query results client-side or server-side, doubling complexity for a temporary feature.
- Historical previews naturally live alongside sent messages in correct chronological order with no extra JOINs — the `sentAt` ordering used today already gives the right display order.
- The Message model currently has **no** `status` / `state` / `draft` fields (verified in `backend/prisma/schema.prisma:155-174`), so adding `previewState` is additive and non-disruptive.
- Clean retirement: dropping the columns is a single `ALTER TABLE` per field. No orphaned rows, no data migration.
- Matches the constitution's "reuse existing patterns" ethos and §VI "Observability by Default" (the fields carry audit data directly on the message where operators can see them).

**Alternatives considered**:
1. *Separate `ShadowPreview` table, render by merging with Messages*. Rejected: inbox pagination and ordering become painful; retirement requires more surgery; two code paths for "a thing in the chat".
2. *Reuse `PendingAiReply.suggestion` (the existing copilot storage)*. Rejected: `PendingAiReply` is `@@unique([conversationId])` — only one row per conversation — but Shadow Mode needs to preserve **historical** locked previews in chat history. Structurally wrong shape.
3. *Store in `AiApiLog.ragContext` JSON*. Rejected: AiApiLog is append-only diagnostic storage, not queryable chat content. Rendering would require JSON extraction on every inbox load.

---

## Decision 2: Where exactly does the interception happen in `ai.service.ts`?

**Decision (CORRECTED)**: **Inside the existing copilot branch** at `ai.service.ts:2099-2108`. The existing block is restructured so that when `tenantConfig.shadowModeEnabled === true`, it runs the new preview-bubble flow; otherwise, it falls through to the legacy suggestion-card flow (writing `PendingAiReply.suggestion`, broadcasting `ai_suggestion`) unchanged.

**Shape**:
```ts
if (context.aiMode === 'copilot') {
  if (tenantConfig.shadowModeEnabled) {
    // NEW: Shadow Mode preview flow
    const lockedIds = await shadowPreviewService.lockOlderPreviews(prisma, tenantId, conversationId);
    const savedMessage = await prisma.message.create({
      data: {
        conversationId, tenantId,
        role: MessageRole.AI,
        content: guestMessage,
        sentAt,
        channel: lastMsgChannel,
        communicationType,
        hostawayMessageId: '',
        previewState: 'PREVIEW_PENDING',
        originalAiText: guestMessage,
        aiApiLogId: apiLogId,
      },
    });
    broadcastCritical(tenantId, 'shadow_preview_locked', { conversationId, lockedMessageIds: lockedIds });
    broadcastCritical(tenantId, 'message', { conversationId, message: { id: savedMessage.id, role: 'AI', content: guestMessage, sentAt: sentAt.toISOString(), channel: String(lastMsgChannel), imageUrls: [], previewState: 'PREVIEW_PENDING', originalAiText: guestMessage }, lastMessageRole: 'AI', lastMessageAt: sentAt.toISOString() });
    return;
  }
  // LEGACY: unchanged — existing copilot suggestion-card flow
  await prisma.pendingAiReply.update({
    where: { conversationId },
    data: { suggestion: guestMessage },
  }).catch(() => {});
  broadcastCritical(tenantId, 'ai_suggestion', { conversationId, suggestion: guestMessage });
  return;
}
```

**Rationale**:
- **Shadow Mode only targets copilot** — the user clarified that autopilot cannot be intercepted because the message is already sent. Sitting inside the existing copilot branch is the exact place where the reply is already being held for approval.
- The legacy suggestion-card flow is preserved verbatim as the `else` branch — retirement is trivial (remove the inner `if` block and the legacy path remains).
- The branch sits after escalation enrichment and task creation, so **FR-004 (escalations unchanged)** is satisfied structurally — neither the new preview flow nor the legacy flow touches upstream escalation code.
- The generated `AiApiLog` row already exists by this point (the id is captured earlier in the function as `apiLogId` or similar — verify and plumb to this point if needed), so we can stamp it onto the preview Message.
- Autopilot is completely untouched: the `if (context.aiMode === 'copilot')` guard ensures the new code path is unreachable for autopilot reservations.

**Alternatives considered**:
1. *A separate branch before the copilot check that also intercepts autopilot*. Rejected per user clarification: autopilot messages are already sent; there is nothing to preview.
2. *Replace the legacy copilot flow entirely (delete the suggestion-card path)*. Rejected: the feature is a short-lived diagnostic tool; deleting legacy code increases retirement surface area. Keeping the legacy path as the `else` branch means turning off the toggle fully restores pre-feature behavior.
3. *Intercept at the Hostaway delivery function*. Rejected: violates separation of concerns; `hostawayService` should not know about tenant AI config.

---

## Decision 3: How does the analyzer retrieve full generation context for a preview?

**Decision**: Link `Message.aiApiLogId → AiApiLog.id` explicitly. The analyzer loads the `AiApiLog` row for the preview's source turn and reads everything it needs from `AiApiLog.ragContext` (tool call trace, SOP classification with resolution level, FAQ entries consulted) plus `systemPrompt` and `userContent`.

**Rationale**:
- `AiApiLog.ragContext` is an existing JSON column documented in the constitution §VI as containing: "SOP classification, tool calls, escalation signals, cache stats". This is exactly the context the analyzer needs.
- Without an explicit link, the analyzer would have to heuristically match by `conversationId` + timestamp, which is brittle under concurrent generation.
- The link field costs nothing when null (normal Hostaway-sourced guest messages simply have no AiApiLog).
- Adding the column is non-invasive — it's a new nullable foreign key with no impact on existing queries.

**Alternatives considered**:
1. *Denormalize: duplicate the context into a `TuningSuggestion.context` blob*. Rejected: wastes storage and violates single-source-of-truth; AiApiLog already holds it.
2. *Match by timestamp proximity*. Rejected: fragile under concurrent generation; no strong guarantee of 1:1 mapping.

---

## Decision 4: What model does the tuning analyzer use?

**Decision**: `gpt-5.4-mini-2026-03-17` with **`reasoning: "high"`** and `strict: true` json_schema output.

**Rationale**:
- The user explicitly said "i need something smart". The analyzer's task is qualitatively harder than existing nano-tier fire-and-forget services (summary, FAQ suggest, task dedup): it must *diagnose* which artifact is at fault across system prompts, SOPs, SOP routing, and FAQs, and *propose* concrete replacement text — often across multiple artifacts at once.
- `gpt-5.4-mini` is already the main-pipeline model; the codebase already supports `reasoning` as a string parameter (`"none" | "low" | "medium" | "high" | "auto"`) via `TenantAiConfig.reasoningCoordinator`. Using `"high"` gets significantly better quality on multi-artifact diagnosis than default/medium reasoning, at modest extra latency and cost.
- Using the same model as the main pipeline means the analyzer "speaks the same language" as the system prompt and SOP content it's critiquing — avoiding a mismatch between tuning recommendations and how the live pipeline actually interprets the prompts.
- The feature is temporary and low-volume (one analyzer call per edited-send, which is a small fraction of total messages), so the cost delta is negligible at expected usage.
- If during the tuning period this model consistently misses root causes, the fallback is a **one-line change** to bump to full `gpt-5.4` (non-mini) in the same service file. Low-cost to reverse.

**Alternatives considered**:
1. *gpt-5-nano*. Rejected on quality grounds; multi-artifact diagnosis is beyond nano's demonstrated reliability on this codebase (see commit `74ada66`).
2. *gpt-5.4-mini with default reasoning*. Rejected: user asked for "something smart" and the extra cost of `reasoning: "high"` is trivial at feature volume.
3. *Full `gpt-5.4` (non-mini)*. Held in reserve as the bump-up option if `gpt-5.4-mini high` proves insufficient during the tuning period. Not chosen for v1 because the latency overhead could push edge cases past the 30s SC-004 target.
4. *A reasoning-first model (o-class)*. Rejected: schema response handling would need different code paths; availability not confirmed in this account.
5. *The tenant's configured model (`TenantAiConfig.model`)*. Rejected: tenants may configure nano for cost reasons; the analyzer needs a floor-quality guarantee regardless of tenant config.

---

## Decision 5: How is the "latest preview per conversation" computed?

**Decision**: Client-side. The inbox chat already sorts messages by `sentAt`. The frontend iterates the rendered message list, finds the last Message with `previewState === 'PREVIEW_PENDING'`, and shows Send/Edit on that one only. Other previews (state `PREVIEW_PENDING` but not the last one, or state `PREVIEW_LOCKED`) render as inert bubbles.

**Rationale**:
- No server-side computation needed. The frontend already has the full message list in memory.
- Eliminates a class of race conditions where a stale server flag disagrees with the actual latest preview.
- The server still enforces "only latest is sendable" in the Send endpoint via a second check (re-query at Send time) — client-side is for rendering, server-side is for authorization.

**Alternatives considered**:
1. *A `isLatestPreview` boolean on Message that the server maintains*. Rejected: introduces a second source of truth that must be kept in sync on every new preview generation; adds write amplification.
2. *A dedicated `latestPreviewMessageId` field on `Conversation`*. Rejected: adds a field that's only used by a temporary feature; retirement cost goes up.

---

## Decision 6: How is an older preview "locked" when a new one is generated?

**Decision**: Before creating the new preview Message, the shadow-mode branch runs a single `UPDATE` query:
```
UPDATE Message SET previewState = 'PREVIEW_LOCKED'
WHERE conversationId = ? AND previewState = 'PREVIEW_PENDING'
```
Then creates the new Message with `previewState = 'PREVIEW_PENDING'`. A `'shadow_preview_locked'` Socket.IO event is broadcast to the tenant carrying the list of locked message ids, so inboxes that have an in-progress edit open on one of them can discard the edit buffer and show the FR-011a notification.

**Rationale**:
- Bulk UPDATE is one round-trip, idempotent, and matches Prisma's `updateMany` exactly.
- Wrapping the lock + create in a transaction is unnecessary because only the shadow-mode branch writes previews on a given conversation, and the debounce machinery guarantees only one generation is in flight per conversation at a time.
- The separate socket event is more explicit than overloading the `'message'` event — it lets the frontend distinguish "a new message arrived" from "your edit just got invalidated".

**Alternatives considered**:
1. *Only one `PREVIEW_PENDING` row allowed per conversation via a unique partial index*. Rejected: the constraint would fire a DB error on the normal flow and require application-level retry; the UPDATE approach is cleaner.
2. *Compute "locked" implicitly at render time (latest pending wins; everyone else is locked)*. Rejected: works for rendering but doesn't give us an explicit signal to fire the lock notification to the frontend.

---

## Decision 7: How does the Send endpoint avoid double-send races?

**Decision**: The Send endpoint runs a conditional UPDATE that flips `previewState` from `PREVIEW_PENDING` → `PREVIEW_SENDING` in a single atomic query, gated by the message id. If 0 rows are affected, the caller gets an error — the preview was already locked (superseded), already sending, or already sent. On Hostaway failure, flip back to `PREVIEW_PENDING`. On success, clear `previewState` entirely (set to null) so the Message becomes a normal sent AI message.

**Rationale**:
- Single-row conditional UPDATE is the standard idempotency primitive for this pattern and matches how the codebase already handles `PendingAiReply.fired` flipping at `workers/aiReply.worker.ts`.
- No distributed lock, no BullMQ job needed — the operation is fast (one DB write + one Hostaway call) and runs inline in the HTTP handler.
- FR-014 (idempotent Send) and FR-015 (failure retains preview state) both fall out of the state machine.

**Alternatives considered**:
1. *Redis lock*. Rejected: unnecessary complexity for a low-volume feature; the DB already gives us atomicity for free.
2. *Status field with optimistic locking via `updatedAt`*. Rejected: conditional UPDATE is simpler and more explicit.

---

## Decision 8: How does the frontend receive preview bubbles in real time?

**Decision**: Extend the existing `'message'` Socket.IO broadcast payload with three new optional fields: `messageId`, `previewState`, and `originalAiText`. The frontend already listens to `'message'`; it just needs a render branch for `previewState === 'PREVIEW_PENDING' | 'PREVIEW_LOCKED'`.

**Rationale**:
- Reuses the existing transport — no new listeners, no connection changes.
- Backwards compatible: clients that ignore the new fields continue to work (they'd just render the preview as a normal AI bubble, which is a graceful degradation — worst case the admin sees it as "sent" in an older client until they refresh).
- Adding `messageId` to the payload (it's currently missing — the existing payload has only role/content/sentAt/channel/imageUrls) is generally useful beyond this feature and unblocks client-side deduplication.

**Alternatives considered**:
1. *New dedicated `'shadow_preview'` event*. Rejected: would require the frontend to maintain two separate code paths for "new thing in the chat" — more complexity for no benefit.
2. *Poll-based refresh*. Rejected: violates the ≤5s latency target (SC-002).

---

## Decision 9: How is the analyzer triggered — inline, BullMQ, or direct fire-and-forget?

**Decision**: Direct fire-and-forget via `setImmediate` (or promise + `.catch(() => {})`), matching the pattern in `faq-suggest.service.ts` and `summary.service.ts`. No BullMQ.

**Rationale**:
- The Send endpoint's 5s target (SC-003) is a guest-visible latency; the analyzer's 30s target (SC-004) is tuning-surface latency. Running the analyzer inline would push Send above its target.
- The analyzer doesn't need retry, durable delivery, or cross-process scheduling — it's a single OpenAI call that either succeeds and writes `TuningSuggestion` rows or fails and logs a warning (§I: fire-and-forget services MUST catch all errors internally).
- Adding BullMQ would introduce a hard dependency on Redis for a temporary feature — violating §I's "optional dependencies" guideline.
- If a tenant has Redis, the existing BullMQ queue can remain for the main pipeline; the analyzer simply uses a different, lighter mechanism.

**Alternatives considered**:
1. *BullMQ job*. Rejected: over-engineered; see above.
2. *Synchronous inside Send handler*. Rejected: blows the Send latency target.

---

## Decision 10: How is `EDIT_SOP_CONTENT` target resolution stored precisely?

**Decision**: `TuningSuggestion` stores a compound target reference as three fields for SOP targets: `sopCategory` (always present), `sopStatus` (always present: DEFAULT / INQUIRY / CONFIRMED / CHECKED_IN), and `sopPropertyId` (present only when the AI consulted a property override, otherwise null). The analyzer reads the resolution level from `AiApiLog.ragContext` and stores whichever tier the AI actually saw. Accept then applies the edit at exactly that tier — no inference, no re-resolution.

**Rationale**:
- The spec's FR-018b explicitly mandates "the most-specific level the AI actually consulted". Without storing all three levels, the Accept action would have to re-resolve at accept-time, which could write to a different tier than the one the analyzer was critiquing (if a property override was added between generation and accept).
- Three fields is the minimum to fully qualify a SOP target given the 3-level resolution model in the existing schema (`SopDefinition` / `SopVariant` / `SopPropertyOverride`).
- For `EDIT_SOP_ROUTING`, only `sopCategory` is needed (toolDescription lives on `SopDefinition`, not on variants).
- For `EDIT_SYSTEM_PROMPT`, a single `systemPromptVariant` field (`coordinator` | `screening`) is sufficient.
- For `EDIT_FAQ`, a single `faqEntryId` field is sufficient.

**Alternatives considered**:
1. *Single opaque `targetRef` JSON blob*. Rejected: harder to query and validate; schema-less fields rot.
2. *Re-resolve at accept-time*. Rejected: drift risk as described above.

---

## Decision 11: What model format does the analyzer's json_schema enforce?

**Decision**: A single top-level array of suggestion objects, where each object is a discriminated union on `actionType`. The OpenAI Responses API with `strict: true` supports this via a union schema with `const` discriminator on `actionType`. This maps 1:1 onto the 6 action types from FR-018b.

**Rationale**:
- Matches how the existing AI pipeline output is structured (§IV Structured AI Output).
- Accepting an array means one analyzer call can produce multiple suggestions (FR-018a: a single edit may span multiple artifacts).
- Schema validation at the OpenAI boundary catches malformed output before it hits the DB — no defensive re-parsing needed.

**Alternatives considered**:
1. *Plain text with post-hoc parsing*. Rejected: violates §IV.
2. *Separate OpenAI call per action type*. Rejected: 6× cost, slower, and the analyzer needs to see the whole picture to cross-reference root causes.

---

## Decision 12: Where does the `shadowModeEnabled` flag live?

**Decision**: A new boolean column `shadowModeEnabled` on `TenantAiConfig`, defaulting to `false`. Read by the ai.service interception branch; set via the existing `PATCH /api/tenant-config` endpoint (extended to accept the new field).

**Rationale**:
- `TenantAiConfig` is already the canonical location for tenant-scoped AI toggles (`aiEnabled`, `screeningEnabled`, `memorySummaryEnabled`, `workingHoursEnabled`, `adaptiveDebounce`). Adding one more boolean matches the pattern exactly.
- Already cached by `tenant-config.service.ts` (60s cache), so the interception branch reads it with zero extra latency.
- Cache invalidation on toggle already works — flipping the toggle clears the cache and the next generation picks up the new value within one cache TTL at worst. FR-025 (disabling restores normal delivery for next and subsequent replies) is met.

**Alternatives considered**:
1. *Per-property or per-reservation override*. Explicitly out of scope per the Q/A clarifications.
2. *Global environment variable*. Rejected: needs to be tenant-scoped (§II).
