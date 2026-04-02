# GuestPilot v2 — System Specification

**Last updated:** 2026-04-03

---

## 1. System Overview

GuestPilot is a **multi-tenant AI guest services platform** for serviced apartments (STR). It automates guest communication across Airbnb, Booking.com, WhatsApp, and direct channels via integration with Hostaway PMS. The AI handles routine guest requests using tool-based SOPs, screens booking inquiries, escalates issues to managers, and builds a reusable FAQ knowledge base from manager interactions.

---

## 2. Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + TypeScript + Express |
| Database | PostgreSQL + Prisma ORM |
| AI | OpenAI Responses API (GPT-5.4-Mini default) |
| Lightweight AI | OpenAI GPT-5-Nano (summaries, FAQ suggest, task dedup) |
| Queue | BullMQ + Redis (optional, falls back to polling) |
| Observability | Langfuse (optional) |
| Frontend | Next.js 16 + React 19 + Tailwind 4 + shadcn/ui |
| Hosting | Railway (backend + PostgreSQL + Redis), Vercel (frontend) |
| PMS | Hostaway (webhooks + REST API) |
| Push | Web Push via VAPID (optional) |

---

## 3. Architecture

```
Guest Message (Airbnb / Booking / WhatsApp / Direct)
    ↓
Hostaway Unified Webhook → POST /webhooks/hostaway/:tenantId
    ↓
Save message to DB + Socket.IO broadcast to browser
    ↓
scheduleAiReply() → PendingAiReply record (30s debounce)
    ↓
Poll Job (30s interval) OR BullMQ worker picks up due replies
    ↓
generateAndSendAiReply() — MAIN PIPELINE
    ├── 1. Load tenant config + resolve template variables → content blocks
    ├── 2. Inject conversation summary (if >10 messages)
    ├── 3. SOP classification via forced get_sop tool call
    ├── 4. Fetch SOP content (status variant → property override → default)
    ├── 5. Tool use loop (max 5 rounds):
    │       get_faq, search_available_properties,
    │       check_extend_availability, mark_document_received,
    │       create_document_checklist, custom webhook tools
    ├── 6. Structured JSON output (coordinator or screening schema)
    ├── 7. Escalation enrichment (keyword signal detection)
    ├── 8. Task manager dedup (GPT-5-Nano: CREATE/UPDATE/RESOLVE/SKIP)
    ├── 9. Send via Hostaway API → save to DB → Socket.IO broadcast
    ├── 10. Web Push notification
    └── 11. Fire-and-forget: summary generation (GPT-5-Nano)
```

---

## 4. Data Model

### Enums

| Enum | Values |
|------|--------|
| Plan | FREE, PRO, SCALE |
| Channel | AIRBNB, BOOKING, DIRECT, OTHER, WHATSAPP |
| ReservationStatus | INQUIRY, CONFIRMED, CHECKED_IN, CHECKED_OUT, CANCELLED |
| ConversationStatus | OPEN, RESOLVED |
| MessageRole | GUEST, AI, HOST, AI_PRIVATE, MANAGER_PRIVATE |
| FaqScope | GLOBAL, PROPERTY |
| FaqStatus | SUGGESTED, ACTIVE, STALE, ARCHIVED |

### Models

**Tenant** — Multi-tenant account
- `id`, `email` (unique), `passwordHash`, `hostawayApiKey`, `hostawayAccountId`
- `webhookSecret`, `plan` (FREE), `propertyCount`

**Property** — Listing/apartment
- `tenantId`, `hostawayListingId`, `name`, `address`, `listingDescription`
- `customKnowledgeBase` (JSON — amenities, rules, access info, description)

**Guest** — Guest profile
- `tenantId`, `hostawayGuestId`, `name`, `email`, `phone`, `nationality`

**Reservation** — Booking
- `tenantId`, `propertyId`, `guestId`, `hostawayReservationId`
- `checkIn`, `checkOut`, `guestCount`, `channel`, `status`
- `screeningAnswers` (JSON — document checklist), `aiEnabled`, `aiMode`

**Conversation** — Guest-host thread
- `tenantId`, `reservationId`, `guestId`, `propertyId`
- `channel`, `status`, `unreadCount`, `starred`, `lastMessageAt`
- `conversationSummary` (Text), `summaryUpdatedAt`, `summaryMessageCount`

**Message** — Single message
- `conversationId`, `tenantId`, `role`, `content`, `channel`
- `communicationType`, `sentAt`, `hostawayMessageId`, `imageUrls` (String[])

