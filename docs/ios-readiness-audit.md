# iOS Readiness Audit — Backend Side

**Date:** 2026-04-13
**Branch:** `040-autopilot-shadow-mode` (20 commits ahead of `advanced-ai-v7`)
**Scope:** Cross-repo audit — backend TypeScript source vs iOS Swift source vs 7 iOS backend contracts

---

## 1. Executive Summary

1. **The backend can support iOS prototyping today** for the core inbox/messaging flow. No blocking endpoint gaps exist for reading conversations, messages, or tasks.
2. **iOS push notifications do not work.** Backend has Web Push (VAPID) only. iOS has a `PushManager` that acquires an APNs token and stores it in Keychain, but there is no backend endpoint to register it and no APNs sender. This is the single biggest infrastructure gap.
3. **Hostaway send failures are silently swallowed.** iOS will show "sent" (201) even when Hostaway rejects the message. The user has no way to know a message was lost. This is a data-loss risk for real-guest messaging.
4. **No server-side send guards exist.** There is no rate limit on `POST /messages`, no conversation-status gate, no content-length limit beyond Express's 10MB body parser. A send-loop bug in iOS could spam real guests.
5. **Task REST mutations (POST/PATCH/DELETE) do not broadcast socket events.** Multi-device task sync is broken for manual actions.
6. **The reservation sync job hardcodes `aiMode: 'copilot'`** for all new reservations, ignoring the property's current AI mode. Properties set to autopilot or off will see new reservations revert to copilot.
7. **Password change does not verify current password.** Anyone with a valid JWT can change the password. Security risk.
8. **No structured logging, no Sentry/Datadog.** 161 `console.log` calls across 37 files. Production errors go to Railway stdout only. Observability limited to Langfuse (AI calls only).
9. **All list endpoints are unpaginated.** Conversations, tasks, and reservations return full arrays. Acceptable for current scale (~100s) but will degrade past ~1000 items.
10. **Shadow Mode preview fields ARE now returned on the detail endpoint** (contradicting the iOS contracts). iOS Swift models don't decode `previewState` on detail messages — this is fine for v1 but the contract docs are stale.

---

## 2. Endpoint Surface Analysis

### 2.1 Endpoints iOS calls → backend handlers (full matrix)

| # | iOS Call Site | Method + Path | Backend Handler | Match? | Notes |
|---|---|---|---|---|---|
| 1 | `APIClient.swift:157` | `POST /auth/login` | `auth.controller.ts:67` | **Match** | Response shape matches `LoginResponse` |
| 2 | `APIClient+Conversations.swift:9` | `GET /api/conversations` | `conversations.controller.ts:31` | **Match** | Bare array response, all fields present |
| 3 | `APIClient+Conversations.swift:16` | `PATCH /api/conversations/:id/star` | `conversations.controller.ts:555` | **Match** | `{ starred: Bool }` both sides |
| 4 | `APIClient+Conversations.swift:27` | `PATCH /api/conversations/:id/resolve` | `conversations.controller.ts:590` | **Match** | `{ status: String }` both sides |
| 5 | `APIClient+Conversations.swift:38` | `PATCH /api/conversations/:id/ai-mode` | `conversations.controller.ts:440` | **Match** | `{ aiMode: String }` both sides |
| 6 | `APIClient+ConversationDetail.swift:10` | `GET /api/conversations/:id` | `conversations.controller.ts:73` | **Partial** | Backend returns `previewState`, `originalAiText`, `editedByUserId` on messages; iOS `Message` model doesn't decode these (safe to ignore) |
| 7 | `APIClient+ConversationDetail.swift:18` | `GET /api/conversations/:id/reservation` | `conversations.controller.ts` (getReservation) | **Match** | Returns reservation + guest + property |
| 8 | `APIClient+ConversationDetail.swift:24` | `GET /api/conversations/:id/suggestion` | `conversations.controller.ts` (getSuggestion) | **Match** | `{ suggestion: String? }` |
| 9 | `APIClient+ConversationDetail.swift:33` | `POST /api/conversations/:id/messages` | `messages.controller.ts:19` | **Match** | `{ content, channel? }` → `{ id, role, content, sentAt }` |
| 10 | `APIClient+ConversationDetail.swift:44` | `POST /api/conversations/:id/notes` | `messages.controller.ts` (sendNote) | **Match** | Same shape as messages |
| 11 | `APIClient+ConversationDetail.swift:56` | `POST /api/conversations/:id/messages/translate` | `messages.controller.ts` (translateAndSend) | **Match** | LLM rewrite endpoint |
| 12 | `APIClient+ConversationDetail.swift:68` | `POST /api/conversations/:id/approve-suggestion` | `conversations.controller.ts:463` | **Match** | `{ editedText?: String }` both sides |
| 13 | `APIClient+ConversationDetail.swift:80` | `POST /api/shadow-previews/:messageId/send` | `shadow-preview.controller.ts:24` | **Match** | `{ editedText?: String }` both sides |
| 14 | `APIClient+ConversationDetail.swift:90` | `POST /api/conversations/:id/cancel-ai` | `conversations.controller.ts` (cancelPendingAi) | **Match** | `{}` → `{ ok: true }` |
| 15 | `APIClient+ConversationDetail.swift:98` | `POST /api/reservations/:id/approve` | `reservations.ts:198` | **Match** | Returns `{ success, action, reservationId, previousStatus }` |
| 16 | `APIClient+ConversationDetail.swift:109` | `POST /api/reservations/:id/reject` | `reservations.ts:279` | **Match** | Same shape as approve |
| 17 | `APIClient+Calendar.swift:18` | `GET /api/reservations` | `reservations.ts:28` | **Match** | Query params: startDate, endDate, propertyId?, status? |
| 18 | `APIClient+Calendar.swift:43` | `GET /api/properties` | `properties.controller.ts:12` | **Match** | Bare array response |
| 19 | `APIClient+Tasks.swift:8` | `GET /api/tasks` | `task.controller.ts:7` | **Match** | Mapped response with guestName/propertyName |
| 20 | `APIClient+Tasks.swift:14` | `POST /api/tasks` | `task.controller.ts:64` | **Match** | `{ title, note?, urgency, propertyId? }` |
| 21 | `APIClient+Tasks.swift:19` | `PATCH /api/tasks/:id` | `task.controller.ts:102` | **Match** | `{ status?: String }` — but backend also accepts `dueDate`, `assignee` |
| 22 | `APIClient+Tasks.swift:26` | `DELETE /api/tasks/:id` | `task.controller.ts:121` | **Match** | → `{ ok: true }` |
| 23 | `APIClient+Hostaway.swift:8` | `GET /api/hostaway-connect/status` | `hostaway-connect.ts:116` | **Match** | Full connection status object |
| 24 | `APIClient+Hostaway.swift:14` | `GET /api/import/progress` | `import.controller.ts:54` | **Match** | Import progress fields |
| 25 | `APIClient+Hostaway.swift:20` | `GET /health` | `app.ts:61` (inline) | **Match** | `{ status, timestamp }` |
| 26 | `APIClient+Properties.swift:9` | `GET /api/properties/ai-status` | `properties.controller.ts:35` | **Match** | Array of PropertyAIStatus |
| 27 | `APIClient+AIMode.swift:11` | `PATCH /api/conversations/ai-toggle-property` | `conversations.controller.ts:240` | **Partial** | iOS sends `{ propertyId, aiMode }`. Backend expects `{ propertyId, aiEnabled?, aiMode? }`. Backend reads `aiMode` from body — works, but iOS doesn't send `aiEnabled`, so the backend infers it from `aiMode !== 'off'`. This works correctly. |

