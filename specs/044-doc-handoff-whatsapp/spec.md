# Feature Specification: Check-in Document Handoff via WhatsApp

**Feature Branch**: `044-doc-handoff-whatsapp`
**Created**: 2026-04-19
**Status**: Draft
**Input**: Operator-facing automation that sends two WhatsApp messages per reservation — a document-status reminder to the manager the day before check-in, and a document handoff (images + unit + dates) to the security group on check-in day. Both recipients and send times are configurable per tenant. Uses WAsender as the outbound WhatsApp provider.

## Clarifications

### Session 2026-04-19

- Q: Does the handoff message include documents received after the reminder has already fired? → A: Yes — the attachment list is built at send time, so any document received up until the handoff actually fires is included.
- Q: For a reservation whose check-in day is today or in the past when the feature first sees it (e.g. walk-in booked at 1pm on check-in day), what happens to the reminder and handoff? → A: Reminder is skipped entirely. Handoff fires when the checklist becomes complete (all required passports + marriage cert if required). If the checklist is already complete, fires immediately. If it never becomes complete, no handoff is sent.
- Q: How long do we retain captured document image references (URLs + source message IDs) in our database? → A: Indefinitely. We store only URLs pointing at the PMS, not the image bytes themselves, so storage cost is negligible and the refs remain useful for future audit/reprocessing.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Security receives document handoff on check-in day (Priority: P1)

At a configured time on the day a reservation checks in, the security team at the property receives a WhatsApp message with the unit number, the stay dates, and images of every guest identity document the system has collected. Security uses this to recognize who is allowed to enter the building.

**Why this priority**: This is the operational payoff of the whole document-collection workflow. Without it, the AI collects passports but no one on the ground sees them — managers manually forward images every day. This user story alone delivers value even if the reminder (Story 2) is skipped.

**Independent Test**: Create a reservation checking in today, mark at least one passport received via the existing document-checklist flow, set the security WhatsApp number in settings and the handoff send time to a few minutes from now, wait for the scheduled fire. Confirm the security number receives a message matching the format `{UNIT_NUMBER}\n{DD/MM} - {DD/MM}` with the passport image attached.

**Acceptance Scenarios**:

1. **Given** a reservation checking in today with 2 passports received and a security recipient configured, **When** the handoff send time arrives, **Then** one WhatsApp message is delivered to the security recipient containing the unit number on line 1, `DD/MM - DD/MM` of the stay dates on line 2, and both passport images attached, and the reservation is marked as having had its handoff sent.
2. **Given** a reservation checking in today with zero documents received, **When** the handoff send time arrives, **Then** the security recipient still receives a text-only message with unit number and dates (no media, no mention of what is missing), and the reservation is marked as handoff sent.
3. **Given** a reservation that has already had its handoff sent, **When** any trigger fires again for that reservation (re-scheduled, feature re-enabled, etc.), **Then** no second message is sent.
4. **Given** a reservation that has been cancelled, **When** the handoff send time arrives, **Then** no message is sent.

---

### User Story 2 — Manager receives document-status reminder day before check-in (Priority: P1)

At a configured time the day before a reservation checks in, the manager receives a WhatsApp message telling them whether that reservation's documents are complete. If documents are missing, the message lists what is missing so the manager can chase the guest. If documents are complete, the message confirms so.

**Why this priority**: Equal-priority with Story 1 because the two messages together form the intended workflow — the reminder *causes* more documents to be collected before the handoff fires the next morning. Shipping only Story 1 without Story 2 means the handoff often goes out with missing docs. Listed second only because Story 1 is the harder integration (attaching media).

**Independent Test**: Create a reservation checking in tomorrow with an incomplete checklist (e.g. 1 of 2 passports received), set the manager recipient and reminder send time, wait. Confirm the manager number receives a text message matching `{UNIT_NUMBER}; 1 missing passport`. Repeat with a complete checklist and confirm it says `{UNIT_NUMBER}; all documents received`.

**Acceptance Scenarios**:

1. **Given** a reservation checking in tomorrow with a complete checklist (all passports received, marriage cert received if required), **When** the reminder send time arrives, **Then** the manager receives a text-only message `{UNIT_NUMBER}; all documents received`.
2. **Given** a reservation checking in tomorrow with 1 of 2 passports received and no marriage cert required, **When** the reminder send time arrives, **Then** the manager receives `{UNIT_NUMBER}; 1 missing passport`.
3. **Given** a reservation checking in tomorrow with 0 of 2 passports received and a marriage cert required but not received, **When** the reminder send time arrives, **Then** the manager receives `{UNIT_NUMBER}; 2 missing passports, marriage cert missing`.
4. **Given** a reservation that has already had its reminder sent, **When** any trigger fires again, **Then** no second reminder is sent.
5. **Given** a reservation with no document checklist attached at all (screening never created one), **When** the reminder send time arrives, **Then** no reminder is sent (the feature only applies to reservations where the AI or the manager has established a document-collection expectation).

---

### User Story 3 — Operator configures recipients and schedule in settings (Priority: P2)

A tenant administrator opens the application's settings, enters the manager's WhatsApp number and the security group's WhatsApp number, chooses the reminder time (default 22:00) and the handoff time (default 10:00), and toggles the feature on. Without this configuration the feature sits idle.

**Why this priority**: Without configuration the messages never fire, so this is load-bearing — but seeded defaults mean Story 1 and Story 2 are demoable without it on the happy path. Listed as P2 because it is simpler UI work that can follow the scheduling/sending plumbing.

**Independent Test**: Log in as a tenant admin, open Settings, fill in the two WhatsApp numbers and the two times, save. Verify the values persist across page reload. Verify the feature does not fire for any tenant that has left the fields blank.

**Acceptance Scenarios**:

1. **Given** a tenant admin on the settings page, **When** they enter a WhatsApp number in international format (e.g. `+971501234567`) and save, **Then** the value persists and is used for subsequent sends.
2. **Given** a tenant admin has left the manager or security recipient blank, **When** a reservation's send time arrives, **Then** that message is skipped (the other still fires if its recipient is set), and the skip is logged in an operator-visible audit entry.
3. **Given** a tenant admin changes the reminder or handoff time, **When** reservations already scheduled for the old time have not yet fired, **Then** those pending sends use the new time; reservations that already fired are unaffected.

---

### Edge Cases

- **Send attempt fails (WhatsApp provider returns error):** the reservation is NOT marked as sent, so the next scheduled poll can retry. A failure count is recorded; after three consecutive failures for the same reservation+message-type, it is marked permanently failed and surfaced in an operator log (no more auto-retries).
- **Property has no unit number / short code:** fall back to the property's display name. If that is also blank, send the reservation code so the recipient can still identify the booking.
- **Guest's stay dates update after check-in and before handoff fires:** the handoff uses the current dates at send time, not the dates at schedule time.
- **Reservation is rescheduled from tomorrow to next week:** if the reminder has not yet fired, it re-schedules to the new check-in-minus-one-day. If it already fired, no re-send.
- **Guest sends multiple images in one message claiming to be passports:** behavior mirrors the existing document-checklist update flow — the coordinator decides which count toward which slot; this feature only forwards whatever images ended up attributed to received slots.
- **Images become unavailable at send time (upstream storage error):** fall back to sending the text portion of the handoff only; log the missing-media incident.
- **Timezone ambiguity (property and tenant in different timezones):** all schedules resolve against the property's timezone, not the tenant's.
- **Manager or security recipient is the same as a guest's number:** not validated; operator's responsibility.

## Requirements *(mandatory)*

### Functional Requirements

#### Recipient & schedule configuration
- **FR-001**: System MUST allow a tenant administrator to configure two independent WhatsApp recipient numbers per tenant: one "manager" recipient for reminders and one "security" recipient for handoffs.
- **FR-002**: System MUST allow a tenant administrator to configure the reminder send time (hour + minute) and the handoff send time, each independently, per tenant, with seeded defaults of 22:00 and 10:00 respectively.
- **FR-003**: System MUST allow a tenant administrator to disable the feature by either clearing the relevant recipient field or toggling the feature off; clearing one recipient MUST NOT disable the other.
- **FR-004**: System MUST validate that recipient numbers are in international format (starting `+` followed by digits, 8–15 digits total) before saving.