**PendingAiReply** — Debounce state
- `conversationId`, `tenantId`, `scheduledAt`, `fired`
- `suggestion` (Text — co-pilot mode)

**Task** — Escalation/action item
- `tenantId`, `conversationId?`, `propertyId?`
- `title`, `note`, `urgency`, `type`, `status`, `source`
- `dueDate`, `assignee`, `completedAt`

**TenantAiConfig** — Per-tenant AI settings
- System prompts (coordinator, screening), model, temperature, maxTokens
- Debounce settings, working hours, reasoning effort
- `systemPromptHistory` (JSON — version history with timestamps)

**SopDefinition** — SOP category definition
- `tenantId`, `category`, `toolDescription`, `enabled`
- Relations: SopVariant[], SopPropertyOverride[]

**SopVariant** — Status-specific SOP content
- `sopDefinitionId`, `reservationStatus` (DEFAULT/INQUIRY/CONFIRMED/CHECKED_IN)
- `content` (Text — Markdown with template variable support)

**SopPropertyOverride** — Per-property SOP customization
- `sopDefinitionId`, `propertyId`, `reservationStatus`, `content`

**ToolDefinition** — System + custom tools
- `tenantId`, `name`, `displayName`, `description`, `parameterSchema` (JSON)
- `type` (SYSTEM/CUSTOM), `agentScope`, `enabled`
- `webhookUrl?`, `webhookTimeout?`

**FaqEntry** — FAQ knowledge base
- `tenantId`, `propertyId?`, `category`, `question`, `answer`
- `scope` (GLOBAL/PROPERTY), `status` (SUGGESTED/ACTIVE/STALE/ARCHIVED)
- `source`, `usageCount`, `lastUsedAt`

**AiApiLog** — AI call audit log
- `tenantId`, `conversationId?`, `agentName`, `model`
- `systemPrompt` (Text), `userContent` (Text), `responseText` (Text)
- `inputTokens`, `outputTokens`, `costUsd`, `durationMs`, `error?`
- `ragContext` (JSON — SOP classification, tool calls, escalation signals, cache stats)

**Other models:** MessageTemplate, WebhookLog, PushSubscription, AiConfigVersion, MessageRating

---

## 5. API Endpoints

### Authentication (`/auth`)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/signup` | Register tenant with Hostaway credentials |
| POST | `/auth/login` | Login, returns JWT (30-day expiry) |
| POST | `/auth/change-password` | Change password |

### Conversations (`/api/conversations`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/conversations` | List conversations (paginated, filterable) |
| GET | `/api/conversations/:id` | Full conversation with messages, tasks, AI meta |
| PATCH | `/api/conversations/:id/star` | Toggle starred |
| PATCH | `/api/conversations/:id/resolve` | Mark resolved |
| PATCH | `/api/conversations/:id/ai-toggle` | Enable/disable AI |
| PATCH | `/api/conversations/:id/ai-mode` | Set AI mode (autopilot/copilot/off) |
| PATCH | `/api/conversations/ai-toggle-all` | Toggle AI globally |
| POST | `/api/conversations/:id/messages` | Send message |
| POST | `/api/conversations/:id/messages/translate` | Translate & send |
| POST | `/api/conversations/:id/notes` | Internal notes |
| POST | `/api/conversations/:id/send-ai-now` | Force immediate AI reply |
| POST | `/api/conversations/:id/approve-suggestion` | Approve co-pilot suggestion |
| POST | `/api/conversations/:id/sync` | Sync conversation from Hostaway |

### Properties (`/api/properties`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/properties` | List properties |
| PUT | `/api/properties/:id/knowledge-base` | Update knowledge base |
| POST | `/api/properties/:id/resync` | Resync from Hostaway |
| POST | `/api/properties/:id/summarize-description` | AI-summarize listing |
| GET | `/api/properties/:id/variable-preview` | Preview template variables |

### Tasks (`/api/tasks`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tasks` | List all tasks (filterable by status, urgency, property) |
| POST | `/api/tasks` | Create task |
| PATCH | `/api/tasks/:id` | Update task |
| DELETE | `/api/tasks/:id` | Delete task |

### AI Config (`/api/ai-config`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/ai-config` | Current config |
| PUT | `/api/ai-config` | Update config |
| GET | `/api/ai-config/versions` | Config version history |
| POST | `/api/ai-config/versions/:id/revert` | Revert to version |
| GET | `/api/ai-config/template-variables` | Available template variables |
| GET | `/api/ai-config/prompt-history` | Prompt change history |

### Tenant Config (`/api/tenant-config`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tenant-config` | Get all AI settings |
| PUT | `/api/tenant-config` | Update settings |

