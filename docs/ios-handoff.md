# GuestPilot iOS Handoff — Backend Contracts & Frontend Design

> Reference document for building a SwiftUI iOS client against the existing GuestPilot backend + web app.
> Generated 2026-04-11 from the `040-autopilot-shadow-mode` branch.
>
> Nothing in this document is code to copy — it's contracts, conventions, and visual language to translate.

---

## Table of Contents

1. [Base URLs & Environment](#1-base-urls--environment)
2. [Authentication](#2-authentication)
3. [API Endpoints (Full Inventory)](#3-api-endpoints-full-inventory)
4. [Zod Schemas](#4-zod-schemas)
5. [Real-time / Socket.IO](#5-real-time--socketio)
6. [Error Response Shape](#6-error-response-shape)
7. [Custom Headers, CORS, Rate Limits](#7-custom-headers-cors-rate-limits)
8. [Backend Notes & Gotchas](#8-backend-notes--gotchas)
9. [Design Tokens (Colors, Type, Radius, Motion)](#9-design-tokens-colors-type-radius-motion)
10. [shadcn Component Inventory](#10-shadcn-component-inventory)
11. [Logo & App Icon Assets](#11-logo--app-icon-assets)
12. [Product Copy (Shared Screens)](#12-product-copy-shared-screens)
13. [User-Facing Error Messages](#13-user-facing-error-messages)
14. [Notes for iOS Translation](#14-notes-for-ios-translation)

---

# Part 1 — Backend Contracts

## 1. Base URLs & Environment

- **Production URL**: `https://guestpilot-v2-production.up.railway.app` — pinned in `frontend/vercel.json:7` as `NEXT_PUBLIC_API_URL`. The backend itself constructs webhook URLs from `RAILWAY_PUBLIC_DOMAIN` (`backend/src/controllers/auth.controller.ts:21`), pattern `${protocol}://${domain}/webhooks/hostaway/${tenantId}`.
- **Staging URL**: None found in repo.
- **Local dev URL**: `http://127.0.0.1:3001` — the web app expects the backend on **port 3001** (`frontend/lib/api.ts:3`, `frontend/lib/socket.ts:5`). The backend's default `PORT` is 3000 (`backend/src/server.ts:16`), so local dev overrides it via `.env` or launch script. **Start the backend with `PORT=3001 npm run dev`** to match the web app's expectations.
- **Relevant env vars** (`backend/.env.example`):
  - `DATABASE_URL` — PostgreSQL (required)
  - `JWT_SECRET` — JWT signing key (required; enforced in `backend/src/middleware/auth.ts:6-9`)
  - `PORT` — default 3000
  - `RAILWAY_PUBLIC_DOMAIN` — public domain (prod)
  - `NODE_ENV` — `development` | `production`
  - `OPENAI_API_KEY` — required server-side (iOS client never sees it)
  - `REDIS_URL` — optional; enables BullMQ + Socket.IO Redis adapter
  - `CORS_ORIGINS` — comma-separated; defaults to `['http://localhost:3000']` (`backend/src/app.ts:47-52`)

---

## 2. Authentication

### Endpoints

#### `POST /auth/signup`
- **Auth**: none
- **Rate limit**: 3/min per IP (`backend/src/middleware/rate-limit.ts:36-44`)
- **Request body**:
  ```ts
  {
    email: string,            // valid email
    password: string,         // min 8 chars
    hostawayApiKey: string,   // non-empty
    hostawayAccountId: string // non-empty
  }
  ```
- **Response 201**:
  ```ts
  {
    token: string,
    tenantId: string,
    email: string,
    plan: "FREE" | "PRO" | "SCALE",
    webhookUrl: string,
    webhookSecret: string
  }
  ```
- **Errors**: 409 (email taken), 400 (validation), 500

#### `POST /auth/login`
- **Auth**: none
- **Rate limit**: 5/min per IP (`backend/src/middleware/rate-limit.ts:24-33`)
- **Request body**:
  ```ts
  { email: string, password: string }
  ```
- **Response 200**:
  ```ts
  {
    token: string,
    tenantId: string,
    email: string,
    plan: "FREE" | "PRO" | "SCALE",
    webhookUrl?: string
  }
  ```
- **Errors**: 401 (invalid credentials), 400 (validation), 500

#### `GET /auth/settings`
- **Auth**: Bearer
- **Response 200**: `{ webhookUrl: string, webhookSecret: string }`

#### `POST /auth/change-password`
- **Auth**: Bearer
- **Request body**: `{ newPassword: string }` (min 8)
- **Response 200**: `{ ok: true }`

> **No `/auth/refresh`, no `/auth/logout`, no `/auth/me` endpoint exists.** The iOS app must treat auth as "login → store token → reauthenticate on expiry". See JWT structure below.

### JWT Structure

- **Payload** (`backend/src/types/index.ts:8-12`, `backend/src/middleware/auth.ts:26, 35-36`):
  ```ts
  {
    tenantId: string,
    email: string,
    plan: "FREE" | "PRO" | "SCALE"
  }
  ```
- **Access token lifetime**: **30 days** (hardcoded `expiresIn` in `signToken`, `backend/src/middleware/auth.ts:35-36`)
- **Refresh tokens**: **Not implemented.** No refresh table, no rotation, no `/auth/refresh` endpoint. Client reauthenticates on expiry.
- **Storage**: Not persisted server-side — tokens are self-contained JWTs. Client stores (recommend Keychain on iOS).
- **Delivery**: `Authorization: Bearer <token>` header.
- **Signing secret env var**: `JWT_SECRET` (required at server boot).
- **Middleware that enforces auth**: `backend/src/middleware/auth.ts:13-33` — extracts `Bearer` token, verifies with `jwt.verify`, sets `req.tenantId` and `req.tenantPlan`. Returns 401 on missing/invalid/expired.

### iOS implications

1. **Pick a token expiry UX up front**: at 30-day lifetime, silent reauth on 401 is sufficient. No background refresh needed.
2. **No `/me` endpoint** — treat the `{tenantId, email, plan}` payload from login/signup response as the "current user". If you need them again later, decode the JWT locally.
3. **No logout server-side** — "logout" on iOS is just deleting the token from Keychain.

---

## 3. API Endpoints (Full Inventory)

Grouped by router file. All paths prefixed with the base URL. All `/api/*` endpoints require `Authorization: Bearer` unless noted.

### Auth — `backend/src/routes/auth.ts`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/signup` | No | Create tenant account (see §2) |
| POST | `/auth/login` | No | Authenticate tenant (see §2) |
| GET | `/auth/settings` | Yes | Retrieve webhook configuration |
| POST | `/auth/change-password` | Yes | Update tenant password |

### Conversations — `backend/src/routes/conversations.ts`

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/conversations` | List all conversations for tenant |
| PATCH | `/api/conversations/ai-toggle-all` | Toggle AI globally across tenant |
| PATCH | `/api/conversations/ai-toggle-property` | Toggle AI for one property's conversations |
| GET | `/api/conversations/:id` | Full conversation with messages + AI metadata |
| GET | `/api/conversations/:id/reservation` | Linked reservation details |
| GET | `/api/conversations/:id/suggestion` | Current AI suggestion for conversation |
| PATCH | `/api/conversations/:id/star` | Toggle star/pin |
| PATCH | `/api/conversations/:id/resolve` | Mark resolved |
| PATCH | `/api/conversations/:id/ai-toggle` | Toggle AI on single conversation |
| POST | `/api/conversations/:id/messages` | Send message to guest via Hostaway |
| POST | `/api/conversations/:id/notes` | Create private manager note |
| POST | `/api/conversations/:id/messages/translate` | Translate then send message |
| POST | `/api/conversations/:id/translate-message` | Translate without sending |
| POST | `/api/conversations/:id/inquiry-action` | Approve/reject/cancel inquiry |
| POST | `/api/conversations/:id/cancel-ai` | Cancel pending AI reply |
| POST | `/api/conversations/:id/send-ai-now` | Trigger immediate AI reply |
| PATCH | `/api/conversations/:id/ai-mode` | Set AI mode (autopilot/ghost/off) |
| POST | `/api/conversations/:id/approve-suggestion` | Accept AI suggestion |
| POST | `/api/conversations/:id/sync` | Force sync from Hostaway |

### Messages — `backend/src/routes/messages.ts`
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/messages/:id/rate` | Rate AI message quality |

### Properties — `backend/src/routes/properties.ts`

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/properties` | List all properties |
| GET | `/api/properties/ai-status` | Properties with AI enablement stats |
| GET | `/api/properties/calendar-bulk` | Pricing calendar across all (query: `startDate`, `endDate`, max 6 months, `YYYY-MM-DD`) |
| GET | `/api/properties/:id` | Single property |
| PUT | `/api/properties/:id/knowledge-base` | Update `customKnowledgeBase` JSON |
| POST | `/api/properties/summarize-all` | Batch summarize descriptions |
| POST | `/api/properties/:id/summarize` | Summarize one description |
| POST | `/api/properties/:id/resync` | Fetch fresh listing + rebuild KB |
| GET | `/api/properties/:id/variable-preview` | Preview resolved template variables |
| GET | `/api/properties/:id/calendar` | Pricing calendar for one property |

### Templates — `backend/src/routes/templates.ts`
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/templates` | List templates |
| PATCH | `/api/templates/:id` | Update template body |
| POST | `/api/templates/:id/enhance` | AI-enhance template text |

### Tasks — `backend/src/routes/tasks.ts`
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/tasks` | List all tenant tasks |
| POST | `/api/tasks` | Create global task |
| GET | `/api/conversations/:conversationId/tasks` | List conversation-scoped tasks |
| POST | `/api/conversations/:conversationId/tasks` | Create task linked to conversation |
| PATCH | `/api/tasks/:id` | Update task |
| DELETE | `/api/tasks/:id` | Delete task |

### AI Config — `backend/src/routes/ai-config.ts`
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/ai-config` | Get tenant AI configuration |
| PUT | `/api/ai-config` | Update AI config |
| GET | `/api/ai-config/template-variables` | List available template variables |
| GET | `/api/ai-config/prompt-history` | System prompt version history |
| GET | `/api/ai-config/versions` | List all config versions |
| POST | `/api/ai-config/versions/:id/revert` | Revert to prior version |

### Analytics — `backend/src/routes/analytics.ts`
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/analytics` | Dashboard analytics |

### Knowledge / SOPs — `backend/src/routes/knowledge.ts`
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/knowledge/dedup-conversations` | Dedup FAQ suggestions |
| GET | `/api/knowledge/sop-data` | All SOP definitions + variants + overrides |
| GET | `/api/knowledge/sop-definitions` | List SOP definitions |
| PUT | `/api/knowledge/sop-definitions/:id` | Update SOP definition |
| POST | `/api/knowledge/sop-variants` | Create SOP variant (per reservation status) |
| PUT | `/api/knowledge/sop-variants/:id` | Update SOP variant |
| DELETE | `/api/knowledge/sop-variants/:id` | Delete SOP variant |
| POST | `/api/knowledge/sop-definitions/reset` | Reset SOPs to defaults |
| GET | `/api/knowledge/sop-property-overrides` | List property overrides |
| POST | `/api/knowledge/sop-property-overrides` | Create property override |
| PUT | `/api/knowledge/sop-property-overrides/:id` | Update property override |
| DELETE | `/api/knowledge/sop-property-overrides/:id` | Delete property override |
| GET | `/api/knowledge/tool-invocations` | Tool invocation logs |

### FAQ — `backend/src/routes/faq.ts`
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/faq` | List FAQ entries (status filter) |
| POST | `/api/faq` | Create FAQ entry |
| GET | `/api/faq/categories` | List FAQ categories |
| PATCH | `/api/faq/:id` | Update entry |
| DELETE | `/api/faq/:id` | Delete entry |

### Tenant Config — `backend/src/routes/tenant-config.ts`
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/tenant-config` | Get tenant configuration |
| PUT | `/api/tenant-config` | Update tenant configuration |
| POST | `/api/tenant-config/reset-prompts` | Reset system prompts to defaults |

### Tool Definitions — `backend/src/routes/tool-definitions.ts`
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/tools` | List tool definitions (system + custom) |
| POST | `/api/tools` | Create custom tool |
| PUT | `/api/tools/:id` | Update tool |
| DELETE | `/api/tools/:id` | Delete custom tool |
| POST | `/api/tools/:id/reset` | Reset to system default |

### Push Notifications — `backend/src/routes/push.ts`
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/push/vapid-public-key` | No | Get VAPID public key (Web Push) |
| POST | `/api/push/subscribe` | Yes | Subscribe: `{ endpoint, p256dh, auth, userAgent? }` |
| DELETE | `/api/push/subscribe` | Yes | Unsubscribe |

> **iOS implication**: Web Push is not usable on iOS — the iOS app will need a new endpoint family (APNs via device token) OR reuse `push/subscribe` with an adapter. Coordinate with backend owner before building notifications.

### Reservations — `backend/src/routes/reservations.ts`
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/reservations` | List all reservations |
| DELETE | `/api/reservations/cleanup-orphans` | Delete orphans not in Hostaway |
| POST | `/api/reservations/:reservationId/approve` | Approve inquiry |
| POST | `/api/reservations/:reservationId/reject` | Reject inquiry |
| POST | `/api/reservations/:reservationId/cancel` | Cancel reservation |
| GET | `/api/reservations/:reservationId/last-action` | Last action (approve/reject/cancel) log |

### Alterations — `backend/src/routes/alterations.ts`
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/reservations/:reservationId/alteration` | Get booking alteration details |
| POST | `/api/reservations/:reservationId/alteration/accept` | Accept date/guest count change |
| POST | `/api/reservations/:reservationId/alteration/reject` | Reject alteration |

### Hostaway Connect — `backend/src/routes/hostaway-connect.ts`
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/hostaway-connect/callback` | No | OAuth callback from Hostaway |
| POST | `/api/hostaway-connect/manual` | Yes | Manually link Hostaway credentials |
| GET | `/api/hostaway-connect/status` | Yes | Connection status |
| DELETE | `/api/hostaway-connect` | Yes | Disconnect Hostaway |

### Shadow Preview (Feature 040) — `backend/src/routes/shadow-preview.ts`
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/shadow-previews/:messageId/send` | Send preview bubble (with optional edited text) to guest |

### Tuning Suggestion (Feature 040) — `backend/src/routes/tuning-suggestion.ts`
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/tuning-suggestions` | List (`status`: PENDING\|ACCEPTED\|REJECTED\|ALL, `limit`, `cursor`) |
| POST | `/api/tuning-suggestions/:id/accept` | Apply suggestion to target artifact |
| POST | `/api/tuning-suggestions/:id/reject` | Reject without applying |

### Import — `backend/src/routes/import.ts`
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/import` | Import from Hostaway |
| GET | `/api/import/progress` | Progress status |
| DELETE | `/api/import` | Delete all imported data |

### Document Checklist — `backend/src/routes/document-checklist.ts`
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/conversations/:id/checklist` | Get reservation's document checklist |
| PUT | `/api/conversations/:id/checklist` | Update checklist items |

### Sandbox — `backend/src/routes/sandbox.ts`
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/sandbox/chat` | Test AI chat in isolated environment |

### Webhook Logs — `backend/src/routes/webhook-logs.ts`
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/webhook-logs` | List webhook delivery logs |

### AI Logs — inlined in `backend/src/app.ts:111-204`
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/ai-logs` | List AI API call logs (query: `agent`, `model`, `search`, `limit`, `offset`) |
| GET | `/api/ai-logs/:id` | Single AI API log details |

### System

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | No | `{ status: 'ok', timestamp: ISO8601, messageSync: {...} }` |
| POST | `/webhooks/hostaway/:tenantId` | Basic (webhook secret) | Inbound Hostaway events — **NOT called by iOS client** |

---

## 4. Zod Schemas

Zod is used for endpoint validation in controllers. Validation is via `safeParse()`; failures return 400 with `.flatten()` output.

**Top 5 most relevant to iOS client:**

1. **Signup** — `backend/src/controllers/auth.controller.ts:8-13`
   ```ts
   z.object({
     email: z.string().email(),
     password: z.string().min(8),
     hostawayApiKey: z.string().min(1),
     hostawayAccountId: z.string().min(1),
   });
   ```

2. **Login** — `backend/src/controllers/auth.controller.ts:15-18`
   ```ts
   z.object({
     email: z.string().email(),
     password: z.string().min(1),
   });
   ```

3. **Send Message** — `backend/src/controllers/messages.controller.ts:12-15`
   ```ts
   z.object({
     content: z.string().min(1),
     channel: z.string().optional(),
   });
   ```

4. **Property Knowledge Base** — `backend/src/controllers/properties.controller.ts:6-8`
   ```ts
   z.object({
     customKnowledgeBase: z.record(z.unknown()),
   });
   ```

5. **AI Toggle** — `backend/src/controllers/conversations.controller.ts:11-13`
   ```ts
   z.object({
     aiEnabled: z.boolean(),
   });
   ```

> For a SwiftUI client, **Prisma models in `backend/prisma/schema.prisma` are the richer source of truth** for response shapes (Conversation, Message, Reservation, Property, Task, FaqEntry, etc.). The Zod schemas mostly cover request bodies.

---

## 5. Real-time / Socket.IO

Fully wired up — see `backend/src/services/socket.service.ts`, initialized in `backend/src/server.ts:49` (`initSocketIO()`).

### Connection

- **Transport**: **WebSocket only.** No HTTP long-polling — Railway has no sticky sessions.
- **CORS**: reads `CORS_ORIGINS` env var; same allowlist as REST.
- **Redis adapter**: enabled if `REDIS_URL` set (supports multi-instance); single-instance fallback otherwise.
- **Auth**: JWT passed as `socket.handshake.auth.token`. Verified with same `JWT_SECRET`. On success, `socket.data.tenantId` and `socket.data.userId` (email) are set. Invalid token → connection rejected with `"Invalid token"`.

### Rooms

- Every socket auto-joins room `tenant:{tenantId}` on connect.
- All broadcasts are tenant-scoped — no cross-tenant leakage.

### Emit patterns

- **Fire-and-forget broadcast**: `broadcastToTenant(tenantId, event, data)` — used for non-critical events.
- **Critical broadcast (with retry)**: `broadcastCritical(tenantId, event, data)` — fires event with 5s ACK timeout, retries once on no-ACK. Used for `message` and `ai_suggestion`-type events.
- **Event names** are service-dependent and not strictly typed at the socket layer. Examples found:
  - `knowledge_suggestion_updated` — fired from `backend/src/controllers/messages.controller.ts:112-113`
  - `message` (critical) — new guest or AI message appeared
  - `ai_suggestion` (critical) — new AI suggestion ready

### Server-side inbound

Backend currently only listens for `disconnect` (`backend/src/services/socket.service.ts:119-128`) to maintain stats. **The iOS client does not need to emit anything inbound.**

### Stats helper
`getSocketStats()` returns `{ connections, tenants, totalConnections }` (not exposed over HTTP yet).

### iOS implications

- **No Connection State Recovery** — Railway is stateless. On reconnect, the iOS client must refetch the conversation list / messages via REST to catch up on missed events.
- **Listener-only**: the iOS client subscribes to events for live UI updates; mutations flow through REST.
- Consider **Starscream** or native `URLSessionWebSocketTask` with a thin Socket.IO protocol implementation — or the `socket.io-client-swift` library.
- Event payload shapes aren't strictly typed in the backend; decode defensively. **Ask the backend owner for a payload spec** before committing to a strict `Codable` layout.

---

## 6. Error Response Shape

Global error middleware: `backend/src/middleware/error.ts:3-20`.

### Base shape

```json
{ "error": "string — human-readable message" }
```

### Specialized shapes

- **Zod validation**: `{ "error": { "<field>": { "_errors": ["..."] }, ... } }` — the output of `.flatten()` nested under `error`.
- **Shadow Preview errors**: `{ "error": "<CODE>", "detail": "..." }` where CODE is one of `PREVIEW_NOT_PENDING`, `PREVIEW_NOT_FOUND`, etc.
- **Hostaway delivery failure**: `{ "error": "HOSTAWAY_DELIVERY_FAILED", "detail": "..." }`, status 502.

### Status code conventions

| Code | Meaning |
|---|---|
| 200 | Success (GET, PATCH) |
| 201 | Created (POST) |
| 400 | Validation error / bad request |
| 401 | Missing/invalid/expired token, bad credentials |
| 404 | Resource not found (also implicit permission denial) |
| 409 | Conflict (email taken, preview state mismatch) |
| 500 | Uncaught internal error |
| 502 | Upstream failure (Hostaway) |

**No correlation / request IDs** in error responses or headers.

### iOS decoder strategy

Use a single `APIError` type with:

```swift
struct APIError: Codable, Error {
    let error: ErrorBody
    enum ErrorBody: Codable {
        case message(String)
        case validation([String: ValidationField])
    }
    struct ValidationField: Codable {
        let _errors: [String]
    }
}
```

Treat `string` vs `object` polymorphism at the `error` field via a custom `init(from:)`.

---

## 7. Custom Headers, CORS, Rate Limits

### Request headers the backend requires
- `Authorization: Bearer <token>` on all `/api/*` except `GET /api/push/vapid-public-key` and `/health`.
- **No custom request headers** (no `X-Tenant-Id`, `X-Client-Version`, `Idempotency-Key`, etc.).

### CORS — `backend/src/app.ts:47-53`
```ts
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',')
  : ['http://localhost:3000'];
app.use(cors({ origin: allowedOrigins, credentials: true }));
```
`credentials: true` means the server advertises cookie support, but the web app uses bearer tokens. **iOS is unaffected by CORS.** For local dev, the Railway backend's `CORS_ORIGINS` may need a new entry for dev tooling (e.g., a local dev proxy) — ask backend owner.

### Helmet
Standard security headers applied (`backend/src/app.ts:41-44`). CSP is disabled (it's an API).

### Rate limit response headers
`express-rate-limit` with `standardHeaders: 'draft-7'`:
- `RateLimit-Limit`
- `RateLimit-Remaining`
- `RateLimit-Reset`

### Rate limits (`backend/src/middleware/rate-limit.ts`)
| Endpoint | Limit |
|---|---|
| `POST /auth/login` | 5/min per IP |
| `POST /auth/signup` | 3/min per IP |
| `POST /webhooks/hostaway/:tenantId` | 100/min per tenantId |

Redis store when available; memory fallback otherwise.

### Trust proxy
`trust proxy = 1` (`backend/src/app.ts:38`) — honors `X-Forwarded-For` from Railway edge.

### `req.rawBody`
Captured during body parsing (`backend/src/app.ts:56`) for potential webhook signature verification. **Not relevant to iOS.**

---

## 8. Backend Notes & Gotchas

1. **Multi-tenant isolation** — every query is filtered by `tenantId`. No cross-tenant leakage by design. The iOS client just holds one token; server enforces scope.
2. **Pagination is not standardized**:
   - `GET /api/ai-logs` uses `limit` + `offset`
   - `GET /api/tuning-suggestions` uses cursor-based (`cursor` + `limit`)
   - Most list endpoints return everything (no pagination)
3. **Date format**: ISO 8601 throughout (`YYYY-MM-DDTHH:mm:ss.sssZ`). Calendar queries use date-only (`YYYY-MM-DD`).
4. **Enums** (`backend/prisma/schema.prisma`):
   - `Plan`: `FREE | PRO | SCALE`
   - `Channel`: `AIRBNB | BOOKING | DIRECT | OTHER | WHATSAPP`
   - `ReservationStatus`: `INQUIRY | PENDING | CONFIRMED | CHECKED_IN | CHECKED_OUT | CANCELLED`
   - `ConversationStatus`: `OPEN | RESOLVED`
   - `MessageRole`: `GUEST | AI | HOST | AI_PRIVATE | MANAGER_PRIVATE`
   - `FaqScope`: `GLOBAL | PROPERTY`
   - `FaqStatus`: `SUGGESTED | ACTIVE | STALE | ARCHIVED`
   - `FaqSource`: `MANUAL | AUTO_SUGGESTED`
   - **Feature 040 (Shadow Mode)** — `PreviewState`: `PREVIEW_PENDING | PREVIEW_LOCKED | PREVIEW_SENDING`; `TuningActionType`: `EDIT_SYSTEM_PROMPT | EDIT_SOP_CONTENT | EDIT_SOP_ROUTING | EDIT_FAQ | CREATE_SOP | CREATE_FAQ`; `TuningSuggestionStatus`: `PENDING | ACCEPTED | REJECTED`
5. **Shadow Mode fields on Message** — `previewState`, `originalAiText`, `editedByUserId`, `aiApiLogId`. Safe to hide in iOS v1 unless you're building the tuning flow.
6. **Web Push ≠ APNs** — the `/api/push/*` endpoints are Web Push only (VAPID keys, endpoint + p256dh + auth). iOS needs a parallel APNs flow. **Coordinate before building notifications.**
7. **Hostaway dependency** — signup requires live Hostaway credentials. The iOS app can delegate signup to the web app initially, or gate the signup form behind "you'll need Hostaway credentials" (the web app does this).
8. **JWT expiry** — 30 days, no refresh. Treat 401 on a valid token as "session expired" and route to login.
9. **`DRY_RUN` mode** — server-side safeguard that restricts outbound messages to specific conversation IDs. Invisible to iOS, but relevant when testing against a staging tenant.
10. **Rating endpoint** — `POST /api/messages/:id/rate` exists but request shape is not in Zod schemas dumped above. Check `backend/src/controllers/messages.controller.ts` before wiring up thumb-up/down.

---

# Part 2 — Frontend Design Language

## 9. Design Tokens (Colors, Type, Radius, Motion)

Sources: `frontend/tailwind.config.*`, `frontend/app/globals.css`, `frontend/app/layout.tsx`.

### Color palette (light mode — CSS vars in `:root`)

| Token | Value | Role |
|---|---|---|
| `--background` | `#FAFAF9` | Main surface |
| `--foreground` | `#0C0A09` | Primary text |
| `--popover` | `#FFFFFF` | Popover / modal bg |
| `--popover-foreground` | `#0C0A09` | Popover text |
| `--primary` | `#1D4ED8` | Brand + primary action |
| `--primary-foreground` | `#FFFFFF` | Text on primary |
| `--secondary` | `#F5F5F4` | Secondary surface |
| `--secondary-foreground` | `#0C0A09` | Text on secondary |
| `--muted` | `#E7E5E4` | Muted surface |
| `--muted-foreground` | `#A8A29E` | Muted text |
| `--accent` | `#EEF2FF` | Accent / hover tint |
| `--accent-foreground` | `#1D4ED8` | Text on accent |
| `--destructive` | `#DC2626` | Error / destructive |
| `--destructive-foreground` | `#FFFFFF` | Text on destructive |
| `--border` | `#E7E5E4` | Borders |
| `--input` | `#F5F5F4` | Input bg |
| `--ring` | `#1D4ED8` | Focus ring |

### SwiftUI translation (drop into `Theme.swift`)

```swift
extension Color {
    static let gpBackground         = Color(hex: 0xFAFAF9)
    static let gpForeground         = Color(hex: 0x0C0A09)
    static let gpPopover            = Color(hex: 0xFFFFFF)
    static let gpPrimary            = Color(hex: 0x1D4ED8)
    static let gpPrimaryForeground  = Color(hex: 0xFFFFFF)
    static let gpSecondary          = Color(hex: 0xF5F5F4)
    static let gpMuted              = Color(hex: 0xE7E5E4)
    static let gpMutedForeground    = Color(hex: 0xA8A29E)
    static let gpAccent             = Color(hex: 0xEEF2FF)
    static let gpAccentForeground   = Color(hex: 0x1D4ED8)
    static let gpDestructive        = Color(hex: 0xDC2626)
    static let gpBorder             = Color(hex: 0xE7E5E4)
    static let gpInput              = Color(hex: 0xF5F5F4)
    static let gpRing               = Color(hex: 0x1D4ED8)
}
```

### Dark mode
`next-themes` is installed and referenced in `frontend/components/ui/sonner.tsx:7`, but **dark mode color variables are NOT defined** in `globals.css`. The web app is effectively light-only today. For iOS, either:
1. Ship light-only for v1 to match parity, OR
2. Define your own dark palette now and propose it back for the web app later.

### Typography

Fonts loaded via `next/font/google` in `frontend/app/layout.tsx`:

| Family | Weights | CSS Var | Use |
|---|---|---|---|
| **Plus Jakarta Sans** | 400, 500, 600, 700, 800 | `--font-jakarta` | UI / body (sans) |
| **Playfair Display** | default | `--font-playfair` | Display / brand (serif) |

**Tailwind theme variables**:
- `--font-sans`: `var(--font-jakarta), 'Plus Jakarta Sans', system-ui, sans-serif`
- `--font-display`: `var(--font-playfair), 'Playfair Display', Georgia, serif`

**iOS**: bundle both fonts as `.ttf`, register in `Info.plist`. Use Plus Jakarta Sans as the default app font; Playfair Display for the wordmark and large headings (login screen, onboarding hero).

### Border radius

Base `--radius: 0.5rem` (8px). Derived:

| Token | Size | Derivation |
|---|---|---|
| `--radius-sm` | 4px | `calc(0.5rem - 4px)` |
| `--radius-md` | 6px | `calc(0.5rem - 2px)` |
| `--radius-lg` | 8px | `var(--radius)` |
| `--radius-xl` | 12px | `calc(0.5rem + 4px)` |

**SwiftUI**: standardize on `.cornerRadius(8)` for cards/buttons, `.cornerRadius(12)` for sheets/modals, `.cornerRadius(4)` for chips/tags.

### Motion

Custom keyframes in `globals.css`:

```css
@keyframes typing-bounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.5; }
  30%            { transform: translateY(-5px); opacity: 1; }
}
@keyframes gp-wiggle {
  0%,100% { transform: rotate(-0.25deg); }
  50%     { transform: rotate(-0.25deg); }
  25%,75% { transform: rotate(0.25deg); }
}
/* gp-wiggle: 0.35s ease-in-out infinite — iOS-style reorder jiggle */
```

Standard Tailwind animations used on modals/sheets:
- `animate-in` / `animate-out`, `fade-in-0` / `fade-out-0`, `zoom-in-95` / `zoom-out-95`, `slide-in-from-*`
- Sheet timing: **300ms** on close, **500ms** on open
- `animate-pulse` for skeletons

**SwiftUI equivalents**: `.transition(.opacity.combined(with: .scale(0.95)))` for dialogs, `.transition(.move(edge: .bottom))` for sheets, `withAnimation(.spring())` for list reorders.

### Spacing & shadows

- **Spacing**: stock Tailwind scale, no extensions. Use 4/8/12/16/24 px rhythm in SwiftUI.
- **Shadows**:
  - `shadow-xs`: `0 1px 2px 0 rgba(0,0,0,0.05)` — subtle elevation
  - `shadow-lg`: heavy (modals, sheets)
  - Login card: `0 2px 24px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.04)` — signature elevated card

---

## 10. shadcn Component Inventory

Total: **13 components** in `frontend/components/ui/`. Ordered by usage (heaviest first → SwiftUI priority).

| # | Component | SwiftUI analogue | Usage | Notes |
|---|---|---|---|---|
| 1 | **Button** | Custom `GPButton` with `variant` + `size` enums | Very high | CVA variants: default, destructive, outline, secondary, ghost, link. Sizes: default, sm, lg, icon, icon-sm, icon-lg |
| 2 | **Input** | `TextField` in a bordered background | Very high | Dark-mode ready (`dark:bg-input/30`), custom selection color |
| 3 | **Dialog** | `.sheet` or `.alert` depending on size | High | Wraps `@radix-ui/react-dialog`; fade-in animation |
| 4 | **Sheet** | `.sheet` with `presentationDetents` | High | Drawers (right for nav, bottom for actions) |
| 5 | **Label** | `Text` above a field | High | Disabled state via `group` selector |
| 6 | **Textarea** | `TextEditor` (or `TextField` with `axis: .vertical`) | Medium | Auto-sizes via `field-sizing-content` |
| 7 | **Toggle** | `Toggle` (style pill-button) | Medium | CVA variants, `data-state` driven |
| 8 | **Tooltip** | `.help(...)` / custom popover | Medium | 0ms delay, zoom-in/out animation with arrow |
| 9 | **Separator** | `Divider` | Low-Medium | Horizontal + vertical, 1px |
| 10 | **Skeleton** | Shimmer view | Medium | `bg-accent` + `animate-pulse` |
| 11 | **Sonner** | Custom toast host (e.g. top-of-screen banner) | High | Theme-aware via next-themes |
| 12 | **Toast** | — | Low | Thin wrapper around Radix Toast; app prefers Sonner |
| 13 | **Connection Status** | Custom SwiftUI view | Medium | **Not from shadcn** — fully custom; see copy in §12 |

### Translation priorities for v1

1. `GPButton` — the one component you'll reuse everywhere
2. `GPInput` / `GPTextarea` — auth + compose
3. `GPCard` — conversation rows, property rows (the web app uses raw divs; standardize in SwiftUI)
4. Sheet / Dialog presentation helpers
5. Toast host (Sonner equivalent)

Everything else can lean on native SwiftUI.

---

## 11. Logo & App Icon Assets

### Assets found

| Path | Type | Dimensions | Purpose |
|---|---|---|---|
| `frontend/public/logos/airbnb.png` | PNG | 640×480 | Integration (Airbnb source) |
| `frontend/public/logos/booking.png` | PNG | 640×480 | Integration (Booking.com source) |
| `frontend/public/logos/whatsapp.png` | PNG | 500×500 | Integration (WhatsApp channel) |

### App icon / brand mark

- **No dedicated app icon SVG found** in `public/`, no `app/icon.*`, `app/apple-icon.*`, or `app/favicon.*`.
- The **login screen** renders an inline mark: a **single "G"** on a **#1D4ED8 rounded-xl badge (40×40)** paired with the word **"GuestPilot"** in Playfair Display.
- Loading states use the abbreviation **"GP"** (`frontend/app/page.tsx:51`).

### iOS implications

1. **An iOS app icon needs to be designed from scratch.** No ready-to-use master SVG exists.
2. Short-term: a **"G" monogram on #1D4ED8** with Playfair Display matches the web wordmark — enough to ship a beta. Commission a proper icon set (1024, notification, spotlight sizes) before App Store.
3. **Ask the brand owner for a vector logo** before committing — the inline HTML/CSS mark isn't a real asset.

### Brand naming
- Name: **GuestPilot**
- Tagline (from metadata): **"AI guest communication platform for short-term rental operators"**
- Page title pattern: `"GuestPilot — <Section>"` (e.g. "GuestPilot — Inbox")

---

## 12. Product Copy (Shared Screens)

All strings verbatim. File:line cites `frontend/...`.

### Login / Signup — `app/login/page.tsx`

| Element | Copy | Line |
|---|---|---|
| Wordmark | `GuestPilot` | 60 |
| Subtitle (login) | `Sign in to your account` | 64 |
| Subtitle (signup) | `Create your account` | 64 |
| Tab 1 | `Sign In` | 92 |
| Tab 2 | `Sign Up` | 92 |
| Email label | `Email` | 99 |
| Email placeholder | `you@example.com` | 105 |
| Password label | `Password` | 118 |
| Password placeholder (login) | `••••••••` | 125 |
| Password placeholder (signup) | `Min 8 characters` | 125 |
| Hostaway Account ID label | `Hostaway Account ID` | 147 |
| Hostaway Account ID placeholder | `e.g. 12345` | 153 |
| Hostaway API Key label | `Hostaway API Key` | 166 |
| Hostaway API Key placeholder | `Your Hostaway API key` | 172 |
| Signup info box | `You'll need your Hostaway API credentials. Find them in Hostaway → Settings → API.` | 143 |
| Submit (loading) | `Please wait...` | 202 |
| Submit (login ready) | `Sign In` | 203 |
| Submit (signup ready) | `Create Account` | 203 |
| Footer | `GuestPilot © [YEAR]` (dynamic) | 209 |

**No "Forgot password" link exists today** — there is no reset endpoint or flow in the web app. If the iOS app needs it, coordinate backend work first.

### Main navigation — `components/inbox-v5.tsx:5117–5125`

Tabs, in order:
1. `Overview`
2. `Inbox`
3. `Calendar`
4. `Analytics`
5. `Settings`
6. `Tools`
7. `FAQs`

### Empty states

| Screen | Copy | File:line |
|---|---|---|
| No conversations | `No conversations` | `components/inbox-v5.tsx:3297` |
| No open tasks (in conversation) | `No open tasks` | `components/inbox-v5.tsx:749` |
| No tasks (global) | `No tasks` / `No tasks found` | `components/tasks-v5.tsx:1278, 1286` |
| No FAQ entries | `No FAQ entries yet` | `components/faq-v5.tsx:1018` |
| No properties | `No properties found. Import your listings from Hostaway in Settings.` | `components/listings-v5.tsx:1506` |
| No webhook logs | `No webhook logs yet` | `components/webhook-logs-v5.tsx` |
| No AI logs | `No AI logs yet` | `components/ai-logs-v5.tsx` |
| No analytics data | `No data for this period` | `components/analytics-v5.tsx` |

### Connection status — `components/ui/connection-status.tsx:16-32`

| State | Display | Tooltip |
|---|---|---|
| `connected` | `Live` | `Real-time connection active` |
| `delayed` | `Live (delayed)` | `WebSocket unavailable — using 5-second polling` |
| `reconnecting` | `Reconnecting...` | `Connection lost — reconnecting...` |
| `disconnected` | `Offline` | `No network connection` |

---

## 13. User-Facing Error Messages

Reuse these **verbatim** in iOS for cross-client consistency.

### Auth

| Message | Context | File:line |
|---|---|---|
| `Something went wrong` | Generic login/signup fallback | `app/login/page.tsx:34` |
| *(API-returned message)* | Surfaced directly from backend error body | `app/login/page.tsx:34` |

### Network / connection

| Message | Context | File:line |
|---|---|---|
| `WebSocket unavailable — using 5-second polling` | Degraded real-time | `components/ui/connection-status.tsx:22` |
| `Connection lost — reconnecting...` | Reconnecting | `components/ui/connection-status.tsx:26` |
| `No network connection` | Offline | `components/ui/connection-status.tsx:32` |

### Data loading

| Message | File:line |
|---|---|
| `Failed to load FAQ entries` | `components/faq-v5.tsx:668` |
| `Failed to load properties` | `components/tasks-v5.tsx:835`, `components/listings-v5.tsx:1248` |
| `Failed to load tasks` | `components/tasks-v5.tsx:843, 902` |
| `Failed to load preview` | `components/listings-v5.tsx:503` |
| `Failed to load config` | `components/configure-ai-v5.tsx:800` |
| `Failed to load AI config: <loadError>` | `components/configure-ai-v5.tsx:864` |
| `Failed to load suggestions` | `components/tuning-review-v5.tsx:103` |
| `Failed to load tools` | `components/tools-v5.tsx:933` |
| `Failed to load tool invocations` | `components/tools-v5.tsx:947` |

### Mutations (save / update / delete)

| Message | File:line |
|---|---|
| `Failed to save` | `components/configure-ai-v5.tsx:411, 952, 2210`; `components/sop-editor-v5.tsx:282` |
| `Failed to reset` | `components/configure-ai-v5.tsx:1775` |
| `Failed to update task` | `components/tasks-v5.tsx:886` |
| `Failed to delete task` | `components/tasks-v5.tsx:900` |
| `Failed to reload tasks` | `components/tasks-v5.tsx:902` |
| `Failed to update password` | `components/settings-v5.tsx:643` |
| `Failed to accept alteration` | `components/inbox-v5.tsx:863` |
| `Failed to reject alteration` | `components/inbox-v5.tsx:887` |
| `Rejection not supported for this channel — please reject on Airbnb/Booking.com.` | `components/inbox-v5.tsx:884` |
| `Failed to toggle` | `components/sop-editor-v5.tsx:295` |
| `Failed to create variant` | `components/sop-editor-v5.tsx:338` |
| `Failed to delete variant` | `components/sop-editor-v5.tsx:353` |
| `Failed to save override` | `components/sop-editor-v5.tsx:369` |
| `Failed to create override` | `components/sop-editor-v5.tsx:391` |
| `Failed to remove override` | `components/sop-editor-v5.tsx:406` |

### Tool management

| Message | Context | File:line |
|---|---|---|
| `Required` | Display name empty | `components/tools-v5.tsx:686` |
| `Invalid JSON syntax` | Parameters JSON parse failure | `components/tools-v5.tsx:701` |
| `Failed to create tool` | API failure | `components/tools-v5.tsx:724` |

### Sync / AI

| Message | File:line |
|---|---|
| `Failed to start` | `components/settings-v5.tsx:279` |
| `Failed to get AI response` | `components/sandbox-chat-v5.tsx:201` |

### Generic / fallback

| Message | File:line |
|---|---|
| `Something went wrong` | `components/inbox-v5.tsx:2176`, `components/error-boundary.tsx:71` |

### Message-building pattern

Most call sites use this pattern:

```ts
toast.error(error instanceof Error ? error.message : "Failed to save")
```

i.e. **prefer the backend error message when present, fall back to the static string above**. The iOS client should follow the same pattern: decode the `APIError` body; on success, show `error.error`; on decode failure, show the matching static fallback from this table.

---

## 14. Notes for iOS Translation

### Dark mode
- Partially wired (next-themes installed, Sonner is theme-aware), but **no dark CSS variables** exist in `globals.css` — the web app is effectively light-only.
- **v1 recommendation**: light-only to match parity. Add dark later if the web app defines dark tokens.

### RTL
- Not implemented. No `dir="rtl"`, no bidi logic. Defer for v1.

### i18n
- **Not implemented.** No i18n library, no translation files. All copy above is the canonical English source.
- If you know localization is coming, route every string through a `L10n.Key` enum on iOS day 1 — even pointing at English — so swapping backends later is a config change.

### Design system docs
- None committed (no `STYLE.md`, `docs/design*`, etc.). **This document is the design system reference for iOS.**

### Open questions to resolve with the web/backend team before building

1. **iOS push strategy** — Web Push (`/api/push/*`) won't work on iOS. Build APNs flow (new endpoints) or adapter.
2. **Socket.IO event payload spec** — event names are known, shapes are service-dependent. Get authoritative types.
3. **Forgot password flow** — no endpoint exists. Does iOS need it at launch?
4. **Inquiry approval flow vs channel restrictions** — rejection isn't supported for Airbnb/Booking.com (see the error string in §13). Mirror this limitation.
5. **App icon master asset** — does not exist; commission one or design a monogram for beta.
6. **Rating endpoint body shape** — `POST /api/messages/:id/rate` has no dumped Zod schema. Read the controller before wiring it.
