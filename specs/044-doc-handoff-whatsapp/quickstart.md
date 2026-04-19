# Quickstart: Manual Verification for Feature 044

Assumes backend dev server on `localhost:3000`, frontend on `localhost:3001`, signed in as tenant admin.

## Env setup

```bash
# .env.local (backend)
WASENDER_API_KEY=...your real key...
WASENDER_BASE_URL=https://wasenderapi.com
```

If `WASENDER_API_KEY` is omitted, the feature logs intended sends but does not hit the network. Useful for UI-only verification.

## Scenario 1 — Settings page round-trip (US3)

1. Open Settings. Scroll to **Check-in Document Handoff**.
2. Enter manager recipient: `+971501234567`. Security: `+971509999999`.
3. Leave times at defaults (22:00 / 10:00). Toggle **Enabled** on. Save.
4. Reload page. Values persist.
5. Try to save with `managerRecipient = "abc"`. Expect inline validation error on that field; other fields unchanged.

## Scenario 2 — Manager reminder (US2)

1. Pick a reservation checking in tomorrow with an existing document checklist (e.g. `passportsNeeded: 2, passportsReceived: 1`).
2. In Settings, temporarily set reminder time to **3 minutes from now**.
3. Wait for the polling tick (2-min interval).
4. Check the manager's WhatsApp: should see `103; 1 missing passport` (or `103; all documents received` if complete).
5. Back in Settings → Recent sends: new row, `messageType=REMINDER, status=SENT`.

## Scenario 3 — Security handoff with media (US1)

1. Pick a reservation checking in **today** with at least one passport received (check the conversation; the guest message bearing the passport image should be the one the AI reacted to).
2. Temporarily set handoff time to **3 minutes from now**.
3. Wait for the tick.
4. Check security's WhatsApp: message with `103\n19/04 - 25/04` plus each received passport image as separate follow-up media messages.
5. Settings → Recent sends: `HANDOFF / SENT`, `imageUrlCount` matches the number of passports received.

## Scenario 4 — Cancelled reservation no-send

1. Pick a reservation checking in tomorrow.
2. Confirm a reminder row exists (`SCHEDULED`).
3. Cancel the reservation (via Hostaway simulator or admin UI).
4. Wait for the reminder time.
5. Recent sends: row should show `SKIPPED_CANCELLED`, no WhatsApp received.

## Scenario 5 — Missing WAsender key (graceful degradation)

1. Unset `WASENDER_API_KEY` and restart backend.
2. Trigger a reminder at its fire time.
3. Recent sends: row shows `SKIPPED_NO_PROVIDER`. No crash. Console shows `[WAsender] disabled — logging intended send`.

## Scenario 6 — Idempotency

1. Take a reservation whose handoff is `SENT`.
2. Update its check-in date via Hostaway.
3. Recent sends: no new `HANDOFF` row for that reservation — FR-018 enforced.

## Scenario 7 — Walk-in (clarify Q2)

1. Create a reservation today with check-in today. No docs yet.
2. Observe: no reminder row created; handoff row in `DEFERRED`.
3. Send a passport image in-conversation; AI marks received; checklist becomes complete.
4. Within 2 minutes: handoff fires.

## Scenario 8 — Regression: existing checklist flow

1. Send passport image as guest → AI calls `mark_document_received`.
2. Verify `screeningAnswers.documentChecklist.passportsReceived` still increments exactly as before.
3. Verify `screeningAnswers.documentChecklist.receivedDocs` now has a matching entry — non-breaking extension.
4. Manager-initiated manual checklist update from UI still works (adjust passport count, mark marriage cert received).

## Build verification

```bash
cd backend && npx tsc --noEmit
cd frontend && npx tsc --noEmit
```

Both must be clean on the feature's touched files.