### 2.2 Backend endpoints iOS does NOT call

| Endpoint | Used by |
|---|---|
| `POST /auth/signup` | Web dashboard onboarding |
| `GET /auth/settings` | Web dashboard settings |
| `POST /auth/change-password` | Not called by iOS (Settings screen has change-password TODO) |
| `PATCH /api/conversations/:id/ai-toggle` | Web dashboard; iOS uses ai-mode instead |
| `PATCH /api/conversations/ai-toggle-all` | Web dashboard |
| `POST /api/conversations/:id/send-ai-now` | Web dashboard "Send AI Now" button |
| `POST /api/conversations/:id/sync` | Web dashboard sync button |
| `POST /api/conversations/:id/translate-message` | Google Translate path (unused) |
| `POST /api/conversations/:id/inquiry-action` | Legacy inquiry action path |
| `GET /api/conversations/:conversationId/tasks` | Web dashboard conversation detail |
| `POST /api/conversations/:conversationId/tasks` | Web dashboard task creation |
| All `/api/knowledge/*` routes | Web dashboard SOP/FAQ management |
| All `/api/ai-config/*` routes | Web dashboard AI config |
| All `/api/tenant-config/*` routes | Web dashboard settings |
| All `/api/templates/*` routes | Web dashboard message templates |
| All `/api/tools/*` routes | Web dashboard tool definitions |
| All `/api/sandbox/*` routes | Web dashboard AI sandbox |
| All `/api/faq/*` routes | Web dashboard FAQ management |
| `/api/ai-logs`, `/api/ai-logs/:id` | Web dashboard AI log viewer |
| `POST /api/messages/:id/rate` | Web dashboard message rating (phantom route in `app.ts:93`) |
| `POST /api/import`, `DELETE /api/import` | Web dashboard import management |
| All `/api/properties/:id/*` routes | Web dashboard property management |
| All alteration action routes | Web dashboard (iOS uses reservation approve/reject) |
| All `/api/push/*` routes | Web Push only — iOS can't use these |
| `POST /webhooks/hostaway/:tenantId` | Hostaway callback (server-to-server) |
| All hostaway-connect routes except status | Web dashboard Hostaway connection |
| All tuning-suggestion routes | Web dashboard Feature 040 |

### 2.3 Endpoints iOS expects but backend doesn't have

| iOS Reference | Expected Endpoint | Status |
|---|---|---|
| `PushManager.swift:77` | `POST /api/push/ios-token` | **Missing** — TODO in iOS code |
| `PushManager.swift:95` | `DELETE /api/push/ios-token` | **Missing** — implied by clearToken() |
| Settings contract §1.3 | `GET /api/me` | **Missing** — iOS uses JWT decode instead |
| Settings contract §11.4 | `PATCH /api/conversations/ai-toggle-all-mode` | **Missing** — bulk set all properties to a mode |

---

## 3. CRITICAL Findings

### C-1. Hostaway send failures silently swallowed — data loss risk
**Severity:** CRITICAL
**Backend:** `messages.controller.ts:58-60`
```typescript
} catch (err: any) {
  console.warn(`[Messages] Hostaway send failed (message still saved locally): ${err.message}`);
}
```
The message is saved to the local database and a 201 is returned to the client. The guest never receives the message. There is no delivery status field, no retry mechanism, and no way for the user to know the message was lost.

