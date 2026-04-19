# Contract: Socket.IO Events for Handoff-State UI Refresh

Optional — the Settings page's "Recent sends" list re-fetches on page open. Live push is a nice-to-have so the operator can watch sends succeed/fail in real time without a refresh.

---

## Event: `doc_handoff_updated`

**Emitted when:** a `DocumentHandoffState` row changes status (SCHEDULED → SENT, SCHEDULED → FAILED, DEFERRED → SENT, etc.) from the polling job or reservation-update path.

**Room:** tenant-scoped. Matches the existing Socket.IO tenant-room pattern (`socket.service.ts`).

**Payload:**
```json
{
  "id": "cl...",
  "reservationId": "cl...",
  "messageType": "HANDOFF",
  "status": "SENT",
  "updatedAt": "2026-04-19T07:00:12.000Z"
}
```

**Frontend handler:** `doc-handoff-section.tsx` listens and either refreshes the recent-sends list or does a local state patch by `id`.

---

## Non-goals

- No event for row **creation** — the UI doesn't display pending rows (operators care about outcomes, not schedule).
- No guest-facing socket traffic (this is an operator-facing feature).
- No cross-tenant broadcast (§II).
