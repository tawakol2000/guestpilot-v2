# Quickstart — 043-checkin-checkout-actions

End-to-end manual verification after implementation. Walk through all four stories + the alteration non-regression + the §III constitutional check.

## Prerequisites

- Backend running (`cd backend && npm run dev`), schema pushed (`npx prisma db push` after the edits).
- Frontend running (`cd frontend && npm run dev`).
- At least one tenant with at least one property and one CONFIRMED reservation.
- At least one INQUIRY reservation with a pending alteration (for the regression check). If none exist, create one via Prisma Studio using the existing `BookingAlteration` fields.

Set up the tenant with:
- `Property.autoAcceptLateCheckoutUntil = "13:00"` (via SQL / Prisma Studio).
- `Property.autoAcceptEarlyCheckinFrom` left null.
- No `AutomatedReplyTemplate` rows initially — we want to verify defaults render.

---

## Story 1 — Manager accepts a late-checkout request (MVP)

1. In the CONFIRMED conversation, simulate a guest message: "can we check out at 2pm?" (outside the 13:00 threshold → must escalate to manager).
2. Wait for the AI pipeline to process. Confirm:
   - The AI sends the holding message to the guest ("Standard checkout is 11 AM… I'll check with the manager").
   - A Task row is created with `type='late_checkout_request'`, `metadata.requestedTime='14:00'`, `status='open'`.
3. Open that conversation in the inbox. In the right-panel Actions card, verify:
   - A card titled "Late checkout · 2:00 PM" appears with Accept and Reject buttons.
   - The existing alteration card (if any) is still visible above/below without regression.
4. Click **Accept**. Verify:
   - The card flips to a textarea pre-filled with the default approval template, variables substituted: "Hi [GuestFirstName] — confirmed, you can check out at 2:00 PM. Safe travels!"
   - The textarea is editable. Edit it to: "Hi Noah — all good, 2pm works. See you at checkout!"
   - Send and Cancel buttons appear.
5. Click **Cancel**. Verify:
   - The card reverts to Accept / Reject.
   - No message delivered.
   - No reservation changes.
6. Click Accept again, leave the edited text, click **Send**. Verify:
   - The edited message appears in the conversation thread.
   - The guest receives the edited message (check Hostaway).
   - The Task row is `status='resolved'`, `completedAt` set.
   - The Actions card no longer shows this task.
   - The Property details card's "Check-out Time" row now shows "2:00 PM" with a green "Modified" pill/label.
   - A `TaskActionLog` row exists with `action='accepted'`, `deliveredBody` matching the edited text, `appliedTime='14:00'`.
7. Reload the page. Reopen the conversation. Verify the Property card still shows the modified time with its treatment.

## Story 1 (Reject variant)

1. Trigger a new late-checkout request ("can we check out at 3pm?").
2. In the Actions card, click **Reject**.
3. Verify the preview textarea pre-fills with the default rejection template.
4. Edit if desired. Click **Send**. Verify:
   - The rejection message delivers to the guest.
   - The Task is resolved.
   - The reservation's `scheduledCheckOutAt` is NOT updated.
   - The Property card shows the default 11:00 AM time (no Modified pill).
   - `TaskActionLog` row has `action='rejected'`, `appliedTime=null`.

---

## Story 2 — Auto-accept within threshold

1. In the same conversation, simulate a new guest message: "can we check out at 12:30 instead?" (inside the 13:00 threshold).
2. Verify the AI pipeline:
   - Does NOT create a new escalation task.
   - Does NOT send a holding message.
   - Directly sends the default approval template, rendered: "Hi Noah — confirmed, you can check out at 12:30 PM. Safe travels!"
   - Updates `Reservation.scheduledCheckOutAt = '12:30'` (overwriting the previous 14:00).
   - Creates a resolved Task with `type='late_checkout_request'`, `status='resolved'`.
   - Creates a `TaskActionLog` with `actorKind='ai_autoaccept'`, `appliedTime='12:30'`.
   - The AI call's `ragContext` includes `{ timeRequestDecision: { matchedThreshold: '13:00', approved: true, appliedTime: '12:30' } }`.
