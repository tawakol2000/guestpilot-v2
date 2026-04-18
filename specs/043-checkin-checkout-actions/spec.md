# Feature Specification: Check-in / Check-out Time Accept-Reject Workflow

**Feature Branch**: `043-checkin-checkout-actions`
**Created**: 2026-04-19
**Status**: Draft
**Input**: User description: "Add a check-in/out time accept workflow in the Actions card. When a guest asks for late checkout or early check-in, today the AI escalates and sends a holding message. The resulting task should surface in the existing Actions card with Accept/Reject buttons for the proposed time. Accept switches the card to a pre-filled approval reply (templated per tenant) with Send/Cancel. Reject does the same with a rejection template. Send writes the agreed time to Reservation.scheduledCheckInAt/scheduledCheckOutAt and sends the templated message. Per-property auto-accept thresholds (until-HH:MM for late checkout, from-HH:MM for early check-in) let the AI auto-approve within threshold via structured output; outside threshold escalates. Generalized so future escalation types plug in. AI never auto-rejects. Existing alteration flow must not regress."

## Clarifications

### Session 2026-04-19

- Q: Is the pre-filled preview text editable by the manager before Send? → A: Editable — preview renders as a textarea pre-filled from the template; manager can freely edit; edited text is what gets delivered.
- Q: What happens on a re-request when the reservation already has a scheduled-time override? → A: Treat re-requests identically to first requests — the threshold is always the sole authority. New time within threshold → auto-accept and overwrite the existing override. New time outside threshold (or auto-accept not configured) → escalate to the manager via the Actions card like any first request. No special "already has an override" rule.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Manager accepts a late-checkout request from the Actions card (Priority: P1)

A guest messages asking to check out later than the standard time. The AI recognizes the request, fetches the matching SOP, sends the guest a holding message ("Standard checkout is 11 AM… I'll check with the manager"), and raises an escalation. In the inbox, the manager opens the conversation and sees the request appear as a card inside the existing **Actions** panel on the right, showing the proposed time (e.g., "Late checkout · 1:00 PM") with **Accept** and **Reject** buttons. When the manager clicks **Accept**, the same card flips to a preview state showing a pre-filled approval message to the guest ("Hi Noah — confirmed, you can check out at 1:00 PM."), with **Send** and **Cancel**. Clicking **Send** delivers the message to the guest, marks the agreed time on the reservation, resolves the escalation, and the Actions panel returns to its normal empty state. Clicking **Cancel** in the preview brings the card back to Accept/Reject without having done anything.

**Why this priority**: This is the manual, trust-building path — the one a manager sees the first time the feature ships. Everything else (auto-accept, the AI-mirrored flow, generalization) is layered on top. Without this path, there is no shipping feature.

**Independent Test**: Fire a webhook with a guest message like "can we check out at 1pm?" on a CONFIRMED reservation. Verify the Actions card renders a late-checkout card with Accept/Reject. Click Accept → verify the card flips to a preview with a pre-filled message. Click Send → verify (a) the guest receives the approval message, (b) the reservation's stored check-out time reflects the new 1:00 PM, (c) the escalation is marked resolved, (d) the Actions card clears, (e) the Property details card on the right panel now shows "Check-out Time: 1:00 PM" rendered in a modified/highlighted style (green or similar) instead of the default 11:00 AM.

**Acceptance Scenarios**:

1. **Given** a guest message asking for a specific late-checkout time on a CONFIRMED reservation, **When** the AI processes the message, **Then** a holding message is sent to the guest AND a late-checkout escalation is created with the requested time parsed from the message.
2. **Given** an open late-checkout escalation on the selected conversation, **When** the manager opens that conversation, **Then** the Actions card shows a row titled with the request type and the requested time, with Accept and Reject buttons.
3. **Given** the manager has clicked Accept, **When** the card flips to preview, **Then** a pre-filled approval message is shown, populated from the tenant-configured approval template with the guest's first name and the requested time substituted.
4. **Given** the approval preview is showing, **When** the manager clicks Send, **Then** the message is delivered to the guest via the conversation's channel, the reservation's scheduled check-out time is updated, the escalation is resolved, the Actions card returns to showing no pending actions, and the Property details card's Check-out Time row flips to the new time rendered in a visually-modified style (e.g., green text with a "modified" label or icon).
5. **Given** the approval preview is showing, **When** the manager clicks Cancel, **Then** the preview closes and the Accept/Reject state is restored without any message sent and without any state changes to the reservation or escalation.
6. **Given** the manager clicks Reject on the original card, **When** the card flips to the rejection preview, **Then** the pre-filled message uses the tenant-configured rejection template; clicking Send delivers the rejection message and resolves the escalation without updating the reservation's scheduled time, and the Property details card continues to show the unchanged default time.
7. **Given** a conversation has multiple pending escalations (e.g., alteration + late checkout), **When** the manager opens the conversation, **Then** the Actions card lists all of them stacked, each with its own Accept/Reject flow; acting on one does not dismiss the others.

---

### User Story 2 — Property auto-accepts a late-checkout request inside the threshold (Priority: P2)

A property has "Auto-accept late checkouts until 1:00 PM" configured. A guest on a CONFIRMED reservation at that property messages "can we check out at 12:30?". The AI recognizes the request as within the auto-accept threshold. Instead of escalating and sending a holding message, the AI proceeds directly: the reservation's scheduled check-out time is updated to 12:30 PM, the tenant-configured approval template is filled and sent to the guest ("Hi Noah — confirmed, you can check out at 12:30 PM."), and no escalation or Actions-card entry is created. The manager sees the updated time on the reservation (with the Property card's Check-out Time row now rendered in the modified style) and the conversation activity in the normal thread, but has no pending action to handle.

**Why this priority**: Core ROI for the feature — auto-handling free/within-policy requests removes the most common escalation from the manager's queue. Depends on Story 1's storage + template infrastructure being in place, which is why it ships second.

**Independent Test**: Configure the property with `autoAcceptLateCheckoutUntil = "13:00"`. Fire a webhook message "can we check out at 12:30?" on a CONFIRMED reservation at that property. Verify (a) the guest receives the approval message automatically, (b) the reservation's scheduled check-out time is 12:30, (c) no escalation was created, (d) the Actions card shows nothing, (e) the Property details card reflects the modified check-out time visibly.

**Acceptance Scenarios**:

1. **Given** a property with `autoAcceptLateCheckoutUntil` set to 13:00 and an early-check-in threshold set, **When** a guest on a CONFIRMED reservation asks to check out at 12:30, **Then** the AI applies the scheduled check-out time, sends the approval template, does not create an escalation, and the Property details card renders Check-out Time as modified.
2. **Given** the same property and reservation, **When** a guest asks to check out at 14:30 (outside the threshold), **Then** the AI behaves exactly as it does today: sends the holding message and creates an escalation for the manager (Story 1 flow).
3. **Given** a property with no threshold configured, **When** a guest asks for any late-checkout time, **Then** the AI always escalates (never auto-accepts).
4. **Given** a property with `autoAcceptEarlyCheckinFrom` set to 12:00, **When** a guest asks to check in at 13:00 on an upcoming CONFIRMED reservation, **Then** the AI applies the scheduled check-in time and sends the approval template.
5. **Given** any configuration, **When** a late-checkout or early-check-in request is auto-approved, **Then** the approval message uses the same tenant-configured approval template used in the manual path.

---

### User Story 3 — Per-tenant reply templates for Accept and Reject (Priority: P2)

A tenant admin opens Settings / Configure AI and finds a new **Automated Replies** section. For each supported escalation type (Late checkout, Early check-in at launch, extensible later), there are two editable templates — Approval and Rejection — each supporting variables like `{GUEST_FIRST_NAME}`, `{REQUESTED_TIME}`, `{PROPERTY_NAME}`. Saving the templates updates every future Accept/Reject preview and every future auto-accept delivery for that tenant.

**Why this priority**: Without editable templates the feature still works (a sensible default template ships per escalation type), but managers in different languages / brand voices / legal environments need to edit the wording. Depends on Stories 1 and 2 for the consumption point.