**iOS impact:** User sends message from iOS, sees it in their chat, believes it was delivered. Guest never gets it.
**Minimum fix:** Add `deliveryStatus` field to Message model. Set to `'pending'` on create, `'delivered'` when Hostaway returns success, `'failed'` when it throws. Return in response. ~2h.
**File:** `messages.controller.ts:48-60`, `schema.prisma:156`

### C-2. No iOS push infrastructure
**Severity:** CRITICAL
**Details:** See Section 5 (iOS Push Infrastructure Plan) for full breakdown.
**iOS impact:** No push notifications. User must keep app open to see new messages.

### C-3. Password change does not verify current password
**Severity:** CRITICAL (security)
**Backend:** `auth.controller.ts:112-122`
```typescript
const { newPassword } = req.body as { newPassword?: string };
// No currentPassword check — only JWT required
const passwordHash = await bcrypt.hash(newPassword, 12);
await prisma.tenant.update({ where: { id: tenantId }, data: { passwordHash } });
```
Anyone with a stolen or leaked JWT can change the account password without knowing the current one.
**Minimum fix:** Add `currentPassword` to request body, bcrypt.compare before updating. ~30min.
**File:** `auth.controller.ts:107-123`

---

## 4. HIGH Findings

### H-1. No rate limit on POST /api/conversations/:id/messages
**Backend:** `routes/conversations.ts:24`, `messages.controller.ts:19`
No rate limiter applied. Rate limits exist only on `/auth/login` (5/min), `/auth/signup` (3/min), and `/webhooks` (100/min). A send-loop bug in iOS could spam real guests with no server-side cap.
**Minimum fix:** Add `express-rate-limit` to message send endpoint. 10 sends/min/tenant is safe. ~30min.
**File:** `middleware/rate-limit.ts`, `routes/conversations.ts:24`

### H-2. Reservation sync job hardcodes aiMode: 'copilot'
**Backend:** `reservationSync.job.ts:115`
```typescript
aiMode: 'copilot',
```
New reservations from the 2-minute background sync always get `aiMode: 'copilot'`, regardless of the property's current AI mode. The webhook path inherits from the most recent reservation, but the sync path does not.
**iOS impact:** User sets property to autopilot. New booking arrives via sync. iOS shows it as copilot.
**Minimum fix:** Look up most recent reservation for the same property and inherit its `aiMode`. ~1h.
**File:** `reservationSync.job.ts:110-118`

### H-3. Task REST mutations do not broadcast socket events
**Backend:** `task.controller.ts:52-99` (create, createGlobal), `task.controller.ts:102-118` (update), `task.controller.ts:121-128` (delete)
None of POST, PATCH, or DELETE on tasks emit socket events. Only AI-created tasks broadcast (`ai.service.ts:1230`, `webhooks.controller.ts:465`).
**iOS impact:** Multi-device task sync broken for manual operations. User A creates task, User B doesn't see it until refresh.
**Minimum fix:** Add `broadcastToTenant` calls after each mutation. ~1h.
**File:** `task.controller.ts:60,98,117,126`

### H-4. Task sort order puts completed tasks first
**Backend:** `task.controller.ts:17`
```typescript
orderBy: [{ status: 'asc' }, { urgency: 'asc' }, { createdAt: 'desc' }],
```
Alphabetically, `completed` < `open`. Completed tasks appear before open tasks.
**iOS impact:** iOS sorts client-side (confirmed in `TasksStore.swift`), so this is mitigated. But any future reliance on server sort would be wrong.
**Minimum fix:** Reverse to `{ status: 'desc' }` or use CASE expression. ~15min.
**File:** `task.controller.ts:17`

### H-5. Task DELETE returns 500 instead of 404 for missing tasks
**Backend:** `task.service.ts:48`
```typescript
if (!task) throw new Error('Task not found');
```
This throws a generic Error. The error middleware catches it and returns 500 (no `status` property set).
**iOS impact:** iOS treats any non-200 as "not found" per contract guidance, so functionally OK. But 500 triggers error tracking noise.
**Minimum fix:** Create and throw a custom error with `status: 404`. ~15min.
**File:** `task.service.ts:48`

### H-6. "Off" AI mode indistinguishable from "autopilot" in socket events
**Backend:** `conversations.controller.ts:240-281`
When a property is set to "off", the backend stores `aiEnabled: false, aiMode: 'autopilot'`. The `property_ai_changed` socket event sends `{ propertyId, aiMode: 'autopilot' }`.
**iOS impact:** iOS `RealtimeEvent.swift:65` handles `property_ai_changed` — it can't distinguish off from autopilot. iOS uses this as a refetch trigger only (correct workaround).
**Minimum fix:** Include `aiEnabled` in the socket payload alongside `aiMode`. ~15min.
**File:** `conversations.controller.ts:281`

---

## 5. iOS Push Infrastructure Plan

### 5.1 Current state

- **Backend:** Web Push via `web-push` npm package (VAPID). `PushSubscription` model stores web push endpoints. `sendPushToTenant()` fans out to all subscriptions for a tenant.
- **iOS:** `PushManager.swift` acquires APNs device token (hex string), stores in Keychain. Line 77: `// TODO: register token with backend when POST /api/push/ios-token ships`
- **Token format:** 64-character hex string from `deviceToken.map { String(format: "%02.2hhx", $0) }.joined()` (PushManager.swift:70)

### 5.2 New Prisma model