### SOPs (`/api/sops`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sops` | List SOP definitions with variants |
| PATCH | `/api/sops/:id` | Update SOP definition |
| POST | `/api/sops/:id/variants` | Create status variant |
| PATCH | `/api/sops/variants/:id` | Update variant content |
| DELETE | `/api/sops/variants/:id` | Delete variant |
| POST | `/api/sops/:id/overrides` | Create property override |
| PATCH | `/api/sops/overrides/:id` | Update property override |
| DELETE | `/api/sops/overrides/:id` | Delete property override |

### Tools (`/api/tools`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tools` | List tool definitions |
| POST | `/api/tools` | Create custom tool |
| PATCH | `/api/tools/:id` | Update tool |
| DELETE | `/api/tools/:id` | Delete tool |
| GET | `/api/tools/invocations` | Recent tool invocations |

### FAQ (`/api/faq`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/faq` | List FAQ entries (filterable by property, scope, status, category) |
| POST | `/api/faq` | Create FAQ entry |
| PATCH | `/api/faq/:id` | Update FAQ entry |
| DELETE | `/api/faq/:id` | Delete FAQ entry |
| GET | `/api/faq/categories` | Category stats |

### Other
| Method | Path | Description |
|--------|------|-------------|
| POST | `/webhooks/hostaway/:tenantId` | Hostaway webhook handler |
| POST | `/api/sandbox/chat` | Test AI response without creating messages |
| GET | `/api/ai-logs` | AI API logs (paginated) |
| GET | `/api/ai-logs/:id` | Single AI log with full system prompt |
| GET | `/api/analytics` | Analytics data |
| POST | `/api/messages/:id/rate` | Rate AI message |
| GET | `/api/webhook-logs` | Webhook audit trail |
| POST | `/api/push/subscribe` | Web Push subscription |
| GET | `/api/reservations` | List reservations |
| GET | `/api/document-checklist/:id` | Get document checklist |
| GET | `/health` | Health check |

---

## 6. AI Pipeline — Detailed Flow

### Stage 1: Webhook Ingestion
- Entry: `POST /webhooks/hostaway/:tenantId`
- Returns 200 immediately, processes async
- Events: `message.received`, `reservation.created`, `reservation.updated`
- Deduplication by `hostawayMessageId`
- Guest name enrichment from Hostaway API if "Unknown Guest"

### Stage 2: Debounce & Scheduling
- Default delay: **30 seconds** (configurable per-tenant)
- New messages reset the timer (batches rapid messages)
- Working hours: defer outside window to next morning
- Socket.IO broadcast: `ai_typing` with `expectedAt` countdown
- BullMQ enqueue (non-fatal if Redis unavailable)

### Stage 3: Context Assembly
- Load tenant config (cached 60s) + system prompt
- Resolve template variables into content blocks:
  - `{CONVERSATION_HISTORY}`, `{RESERVATION_DETAILS}`, `{CURRENT_MESSAGES}`
  - `{ACCESS_CONNECTIVITY}` — **hidden for INQUIRY status**
  - `{PROPERTY_DESCRIPTION}`, `{AVAILABLE_AMENITIES}`, `{ON_REQUEST_AMENITIES}`
  - `{OPEN_TASKS}`, `{DOCUMENT_CHECKLIST}`, `{CURRENT_LOCAL_TIME}`
- Inject conversation summary (if >10 messages, prepended as first block)
- Inject document checklist (appended as last block)

### Stage 4: SOP Classification
- **Single forced tool call** to `get_sop` — replaces the old 3-tier classifier
- GPT-5.4-Mini analyzes the guest message and selects SOP categories
- Returns confidence level (high/medium/low) and reasoning
- SOP content fetched with cascading priority:
  1. Property override for current status
  2. Property override DEFAULT
  3. Status-specific variant
  4. DEFAULT variant
  5. Empty (no SOP for this category)
- SOP content supports template variables: `{ON_REQUEST_AMENITIES}`, `{PROPERTY_AMENITIES}`, custom variables

### Stage 5: Tool Use Loop (max 5 rounds)
- AI can call tools during response generation
- **System tools:** get_sop, get_faq, search_available_properties, check_extend_availability, mark_document_received, create_document_checklist
- **Custom tools:** webhook-backed, user-defined via Tools page
- Each tool call logged in ragContext: `{ name, input, results, durationMs }`
- All tool names tracked in `toolNames[]` array

### Stage 6: AI Generation — Dual Persona