**Independent Test**: Log in as a tenant admin, open Automated Replies, change the Late-checkout Approval template, save. Run Story 1 (manager Accept) — verify the new template text appears in the preview. Run Story 2 (auto-accept) — verify the guest receives a message using the new template.

**Acceptance Scenarios**:

1. **Given** the Automated Replies settings, **When** the admin edits and saves the Late-checkout Approval template, **Then** the next Accept preview (Story 1) and the next auto-accept send (Story 2) both use the updated text.
2. **Given** no template has ever been saved, **When** an Accept preview or auto-accept fires, **Then** a system-provided default template is used.
3. **Given** a template references an undefined variable, **When** the message is rendered, **Then** the message is still sent (with the unknown placeholder either preserved as literal text or replaced with empty string — whichever is more forgiving) rather than blocking the flow.

---

### User Story 4 — Action-card framework generalizes to future escalation types (Priority: P3)

Later, the ops team wants the same Accept/Reject → Preview/Send/Cancel pattern for other escalation types: "Extra guests approval", "Amenity-with-fee", "Early cleaning request". Adding a new type should require defining the escalation type, its approval/rejection templates, and any type-specific field (e.g., number of extra guests, amenity name) — not rebuilding the card or the settings UI.

**Why this priority**: This is architectural — the first two escalation types (late checkout + early check-in) could be hardcoded, but hardcoding is dead weight the next time the team asks for a new escalation flow. Generalizing costs marginal effort at v1 and amortizes well. Lower priority because it is additive to Stories 1–2 and provides no standalone user value.

**Independent Test**: After the feature ships, a developer adds a hypothetical new escalation type ("Extra guest approval") by defining its metadata + templates. Verify that (a) the Actions card renders the new type's Accept/Reject card with no inbox code changes, (b) the Automated Replies settings page lists the new type's templates editable.

**Acceptance Scenarios**:

1. **Given** the feature has shipped with late-checkout and early-check-in types, **When** a new escalation type is registered in the system, **Then** the Actions card automatically handles it (correct title, requested value display, Accept/Reject flow) without requiring inbox-component changes.
2. **Given** a new escalation type is registered, **When** a tenant admin opens Automated Replies settings, **Then** the new type's approval and rejection templates appear in the editor alongside existing types.

---

### Edge Cases