```prisma
model IosPushToken {
  id          String   @id @default(cuid())
  tenantId    String
  deviceToken String   // 64-char hex APNs token
  deviceId    String?  // Optional device identifier for multi-device
  createdAt   DateTime @default(now())
  lastUsedAt  DateTime @default(now())
  tenant      Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([tenantId, deviceToken])
  @@index([tenantId])
}
```

### 5.3 New endpoints

**POST /api/push/ios-token** — Register or update token
- Auth: Bearer token required
- Request: `{ deviceToken: string, deviceId?: string }`
- Response: `{ ok: true }`
- Logic: Upsert by (tenantId, deviceToken). Update `lastUsedAt`.

**DELETE /api/push/ios-token** — Remove token (on logout)
- Auth: Bearer token required
- Request: `{ deviceToken: string }`
- Response: `{ ok: true }`

### 5.4 APNs sender library

Recommended: **`@parse/node-apn`** (maintained fork of `node-apn`). Supports:
- JWT-based provider authentication (Provider Tokens — no certificate management)
- HTTP/2 multiplexing
- Production vs sandbox endpoint selection via `production: boolean`

Alternative: Direct HTTP/2 to `api.push.apple.com` using Node's built-in `http2` module (zero dependencies, more control).

### 5.5 APNs credentials required from user

From developer.apple.com (requires paid Apple Developer Program — $99/year):
1. **AuthKey .p8 file** — APNs authentication key (download once, use forever)
2. **Key ID** — 10-character identifier for the .p8 key
3. **Team ID** — 10-character Apple Developer team identifier
4. **Bundle ID** — app's bundle identifier (e.g., `com.abdelrahman.guestpilot`)

Store as environment variables:
```
APNS_AUTH_KEY_BASE64=<base64 of .p8 file>
APNS_KEY_ID=<10 chars>
APNS_TEAM_ID=<10 chars>
APNS_BUNDLE_ID=com.abdelrahman.guestpilot
APNS_PRODUCTION=false  # true for production
```

### 5.6 Integration points — existing sendPushToTenant() call sites

All 8 call sites in `webhooks.controller.ts` and 1 in `ai.service.ts` need to fan out to BOTH Web Push AND iOS Push:

| # | File:Line | Event | Payload |
|---|---|---|---|
| 1 | `webhooks.controller.ts:404` | Inquiry reservation created | `{ title: 'New Inquiry', body: guestName + propertyName }` |
| 2 | `webhooks.controller.ts:410` | Non-inquiry reservation created | `{ title: 'New Reservation', body: guestName + propertyName }` |
| 3 | `webhooks.controller.ts:473` | Alteration request | `{ title: 'Alteration Request', body: ... }` |
| 4 | `webhooks.controller.ts:687` | Guest message received | `{ title: 'New Message', body: guestName + content preview }` |
| 5 | `webhooks.controller.ts:910` | Reservation created (alternate path) | `{ title: 'New Reservation', body: ... }` |
| 6 | `webhooks.controller.ts:1030` | Reservation status change | `{ title: 'Reservation Updated', body: ... }` |
| 7 | `webhooks.controller.ts:1038` | Reservation cancelled | `{ title: 'Reservation Cancelled', body: ... }` |
| 8 | `ai.service.ts:1233` | Task created by AI escalation | `{ title: 'Task Created: ...', body: note }` |

### 5.7 Payload mapping

| Web Push Field | APNs Equivalent | Notes |
|---|---|---|
| `title` | `aps.alert.title` | Direct map |
| `body` | `aps.alert.body` | Direct map |
| `icon` | N/A | iOS uses app icon automatically |
| `badge` | `aps.badge` | Need unread count (see below) |
| `data` | Custom keys at root | `{ conversationId, taskId, type }` |

### 5.8 Badge counts

Backend has `unreadCount` per conversation but no aggregate "total unread for tenant" query. Options:
1. **Server-computed badge:** `SELECT SUM(unreadCount) FROM Conversation WHERE tenantId = ? AND status = 'OPEN'` — add to push sender. ~15min.
2. **iOS-computed badge:** iOS computes from ConversationsStore. Less accurate when app is backgrounded.

Recommend option 1 — server-computed badge count sent with every push.

### 5.9 Silent vs visible push mapping

| Event Type | Push Type | Rationale |
|---|---|---|
| Guest message received | **Visible alert** | User needs to see and respond |
| AI task created | **Visible alert** | Requires attention |
| Reservation created/updated | **Visible alert** | Important booking events |
| Alteration request | **Visible alert** | Time-sensitive action needed |
| Reservation cancelled | **Visible alert** | Important status change |
| `ai_suggestion` (copilot) | **Silent push** (content-available: 1) | Background data update, not urgent |
| `reservation_updated` (status change mid-AI) | **Silent push** | Data refresh, not user-facing |

### 5.10 Work estimate

| Task | Hours |
|---|---|
| Prisma model + migration | 0.5h |
| Register/remove endpoints | 1h |
| APNs sender service (with @parse/node-apn) | 2h |
| Integration into sendPushToTenant (fan-out) | 1h |
| Badge count query | 0.5h |
| Silent push support | 0.5h |
| iOS-side: wire PushManager to backend endpoint | 0.5h |
| Testing (manual + device) | 2h |
| **Total** | **8h** |

**Blocked on:** Paid Apple Developer account ($99/year) for APNs credentials.

---

## 6. MEDIUM and LOW Findings

### MEDIUM