| Persona | Trigger | Temperature | Purpose |
|---------|---------|-------------|---------|
| Guest Coordinator (Omar) | CONFIRMED / CHECKED_IN | 0.25 | Handle guest requests during stay |
| Screening AI (Omar) | INQUIRY | 0.20 | Screen bookings against house rules |
| Manager Translator | Internal | — | Convert manager instructions to guest messages |

- Model: `gpt-5.4-mini-2026-03-17` (configurable per-tenant)
- Output: structured JSON via `json_schema` enforcement
- Prompt caching: 24h retention via `prompt_cache_key` (~90% cache hit)
- Streaming: real-time SSE broadcast via Socket.IO (`ai_typing_text`)
- Image handling: download from Hostaway → base64 → multimodal content block

### Stage 7: Response Parsing & Escalation

**Coordinator output:**
```json
{
  "guest_message": "Response text",
  "escalation": { "title": "kebab-case", "note": "details", "urgency": "immediate|scheduled|info_request" },
  "resolveTaskId": "optional",
  "updateTaskId": "optional"
}
```

**Screening output:**
```json
{
  "guest message": "Response text",
  "manager": { "needed": true, "title": "category", "note": "details" }
}
```

### Stage 8: Escalation Enrichment & Task Dedup
- Keyword-based signal detection (English + Arabic patterns)
- Task manager (GPT-5-Nano): compare new escalation against open tasks → CREATE/UPDATE/RESOLVE/SKIP
- Fast path: no open tasks → CREATE without API call
- Fallback: on error → CREATE (never lose escalation)

### Stage 9: Delivery & Post-Processing

| Mode | Behavior |
|------|----------|
| Autopilot | Send via Hostaway API → save to DB → Socket.IO broadcast |
| Co-pilot | Hold in `pendingAiReply.suggestion` → Socket.IO `ai_suggestion` |

- Web Push notification to manager
- Fire-and-forget: conversation summary (GPT-5-Nano, if >10 messages)
- Fire-and-forget: FAQ auto-suggest (if manager replied to info_request)

---

## 7. SOP Categories (23)

| Category | Description |
|----------|-------------|
| sop-cleaning | Housekeeping requests |
| sop-amenity-request | Towels, pillows, crib, blender, etc. |
| sop-maintenance | Broken items, leaks, AC, electrical |
| sop-wifi-doorcode | WiFi password, door code, connectivity |
| sop-visitor-policy | Visitors, family visits |
| sop-early-checkin | Early check-in, bag drop |
| sop-late-checkout | Late checkout, extending |
| sop-complaint | Dissatisfaction, review threats |
| sop-booking-inquiry | Availability, new bookings |
| sop-booking-modification | Date changes, guest count |
| sop-booking-confirmation | Reservation verification |
| sop-booking-cancellation | Cancellation requests |
| sop-long-term-rental | Monthly rentals, corporate stays |
| sop-property-viewing | Tours, photo requests |
| pricing-negotiation | Discounts, rates, budget |
| pre-arrival-logistics | Directions, arrival coordination |
| payment-issues | Payment failures, receipts, disputes |
| post-stay-issues | Lost items, post-stay complaints |
| property-info | General property information |
| property-description | Listing description |
| local-recommendations | Restaurants, attractions, activities |
| none | No matching SOP |
| escalate | Direct escalation to manager |

Each SOP has status-specific variants (INQUIRY, CONFIRMED, CHECKED_IN) and per-property overrides.

---

## 8. FAQ Categories (15)

check-in-access, check-out-departure, wifi-technology, kitchen-cooking, appliances-equipment, house-rules, parking-transportation, local-recommendations, attractions-activities, cleaning-housekeeping, safety-emergencies, booking-reservation, payment-billing, amenities-supplies, property-neighborhood

---

## 9. Screening Rules

**Arab nationals:**
- Accepted: families (marriage cert required), married couples (cert required), female-only groups
- Rejected: single males, all-male groups, unmarried couples, mixed-gender non-family

**Lebanese & Emirati exception:**
- Solo travelers (male or female) accepted
- Groups still follow standard Arab rules

**Non-Arab nationals:** All configurations accepted

**Mixed nationality:** If ANY guest is Arab, apply Arab rules to entire party

**Documents:** Sent AFTER booking acceptance, never before

---

## 10. Escalation Rules

### Immediate (12 triggers)
Safety (fire, gas, flood, medical), locked out, angry guest, manager request, rule violation, review threat, urgent maintenance, guest image, noise complaint, past bad experience, payment dispute

### Scheduled (5 triggers)
Cleaning confirmed, maintenance scheduled, amenity delivery, next day arrangement, viewing appointment