#### Document image capture
- **FR-005**: System MUST capture, at the moment a document is marked received (by the AI via the existing document-confirmation tool, or by a manager's manual checklist update), a stable reference to the source message and any image attachments associated with that event, so those images can be retrieved and forwarded later.
- **FR-006**: System MUST associate each captured image reference with a document slot (passport N of M, marriage certificate) so the handoff can be ordered and the image count aligns with the checklist's received count.
- **FR-007**: System MUST continue to function if the underlying PMS image URL becomes invalid by the send time: the handoff falls back to a text-only send and the failure is logged, rather than blocking the whole message.

#### Scheduling
- **FR-008**: System MUST schedule a reminder send for each eligible reservation to fire at the tenant's configured reminder time on the day before the reservation's check-in date, in the property's timezone.
- **FR-009**: System MUST schedule a handoff send for each eligible reservation to fire at the tenant's configured handoff time on the day of the reservation's check-in date, in the property's timezone.
- **FR-010**: A reservation is "eligible" for the reminder when its status is not cancelled and a document checklist has been created for it (meaning the AI or a manager has established that documents are expected).
- **FR-011**: A reservation is "eligible" for the handoff when its status is not cancelled. A reservation without a checklist is still eligible for the handoff text (security still needs to know someone is arriving), but with no attachments.
- **FR-012**: For the reminder only: if the tenant's configured reminder time has already passed on the reminder's target day (check-in minus 1) at the moment the reservation is first scheduled — but that target day is still today — System MUST send the reminder immediately rather than skip it.
- **FR-012a**: If the reminder's target day (check-in minus 1) is already fully in the past when the reservation is first scheduled (a walk-in or same-day booking), System MUST skip the reminder entirely.
- **FR-012b**: For the handoff: if the handoff's configured fire time is still in the future on check-in day, it fires normally at that time. If the handoff's configured fire time is already past when the reservation is first scheduled on check-in day: (a) if there is no document checklist for the reservation, send the text-only handoff immediately; (b) if a checklist exists and is already complete, send the handoff immediately; (c) if a checklist exists and is incomplete, defer the handoff and fire it the moment the checklist becomes complete — if it never becomes complete, no handoff is sent.
- **FR-013**: If the reservation's check-in date changes after scheduling and before firing, System MUST reschedule the pending sends to the new dates.

#### Message content
- **FR-014**: The reminder message MUST have the format `{UNIT_IDENTIFIER}; all documents received` when the checklist is complete. `{UNIT_IDENTIFIER}` resolves to the property's unit number/short code, falling back to the property display name, falling back to the reservation code.
- **FR-015**: The reminder message MUST have the format `{UNIT_IDENTIFIER}; {N} missing {TYPE}` when the checklist is incomplete, where `{TYPE}` is pluralized (`passport` vs `passports`) and marriage certificate is appended as `marriage cert missing` if needed. Zero-received and complete are both valid states the message covers.
- **FR-016**: The handoff message MUST have the format `{UNIT_IDENTIFIER}\n{DD/MM} - {DD/MM}` (check-in date — check-out date) as the text portion, with every captured received-document image attached as media. The attachment list MUST be built at the moment the handoff fires (not at schedule time), so documents received in the window between the reminder firing and the handoff firing are included.
- **FR-017**: The handoff message MUST NOT contain any reference to what is missing or what count is expected. Only what is present is forwarded.

#### Idempotency & durability
- **FR-018**: System MUST send each message type at most once per reservation in the reservation's lifetime (reminder once, handoff once), regardless of schedule changes, toggle flips, or recipient edits.
- **FR-019**: System MUST persist a "sent" record (timestamp, recipient, message body, provider message ID if available) for every successfully delivered message, viewable by an operator.
- **FR-020**: System MUST persist a "failed" record after 3 consecutive delivery failures for the same reservation+message-type and MUST NOT continue retrying thereafter without manual intervention.
- **FR-021**: System MUST NOT send either message if the reservation is cancelled at the moment the send is about to fire, even if it was eligible at schedule time.

#### Regression & safety
- **FR-022**: The existing document-checklist flow (screening agent creates, coordinator/manager updates) MUST continue to function with no change in behavior from the operator's or guest's perspective. This feature only adds image capture alongside, not in place of, the existing count update.
- **FR-023**: System MUST NOT send any WhatsApp message to the guest as part of this feature. All recipients are operator-side (manager, security).
- **FR-024**: If the WhatsApp provider credentials are missing or invalid, the feature MUST degrade to logging intended sends without crashing the reservation-processing pipeline.

### Key Entities *(include if feature involves data)*

- **Tenant WhatsApp configuration**: per-tenant settings holding two recipient numbers (manager, security), two send times (reminder, handoff), and a feature on/off flag.
- **Document image reference**: associated with a document-checklist slot; holds the source message identifier and the image URL(s) that were captured when that slot was marked received.
- **Scheduled handoff send**: per-reservation record of a pending or completed send, carrying message type (reminder | handoff), scheduled fire time, status (pending | sent | failed | skipped), recipient used, message body used, provider message ID, failure count.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On the day after this feature launches, 100 % of reservations with a check-in that day and with at least one document received, whose tenant has configured a security recipient, result in a WhatsApp message to that recipient — measured by the count of "sent" records versus the count of eligible reservations.
- **SC-002**: Every reminder and handoff message is delivered within 5 minutes of its scheduled fire time, 95th percentile, measured over a rolling 7-day window.
- **SC-003**: Zero reservations receive duplicate reminder or handoff messages — measured by a nightly check that no reservation has more than one "sent" record per message type.
- **SC-004**: The operator who previously forwarded guest documents manually each morning spends zero minutes per day doing so for tenants that have configured this feature — measured by a qualitative check-in with the launch tenant at day 7.
- **SC-005**: No regression in the existing document-checklist flow: manager-facing metrics (checklists created per day, documents marked received per day) stay within ±5 % of their pre-launch 14-day baseline.

## Assumptions

- WAsender remains the chosen outbound WhatsApp provider; the account has been provisioned outside this feature's scope and credentials will be supplied via environment.
- Property-local timezone information is already available for every property (existing field or derivable from address); no new data gathering is required from operators.
- Properties have a unit identifier (short code, number, or display name) populated for every listing. If not, the reservation code is used as fallback — this is acceptable for v1.
- The existing document-checklist data model can be extended to hold image references without breaking existing consumers.
- WAsender's API accepts either a publicly reachable media URL or accepts a direct media upload; whichever it supports will be used. If the PMS's image URLs turn out not to be reachable by WAsender, a download-then-upload step will be added during implementation.
- Tenant administrators are the appropriate authority to set operator-side recipient numbers; no per-user or per-property override is needed for v1.
- Running the reminder and handoff once per reservation each is sufficient operational value; a repeating nag (e.g. every 2 hours until docs are received) is not desired.
- Captured document image references are stored indefinitely alongside the reservation. We store only URLs pointing at the source system (not raw image bytes), so retention cost is negligible; no automatic purge is scheduled in v1.

## Dependencies

- **WAsender WhatsApp API** (external) — required for message delivery. Credentials and base URL provisioned out of band.
- **Property-management-system image hosting** — images captured at mark-received time must remain fetchable at handoff send time. If they are not, the handoff degrades per FR-007.
- **Existing document-checklist service** — this feature extends its data, not replaces it. Its contract must stay stable.
- **Tenant / Property timezone metadata** — required by FR-008 / FR-009 scheduling.

## Out of Scope for v1

- Re-hosting captured document images on any third-party storage (Google Drive, S3, etc.) beyond what is strictly needed for WAsender delivery.
- Per-property recipient overrides (one security team for all properties is assumed).
- Automated retry beyond three attempts; permanently failed sends require manual intervention.
- Any message to the guest themselves — this feature is entirely operator-facing.
- Rich doc-type labels on the security handoff (no captions; images only).
- Attaching non-ID documents (e.g. contract PDFs); only passport and marriage certificate images captured via the existing checklist flow are in scope.
- A resend/"resend handoff now" operator button — deferred to a follow-up.
