# Phase 0 Research — 043-checkin-checkout-actions

The spec's two `/speckit.clarify` answers already resolved the highest-impact UX decisions (editable preview; threshold-as-sole-authority for re-requests). This phase captures the remaining design decisions — some of which arose during planning — with rationale and rejected alternatives.

---

## Decision 1 — Auto-accept as "policy-as-authority" (Constitution §III carve-out)

**Decision**: Auto-accept is governed exclusively by explicit operator-configured thresholds on the `Property` (or `Tenant` default). When an operator sets `autoAcceptLateCheckoutUntil=13:00`, the *operator* is the authority guaranteeing that time, not the AI. The AI's role is reduced to: parse the guest's requested time, compare to the operator's threshold, and mirror the policy. This threads the needle on Constitution §III ("AI MUST never guarantee specific service times") without requiring a constitutional amendment.

**Rationale**:
- §III exists to prevent the AI from committing the business to service times based on its own judgement. An operator-configured threshold is *not* AI judgement — it is explicit business policy.
- Symmetric to how `Reservation.aiEnabled` and `aiMode` already gate AI behavior by explicit config: the AI follows config, it doesn't override it.
- Auto-reject remains forbidden (FR-014) — the one-sided nature is the safeguard. The AI can only *affirm* a policy, never *deny* a request.
- The policy itself is a reversible config value. An operator who sets `until=16:00` then realizes their cleaning crew can't accommodate can simply change it — future requests respect the new value.

**Alternatives considered & rejected**:
- *Amend §III entirely*: heavy-handed. The principle still protects against the much larger risk of AI freelancing.
- *Require manager Accept even when within auto-accept threshold*: negates the feature's ROI. The whole point is removing the manager's click for policy-compliant requests.
- *Auto-accept only up to a "free" tier derived from the SOP*: we explored this in the spec discussion and rejected it. Threshold is a simpler, more transparent model the operator fully controls; fees remain a template-authoring concern.

**Implementation implication**: Every auto-accept decision is logged with `{ propertyId, threshold, requestedTime, approved: boolean, templateId }` so auditability is equivalent to the manual path. No principle compromise without a trace.

---

## Decision 2 — `scheduledTime` as a structured-output field, not a tool

**Decision**: The coordinator's existing JSON schema gets a new optional field:

```json
"scheduledTime": {
  "type": ["object", "null"],
  "properties": {
    "kind": { "type": "string", "enum": ["check_in", "check_out"] },
    "time": { "type": "string", "pattern": "^([01]?[0-9]|2[0-3]):[0-5][0-9]$" }
  },
  "required": ["kind", "time"],
  "additionalProperties": false
}
```