- **Guest retracts or edits the request before the manager acts**: If the guest sends a new message changing the requested time ("actually 2pm not 1pm"), the existing open escalation's requested time should update rather than creating a second parallel escalation. If the guest outright says "never mind, standard time is fine", the escalation should auto-resolve (no action card shown).
- **Guest re-requests after a time has already been agreed**: If the reservation already has a `scheduledCheckInAt`/`scheduledCheckOutAt` from an earlier approval and the guest asks for a different time, the system treats it as any other request: within-threshold → auto-accept (overwrite the previous scheduled value, send the approval template); outside-threshold or no threshold → escalate to the manager's Actions card (FR-013). No special "already scheduled" gate.
- **Manager accepts, then the guest sends another message before Send is clicked**: The preview stays open; the manager's pending Send is not auto-discarded by unrelated inbound traffic.
- **Manager clicks Accept but the conversation is on a channel that is offline (Hostaway send fails)**: The card surfaces a clear error inline, the scheduled time is NOT applied, the escalation is NOT resolved, the Property card continues to show the unmodified time, and the manager can retry.
- **Auto-accept race with a manager already viewing the same conversation**: If the AI auto-approves before the manager has a chance to act, the conversation thread simply shows the approval message arriving and the Property card's time row updates live. No orphan Actions card, no error.
- **Auto-accept threshold is set but the guest-requested time is ambiguous** (e.g., "early" with no time): The AI cannot compare to a threshold, so it falls back to the manager-escalation path (Story 1) — never auto-approve on inference.
- **Manager accepts via the Actions card while autopilot is enabled for the conversation**: The manager's explicit accept takes precedence; no conflicting autopilot AI reply should get queued for the same turn.
- **Multiple pending escalations on one conversation**: Each escalation renders as an independent card in the Actions panel; acting on one does not affect the others.
- **Reservation is not CONFIRMED or CHECKED_IN** (e.g., INQUIRY): Late-checkout and early-check-in escalations are not meaningful; the AI should escalate as "general inquiry" or route via existing SOPs rather than raising this card type.
- **Tenant has no templates saved AND no defaults** (shouldn't happen — defaults always exist): The system uses a hardcoded safe fallback and logs the misconfiguration for diagnostics; the guest still receives a message.
- **The existing alteration-request flow in the Actions card continues to work**: alteration requests are out of scope here but must not regress; rendering a late-checkout card next to an alteration card on the same conversation must not break either.
- **Modified time indicator stale after page switch / reload**: The Property details card must read the reservation's scheduled override on every render (not a cached value from the conversation fetch), so reloading the page or switching conversations and returning still shows the modified time correctly.

## Requirements *(mandatory)*

### Functional Requirements

#### Escalation surfacing (action card)

- **FR-001**: When the AI receives a guest request for a non-standard check-in or check-out time that falls outside any configured auto-accept threshold, the system MUST create a structured escalation identifying (a) the kind (late-checkout or early-check-in), (b) the requested time, (c) the originating conversation, (d) the originating reservation, and send a holding message to the guest (preserving today's behavior).
- **FR-002**: The inbox Actions card MUST render every open, unresolved escalation of a supported type for the currently-selected conversation. Each escalation renders as its own row/card within the Actions panel; multiple escalations stack.
- **FR-003**: A late-checkout or early-check-in action card MUST display the request kind, the requested time (parsed from the conversation), and two primary buttons: Accept and Reject.
- **FR-004**: Clicking Accept MUST flip the same card (not open a modal, not navigate away) into a preview state showing an **editable textarea** pre-filled from the tenant-configured approval template (variables substituted), plus Send and Cancel controls. The manager can freely edit the text before clicking Send; the delivered message is the textarea's contents at the moment of Send (not the original template text).
- **FR-005**: Clicking Reject MUST flip the same card into a preview state showing an **editable textarea** pre-filled from the tenant-configured rejection template (variables substituted), plus Send and Cancel controls. The manager can freely edit before Send; the delivered message is the textarea's contents at the moment of Send.
- **FR-006**: Clicking Cancel in the preview state MUST revert the card to the Accept/Reject state, with no message sent and no persistent state changed.
- **FR-007**: Clicking Send from the approval preview MUST (a) deliver the message to the guest via the conversation's active channel, (b) record the delivered message in the conversation thread as a manager-sent message, (c) update the reservation's scheduled check-in or check-out time to the requested time, (d) mark the escalation resolved, (e) clear the card from the Actions panel, (f) trigger a re-render of the Property details card so the modified time is visible immediately.
- **FR-008**: Clicking Send from the rejection preview MUST (a) deliver the message to the guest, (b) record it in the thread, (c) mark the escalation resolved, (d) NOT update any scheduled time on the reservation, (e) clear the card.
- **FR-009**: If the send fails (delivery error, upstream error), the action MUST NOT apply any scheduled-time change and MUST NOT resolve the escalation; the card MUST surface an inline error with a retry affordance.

#### Auto-accept

- **FR-010**: Each property MUST support two optional time thresholds: `autoAcceptLateCheckoutUntil` (an HH:MM time or null) and `autoAcceptEarlyCheckinFrom` (an HH:MM time or null). When unset on a property, the system MUST fall back to a tenant-level default (itself nullable).
- **FR-011**: When a guest requests a late-checkout at time T on a reservation at a property where `autoAcceptLateCheckoutUntil` resolves to a non-null U and T ≤ U, the AI MUST auto-approve: update the reservation's scheduled check-out time to T and send the approval-template message to the guest — without creating an escalation and without sending a holding message. This rule applies regardless of whether the reservation already has a `scheduledCheckOutAt` set from a prior request; the new T simply overwrites the old value.
- **FR-012**: When a guest requests an early-check-in at time T on a reservation at a property where `autoAcceptEarlyCheckinFrom` resolves to a non-null F and T ≥ F, the AI MUST auto-approve (symmetric to FR-011). Same overwrite-on-re-request rule applies.
- **FR-013**: Outside the threshold OR when no threshold is configured OR when the requested time cannot be parsed unambiguously, the AI MUST use the manual-escalation path (FR-001 and downstream). This applies equally to first requests and re-requests — a re-request is not treated specially; the threshold is the sole authority.
- **FR-014**: The AI MUST NEVER auto-reject a check-in or check-out time request. Rejection is always a manual action.
- **FR-015**: Auto-accept activity MUST be observable in the AI call log (which property's threshold matched, what requested time, what delivered time) with the same auditability as today's escalation decisions.

#### Templates

- **FR-016**: The system MUST support per-tenant reply templates for each supported escalation type. At launch, the supported types are late-checkout and early-check-in, each with two templates: Approval and Rejection.
- **FR-017**: Templates MUST support variable substitution including at minimum `{GUEST_FIRST_NAME}`, `{REQUESTED_TIME}`, and `{PROPERTY_NAME}`. Unknown variables MUST NOT cause send failure.
- **FR-018**: When a tenant has not saved a template, a system default MUST be used so the flow never blocks.
- **FR-019**: The same rendered template text used in a manual Accept preview MUST match what an auto-accept delivers for the same scenario (i.e., there is one template per (tenant, escalation-type, decision), not two parallel ones for manual vs auto).
- **FR-020**: A tenant admin MUST be able to view and edit these templates in a single settings surface without requiring developer involvement.

#### Persistence

- **FR-021**: Each reservation MUST support optional overrides for scheduled check-in time and scheduled check-out time, distinct from the property-level default times. When either override is set, it represents the agreed time for this specific reservation. When unset, the property-level default applies.
- **FR-022**: Setting a reservation scheduled time via this feature (manual Accept-Send, or auto-accept) MUST be the only internal write path that uses this field in v1. Manager manual override via the UI is acceptable if trivial to add, but not required for v1.
- **FR-023**: The scheduled check-in / check-out time MUST be surfaced to other parts of the system that currently read the property-level default time (e.g., template variables resolving to check-in/out time in AI-generated messages), so after acceptance the AI's future replies reflect the override.

#### Modified-time display (right panel)

- **FR-024**: The inbox right-panel Property details card MUST render the reservation's scheduled check-in time and scheduled check-out time when those overrides are set, replacing the property-level default values in that card.
- **FR-025**: When the Property details card renders an overridden time (either direction), the displayed value MUST be visually distinguished from the default — for example by colored text (success-green), a "modified" pill/label, a tooltip on hover revealing the default, or an equivalent treatment. The treatment must be obvious at a glance without requiring interaction.
- **FR-026**: When no override is set for a direction, the Property card MUST display the property default exactly as it does today (no regression).
- **FR-027**: The Property card MUST update live in response to an acceptance: once a Send (manual or auto-accept) completes, the card's relevant time row MUST switch to the modified state without requiring a page reload or conversation re-open.
- **FR-028**: The modified state MUST persist across page reloads, conversation switches, and other devices/managers viewing the same reservation — because the underlying state lives on the reservation record, not in transient UI state.

#### Generalization (extension point)

- **FR-029**: The Actions card MUST render escalation cards polymorphically — the frame (title, buttons, preview/send lifecycle) is shared; the specific content (which time, which fee, which quantity) is contributed per escalation type.
- **FR-030**: Adding a new escalation type to this framework MUST NOT require changing the Actions-card component or the send-preview component. It MUST require only: (a) declaring the type and its input fields, (b) providing approval/rejection templates (or inheriting system defaults), (c) wiring AI detection of that escalation type.
- **FR-031**: The existing alteration-request flow that already renders in the Actions card MUST continue to function identically. No user-visible change to alteration handling.

### Key Entities *(include if feature involves data)*

- **Scheduled-time escalation**: An open request by a guest for a non-standard check-in or check-out time on a specific reservation, in a specific conversation. Has a kind (late-checkout or early-check-in), a requested time, a created-at, a resolved-at, and a resolution outcome (accepted-and-sent, rejected-and-sent, cancelled, or still open). One conversation can carry several open escalations concurrently.
- **Reservation scheduled time override**: A per-reservation, per-direction (check-in or check-out) optional time override. When absent, the property's default applies; when present, it is the agreed-upon time for this reservation and the Property details card flags it as modified.
- **Property auto-accept threshold**: A per-property, per-direction optional time threshold that governs whether the AI can auto-approve a guest's time request without manager involvement. When absent, a tenant-level default is used; when both are absent, no auto-accept is permitted.
- **Automated reply template**: A per-tenant, per-(escalation-type, decision) text template with variable substitution. At launch this covers late-checkout and early-check-in, each with Approval and Rejection variants.
- **Action card registration**: A declarative record binding an escalation type to (a) the fields to display, (b) the applicable approval/rejection templates, (c) the write behavior on Send (what gets persisted, including whether a reservation scheduled-time override is set). The Actions panel reads from this registry at render time.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For late-checkout and early-check-in requests that fall within a configured auto-accept threshold, at least 95% of guest requests complete end-to-end (guest received approval message, reservation scheduled time updated, Property card reflects the new time) with zero manager interaction.
- **SC-002**: For requests outside the threshold or without configured thresholds, the manager can Accept and Send in fewer than 10 seconds from opening the conversation (measured from inbox render to Send click) — no navigation, no modal, no external dashboard.
- **SC-003**: The existing alteration-request flow continues to be handled in the Actions panel with zero regressions: the same acceptance tests that pass today continue to pass.
- **SC-004**: After a Send (manual or auto), any subsequent AI-generated reply in the same conversation that references check-in or check-out time reflects the new scheduled time (not the property default).
- **SC-005**: After a Send, the Property details card on the right panel shows the modified time within 1 second in the acting manager's current session, and within 5 seconds for any other manager already viewing the same conversation (via the existing real-time channel).
- **SC-006**: Tenant admins can update an approval or rejection template and see the new text take effect on the next escalation resolution within the same session, without any deploy or restart.
- **SC-007**: Adding a hypothetical new escalation type in developer time costs under one engineering day end-to-end (registration + templates + AI detection wiring + no inbox-card changes).

## Assumptions

- Today, the AI already detects late-checkout and early-check-in intent via SOPs (`sop-late-checkout`, `sop-early-checkin`) and escalates. This feature does not change detection — it extracts the requested time from the structured escalation and adds the management-side workflow.
- The existing escalation pipeline (structured output → task creation → task-dedup → Socket.IO broadcast) is the substrate; this feature adds a new escalation *type* + *action card surface*, not a parallel pipeline.
- The Actions card as it exists today in the inbox right-panel is the correct home. No new panel or page is introduced.
- The Property details card on the right panel is the correct home for the "modified check-in/out time" indicator. No new panel is introduced for this.
- Time comparisons for the auto-accept threshold use the property's local time zone. (If time-zone handling becomes complex enough to warrant clarification, it is captured as a follow-up rather than blocking this spec.)
- Autopilot-mode conversations still route check-in/out escalations through this feature (manual when outside threshold, auto-accept inside threshold) — there is no separate autopilot code path for this.
- Reject does not require a reason field for v1; the tenant-configured rejection template carries the rationale (e.g., "Unfortunately we cannot offer late checkout for this date…").
- The AI never guarantees a time outside the auto-accept policy or the manager's explicit approval. Auto-accept is an explicit tenant-configured policy and is the authority the AI mirrors — the constitution's "AI must never guarantee service times" principle is preserved in spirit (the policy guarantees, the AI executes).

## Out of Scope

- AI auto-rejection of any request. Reject is always a human action.
- Pricing/payment automation (tiered fees for late checkouts, Stripe charges, etc.). The templates may mention fees as static copy, but there is no fee-collection workflow.
- Manager override UI for manually setting a reservation's scheduled check-in/out time in the absence of a guest request. May be added later; not required for v1.
- Bulk reply-template management (import/export, A/B testing).
- Extending this action-card framework to check-in / check-out *date* changes (those belong to alterations, which already have their own flow).
- Alterations flow changes of any kind. This feature must preserve existing alteration behavior exactly.
- Multi-language template variants per tenant (one template per (tenant, type, decision) in v1; tenants run in a single language).
- Time-zone conversion across regions (v1 assumes the reservation's property time zone is the authoritative time zone for parsing and comparing threshold).
