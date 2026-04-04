# Quickstart: Testing Booking Alteration Accept/Reject

## Prerequisites

- GuestPilot running locally (backend + frontend)
- A reservation synced from Hostaway with a pending alteration (or use the manual trigger below)
- Hostaway dashboard connected in Settings (feature 029 — dashboard JWT stored)

---

## Scenario 1: Simulating an Alteration Request (Development)

Since real alteration requests are rare, simulate the webhook payload manually:

```bash
# POST a fake Hostaway webhook message that triggers alteration detection
curl -X POST http://localhost:3000/webhooks/hostaway/{tenantId} \
  -H "Content-Type: application/json" \
  -d '{
    "action": "message",
    "hostawayConversationId": "{hostawayConversationId}",
    "hostawayReservationId": "{hostawayReservationId}",
    "body": "Your guest has submitted an alteration request for their reservation.",
    "isGuest": true,
    "date": "2026-04-04 10:00:00"
  }'
```

**Expected result**: 
- Message saved to conversation
- Manager task created (`title: 'alteration-request'`)
- `BookingAlteration` record created (or with `fetchError` if Hostaway API unavailable)
- SSE broadcast triggers inbox refresh

---

## Scenario 2: View Alteration in Inbox

1. Open GuestPilot inbox
2. Click the conversation for the affected reservation
3. **Expected**: Alteration panel appears at the top of the right panel showing:
   - "Pending Alteration" label
   - Original dates/guest count
   - Proposed dates/guest count (changed fields highlighted)
   - Accept and Reject buttons

---

## Scenario 3: Accept an Alteration

1. With a pending alteration visible, click **Accept Alteration**
2. No confirmation required for acceptance
3. **Expected**:
   - Button shows loading spinner
   - On success: panel transitions to "Accepted ✓" state, buttons disappear
   - `AlterationActionLog` record created with `status: SUCCESS`

---

## Scenario 4: Reject an Alteration

1. With a pending alteration visible, click **Reject Alteration**
2. Confirmation dialog appears: "Reject this alteration request? The original booking dates will be kept."
3. Click **Confirm Reject**
4. **Expected**:
   - Button shows loading spinner
   - On success: panel transitions to "Rejected" state
   - `AlterationActionLog` record created with `status: SUCCESS`

---

## Scenario 5: Dashboard Connection Expired

1. Expire or delete `Tenant.dashboardJwt` directly in Prisma Studio
2. Try to accept or reject an alteration
3. **Expected**: Error message "Hostaway dashboard connection expired — reconnect in Settings" with link to Settings

---

## Scenario 6: Replace Placeholder Endpoints (Pre-Launch)

When a real pending alteration is available:

1. Open Chrome on `dashboard.hostaway.com`
2. Open DevTools → Network tab
3. Find the reservation with the pending alteration
4. Click Accept (or Decline) on the Hostaway dashboard
5. Capture the network request: URL, method, headers, body
6. Update the placeholder URLs in `hostaway-alterations.service.ts`
7. Test Scenario 3 and 4 against the live Hostaway API

---

## Verify in Database (Prisma Studio)

```bash
cd backend && npx prisma studio
```

Check:
- `BookingAlteration` table — one record per tested reservation, `status` transitions correctly
- `AlterationActionLog` table — one record per accept/reject action with `initiatedBy` email and `status: SUCCESS`
