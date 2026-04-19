# Phase 0 Research: Check-in Document Handoff via WhatsApp

## WAsender API shape

### Decision
Use WAsender's REST endpoint `POST /api/send-message` with a Bearer-token `Authorization` header for both text and media sends. Base URL configured via `WASENDER_BASE_URL` env (default `https://wasenderapi.com`). API key in `WASENDER_API_KEY`.

Two request shapes:
- Text only: `{ to: "+971501234567", text: "103; 1 missing passport" }`
- Text + one image: `{ to: "+971501234567", text: "103\n18/04 - 25/04", imageUrl: "https://hostaway-cdn/.../passport.jpg" }`

Multiple images per handoff: send one WAsender request per image. First request carries the text caption; subsequent requests carry `imageUrl` only (or a trivial space in `text`). Response shape: `{ success: true, data: { msgId, jid, status: "in_progress" } }` — `msgId` stored as our `providerMessageId`.

Group recipients use a JID string in the same `to` field. Format will be whatever the operator pastes in (e.g. `123456789-987654321@g.us`). We do not parse or validate group JIDs beyond "non-empty string containing `@g.us`" OR "starts with `+` and 8–15 digits" (FR-004 applies to phone-style only; group JIDs are allowed as a superset).

### Rationale
- URL-based media means we can hand WAsender the Hostaway image URL directly — no download-then-upload step in the happy path.
- Bearer header is standard and matches the WAsender docs.
- Per-image requests are the documented shape; attempting a batched call would require undocumented behavior. One extra round trip per image is acceptable (expected ≤ 4 images per reservation).

### Alternatives considered
- **Twilio WhatsApp Business API**: requires template approval for anything other than in-session messaging. Not a fit — our messages go to private operator contacts who haven't initiated a session with us.
- **Meta Cloud API direct**: requires business verification and a registered number. Overkill for this use case and the user has already configured WAsender externally.
- **Download-then-upload every image to WAsender's media endpoint**: adds S3 or local temp-file dance for no benefit while Hostaway URLs stay reachable. Kept in back pocket as a FR-007 fallback — if WAsender returns 4xx on a specific URL, we can fall back to text-only for that send.

### Open points punted to implementation
- Exact group JID format: confirmed at implementation time when the user pastes one. Code treats it as opaque string.
- Rate limits: WAsender docs mention "plan-dependent" but no numbers. We send ≤ (N_properties × 2 messages × ≤ 4 images) per day. Well under any reasonable quota. If we hit 429 we back off.

---

## Scheduling pattern

### Decision
In-process polling job `docHandoff.job.ts` on a 2-minute `setInterval`, mirrored on the existing `faqMaintenance.job.ts`, `messageSync.job.ts` pattern. No BullMQ dependency.