3. Check the Property details card — should now show "Check-out Time: 12:30 PM" with the Modified treatment.
4. The Actions panel should remain empty (no open tasks).

## Story 2 (out-of-threshold fallback)

1. Send: "push checkout to 3pm please?" (outside 13:00 threshold).
2. Verify the AI falls back to the manual escalation path (Story 1).
3. Manager Accept flow should work identically, overwriting the 12:30 override to 15:00.

---

## Story 3 — Editable per-tenant templates

1. Log in as a tenant admin. Open Settings → Automated Replies.
2. Verify all four rows render with `isDefault=true` and default body.
3. Edit "Late checkout approval" body to: "All set, {GUEST_FIRST_NAME}! Your checkout's been pushed to {REQUESTED_TIME}." Save.
4. Trigger another late-checkout request outside the threshold. Open the Actions card. Click Accept. Verify the preview now uses the new copy.
5. Delete the row (via the DELETE endpoint or a Revert button in the UI). Verify the next preview reverts to the default.
6. Trigger an auto-accept within threshold. Verify the auto-sent message also uses the latest saved template (SC-005 — changes take effect next escalation, no restart).

## Template variable edge cases

- Edit a template to reference an undefined variable like `{SOMETHING_BOGUS}`. Verify send still succeeds and the bogus token renders as empty string (not as literal text, not as an error).
- Edit a template to blank-string (`""`). The API should accept it (or reject per validation policy); confirm behavior matches contract.

---

## Story 4 — Generalization smoke test

Quickest way to verify the polymorphic renderer is working correctly without building a new escalation type end-to-end:

1. In `frontend/components/actions/action-card-registry.ts`, temporarily alias `early_checkin_request` to the same component as `late_checkout_request`.
2. Trigger an early-check-in escalation.
3. Verify the card renders with correct title and time — the registry indirection worked.
4. Revert the alias.

Full new-type addition (amenity-with-fee, extra-guests-approval) should be a follow-up feature, not verified here.

---

## Alteration-flow non-regression (FR-031 / SC-003)

1. Find a conversation that has a pending `BookingAlteration` (INQUIRY with proposed changes).
2. Open it. Verify the Actions card shows the alteration card with its existing Accept / Reject (or equivalent) behavior.
3. Accept the alteration. Verify it behaves exactly as it does today — no visual change, no new button, no extra fields, no changed side effects.
4. Reject similarly.

---

## Constitutional checks

- **§I Graceful degradation**: temporarily break the auto-accept service (throw in `scheduled-time.service.ts`). Trigger an in-threshold request. Verify the pipeline falls back to the manual escalation path and the conversation still gets handled — no exception leaks to the caller.
- **§II Multi-tenant isolation**: with a JWT from Tenant A, POST to `/api/tasks/<id-from-Tenant-B>/accept`. Verify 404.
- **§III Guest safety**: confirm (a) the AI never auto-rejects (there's no code path that does), (b) the operator must explicitly set a threshold before auto-accept fires (null threshold → always escalate).
- **§IV Structured output**: inspect an `AiApiLog.rawResponse` from a successful auto-accept — it should include the `scheduledTime` field in valid JSON form.
- **§VI Observability**: for every action (auto-accept, manual accept, manual reject), verify a `TaskActionLog` row exists and a corresponding `ragContext.timeRequestDecision` (for the auto-accept case) is recorded.

---

## What NOT to verify here

- Multi-tenant threshold fallback (property null → tenant default). Worth a separate test but not on the critical quickstart path.
- Socket.IO real-time propagation across two browsers — nice to have but time-consuming in manual verification; trust the implementation's broadcast call.
- Timezone edge cases. V1 assumes the property's local timezone; cross-timezone tests belong to a follow-up.