#### M-1. `starred` missing from conversation detail response
**Backend:** `conversations.controller.ts:129-172`
The detail response includes `id, status, channel, lastMessageAt, hostawayConversationId, guest, property, reservation, messages`. No `starred` field.
**iOS workaround:** Passes `starred` via navigation state from inbox row. Deep links can't determine starred status.
**Fix:** Add `starred: conversation.starred` to the detail response. ~5min.
**File:** `conversations.controller.ts:129`

#### M-2. Unread count silently cleared on detail fetch, no broadcast
**Backend:** `conversations.controller.ts:93`
```typescript
await prisma.conversation.updateMany({ where: { id, tenantId }, data: { unreadCount: 0 } });
```
No socket event emitted. Other devices see stale unread badge until next message arrives.
**iOS workaround:** Optimistically zeros badge locally on open.
**Fix:** Broadcast `unread_count_changed` event after clearing. ~30min.
**File:** `conversations.controller.ts:93`

#### M-3. HOST send webhook broadcast lacks message.id
**Backend:** `webhooks.controller.ts:468-471`
```typescript
broadcastCritical(tenantId, 'message', {
  conversationId: conversation.id,
  message: { role: 'GUEST', content: data.body || '', sentAt: new Date().toISOString(), ... },
```
The webhook-originated message broadcast does not include `message.id`. iOS must dedupe HOST-sent echoes by content + sentAt ±60s.
**iOS workaround:** `RealtimeEvent.swift:15` — `IncomingMessage.id` is optional (`String?`). Content-based dedupe implemented.
**Fix:** Include `message.id` in webhook broadcast payloads. ~30min.
**File:** `webhooks.controller.ts:468`, `webhooks.controller.ts:630`, `webhooks.controller.ts:708`

#### M-4. Inquiry/alteration actions do not broadcast socket events
**Backend:** `reservations.ts:198-354` (approve/reject/cancel), `alterations.ts:93-195` (accept/reject)
None of these endpoints emit socket events after successful action.
**iOS impact:** Multi-device sync broken for reservation actions. Device B sees stale inquiry status.
**Fix:** Broadcast `reservation_updated` after each action. ~1h.
**File:** `reservations.ts:260`, `reservations.ts:340`, `alterations.ts:175`, `alterations.ts:280`

#### M-5. No `GET /api/me` endpoint
**Backend:** No such route exists.
iOS decodes JWT client-side to get `tenantId`, `email`, `plan`. Works, but prevents the backend from returning additional user data (e.g., future `name` field).
**Fix:** Add `GET /api/me` returning decoded JWT claims + any DB-stored user fields. ~30min.

#### M-6. No user `name` field in Tenant model
**Backend:** `schema.prisma:9-48`
Tenant has only `email`. No name field. Settings screen can only show email.
**Fix:** Add `name String?` to Tenant, `PATCH /api/me` to update it. ~1h.
**File:** `schema.prisma:11`

#### M-7. Task PATCH only accepts status/dueDate/assignee
**Backend:** `task.controller.ts:106`
```typescript
const { status, dueDate, assignee } = req.body;
```
No way to edit `title`, `note`, or `urgency` after creation via REST. iOS can't offer an edit-task feature.
**Fix:** Destructure additional fields from request body. ~15min.
**File:** `task.controller.ts:106`

#### M-8. `completedAt` not cleared on task reopen
**Backend:** `task.controller.ts:108-110`
```typescript
if (status !== undefined) {
  data.status = status;
  if (status === 'completed') data.completedAt = new Date();
}
```
Reopening (setting `status: 'open'`) does not clear `completedAt`.
**Fix:** Add `if (status === 'open') data.completedAt = null;`. ~5min.
**File:** `task.controller.ts:110`

#### M-9. TenantAiConfig cached 60s in-memory
**Backend:** `tenant-config.service.ts` (in-memory cache with 60s TTL)
If user changes AI config on web dashboard, iOS won't see the change reflected in AI behavior for up to 60 seconds.
**Impact:** Acceptable for production. Note for debugging — config changes have propagation delay.

#### M-10. Default reservation status filter excludes CHECKED_OUT
**Backend:** `reservations.ts:28` — defaults to `INQUIRY,PENDING,CONFIRMED,CHECKED_IN`
iOS `ReservationsStore.swift:89-94` explicitly passes `[.inquiry, .pending, .confirmed, .checkedIn, .checkedOut]` — includes CHECKED_OUT. iOS handles this correctly.

### LOW

#### L-1. Phantom router: POST /api/messages/:id/rate
**Backend:** `app.ts:93` — inlined in app.ts instead of a route file.
```typescript
app.post('/api/messages/:id/rate', authMiddleware as any, (req: any, res: any) => {
  knowledgeCtrl.rateMessage(req, res);
});
```
Not called by iOS. Technical debt only.

#### L-2. Task `type` field defaults to `"other"` everywhere
**Backend:** `schema.prisma:207`, `task.service.ts:22`, `task.controller.ts:75`
Vestigial field — AI doesn't set it, web doesn't use it, iOS ignores it. Safe to leave.

#### L-3. `reservation_created` socket payload is minimal
**Backend:** `reservationSync.job.ts:141`, `webhooks.controller.ts:903`
Contains only `{ reservationId }`. iOS refetches on this event (correct behavior).

#### L-4. `reservation_updated` payload varies by emit path
**Backend:** Different code paths include different field sets.
iOS treats all fields except `reservationId` and `conversationIds` as optional (correct behavior).

