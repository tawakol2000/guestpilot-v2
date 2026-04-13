# Batch D Handoff — Backend Multi-Device Sync Fixes

**Date:** 2026-04-13
**Branch:** `040-autopilot-shadow-mode`
**Commits:** 5 (09be670..7fd75d2)
**Files changed:** 8 (235 insertions, 123 deletions)

---

## Fixes delivered

### D1 — Add `starred` to conversation detail response
Added `starred: conversation.starred` to the `GET /api/conversations/:id` response object. iOS no longer needs to pass starred via nav state for deep links.
**Verified:** Field present in response mapping at conversations.controller.ts:132.

### D2 — Broadcast `unread_count_changed` on detail fetch
After zeroing `unreadCount` on detail open, emits `broadcastToTenant(tenantId, 'unread_count_changed', { conversationId, unreadCount: 0 })`. Multi-device unread badges can now sync without waiting for next message.
**Verified:** Broadcast call added immediately after updateMany at conversations.controller.ts:94.

### D3 — Include `message.id` in HOST webhook broadcasts
Alteration-request broadcast at webhooks.controller.ts:468 now includes `savedMsg.id` in the message payload. The main broadcast at line 708 already used the conditional spread pattern. Edited-message broadcast at line 630 already included `existing.id`. All webhook message broadcasts now include id.
**Verified:** Grepped all `broadcastCritical(tenantId, 'message'` in webhooks.controller.ts — all three include id.

### D4 — Broadcast on inquiry/alteration actions
Four success paths now emit `reservation_updated`:
- `reservations.ts` approve → `{ reservationId, conversationIds, status: 'CONFIRMED' }`
- `reservations.ts` reject → `{ reservationId, conversationIds, status: 'CANCELLED' }`
- `alterations.ts` accept → `{ reservationId, conversationIds }`
- `alterations.ts` reject → `{ reservationId, conversationIds }`
**Verified:** broadcastToTenant imported and called in all four success branches.

### D5 — Include `aiEnabled` in `property_ai_changed` event
Changed payload from `{ propertyId, aiMode }` to `{ propertyId, aiMode, aiEnabled }`. iOS can now distinguish off (aiEnabled=false, aiMode='autopilot') from actual autopilot (aiEnabled=true, aiMode='autopilot').
**Verified:** Emit at conversations.controller.ts:283 now includes aiEnabled.

### D6 — Fix task sort order
Changed `orderBy: [{ status: 'asc' }]` to `{ status: 'desc' }`. Now `open` sorts before `completed` (alphabetically reversed).
**Verified:** GET /api/tasks returns open tasks first when mixed statuses present.

### D7 — Clear `completedAt` on task reopen
Added `if (status === 'open') data.completedAt = null;` alongside the existing completed handler.
**Verified:** Reopening a task via PATCH clears completedAt in the update data.

### D8 — Allow task PATCH to edit title/note/urgency
Extended PATCH /api/tasks/:id to accept `title` (1-200 chars), `note` (max 2000 chars, nullable), `urgency` (validated against known values). Invalid values return 400.
**Verified:** Destructure expanded, validation blocks added with early returns.

### D9 — Move phantom inline routes to dedicated route files
- `POST /api/messages/:id/rate` → `routes/messages.ts`
- `GET /api/ai-logs` + `GET /api/ai-logs/:id` → `routes/ai-logs.ts`
- Removed `makeKnowledgeController`, `getAiApiLog`, `authMiddleware` imports from app.ts
- No inlined API routes remain in app.ts (only `/health`)
**Verified:** `grep 'app.(post|get).*\/api' src/app.ts` returns zero matches.

---

## Files changed

| File | Changes |
|---|---|
| `backend/src/controllers/conversations.controller.ts` | D1: starred in detail, D2: unread broadcast, D5: aiEnabled in property event |
| `backend/src/controllers/task.controller.ts` | D6: sort order, D7: completedAt clear, D8: title/note/urgency edit |
| `backend/src/controllers/webhooks.controller.ts` | D3: message.id in alteration broadcast |
| `backend/src/routes/reservations.ts` | D4: reservation_updated on approve/reject |
| `backend/src/routes/alterations.ts` | D4: reservation_updated on alteration accept/reject |
| `backend/src/routes/messages.ts` | D9: new file, message rating route |
| `backend/src/routes/ai-logs.ts` | D9: new file, AI logs routes |
| `backend/src/app.ts` | D9: removed 115 lines of inline routes, added 2 router mounts |

## Build verification

```
npx tsc --noEmit     → clean
npx prisma validate  → valid
```

No schema changes in this batch. No deployment.
