# Inbox Backend Contract

> Source-of-truth contract for the iOS Inbox screen. Every claim cites `backend/<path>:<line>` from this repo. Read-only discovery — no code was changed to produce this doc.
>
> Generated 2026-04-11 against branch `040-autopilot-shadow-mode`.

---

## 1. GET /api/conversations Response Shape

**Handler**: `backend/src/controllers/conversations.controller.ts:31-71` (`list` method on the factory-returned controller).

**Prisma query** (`backend/src/controllers/conversations.controller.ts:34-45`):

```ts
const conversations = await prisma.conversation.findMany({
  where: { tenantId },
  orderBy: { lastMessageAt: 'desc' },
  include: {
    guest: true,
    property: true,
    reservation: true,
    messages: { orderBy: { sentAt: 'desc' }, take: 1 },
  },
});
```

**Response is a bare JSON array** (`backend/src/controllers/conversations.controller.ts:47-66`) where each element has exactly these fields:

```ts
type ConversationListItem = {
  id: string;                          // Conversation.id
  guestName: string;                   // conversation.guest.name           (joined)
  propertyName: string;                // conversation.property.name        (joined)
  channel: Channel;                    // Conversation.channel (enum)
  aiEnabled: boolean;                  // conversation.reservation.aiEnabled (joined, denormalized onto row)
  aiMode: string;                      // conversation.reservation.aiMode    ("autopilot"|"copilot"|"off")
  unreadCount: number;                 // Conversation.unreadCount          (denormalized counter)
  starred: boolean;                    // Conversation.starred
  status: ConversationStatus;          // Conversation.status ("OPEN"|"RESOLVED")
  lastMessage: string;                 // conversation.messages[0]?.content ?? ''
  lastMessageRole: MessageRole | null; // conversation.messages[0]?.role ?? null
  lastMessageAt: string;               // Conversation.lastMessageAt (ISO 8601 via JSON.stringify of Date)
  reservationStatus: ReservationStatus;// conversation.reservation.status   (joined)
  reservationId: string;               // conversation.reservation.id       (joined)
  checkIn: string;                     // conversation.reservation.checkIn  (joined, ISO 8601)
  checkOut: string;                    // conversation.reservation.checkOut (joined, ISO 8601)
  reservationCreatedAt: string;        // conversation.reservation.createdAt (joined, ISO 8601)
  hostawayConversationId: string;      // Conversation.hostawayConversationId
};
```

**Joined/computed fields** (the join source):
| On-wire field | Source |
|---|---|
| `guestName` | `Guest.name` via `Conversation.guest` |
| `propertyName` | `Property.name` via `Conversation.property` |
| `aiEnabled`, `aiMode` | `Reservation.aiEnabled`, `Reservation.aiMode` via `Conversation.reservation` (lives on Reservation, NOT Conversation) |
| `reservationStatus`, `reservationId`, `checkIn`, `checkOut`, `reservationCreatedAt` | `Reservation.*` via `Conversation.reservation` |
| `lastMessage`, `lastMessageRole` | `messages[0]` after `orderBy: { sentAt: 'desc' }, take: 1` — empty string / null when the conversation has no messages |

**Field NOT returned that exists on the model**: `conversationSummary`, `summaryUpdatedAt`, `summaryMessageCount`, `lastSyncedAt`, `createdAt`, `guestId`, `propertyId`, `tenantId`. See `backend/prisma/schema.prisma:124-154` for the full Conversation model.

**Prisma models — source of truth for field types** (`backend/prisma/schema.prisma`):