#### L-5. Task response shape inconsistency
**Backend:** `task.controller.ts:23-39` (list endpoint — mapped with guestName/propertyName) vs `task.controller.ts:116-117` (PATCH — raw Prisma, no guestName/propertyName)
iOS `TaskItem.swift:16-37` handles both shapes by making `guestName`, `propertyName`, `tenantId`, `updatedAt` all optional. `TasksStore.swift:143-150` merges socket events, preserving existing guestName/propertyName.

#### L-6. No `inquiry_expired` socket event
Backend does not emit this. iOS computes countdown from `reservationCreatedAt + 24h` and handles locally.

#### L-7. No `task_deleted` socket event
Backend emits no event on task deletion. Multi-device: deleted task remains visible until refresh.
**Fix:** Emit `task_deleted` with `{ taskId }` in `task.controller.ts:126`. ~10min.

#### L-8. No `unread_count_changed` socket event
Backend has no such event. Unread counts update via `message` events (increment on GUEST message) and local zeroing on detail open.

---

## 7. Per-Subsystem Health Check

### Auth
Solid. JWT with 30-day expiry, bcrypt password hashing, rate-limited login (5/min/IP). **Gap:** No current-password verification on change-password (C-3). No token refresh endpoint — iOS handles by forcing re-login when JWT is within 24h of expiry (`AuthManager.swift:41-62`).

### Conversations
Well-structured. List endpoint returns all fields iOS needs including `reservationCreatedAt` (`conversations.controller.ts:64`). Detail endpoint is comprehensive. **Gap:** `starred` not in detail response (M-1). Unread clear not broadcast (M-2).

### Messages
Send flow works. Zod validation ensures non-empty content. Hostaway message ID captured for dedup on webhook echo. **Critical gap:** Send failures swallowed (C-1). No rate limit (H-1). No content-length validation beyond Express 10MB limit.

### Tasks
CRUD functional. List endpoint returns mapped shapes with guestName/propertyName. **Gaps:** No socket broadcasts on manual mutations (H-3). Sort order bug (H-4). Delete returns 500 not 404 (H-5). No title/note/urgency edit (M-7). completedAt not cleared on reopen (M-8).

### Reservations
Calendar endpoint well-designed with date range filtering. Approve/reject work via Hostaway dashboard JWT. **Gaps:** Actions don't broadcast (M-4). Default status filter excludes CHECKED_OUT (iOS handles correctly).

### Webhooks (Hostaway inbound)
Robust. Rate-limited (100/min/tenant). Basic auth optional. Handles reservation events, message events, alteration events. **Note:** Race condition between webhook and sync is handled by partial unique index on Message.

### Messages/Hostaway outbound
DRY_RUN mode works correctly — allows specific conversation IDs. Retry logic (3x exponential backoff) on transient errors. **Critical gap:** Failures swallowed at controller level (C-1).

### AI Service
Mature pipeline. Tool use loop (5 rounds max), structured JSON output, SOP classification, escalation enrichment. Push notifications sent on task creation. Summary generation fire-and-forget. Feature 040 shadow mode integrated.

### Realtime/Socket
WebSocket-only transport. JWT in handshake auth. Two broadcast modes: fire-and-forget and critical (5s ACK timeout). Redis adapter optional. **Gaps:** Several events missing (inquiry actions, task mutations, unread clear).