The AI populates this field end-of-turn when it has detected a specific check-in/out time request AND the holding-message path is inappropriate for this conversation (e.g., property already has thresholds, AI's system prompt instructs it to extract the time). The pipeline post-processes the field.

**Rationale**:
- Matches existing patterns: `escalation`, `resolveTaskId`, `updateTaskId` are all structured-output fields, not tools. Consistent mental model.
- Zero extra round-trips to the provider. A tool call would cost ~1 second and ~500 tokens for a scalar decision already implicit in the AI's reasoning.
- Strict JSON schema (`strict: true`) + regex pattern on `time` gives us server-side validation for free.
- The field is nullable-optional → older JSON payloads continue to validate; no migration of cached/replayed responses needed.

**Alternatives considered & rejected**:
- *Separate `set_scheduled_time` tool*: would add a mid-turn round-trip + tool-result parse. Better for cases where the AI needs to *verify* before acting (like `check_extend_availability` which queries Hostaway). Here, the AI is just emitting a parsed value from the conversation text — no verification needed.
- *Repurpose the `escalation` field's `note` free-text to carry the time*: fragile parsing, hard to validate, conflates two concerns.
- *Two separate fields `scheduledCheckInAt` and `scheduledCheckOutAt` at the top level*: flatter but pollutes the schema with mutually-exclusive fields. An object with a `kind` discriminator is cleaner.

**Implementation implication**: We extend `buildOutputSchema()` in `ai.service.ts` and add a post-parse block that calls `scheduled-time.service.ts::applyScheduledTimeIfPolicyAllows()` before the existing `handleEscalation()` call.

---

## Decision 3 — Time-of-day stored as `HH:MM` string, not DateTime

**Decision**: `Reservation.scheduledCheckInAt` and `scheduledCheckOutAt` are stored as `String?` in HH:MM 24-hour format (same shape as `Property.customKnowledgeBase.checkInTime`). Similarly, `Property.autoAcceptLateCheckoutUntil` / `autoAcceptEarlyCheckinFrom` are `String?` HH:MM. Tenant-level defaults mirror the property fields.

**Rationale**:
- The existing `Reservation.checkIn` / `checkOut` are dates (Hostaway sends `"arrivalDate": "2026-05-25"` — no time-of-day). The check-in/out *time* is and always has been a property-level default. We're now adding a per-reservation override of that time, not a new datetime.
- HH:MM string keeps timezone concerns explicit and property-local (matches how the existing `checkInTime` is handled — see `customKnowledgeBase.checkInTime`).
- DateTime would require combining with `Reservation.checkIn` date — fine for storage, but introduces ambiguity on which timezone and creates accidental dependencies for downstream code. String HH:MM is less clever and more robust.
- Comparison against the threshold becomes a plain string compare (e.g., `"12:30" <= "13:00"` lexicographic matches numeric for valid HH:MM). Trivial.

**Alternatives considered & rejected**:
- *Full DateTime override*: over-engineered for what is conceptually a "time-of-day" field.
- *Store on `customKnowledgeBase.scheduledCheckInTime`*: hidden in JSON, hard to query, hard to index, doesn't support the Property-card live update cleanly.
- *Separate `ReservationScheduledTime` table with (reservationId, kind, time)*: splits data unnecessarily. Only ever up to two rows per reservation, 1:1 with the reservation lifecycle — belongs on the reservation itself.

**Indexing**: None needed. These fields are always read by primary key via the reservation row.

---

## Decision 4 — Template storage: new `AutomatedReplyTemplate` table

**Decision**: New model:

```prisma
model AutomatedReplyTemplate {
  id             String   @id @default(cuid())
  tenantId       String
  escalationType String   // 'late_checkout_request' | 'early_checkin_request' | ...future types
  decision       String   // 'approve' | 'reject'
  body           String   @db.Text
  updatedAt      DateTime @updatedAt
  tenant         Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([tenantId, escalationType, decision])
  @@index([tenantId])
}
```

System defaults live in `backend/src/config/reply-template-defaults.ts` — consulted when the tenant has no row for a given (type, decision). Overrides are lazy-seeded on first edit, not on tenant creation.

**Rationale**:
- A dedicated table makes the Settings CRUD obvious (`GET /reply-templates`, `PUT /reply-templates/:type/:decision`) and cleanly indexable.
- Lazy seeding means new tenants always get up-to-date system defaults without a seed job — they only save a row once they diverge.
- Unique index on `(tenantId, escalationType, decision)` prevents duplicate rows and makes lookups trivial.

**Alternatives considered & rejected**:
- *JSON blob on `TenantAiConfig`*: hard to edit per row, no natural permissions boundary, can't diff cleanly in the UI.
- *Reuse `MessageTemplate`*: its schema is keyed by Hostaway scheduled-template id (`hostawayId`). Semantically different — that's for Hostaway's outbound scheduled message library, not our inline approval/rejection templates. Overloading it would invite confusion.

**Variable substitution**: keep identical syntax to what `template-variable.service.ts` already uses (`{GUEST_FIRST_NAME}`, `{REQUESTED_TIME}`, `{PROPERTY_NAME}`, `{CHECK_IN_TIME}`, `{CHECK_OUT_TIME}`). Unknown variables are replaced with empty string (FR-017), never blocking send.

---

## Decision 5 — Task type + metadata column

**Decision**: Use the existing `Task.type String` column with new values `'late_checkout_request'` and `'early_checkin_request'`. Add `Task.metadata Json?` to carry per-type payload (e.g., `{ requestedTime: "13:00" }`). The existing alteration path continues to use `type = 'alteration'` with no metadata (its payload already lives on the `BookingAlteration` row).

**Rationale**:
- `Task.type` is already stringly-typed and free-form (`type String @default("other")`) — new values are additive, no migration.
- `metadata` as `Json?` lets future escalation types (amenity-with-fee, extra-guests-approval) store their own structured payload without another schema change.
- The polymorphic Actions-card renderer in the frontend reads `task.type` to pick the lane and `task.metadata` to render type-specific fields.

**Alternatives considered & rejected**:
- *Use `Task.note` free-text*: fine for one type, fragile for many; loses structure for the frontend renderer.
- *Separate `TimeRequest` table joined to Task*: premature; nothing else needs it and two rows per time-request is more plumbing than one JSON blob.

**Dedup on re-request (FR-004 / spec edge case)**: `task-manager.service.ts` — when a guest sends a new message whose parsed `requestedTime` differs from an existing OPEN task of the same type for the same conversation, update `metadata.requestedTime` in place rather than creating a duplicate. Resolves the "actually 2pm not 1pm" case from the spec's edge case list.

---

## Decision 6 — Action card polymorphism on the frontend

**Decision**: Introduce a simple registry map in `frontend/components/actions/action-card-registry.ts`:

```ts
export const ACTION_CARD_REGISTRY: Record<string, React.FC<ActionCardProps>> = {
  alteration: AlterationActionCard,
  late_checkout_request: TimeRequestActionCard,
  early_checkin_request: TimeRequestActionCard,
};
```

The inbox iterates open escalations for the selected conversation and renders each via the registry. Existing alteration logic is extracted verbatim into `AlterationActionCard.tsx` — refactor only, no behavior change, no new render logic. `TimeRequestActionCard` is the new generic "Accept → edit → Send / Reject → edit → Send" component.

**Rationale**:
- Registry-map is the lightest possible polymorphism mechanism. No framework, no DI, no class hierarchy.
- Adding a new escalation type = one line in the registry + one new component. Satisfies FR-025 / FR-029 / SC-007 ("new escalation type under one engineering day").
- Zero risk to alteration flow: the extracted component is a pure refactor, tested by the existing quickstart-checklist for alterations.

**Alternatives considered & rejected**:
- *Generic JSON-schema-driven renderer*: over-engineered for the 1–3 escalation types in foreseeable roadmap.
- *Class hierarchy with inheritance*: React's compositional model makes this strictly worse.
- *Inline switch statement in inbox-v5.tsx*: that's where the current alteration code lives; adding more branches makes the file worse. The registry is the refactor.

---

## Decision 7 — Property-card "Modified" treatment (FR-025)

**Decision**: When a reservation has a non-null `scheduledCheckInAt` (or `scheduledCheckOutAt`), the Property details card in the right panel renders that direction's time row with:
1. The override value (e.g., `1:00 PM`) in place of the default.
2. A single-word inline pill `Modified` next to the value, in the success-green color (`T.status.green`).
3. A tooltip on hover revealing the default (e.g., "Default: 11:00 AM").

Default rendering (no override) is unchanged from today — preserves FR-026.

**Rationale**:
- Three signals (color change, inline pill, tooltip) give the manager an unmissable indicator without screaming. Matches the visual weight of other status-accented items already in the inbox (confidence pill, channel logos).
- Green is the established "positive state change" color in the theme.
- Tooltip gives optional detail without crowding the card.

**Alternatives considered & rejected**:
- *Red / amber*: those colors are reserved for escalation urgency and error states; using them for "modified" would conflict.
- *Icon only*: too subtle; managers would miss it.
- *Replace label ("Check-out Time" → "Modified Check-out Time")*: breaks column alignment with the rest of the card.

**Live-update mechanism**:
- Local session: the Accept controller returns the updated Reservation payload; the inbox state hook merges it and re-renders immediately (<1s, satisfies SC-005).
- Other managers: the controller broadcasts `reservation_scheduled_updated` via Socket.IO to the tenant room; the inbox's existing socket listener merges and re-renders.

---

## Decision 8 — Accept/Reject endpoint shape (server-side)

**Decision**: Three endpoints under `/api/tasks/:taskId`:

- `GET /api/tasks/:taskId/preview?decision=approve|reject` → `{ body: string }` — returns the template-rendered text for the preview textarea. Client calls this when the manager first clicks Accept or Reject.
- `POST /api/tasks/:taskId/accept` body `{ body: string }` → `{ message, reservation }` — sends `body` to the guest via Hostaway, writes `Reservation.scheduledCheckInAt/At`, marks Task resolved, broadcasts socket events, returns the updated reservation so the client can update the Property card without a refetch.
- `POST /api/tasks/:taskId/reject` body `{ body: string }` → `{ message }` — sends `body` to the guest, marks Task resolved, NO reservation write.

**Rationale**:
- Two-step (preview → send) matches the UX: click Accept → textarea pre-fills → edit → Send. Client never sees the template itself; it only sees the rendered body, which is what the manager might edit.
- Server renders the template so variable substitution happens one place — and the delivered text matches `preview` when the manager clicks Send without editing.
- Returning the updated reservation avoids a follow-up GET from the client.

**Alternatives considered & rejected**:
- *Single `POST /resolve` that accepts a decision + body*: cleaner API surface but requires the client to know the preview URL anyway.
- *Client-side template rendering*: duplicates the template variable resolver; eventually they drift apart. Server-render is the single source of truth.

**Error handling**:
- If Hostaway send fails (network, 4xx, 5xx) → 502, no state changes (no reservation write, no task resolve). Client keeps the preview open and shows the inline error with a Retry button.
- If template render fails (unknown tenant, corrupt data) → 500, no state changes. Logged for diagnostics.

---

## Decision 9 — `{CHECK_IN_TIME}` / `{CHECK_OUT_TIME}` resolution precedence

**Decision**: `template-variable.service.ts` resolves these variables with precedence:
1. `Reservation.scheduledCheckInAt` / `scheduledCheckOutAt` if non-null.
2. `Property.customKnowledgeBase.checkInTime` / `checkOutTime` otherwise.
3. A hard default ("11:00" / "15:00") if both absent.

This is transparent to callers — any existing AI reply that uses `{CHECK_OUT_TIME}` automatically reflects an accepted override, satisfying FR-023 and SC-004 without changing any call site.

**Rationale**:
- Single source of truth: the resolver is the only place that knows how to compute the effective time. Everything downstream uses the resolved value.
- Backward-compatible: reservations without overrides behave exactly as today.

**Alternatives considered & rejected**:
- *Bake precedence into every caller*: multiplies bugs.
- *Store the effective time on the reservation upfront*: would require backfilling every reservation and couples to property edits; lazy resolution is cleaner.

---

## Unknowns remaining

None. Both `/speckit.clarify` answers are reflected in the spec. All planning-phase research items above are resolved. Phase 1 can proceed.