```prisma
// schema.prisma:124-154
model Conversation {
  id                     String                @id @default(cuid())
  tenantId               String
  reservationId          String
  guestId                String
  propertyId             String
  channel                Channel               @default(OTHER)
  status                 ConversationStatus    @default(OPEN)
  unreadCount            Int                   @default(0)
  starred                Boolean               @default(false)
  lastMessageAt          DateTime              @default(now())
  hostawayConversationId String                @default("")
  conversationSummary    String?               @db.Text
  summaryUpdatedAt       DateTime?
  summaryMessageCount    Int                   @default(0)
  lastSyncedAt           DateTime?
  createdAt              DateTime              @default(now())
  // relations omitted
  @@unique([tenantId, reservationId])
  @@index([tenantId])
  @@index([tenantId, status])
  @@index([tenantId, lastMessageAt(sort: Desc)])
}

// schema.prisma:90-122
model Reservation {
  id                    String            @id @default(cuid())
  tenantId              String
  propertyId            String
  guestId               String
  hostawayReservationId String
  checkIn               DateTime
  checkOut              DateTime
  guestCount            Int               @default(1)
  channel               Channel           @default(OTHER)
  status                ReservationStatus @default(CONFIRMED)
  screeningAnswers      Json              @default("{}")
  aiEnabled             Boolean           @default(true)
  aiMode                String            @default("autopilot")
  totalPrice            Decimal?
  hostPayout            Decimal?
  cleaningFee           Decimal?
  currency              String?
  createdAt             DateTime          @default(now())
  updatedAt             DateTime          @updatedAt
  // relations omitted
}

// schema.prisma:73-88
model Guest {
  id              String         @id @default(cuid())
  tenantId        String
  hostawayGuestId String
  name            String
  email           String         @default("")
  phone           String         @default("")
  nationality     String         @default("")
  createdAt       DateTime       @default(now())
  // relations omitted
}

// schema.prisma:51-71
model Property {
  id                  String  @id @default(cuid())
  tenantId            String
  hostawayListingId   String
  name                String
  address             String  @default("")
  listingDescription  String  @default("")
  customKnowledgeBase Json    @default("{}")
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt
  // relations omitted
}
```

---

## 2. Pagination

**Not paginated.** The `list` handler at `backend/src/controllers/conversations.controller.ts:31-71` does not read any of `limit`, `offset`, `cursor`, `page`, `take`, or `skip` from `req.query`, and the Prisma query at lines 34-45 does not pass any of those options. The full tenant conversation list is returned in one shot.

- **Query param convention**: none
- **Default/max page size**: n/a
- **Response envelope**: bare JSON array — **not** wrapped in `{ data, nextCursor, hasMore }`
- **Default order**: descending by `lastMessageAt` (see §3)
- **Cap on rows returned**: none
- **How many conversations does a medium tenant have**: not answerable from source.

**Implication for iOS**: if tenants grow, this will become a performance problem (payload size + initial render). The iOS client should assume the list can grow large and render with lazy `List` / pagination-UI even though the server returns everything. Pushing for server-side pagination is a valid follow-up — but changing the endpoint is out of scope for this discovery doc.

---

## 3. Sorting

**Server-side, fixed**: `orderBy: { lastMessageAt: 'desc' }` at `backend/src/controllers/conversations.controller.ts:38`. An index supports this sort — `@@index([tenantId, lastMessageAt(sort: Desc)])` at `backend/prisma/schema.prisma:153`.

The iOS client receives the list pre-sorted by most-recent activity. No client-side sort is required for the default view. Any alternate sort (e.g. by check-in date, unread first) must be done client-side.

---

## 4. Filtering

**The list handler reads ZERO query parameters.** `backend/src/controllers/conversations.controller.ts:31-71` does not touch `req.query` at all. The Prisma `where` clause is `{ tenantId }` only (line 35-37).

Filters the iOS client needs and must therefore implement **locally** over the full response:
- By `status` (OPEN / RESOLVED)
- By `starred` (true / false)
- By `aiMode` (autopilot / copilot / off)
- By `reservationStatus` (INQUIRY / PENDING / CONFIRMED / CHECKED_IN / CHECKED_OUT / CANCELLED)
- By `channel` (AIRBNB / BOOKING / DIRECT / OTHER / WHATSAPP)
- By `unreadCount > 0`

The web app applies all filters client-side too — the inbox components in `frontend/components/inbox-v5.tsx` fetch once, then filter the resulting array in React state.

---

## 5. Search