### Analytics
`GET /api/analytics` returns aggregate metrics. Not used by iOS (Overview contract §11.9 confirms it's not useful for operational data).

### Push
Web Push fully functional with VAPID. Graceful degradation if keys missing. Subscription expiry handled (410/404 → cleanup). **Critical gap:** No iOS push infrastructure (C-2).

---

## 8. Send-Safety Assessment

### Server-side send guards — what exists

| Guard | Status | File:Line |
|---|---|---|
| Auth required | Yes | `routes/conversations.ts:24` (auth middleware) |
| Tenant isolation | Yes | `messages.controller.ts:30` (conversation must belong to tenant) |
| Content non-empty | Yes | `messages.controller.ts:12` (zod: `z.string().min(1)`) |
| Content max length | **No** | Express body limit is 10MB (`app.ts:54`) |
| Rate limit | **No** | No rate limiter on message send |
| Conversation status gate | **No** | Can send to RESOLVED conversations |
| Reservation status gate | **No** | Can send to CANCELLED/CHECKED_OUT reservations |
| DRY_RUN filtering | Yes | `hostaway.service.ts:259-269` (per-conversation allowlist) |
| Hostaway failure visibility | **No** | Silently swallowed (`messages.controller.ts:58-60`) |

### DRY_RUN mode details
**File:** `hostaway.service.ts:259-269`
When `DRY_RUN` env var is set (e.g., `"40570028"`), only messages to listed Hostaway conversation IDs are actually delivered. All others are blocked and logged. The client gets a 201 regardless — there is no header or response field that indicates DRY_RUN was active.

**iOS testing strategy:** Set `DRY_RUN` to the specific conversation IDs being tested. All other conversations are safely read-only. iOS cannot opt into this via header — it's server-side config only.

### Audit trail
Every outbound message is saved to the `Message` table with `role: 'HOST'` and a timestamp. There is no `source` field distinguishing "sent from iOS" vs "sent from web dashboard" vs "sent from API". If iOS misbehaves, the user can see what was sent (message content + time) but not which client sent it.

**Minimum fix:** Add `source` field to Message model (`'web' | 'ios' | 'ai' | 'system'`). iOS sends `X-Client-Source: ios` header. ~1h.

### Recommended pre-prototyping safety work

1. **Rate limit on POST /messages** — 10/min/tenant. 30min.
2. **Content length validation** — reject messages >4000 chars (Airbnb limit). 15min.
3. **Delivery status field** — so user can see if Hostaway actually received the message. 2h.
4. **Client source tracking** — `X-Client-Source` header logged with each message. 30min.

**Total: ~3h of safety work before iOS talks to real guests.**

---

## 9. Operational Readiness

### Error tracking
- **Sentry:** Not integrated
- **Datadog:** Not integrated
- **LogRocket:** Not integrated
- **Langfuse:** Integrated for AI calls only (tokens, cost, duration, escalations). Not general error tracking.
- **Conclusion:** Production errors go to Railway stdout/stderr. No alerting, no error grouping, no stack trace enrichment.
- **Recommendation:** Add Sentry (`@sentry/node`). 2h including Express integration + source maps.

### Logging
- **Pattern:** `console.log('[ServiceName] ...')` with tagged prefixes throughout
- **Count:** 161 `console.log`, 134 `console.error` across 37 files
- **Structured logging:** None. No Winston, Pino, or structured JSON output.
- **Log levels:** Inconsistent. `console.log` for info, `console.warn` for warnings, `console.error` for errors.
- **Recommendation:** Defer structured logging — current pattern is readable and Railway captures it. Sentry is higher priority.

### Crash recovery
- **Database transactions:** Only 1 explicit `$transaction` in entire codebase (`tuning-analyzer.service.ts:413`)
- **Retry logic:** Hostaway calls retry 3x with exponential backoff (`hostaway.service.ts:13-27`)
- **Graceful shutdown:** `server.ts:70-87` — clears jobs, closes BullMQ, flushes Langfuse, disconnects Prisma
- **Process restart:** Railway auto-restarts on crash

### Database backups
Railway PostgreSQL includes automatic daily backups (retention varies by plan). No manual backup/restore documented. Recommend verifying backup frequency and testing restore.

### Secrets management
- `.env` exists locally, is gitignored (confirmed)
- `.env.example` exists with placeholder values
- All secrets configured as Railway environment variables
- `JWT_SECRET` and `DATABASE_URL` validated at startup — server exits if missing

### Webhook rate limiting
`POST /webhooks/hostaway/:tenantId` — 100 requests/minute per tenantId. Implemented in `middleware/rate-limit.ts`. Uses Redis store if available, falls back to in-memory.

### Database indexes for iOS-heavy queries

| Query | Index | Status |
|---|---|---|
| `GET /api/conversations` (all for tenant) | `@@index([tenantId])` on Conversation | Present |
| `GET /api/conversations` (sorted by lastMessage) | `@@index([tenantId, lastMessageAt(sort: Desc)])` | Present |
| `GET /api/tasks` (all for tenant) | `@@index([tenantId])` on Task | Present |
| `GET /api/reservations` (date range) | `@@index([tenantId])` on Reservation | Present, but no date index |
| Message fetch by conversation | `@@index([conversationId])` on Message | Present |
| PendingAiReply polling | `@@index([fired, scheduledAt])` | Present |

**Missing index:** `Reservation` has no index on `(tenantId, checkIn)` or `(tenantId, checkOut)`. Calendar queries with date ranges do a table scan filtered by tenantId index. At ~100 reservations, this is fine. At ~10,000, it will slow down.

### Unpaginated endpoint scale limits

| Endpoint | Current Scale | Safe Until | Risk |
|---|---|---|---|
| `GET /api/conversations` | ~100 | ~2,000 | Payload size (~2KB/row → 4MB at 2K) |
| `GET /api/tasks` | ~50 | ~1,000 | Includes JOIN to guest + property |
| `GET /api/reservations` | ~200/query | ~5,000 | Date-filtered, manageable |

No immediate action needed. Plan pagination when approaching 1,000 conversations.

---

## 10. Schema and Data Model Review

### Models referenced in contracts but missing from schema
- **IosPushToken** — needed for iOS push (C-2)
- No `name` field on Tenant — referenced in Settings contract §1.6 (M-6)

### Missing indexes
- `Reservation` — no `(tenantId, checkIn)` composite index for date-range queries
- `Task` — no `(tenantId, status)` composite index (would help filtered task queries)

### Oddly defaulted fields
- `Task.type String @default("other")` — vestigial field, never meaningfully used (L-2)
- `Task.source String @default("ai")` — correct for AI-created tasks, wrong for manual creates (controller overrides to `"manual"`)
- `Task.status String @default("open")` — plain String, not a Prisma enum
- `Task.urgency String` — plain String, not a Prisma enum. Values: `info_request`, `scheduled`, `urgent`, `modification_request`, `complaint`
- `Reservation.aiMode String @default("autopilot")` — plain String, not a Prisma enum. Values: `autopilot`, `copilot`, `off`

### Plain Strings that could be Prisma enums
Intentional design — backend uses String for flexibility and to avoid migrations when adding new urgency levels or AI modes. Trade-off: no database-level validation, but faster iteration. Acceptable for current stage.

### Migration history
Using `prisma db push` (per CLAUDE.md §Build & Run), not migration files. One manual SQL migration exists for the partial unique index on Message (`Message_conv_hostaway_msg_unique`). This means the schema is the single source of truth, not a migration chain.

---

## 11. Technical Debt Inventory

### TODO/FIXME/HACK/XXX markers
**None found** in `backend/src/`. Clean codebase.

### console.log in production code
161 occurrences across 37 files. All use tagged prefix format `[ServiceName]`. Top offenders:
- `ai.service.ts` — 24 calls
- `webhooks.controller.ts` — 24 calls
- `workers/aiReply.worker.ts` — 9 calls
- `services/import.service.ts` — 9 calls

### Commented-out code blocks > 10 lines
None found in spot checks across controllers and services.

### Phantom router (routes in app.ts)
- `POST /api/messages/:id/rate` at `app.ts:93` — should be in a route file
- `GET /api/ai-logs` at `app.ts:111` — inline route
- `GET /api/ai-logs/:id` at `app.ts:168` — inline route

### Unused dependencies
Would require `depcheck` to confirm. `cohere-ai` is imported for embeddings alternative — may or may not be actively used.

### Express/Prisma versions
- Express 4.21.0 — current stable. Express 5.x exists but is not yet widely adopted.
- Prisma 5.20.0 — current stable.
- Node.js 18+ — matches LTS.

---

## 12. Cross-Reference with iOS Code

### iOS Swift contradicts backend source

| Finding | iOS Source | Backend Source | Authoritative | Action |
|---|---|---|---|---|
| Shadow preview fields on detail | `Message.swift` — no `previewState` field | `conversations.controller.ts:169` — returns `previewState` | Backend (ground truth) | iOS v1 ignores safely; update model when Feature 040 goes to iOS |
| Task update request body | `APIClient+Tasks.swift:19` sends `{ status: String? }` | `task.controller.ts:106` accepts `{ status, dueDate, assignee }` | Both correct | iOS sends subset; backend accepts more |
| AI toggle property request | `APIClient+AIMode.swift:11` sends `{ propertyId, aiMode }` | `conversations.controller.ts:240` reads `{ propertyId, aiEnabled?, aiMode? }` | Both correct | Backend infers `aiEnabled` from `aiMode !== 'off'` |

### iOS Swift contradicts iOS contracts

| Finding | Contract Says | Swift Does | Notes |
|---|---|---|---|
| Shadow preview fields hidden | Conversation Detail Contract §15.2 — "deliberately omits preview fields" | Backend now returns them (line 169) | Contract is **stale**. Backend was updated in Feature 040 commits. |
| `reservationCreatedAt` missing from detail | Conversation Detail Contract §15.6 | List endpoint DOES return it (`conversations.controller.ts:64`) | Contract is about detail endpoint specifically — still correct |
| No `message.id` in webhook broadcasts | Conversation Detail Contract §15.4 | Backend still omits it in some paths | Contract is still accurate |

### Contracts confirmed accurate against current source

- starred not in detail response (confirmed: `conversations.controller.ts:129-172`)
- Hostaway send failures swallowed (confirmed: `messages.controller.ts:58-60`)
- Task sort bug (confirmed: `task.controller.ts:17`)
- Task delete returns 500 (confirmed: `task.service.ts:48`)
- Change password no current-password check (confirmed: `auth.controller.ts:112`)
- Reservation sync hardcodes copilot (confirmed: `reservationSync.job.ts:115`)
- No task mutation socket broadcasts (confirmed: `task.controller.ts` — no broadcastToTenant calls)

---

## 13. Recommended Fix Order

Prioritized by: blocks prototyping → safety for real guests → UX quality → tech debt.

| Priority | Item | Effort | Files |
|---|---|---|---|
| **1** | C-1: Message delivery status field + visible failures | 2h | `schema.prisma`, `messages.controller.ts` |
| **2** | H-1: Rate limit on POST /messages (10/min/tenant) | 30min | `middleware/rate-limit.ts`, `routes/conversations.ts` |
| **3** | C-3: Verify current password on change-password | 30min | `auth.controller.ts` |
| **4** | H-3: Broadcast socket events on task mutations | 1h | `task.controller.ts` |
| **5** | H-2: Sync job inherits property AI mode | 1h | `reservationSync.job.ts` |
| **6** | Content length validation on POST /messages | 15min | `messages.controller.ts` |
| **7** | Client source header tracking | 30min | `messages.controller.ts`, `schema.prisma` |
| **8** | M-1: Add starred to detail response | 5min | `conversations.controller.ts` |
| **9** | M-3: Add message.id to webhook broadcasts | 30min | `webhooks.controller.ts` |
| **10** | M-4: Broadcast on inquiry/alteration actions | 1h | `reservations.ts`, `alterations.ts` |
| **11** | H-4: Fix task sort order | 15min | `task.controller.ts` |
| **12** | H-5: Task delete returns 404 not 500 | 15min | `task.service.ts` |
| **13** | M-8: Clear completedAt on task reopen | 5min | `task.controller.ts` |
| **14** | H-6: Include aiEnabled in property_ai_changed event | 15min | `conversations.controller.ts` |
| **15** | M-2: Broadcast unread_count_changed | 30min | `conversations.controller.ts` |
| **16** | Add Sentry error tracking | 2h | `server.ts`, `app.ts`, `package.json` |
| **17** | C-2: iOS push infrastructure (full plan) | 8h | See Section 5 |
| **18** | M-5: GET /api/me endpoint | 30min | New route file |
| **19** | M-6: User name field | 1h | `schema.prisma`, new endpoint |
| **20** | M-7: Task title/note/urgency edit via PATCH | 15min | `task.controller.ts` |
| **21** | L-7: task_deleted socket event | 10min | `task.controller.ts` |
| | **Total** | **~20h** | |

**Items 1-7 (~5h) are recommended before iOS prototypes with real guests.**
**Items 8-15 (~3h) improve multi-device reliability.**
**Items 16-21 (~12h) are infrastructure and feature gaps for production readiness.**