Each tick:
1. Load all `DocumentHandoffState` rows where `status IN ('SCHEDULED','DEFERRED')` AND `scheduledFireAt <= NOW()` (indexed lookup).
2. For each row, re-validate eligibility (reservation not cancelled, recipient still configured, doc-checklist state for the message type — complete vs incomplete for handoff's DEFERRED path).
3. Render and send via WAsender.
4. Update row to `SENT` / `FAILED` / still `DEFERRED` (if waiting for checklist completion).

The job writes rows; other code paths (reservation creation, reservation update, document-received event) insert rows. No cross-coordination needed.

### Rationale
- Constitution §I requires graceful degradation. The existing BullMQ queue degrades to polling when Redis is missing; a pure polling job needs no fallback at all.
- Persistence is in Postgres (`DocumentHandoffState` rows), so a server restart mid-schedule picks up where it left off — no in-memory timers to lose.
- The 2-min tick is cheap: indexed `scheduledFireAt` scan, small result set in practice.

### Alternatives considered
- **BullMQ delayed jobs**: would shift the scheduling burden to Redis, but adds a Redis hard dependency for anything new unless we build the fallback anyway. Since we'd need the Postgres-backed path regardless of Redis state, using only that path is simpler.
- **node-cron or a cron service**: over-engineered for a 2-min polling loop. Cron expressions are not more expressive than `setInterval` here.
- **Event-driven (fire on reservation-update webhook)**: can't wait for a time to arrive; still need a clock source.

---

## Image-ref capture point

### Decision
Capture at the two entry points that currently mutate `documentChecklist`:
1. `document-checklist.service.ts::updateChecklist()` — called by the AI's `mark_document_received` tool.
2. `document-checklist.service.ts::manualUpdateChecklist()` — called by the manager from the UI.

Both paths receive a new optional argument `{ sourceMessageId, imageUrls }`. When present, the appended image refs are stored on `screeningAnswers.documentChecklist.receivedDocs` (a new array inside the existing JSON blob). Each entry: `{ slot: 'passport' | 'marriage_certificate', slotIndex?: number, hostawayMessageId, imageUrls: string[], capturedAt }`.

For `updateChecklist()` the AI pipeline must pass through the message ID it is reacting to. The existing `mark_document_received` tool handler (in `ai.service.ts`) has access to the current Message.id — it will pass it plus the message's `imageUrls` array into the service.

For `manualUpdateChecklist()` the manager's UI already picks a message to attribute — we pass its ID and imageUrls through the existing PATCH endpoint.

### Rationale
- Storing inside the existing `screeningAnswers` JSON avoids a new migration for a small structural change and keeps the checklist "thing" as a single logical record.
- Storing URLs only (not bytes) matches constitution §Security — no raw image persistence.
- Piggybacking on the same two mutator functions means every existing code path that marks a doc received is automatically upgraded. No parallel path to miss.

### Alternatives considered
- **Separate `DocumentImageRef` table**: cleaner relational model but heavier (new migration, new queries, more surface for the same data). JSON-extension is the minimum viable change.
- **Infer images at send time by scanning conversation history for message IDs near the checklist-update timestamp**: fragile and possibly wrong; misses the case where the AI reacted to an earlier message.

---

## Eligibility rules & state machine

### Decision
`DocumentHandoffState` has one row per `(reservationId, messageType)` where `messageType IN ('REMINDER','HANDOFF')`. Statuses:

- `SCHEDULED` — row exists, `scheduledFireAt` is set, waiting for the tick.
- `DEFERRED` — handoff only; checklist incomplete on check-in day past handoff time. Re-evaluates on every checklist update.
- `SENT` — successfully delivered.
- `FAILED` — 3 consecutive delivery failures; no auto-retry thereafter.
- `SKIPPED_CANCELLED` — reservation was cancelled before fire.
- `SKIPPED_NO_RECIPIENT` — tenant lacks the relevant recipient at fire time.
- `SKIPPED_NO_CHECKLIST` — reminder only; reservation never got a checklist.
- `SKIPPED_NO_PROVIDER` — `WASENDER_API_KEY` unset at fire time; logged for operator.

Row creation points:
- **On reservation creation** (`POST /webhooks/hostaway/:tenantId` + `reservationSync.job.ts`): insert or upsert both rows for future-check-in reservations. Reminder row's `scheduledFireAt` = check-in-minus-1-day at tenant's reminder time in Africa/Cairo; handoff row's `scheduledFireAt` = check-in day at tenant's handoff time.
- **On reservation update** (check-in dates change): reschedule any SCHEDULED rows. Do not resurrect SENT/FAILED rows.
- **On walk-in path** (reservation created with check-in today or past): skip reminder (mark `SKIPPED_NO_CHECKLIST` or don't create at all); handoff gets `scheduledFireAt = NOW()` if checklist complete or no checklist, else `DEFERRED`.
- **On checklist update** (new doc received): for any `DEFERRED` handoff row, re-check checklist completeness; if now complete, set `scheduledFireAt = NOW()` and flip to `SCHEDULED` so the next tick fires it.

### Rationale
- Explicit row per message × reservation enforces idempotency (unique constraint `(reservationId, messageType)`).
- Having the enum-like status makes the SENT-once guarantee a DB-level property: the job's scan excludes anything not in `(SCHEDULED, DEFERRED)`.
- Status transitions are monotone except `DEFERRED → SCHEDULED`, which is triggered by an external event (checklist update), not by the tick itself.

### Alternatives considered
- **One row with two nullable timestamps**: awkward for the `DEFERRED` case and forces conditional logic everywhere. Two rows is clearer.
- **Computed-on-the-fly eligibility without a persisted row**: can't track idempotency reliably; restart/retry windows would double-send.

---

## Unit identifier resolution

### Decision
Build `UNIT_IDENTIFIER` with the fallback chain: `property.customKnowledgeBase.unitNumber ?? property.customKnowledgeBase.shortCode ?? property.name ?? reservation.hostawayReservationId`. All existing fields — no schema change.

### Rationale
- Matches FR-014 / Edge Cases section of spec.
- Reuses existing `customKnowledgeBase` convention for ad-hoc property knowledge (used elsewhere in the codebase).

### Alternatives considered
- Adding a dedicated `Property.unitNumber` column: minor benefit, nonzero migration cost, and `customKnowledgeBase` already holds this kind of data in other places.

---

## Timezone

### Decision
Use hardcoded `Africa/Cairo` (via `date-fns-tz` already in use or Node's `Intl.DateTimeFormat`) for all schedule calculations, matching the existing codebase convention (`ai.service.ts:1559`, `ai-config.controller.ts:302`, `sandbox.ts:160`).

### Rationale
- Zero per-tenant or per-property timezone configuration exists today. Introducing a proper timezone model for this one feature would ripple into those three other call sites and their consumers (prompt generation, UI timestamps).
- The feature's first-tenant use case is Cairo-based. If/when a second timezone tenant appears, we promote the constant to a per-tenant setting in one place and the call sites inherit it.

### Alternatives considered
- **Add `Tenant.timezone` now**: premature. Marked as a v2 consideration in the out-of-scope section of the spec by implication (it's not called out as a v1 requirement).
- **Use UTC and let operators convert mentally**: confusing for operators, easy to get off by a day at date-boundary times.

---

## Settings UI surface

### Decision
New section on the existing Settings page (same page where AutoAccept thresholds and Reply Templates live — per feature 043's `automated-replies-section.tsx`). Contains:
- Manager recipient input (`+` + digits, 8–15 char validation; or raw group JID detected by substring `@g.us`).
- Security recipient input (same validation).
- Reminder time picker (HH:MM, default 22:00).
- Handoff time picker (HH:MM, default 10:00).
- Feature on/off toggle.
- Read-only "Recent sends" list showing the last 20 handoff-state rows (status badge + timestamp + recipient).

### Rationale
- Matches the pattern established by feature 043 (`automated-replies-section.tsx`) for tenant-level operator-facing config. Consistent UX.
- Recent-sends list satisfies FR-019's "viewable by an operator" without adding a new page or admin area.

### Alternatives considered
- New top-level "WhatsApp" settings page: premature separation for a single feature.
- Per-property override UI: out of scope for v1 per spec.