**No server-side conversation search endpoint.** There is no `GET /api/conversations/search`, no `?search=` parameter on `GET /api/conversations` (the handler doesn't read `req.query` — `backend/src/controllers/conversations.controller.ts:31-71`), and the router at `backend/src/routes/conversations.ts:8-36` registers no search route.

The iOS client must implement client-side search across the already-fetched list. Recommended fields to index (matching what the web app de facto searches on via the list shape): `guestName`, `propertyName`, `lastMessage`.

**Note**: message-body search is NOT available — only the last message preview is in the list payload. To search full message content the client would need to open each conversation individually, which is not a practical UX. Treat this as a feature gap; flag to backend team before committing to a search UX.

---

## 6. Mark-Read Semantics

**Auto-clear on detail fetch.** `backend/src/controllers/conversations.controller.ts:93`:

```ts
await prisma.conversation.updateMany({ where: { id, tenantId }, data: { unreadCount: 0 } });
```

`GET /api/conversations/:id` unconditionally sets `unreadCount = 0` before returning the conversation body. There is **no** explicit `/read` / `/unread` / `/mark-read` endpoint on the router (`backend/src/routes/conversations.ts:8-36`).

**Unread count source**: denormalized counter `Conversation.unreadCount` at `backend/prisma/schema.prisma:132` (`Int @default(0)`). It is **not** computed on-the-fly from Message rows. Increments happen in the message-sync path on inbound guest messages (see `backend/src/services/message-sync.service.ts` — the sync writer increments `updateData.unreadCount`).

**Broadcast on clear**: **no Socket.IO event is emitted when unreadCount is cleared.** Grepping `backend/src/controllers/conversations.controller.ts:73-173` for `broadcastToTenant` / `broadcastCritical` inside the `get` handler: zero hits. So:

- The list row's unread badge does **not** clear automatically via a push event on other devices.
- Strategy for iOS: optimistically zero the local `unreadCount` on the row when the user taps to open detail. If another device has the app open, that device's list will be stale until the next refetch or until a new message arrives (which does fire a `message` event).

**No "mark unread" action** exists at all — once cleared, the client cannot set `unreadCount` back to a non-zero value via the API.

---

## 7. Swipe Action Endpoints

### 7a. Star / Unstar

| | |
|---|---|
| **Method / Path** | `PATCH /api/conversations/:id/star` |
| **Route** | `backend/src/routes/conversations.ts:21` |
| **Handler** | `toggleStar` at `backend/src/controllers/conversations.controller.ts:547-579` |
| **Auth** | Bearer (router applies `authMiddleware` at `backend/src/routes/conversations.ts:13`) |
| **Request body** | `{ "starred": boolean }` — validated manually at lines 551-556 (400 if not a boolean) |
| **Response body** | `{ "starred": boolean }` (line 574) |
| **DB write** | `prisma.conversation.updateMany({ where: { id, tenantId }, data: { starred } })` — lines 567-570 |
| **Socket broadcast** | `broadcastToTenant(tenantId, 'conversation_starred', { conversationId: id, starred })` — line 572 |

### 7b. Archive / Unarchive

**Not implemented.** There is no archive endpoint, no `archive` field on the Conversation model (`backend/prisma/schema.prisma:124-154`), and no references to `archive` in `backend/src/controllers/conversations.controller.ts` or `backend/src/routes/conversations.ts`. Archive as a concept does not exist in this backend.

**iOS implication**: if the inbox design has an "archive" swipe action, either repurpose it to `resolve` (which semantically matches "hide from the active list") or add a new backend endpoint. Do not add a client-only "archived" flag — it will not survive reinstall.

### 7c. Resolve / Unresolve

| | |
|---|---|
| **Method / Path** | `PATCH /api/conversations/:id/resolve` |
| **Route** | `backend/src/routes/conversations.ts:22` |
| **Handler** | `resolve` at `backend/src/controllers/conversations.controller.ts:581-613` |
| **Auth** | Bearer |
| **Request body** | `{ "status": "OPEN" \| "RESOLVED" }` — validated at lines 587-590 (400 if neither) |
| **Response body** | `{ "status": "OPEN" \| "RESOLVED" }` (line 608) |
| **DB write** | `prisma.conversation.updateMany({ where: { id, tenantId }, data: { status } })` — lines 601-604 |
| **Socket broadcast** | `broadcastToTenant(tenantId, 'conversation_resolved', { conversationId: id, status })` — line 606 |

This endpoint is bidirectional — pass `"OPEN"` to unresolve, `"RESOLVED"` to resolve. It is the closest thing to an "archive" action the backend has.

### 7d. Mark read / unread

**No explicit endpoint.** As described in §6, unread is cleared implicitly by `GET /api/conversations/:id`. There is no way to mark a conversation as read without loading its full contents, and no way to mark it as unread at all.

---

## 8. Socket.IO Specifics

All citations in this section are to `backend/src/services/socket.service.ts` unless noted. Initialization happens in `backend/src/server.ts` via `initSocketIO(httpServer)`.

### 8a. Namespace

**Default namespace (`/`).** `backend/src/services/socket.service.ts:78` instantiates `new Server(httpServer, serverOpts)` with no `of(...)` call anywhere in the file. All events flow on the root namespace.

### 8b. Connection authentication

Token in `socket.handshake.auth.token`. From `backend/src/services/socket.service.ts:85-98`:

```ts
io.use((socket: Socket, next: (err?: Error) => void) => {
  const token = socket.handshake.auth?.token;
  if (!token) {
    return next(new Error('Authentication required'));
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { tenantId: string; sub?: string; email?: string };
    socket.data.tenantId = payload.tenantId;
    socket.data.userId = payload.sub || payload.email || 'unknown';
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});
```

- Token goes in the **auth** object of the Socket.IO handshake, **not** a header, **not** a query param.
- Same `JWT_SECRET` as the REST API (imported from `../middleware/auth`, `backend/src/services/socket.service.ts:16`).
- Rejection error messages: `"Authentication required"` (missing token) or `"Invalid token"` (bad signature / expired).

**Swift / socket.io-client-swift example**:
```swift
let manager = SocketManager(socketURL: URL(string: baseURL)!, config: [
    .connectParams(["token": jwt]),   // NOT correct — auth is separate from query
    // Use the configured auth callback or pass via `connectParams` if the lib does not expose auth.
])
```
Confirm your chosen client library maps to `handshake.auth` rather than `handshake.query` — they are distinct on the server.

### 8c. Per-tenant rooms / join protocol

**Auto-join on connect.** `backend/src/services/socket.service.ts:105-106`:

```ts
socket.join(`tenant:${tenantId}`);
```

Inside `io.on('connection', ...)`. The client does **not** emit any `join` event — joining is implicit in a successful connection. The tenant ID comes from the JWT payload.

### 8d. Transport & timing

`backend/src/services/socket.service.ts:71-76`:

```ts
const serverOpts: any = {
  cors: { origin: corsOrigins, credentials: true },
  transports: ['websocket'] as const,
  pingInterval: 25000,
  pingTimeout: 60000,
};
```

- **WebSocket-only** — HTTP long-polling is disabled (Railway has no sticky sessions). iOS client must use WebSocket transport.
- **Ping interval 25s, timeout 60s.** Configure the client to tolerate at least 60s without a pong before treating the connection as dead.

### 8e. Reconnection / room membership

**No Connection State Recovery.** Comment at `backend/src/services/socket.service.ts:69-70`:

> *"No CSR — it requires Redis Streams adapter which is too memory-heavy. Missed events are handled by REST API fallback on reconnect (client-side)."*

On reconnect, the client ends up in a fresh `io.on('connection')` flow — auto-join fires again (line 106), so room membership is restored automatically. **But events emitted while the client was disconnected are lost.** The iOS client MUST refetch `GET /api/conversations` (and optionally any open conversation detail) on reconnect to catch up.

### 8f. Broadcast functions

- **Fire-and-forget**: `broadcastToTenant(tenantId, event, data)` — `backend/src/services/socket.service.ts:141-147`. Emits to room `tenant:${tenantId}`.
- **Critical (with ACK + retry)**: `broadcastCritical(tenantId, event, data)` — `backend/src/services/socket.service.ts:154-165`. 5-second ACK timeout; retries once if no ACK, then gives up.

### 8g. Events the server emits (complete list)

Grep for `broadcastToTenant(` and `broadcastCritical(` across `backend/src/` produced this list. **Bold** items are relevant to the Inbox screen.

| Event name | Severity | Payload shape | Where / when fired |
|---|---|---|---|
| **`message`** | critical | `{ conversationId, message: { id, role, content, sentAt: ISO string, channel, imageUrls: string[] }, lastMessageRole, lastMessageAt: ISO string }` | New inbound or outbound message: `conversations.controller.ts:519-524` (approveSuggestion), `ai.service.ts:1271` (private note), `ai.service.ts:2215` (AI autopilot send), `message-sync.service.ts:229`, `webhooks.controller.ts:467`, `webhooks.controller.ts:675` |
| **`ai_suggestion`** | critical | `{ conversationId, suggestion: string }` | Copilot suggestion ready for approval — `ai.service.ts:2183` |
| **`ai_typing_text`** | fire-and-forget | `{ conversationId, delta: string }` | Streamed AI token chunks during generation — `ai.service.ts:415, 426, 467, 473` |
| **`ai_typing_clear`** | fire-and-forget | `{ conversationId }` | Clears the typing indicator — `ai.service.ts:1346, 2087, 2096`, `debounce.service.ts:202`, `webhooks.controller.ts:668` |
| **`conversation_starred`** | fire-and-forget | `{ conversationId, starred: boolean }` | Star toggled — `conversations.controller.ts:572` |
| **`conversation_resolved`** | fire-and-forget | `{ conversationId, status: "OPEN"\|"RESOLVED" }` | Resolve toggled — `conversations.controller.ts:606` |
| **`ai_mode_changed`** | fire-and-forget | `{ conversationId, aiMode: string }` | Per-conversation AI mode change — `conversations.controller.ts:448` |
| `property_ai_changed` | fire-and-forget | `{ propertyId, aiMode }` | Property-wide AI mode change — `conversations.controller.ts:275` |
| `ai_toggled` | fire-and-forget | `{ conversationId, aiEnabled: boolean }` | Per-conversation AI on/off — `conversations.controller.ts:641` |
| `new_task` | fire-and-forget | `{ conversationId, task }` | New task created — `ai.service.ts:1230`, `webhooks.controller.ts:464` |
| `task_updated` | fire-and-forget | `{ conversationId, task }` | Task state changed — `ai.service.ts:1150, 1165, 1207, 1214` |
| `reservation_created` | fire-and-forget | `{ reservationId }` | Reservation synced — `reservationSync.job.ts:141`, `webhooks.controller.ts:869` |
| `reservation_updated` | fire-and-forget | `{ reservationId, conversationIds: string[] }` | Reservation mutated — `ai.service.ts:1392`, `reservationSync.job.ts:178`, `webhooks.controller.ts:389, 976` |
| `knowledge_suggestion` | fire-and-forget | `{ conversationId }` | AI flagged a FAQ candidate — `ai.service.ts:1253` |
| `knowledge_suggestion_updated` | fire-and-forget | `{ id }` | FAQ suggestion mutated — `messages.controller.ts:113` |
| `shadow_preview_locked` | critical | `{ conversationId, lockedMessageIds: string[] }` | Feature 040: older preview superseded — `ai.service.ts:2152` |
| `tuning_suggestion_created` | critical | `{ sourceMessageId, suggestionIds: string[] }` | Feature 040: tuning analyzer produced suggestions — `tuning-analyzer.service.ts:296` |

### 8h. Events the server listens to from clients

Only the built-in `disconnect` event (`backend/src/services/socket.service.ts:119-128`) for stats bookkeeping. **The iOS client does not need to emit anything inbound** — all mutations flow through REST.

### 8i. Confirmation of specific expected events

| Event you asked about | Exists? | Notes |
|---|---|---|
| `message` / `message_created` | **Yes** (`message`) | See row 1 above. `message_created` is not used. |
| `conversation_updated` | **No** — not as a single generic event | Metadata changes are broadcast via specific events: `conversation_starred`, `conversation_resolved`, `ai_mode_changed`, `ai_toggled`. |
| `ai_suggestion_ready` | **Yes** (`ai_suggestion`) | Exact name is `ai_suggestion`. |
| `conversation_starred` | **Yes** | Row 5 above. |
| `conversation_resolved` | **Yes** | Row 6 above. |
| `unread_cleared` | **No** | Unread badge clears implicitly on detail fetch; no push notification. See §6. |
| `typing` (guest typing) | **No** — only AI typing | `ai_typing_text` / `ai_typing_clear` indicate the AI is composing. There is no guest-side typing indicator. |

### 8j. Subscription model

**All-tenant broadcast.** Every event above uses `io.to(`tenant:${tenantId}`).emit(...)` (see `backend/src/services/socket.service.ts:146, 159`). There is no per-conversation subscription protocol — every socket in a tenant receives every event for that tenant and must filter by `conversationId` locally.

---

## 9. Error Response Shape

### Global middleware

`backend/src/middleware/error.ts:3-20` (complete):

```ts
export function errorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  console.error('[Error]', err);

  if (err instanceof Error) {
    const status = (err as { status?: number }).status || 500;
    res.status(status).json({
      error: err.message || 'Internal server error',
    });
    return;
  }

  res.status(500).json({ error: 'Internal server error' });
}
```

### Per-status bodies on `/api/conversations` and children

Most conversation handlers set status + body inline rather than throwing, so the global middleware only catches `catch (err)` blocks at handler bottom. Concrete observed shapes:

| Status | Body | Source |
|---|---|---|
| **400** (Zod) | `{ "error": ZodFormattedError }` (shape of `.flatten()` → `{ fieldErrors: {...}, formErrors: [...] }`) | `conversations.controller.ts:229` (aiToggleAll), `:622` (aiToggle) |
| **400** (ad-hoc) | `{ "error": "<string>" }` | `:249` "propertyId is required", `:255` "aiMode must be one of: ...", `:291` "action must be accept or reject", `:306` "Reservation is not an inquiry", `:433` "aiMode must be autopilot, copilot, or off", `:554` "starred must be a boolean", `:588` "status must be OPEN or RESOLVED" |
| **401** | `{ "error": "<string>" }` | Auth middleware at `backend/src/middleware/auth.ts`. Messages include `"Missing or invalid authorization header"` / `"Invalid or expired token"` |
| **403** | `{ "error": "Forbidden" }` | Rare — `conversations.controller.ts:358` (sendAiNow tenant mismatch) |
| **404** | `{ "error": "Conversation not found" }` etc. | `:89, :187, :264, :301, :346, :415, :441, :467, :563, :597, :669` |
| **422** | `{ "error": "Incomplete conversation data" }` | `:352` — only used by sendAiNow |
| **500** | `{ "error": "Internal server error" }` or `{ "error": "Sync failed" }` or `{ "error": "Failed to fetch suggestion" }` | Every handler's outer catch: `:69, :171, :220, :239, :280, :335, :404, :423, :451, :528, :543, :576, :610, :645, :708` |
| **502** | `{ "error": "<Hostaway API error message>" }` | `:322` — inquiry action Hostaway failure |

**Bottom line for APIError decoder**: the body is **always** an object with a single `error` key. The value is either a **string** (the vast majority of cases) or a **Zod flattened object** (validation errors). No `code`, no `detail`, no `requestId` fields. No trace ID headers either.

### Suggested Swift decoder

```swift
struct APIError: Error, Decodable {
    enum Body {
        case message(String)
        case validation(ZodFlattened)
    }
    struct ZodFlattened: Decodable {
        let fieldErrors: [String: [String]]
        let formErrors: [String]
    }
    let body: Body

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let s = try? c.decode(String.self, forKey: .error) {
            body = .message(s)
        } else {
            body = .validation(try c.decode(ZodFlattened.self, forKey: .error))
        }
    }
    enum CodingKeys: String, CodingKey { case error }
}
```

---

## 10. Rate Limits

**None on `/api/conversations` or any of its children.** `backend/src/routes/conversations.ts:8-36` mounts only `authMiddleware` (line 13). No `loginLimiter`, `signupLimiter`, or `webhookLimiter` is applied.

**Global limiters defined** (`backend/src/middleware/rate-limit.ts`):

```ts
// rate-limit.ts:24-33 — applied ONLY to POST /auth/login
export const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again in 1 minute.' },
  skipSuccessfulRequests: true,
  store: createRedisStore('rl:login:'),
  passOnStoreError: true,
});

// rate-limit.ts:36-44 — applied ONLY to POST /auth/signup
export const signupLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 3,
  // ...
  message: { error: 'Too many signup attempts. Please try again in 1 minute.' },
});

// rate-limit.ts:47-55 — applied ONLY to POST /webhooks/hostaway/:tenantId
export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  // ...
});
```

**429 response shape** (from the `message` option above): `{ "error": "Too many login attempts. Please try again in 1 minute." }` — matches the universal `{ error: string }` shape. `express-rate-limit` is configured with `standardHeaders: 'draft-7'` so responses also carry `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` headers when rate limiting is in effect.

**Implication for iOS**: the Inbox screen does not need to handle 429. Only the login flow does.

---

## 11. Channel / Status / Mode Enumerations

Quoted verbatim from `backend/prisma/schema.prisma`.

### `Channel` — `schema.prisma:280-286`

```prisma
enum Channel {
  AIRBNB
  BOOKING
  DIRECT
  OTHER
  WHATSAPP
}
```

Exact strings: `"AIRBNB"`, `"BOOKING"`, `"DIRECT"`, `"OTHER"`, `"WHATSAPP"` — uppercase. Note: the ios-handoff doc shortened these to "AIR / BOK / DIR" in text, but **the on-wire values are full uppercase**.

### `ReservationStatus` — `schema.prisma:288-295`

```prisma
enum ReservationStatus {
  INQUIRY
  PENDING
  CONFIRMED
  CHECKED_IN
  CHECKED_OUT
  CANCELLED
}
```

Exact strings: `"INQUIRY"`, `"PENDING"`, `"CONFIRMED"`, `"CHECKED_IN"`, `"CHECKED_OUT"`, `"CANCELLED"`. All uppercase; underscore in `CHECKED_IN` / `CHECKED_OUT`.

There is **no `UPCOMING`, `TODAY`, or `EXPIRED`** booking status in the backend. The web UI's "Upcoming" / "Today" grouping is derived client-side from `CONFIRMED` + `checkIn` date arithmetic. iOS must do the same.

### `ConversationStatus` — `schema.prisma:297-300`

```prisma
enum ConversationStatus {
  OPEN
  RESOLVED
}
```

There is no `ARCHIVED` value — archive does not exist (see §7b).

### `MessageRole` — `schema.prisma:302-308`

```prisma
enum MessageRole {
  GUEST
  AI
  HOST
  AI_PRIVATE
  MANAGER_PRIVATE
}
```

`AI_PRIVATE` and `MANAGER_PRIVATE` are internal notes (not sent to the guest); they appear in the detail view but should render distinctly from `GUEST` / `AI` / `HOST` messages.

### AI mode

**Not a Prisma enum.** Stored as `String` on Reservation: `backend/prisma/schema.prisma:103`:

```prisma
aiMode String @default("autopilot")
```

Valid values (enforced by handler-level validation at `backend/src/controllers/conversations.controller.ts:253-254` and `:432`):

```ts
const validModes = ['autopilot', 'copilot', 'off'];
```

Exact strings: `"autopilot"`, `"copilot"`, `"off"` — **lowercase**. Contrast with the Prisma enums above which are uppercase.

### Conversation-level state fields — `schema.prisma:130-134`

```prisma
channel                Channel               @default(OTHER)
status                 ConversationStatus    @default(OPEN)
unreadCount            Int                   @default(0)
starred                Boolean               @default(false)
lastMessageAt          DateTime              @default(now())
```

There is **no** `archived`, `muted`, `pinned`, or `read` boolean on Conversation. The full set of user-visible state is: `status` (OPEN|RESOLVED), `unreadCount` (Int), `starred` (Boolean).

### `PreviewState` — `schema.prisma:658-662` (Feature 040)

```prisma
enum PreviewState {
  PREVIEW_PENDING
  PREVIEW_LOCKED
  PREVIEW_SENDING
}
```

Nullable on Message (`schema.prisma:168`). `null` = normal message; non-null = unsent shadow-mode preview (see Gotchas).

---

## 12. Gotchas

### 12.1 AI mode lives on Reservation, not Conversation

`Reservation.aiEnabled` and `Reservation.aiMode` (`backend/prisma/schema.prisma:102-103`) are joined onto the conversation list row at read time (`conversations.controller.ts:52-53`). Every mutation of these fields hits `prisma.reservation.update(...)`, not `prisma.conversation.update(...)` — e.g. `conversations.controller.ts:444-447` (setAiMode), `:636-639` (aiToggle). **Two conversations in one reservation (rare but possible) would share AI state.** iOS should treat the field as per-conversation for display but understand the write-through goes to the underlying reservation.

### 12.2 Unread is not broadcast on clear

Repeating §6 because this will trip up iOS list-view state: when a user opens a conversation on device A, other devices do not receive any event. They stay stale until the next message arrives (which fires `message` and lets the row update via whatever re-read logic the client has) or until the user manually refreshes. Best practice: optimistically zero the badge locally on tap.

### 12.3 `lastMessage` can be empty string for a brand-new conversation

`conversations.controller.ts:57`: `lastMessage: conv.messages[0]?.content || ''`. If the conversation was just created by a webhook but no messages have synced yet, `lastMessage === ''` and `lastMessageRole === null`. Handle the empty case in the list row — don't crash on a zero-length preview.

### 12.4 No soft-delete anywhere

No `deletedAt` columns on Conversation, Message, Reservation, or Property (`backend/prisma/schema.prisma`). Deleted conversations are gone. But note the "orphan cleanup" path: `conversations.controller.ts:19-27` (`deleteOrphanReservation`) cascades delete Task → PendingAiReply → Message → Conversation → Reservation when a sync discovers the Hostaway reservation no longer exists. iOS clients can encounter "Conversation not found" (404) on the detail endpoint if a background sync ran between a list load and a tap.

### 12.5 Shadow Mode preview fields are hidden on the detail endpoint

Feature 040 adds these fields to Message (`schema.prisma:168-171`):
- `previewState` (PreviewState?)
- `originalAiText` (String?)
- `editedByUserId` (String?)
- `aiApiLogId` (String?)

**But the `GET /api/conversations/:id` response message map at `conversations.controller.ts:159-167` does NOT include any of them.** Each returned message is:

```ts
{ id, role, content, channel, sentAt, imageUrls, ...(aiMeta if available) }
```

So the iOS client cannot distinguish a shadow-mode preview bubble from a normal sent AI message via the conversation detail endpoint. If the iOS app needs to render previews differently, either (a) add these fields to the mapper, or (b) use the dedicated shadow-preview endpoints. **For Inbox v1: ignore shadow mode entirely and render AI messages the same way always.**

### 12.6 `conversation.channel` vs `reservation.channel` vs `message.channel`

Three separate `Channel` fields:
- **`Conversation.channel`** (`schema.prisma:130`) — the conversation's default channel
- **`Reservation.channel`** (`schema.prisma:99`) — the channel the reservation came from
- **`Message.channel`** (`schema.prisma:162`) — the channel this specific message was sent through

These CAN differ. The approveSuggestion handler at `conversations.controller.ts:491-495` picks the reply channel from the **last guest message**, not the conversation default:

```ts
const lastGuestMsg = await prisma.message.findFirst({
  where: { conversationId: id, role: 'GUEST' },
  orderBy: { sentAt: 'desc' },
});
const lastMsgChannel = lastGuestMsg?.channel ?? conversation.channel;
```

For the list row, use `item.channel` (which comes from `Conversation.channel`). For detail display, each message has its own `channel` and should be rendered accordingly (e.g. WhatsApp messages may have different metadata).

### 12.7 Inquiry approval is NOT available on all channels

`conversations.controller.ts:284-337` (`inquiryAction`) calls Hostaway to confirm/cancel. If Hostaway returns an error, the local status is **not** updated (line 318-324: returns 502 with the upstream message). Also note: rejection is platform-limited — the web UI surfaces `"Rejection not supported for this channel — please reject on Airbnb/Booking.com."` (documented in ios-handoff.md §13). For an iOS inquiry action button, expect 502 errors as a normal path and surface them to the user.

### 12.8 `aiMeta` on detail messages is approximated

`conversations.controller.ts:102-127` attaches SOP/tool metadata to AI messages by finding the `AiApiLog` whose `createdAt` is within 60 seconds of the message's `sentAt`. This is a best-effort nearest-neighbor join — it can mis-attribute if two AI calls fired close together. Don't treat `aiMeta` as authoritative for iOS analytics.

### 12.9 Suggestion text is fetched separately

The conversation list row does NOT contain the current copilot suggestion. To render a "pending suggestion" badge on the list, the iOS client must either:
- Listen for the `ai_suggestion` socket event and cache `{ conversationId → suggestion }` in app state, or
- Call `GET /api/conversations/:id/suggestion` (handler at `conversations.controller.ts:533-545`) which returns `{ suggestion: string | null }`

There is no bulk "give me all pending suggestions" endpoint. Polling the per-conversation endpoint for every row is not scalable — prefer the socket-driven cache.

### 12.10 Broadcast model ⇒ client-side filter

Every socket event is broadcast to the entire tenant room (see §8j). On a tenant with 500 active conversations, every keystroke in the AI typing stream fires `ai_typing_text` to every connected client. The iOS client MUST filter events by `conversationId` against "what is this device currently showing" and discard the rest — otherwise you'll spend CPU on unrelated typing updates.

### 12.11 Multi-tenant isolation is strictly server-side

`tenantId` is appended to every Prisma `where` clause in `conversations.controller.ts` (e.g. lines 35, 79, 181, 260, 296, 413, 437, 463, 559, 593, 627, 656). The iOS client does **not** need to send a tenant ID anywhere — it's extracted from the JWT. Don't build a "tenant picker" UI; a token has exactly one tenant.

### 12.12 DRY_RUN mode is not visible on this endpoint

Mentioned in `CLAUDE.md` as a server-side safeguard for outbound messages. None of the conversation list/detail/mutation handlers in `conversations.controller.ts` reference DRY_RUN. It's invisible to the iOS client — but it exists and can cause outbound sends to no-op silently on staging. If "send" calls succeed but the guest never gets the message, ask the backend team about DRY_RUN.

### 12.13 No pagination means the "Inbox" list is O(tenant-conversations)

As noted in §2, the list endpoint returns every conversation the tenant has ever had. On a small tenant this is fine; on a larger one it becomes a payload and render-time issue. Plan the iOS list UI assuming it can receive thousands of rows. Use `List` with lazy rendering and avoid building derived structures (e.g., search indexes) over the whole array synchronously.