### Info Request (8 triggers)
Pricing/discount, local recommendation, reservation change, refund, early/late check-in/out, long-term inquiry, transportation, unknown question

---

## 11. Configuration (TenantAiConfig)

| Field | Default | Description |
|-------|---------|-------------|
| agentName | "Omar" | AI persona name |
| model | gpt-5.4-mini-2026-03-17 | AI model |
| temperature | 0.25 | Response randomness |
| maxTokens | 1024 | Max output tokens |
| reasoningEffort | "auto" | OpenAI reasoning effort |
| debounceDelayMs | 30000 | Message batching delay |
| adaptiveDebounce | false | Extend window for rapid messages |
| aiEnabled | true | Global AI toggle |
| screeningEnabled | true | Pre-booking screening |
| memorySummaryEnabled | true | Long conversation summarization |
| workingHoursEnabled | false | Restrict AI to working hours |
| workingHoursStart | "08:00" | HH:mm format |
| workingHoursEnd | "01:00" | Supports midnight wrap |
| workingHoursTimezone | "UTC" | IANA timezone |

**Allowed models:** gpt-5.4-mini-2026-03-17, gpt-5.4-nano, gpt-5.4, gpt-5-nano

---

## 12. Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| DATABASE_URL | Yes | PostgreSQL connection string |
| JWT_SECRET | Yes | JWT signing key |
| OPENAI_API_KEY | Yes | OpenAI Responses API key |
| REDIS_URL | No | BullMQ queue (falls back to polling) |
| LANGFUSE_PUBLIC_KEY | No | Langfuse observability |
| LANGFUSE_SECRET_KEY | No | Langfuse observability |
| LANGFUSE_HOST | No | Default: https://cloud.langfuse.com |
| PORT | No | Server port (default: 3000) |
| NODE_ENV | No | development / production |
| RAILWAY_PUBLIC_DOMAIN | No | Public URL for webhooks |
| CORS_ORIGINS | No | Comma-separated origins |
| DRY_RUN | No | Restrict to specific conversation IDs |
| VAPID_PUBLIC_KEY | No | Web Push (disabled without all 3) |
| VAPID_PRIVATE_KEY | No | Web Push |
| VAPID_SUBJECT | No | Web Push mailto: address |

---

## 13. Real-Time Events (Socket.IO)

| Event | Payload | Trigger |
|-------|---------|---------|
| ai_typing | conversationId, expectedAt | AI reply scheduled |
| ai_typing_clear | conversationId | AI reply cancelled or sent |
| ai_typing_text | conversationId, text | Streaming AI response chunk |
| ai_suggestion | conversationId, suggestion | Co-pilot mode suggestion |
| message | conversationId, message | New message (any role) |
| new_task | conversationId, task | Escalation created |
| task_updated | taskId, status | Task status changed |
| faq_suggestion | faqEntry | New auto-suggested FAQ |
| reservation_created | reservationId | New booking |
| reservation_updated | reservationId, status, dates | Booking modified |

---

## 14. Observability

**AiApiLog table:** Persistent log of every AI call with full metadata, RAG context snapshot, tool calls, escalation signals, cache stats. Queryable via `/api/ai-logs`.

**Langfuse:** Optional tracing for every AI call. Fire-and-forget — never blocks pipeline.

**AI Logs page:** Frontend viewer with per-call drill-down: system prompt, content blocks, all tool calls with input/output, SOP classification, escalation signals, cache hit rate, cost, duration.

---

## 15. Model Pricing

| Model | Input/1M | Output/1M | Usage |
|-------|----------|-----------|-------|
| gpt-5.4-mini-2026-03-17 | $0.40 | $1.60 | Default (main pipeline + SOP classification) |
| gpt-5-nano | $0.05 | $0.20 | Summaries, FAQ suggest, task dedup |
| gpt-5.4 | $2.00 | $8.00 | Optional premium upgrade |

**Cost per message (typical):** $0.001–0.004 (with ~90% prompt cache hit)
**Monthly at 100 msgs/day:** ~$3–12

---

## 16. Critical Rules

1. Never break the main guest messaging flow — all features degrade gracefully
2. If Redis/Langfuse env vars missing → fall back silently, never crash
3. AI always outputs valid JSON — enforced via json_schema structured output
4. Never show access codes (door code, WiFi) to INQUIRY-status guests
5. Never authorize refunds, credits, or discounts
6. Never guarantee specific service times
7. Escalate when in doubt — better to over-escalate than miss an issue
8. Never discuss manager, AI, or internal processes with guests
