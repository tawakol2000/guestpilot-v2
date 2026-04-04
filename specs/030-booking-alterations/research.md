# Research: Booking Alteration Accept/Reject

## Decision 1: Alteration Data Trigger Mechanism

**Decision**: Use the existing `isAlterationRequest` detection in `webhooks.controller.ts:421` as the trigger. No new polling, webhook registration, or sync job needed.

**Rationale**: The detection already fires reliably on incoming Hostaway system messages. It already skips AI and creates a manager task. Extending it to also call the Hostaway alteration API is a minimal, low-risk addition to existing code.

**Alternatives considered**:
- Polling: Rejected — adds infrastructure complexity and latency.
- Webhook-driven (new Hostaway webhook type): Rejected — requires Hostaway to support a dedicated alteration webhook, which is unconfirmed.
- On-demand fetch on conversation open: Rejected — requires calling Hostaway on every conversation load, even when no alteration exists.

## Decision 2: Hostaway Alteration API Endpoints

**Decision**: Placeholder endpoints used during development. Real endpoints must be intercepted from the Hostaway dashboard when a pending alteration is available before launch.

**Known confirmed endpoint**:
- `GET /reservations/{hostawayReservationId}/alterations` — returns array of alterations (confirmed working, returns `{status: "success", result: []}` for reservations without pending alterations).

**Placeholder endpoints (to be replaced)**:
- Accept: `PUT /reservations/{hostawayReservationId}/alterations/{alterationId}/accept`
- Reject: `PUT /reservations/{hostawayReservationId}/alterations/{alterationId}/decline`

**How to discover real endpoints**: With a pending alteration on a real reservation, open Chrome DevTools → Network tab on `platform.hostaway.com`, click Accept or Decline, capture the request URL and payload. Same method used successfully in feature 029 for inquiry approve/reject.

**Auth**: Same `jwt` header pattern as feature 029 — dashboard JWT stored encrypted in `Tenant.dashboardJwt`.

## Decision 3: BookingAlteration Persistence Strategy

**Decision**: Store fetched alteration details in a new `BookingAlteration` DB record linked to the reservation. One record per reservation (upsert on new alteration).

**Rationale**: Avoids calling Hostaway on every conversation open. The record is created when the webhook fires (which is immediate on alteration request) and updated when accept/reject is actioned. If the initial fetch fails, `fetchError` is stored so the UI can show a meaningful error.

**Alternatives considered**:
- No persistence (fetch on demand): Rejected — slower UI load, extra Hostaway API calls, and no source of truth if Hostaway rate limits.
- Store only the alteration ID (lazy load details): Rejected — adds a second fetch round-trip on every inbox open.

## Decision 4: Accept/Reject Pattern

**Decision**: Mirror feature 029 exactly — same dashboard JWT validation, same audit log pattern, same error handling (401 → clear JWT + reconnect prompt, 409/422 → meaningful message).

**Rationale**: Consistency with 029 reduces implementation risk and gives hosts a familiar experience. The `AlterationActionLog` model mirrors `InquiryActionLog`.

## Decision 5: Post-Action Reservation Sync

**Decision**: After a successful accept, do NOT immediately update the local `Reservation` record (checkIn, checkOut, guestCount). Rely on the next Hostaway sync to update it.

**Rationale**: Attempting an optimistic update without confirmed data from Hostaway risks displaying incorrect values. The existing reservation sync (import/sync service) will pick up the updated booking. The alteration panel itself transitions to "Accepted" state immediately, giving the host clear visual confirmation.
