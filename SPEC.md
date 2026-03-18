# GuestPilot v2 — System Specification

**Last updated:** 2026-03-19
**Branch:** advanced-ai-v7

---

## 1. System Overview

GuestPilot is a **multi-tenant AI guest services platform** for serviced apartments (STR). It automates guest communication across Airbnb, Booking.com, WhatsApp, and direct channels via integration with Hostaway PMS. The AI handles routine guest requests, screens booking inquiries, escalates issues to managers, and continuously improves its own classification accuracy.

---

## 2. Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + TypeScript + Express |
| Database | PostgreSQL + Prisma ORM + pgvector extension |
| AI | Anthropic Claude API (Haiku 4.5 default) |
| Embeddings | OpenAI text-embedding-3-small / Cohere embed-multilingual-v4.0 |
| Reranking | Cohere rerank-v3.5 cross-encoder |
| Queue | BullMQ + Redis (optional, falls back to polling) |
| Observability | Langfuse (optional) |
| Frontend | Next.js 16 + React 19 + Tailwind 4 + shadcn/ui |
| Hosting | Railway (backend + PostgreSQL + Redis), Vercel (frontend) |
| PMS | Hostaway (webhooks + REST API) |

---

## 3. Architecture

```
Guest Message (Airbnb / Booking / WhatsApp)
    ↓
Hostaway Unified Webhook → POST /webhooks/hostaway/:tenantId
    ↓
Save message to DB + SSE broadcast to browser
    ↓
scheduleAiReply() → PendingAiReply record (30s debounce)
    ↓
Poll Job (30s interval) picks up due replies
    ↓
generateAndSendAiReply() — MAIN PIPELINE
    ├── 1. Fetch messages + build tiered memory context
    ├── 2. Filter current window messages (30-min buffer)
    ├── 3. RAG Pipeline:
    │   ├── Tier 1: KNN Classifier (embed → cosine → rerank → vote)
    │   ├── Tier 3: Topic State Cache (re-inject if follow-up)
    │   ├── Tier 2: Intent Extractor / Haiku (if Tier 1 uncertain)
    │   └── pgvector retrieval + Rerank for property knowledge
    ├── 4. Build property info (booking status, access codes, SOPs)
    ├── 5. Select system prompt (coordinator vs screening)
    ├── 6. Claude Haiku API call (with prompt caching)
    ├── 7. Parse JSON → handle escalation → create tasks
    ├── 8. Send via Hostaway API → save to DB → SSE broadcast
    └── 9. Judge evaluation (fire-and-forget self-improvement)
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

### Models

**Tenant** — Multi-tenant account
- `id`, `email` (unique), `passwordHash`, `hostawayApiKey`, `hostawayAccountId`
- `webhookSecret`, `plan` (FREE), `propertyCount`
- Relations: all other models via tenantId

**Property** — Listing/apartment
- `tenantId`, `hostawayListingId`, `name`, `address`, `listingDescription`
- `customKnowledgeBase` (JSON — amenities, rules, custom Q&A)
- Unique: tenantId + hostawayListingId

**Guest** — Guest profile
- `tenantId`, `hostawayGuestId`, `name`, `email`, `phone`, `nationality`
- Unique: tenantId + hostawayGuestId

**Reservation** — Booking
- `tenantId`, `propertyId`, `guestId`, `hostawayReservationId`
- `checkIn`, `checkOut`, `guestCount`, `channel`, `status`
- `screeningAnswers` (JSON), `aiEnabled` (true), `aiMode` ("autopilot")
- Unique: tenantId + hostawayReservationId

**Conversation** — Guest-host thread
- `tenantId`, `reservationId`, `guestId`, `propertyId`
- `channel`, `status` (OPEN), `unreadCount`, `starred`, `lastMessageAt`
- `hostawayConversationId`, `conversationSummary` (Text), `summaryMessageCount`

**Message** — Single message
- `conversationId`, `tenantId`, `role`, `content`, `channel`
- `communicationType`, `sentAt`, `hostawayMessageId`, `imageUrls` (String[])
- Relations: rating (MessageRating)

**PendingAiReply** — Debounce state
- `conversationId`, `tenantId`, `scheduledAt`, `fired` (false)
- `suggestion` (Text, optional — co-pilot mode)

**Task** — Escalation/action item
- `tenantId`, `conversationId?`, `propertyId?`
- `title`, `note`, `urgency`, `type`, `status` ("open"), `source` ("ai")
- `dueDate`, `assignee`, `completedAt`

**TenantAiConfig** — Per-tenant AI settings (see Section 10)

**ClassifierExample** — Training examples (base + auto-generated)
- `tenantId`, `text` (Text), `labels` (String[]), `active` (true)
- `source`: "manual" | "llm-judge" | "low-sim-reinforce" | "tier2-feedback"

**ClassifierEvaluation** — Judge evaluation logs
- `tenantId`, `conversationId?`, `guestMessage`
- `classifierLabels`, `classifierMethod`, `classifierTopSim`
- `judgeCorrectLabels`, `retrievalCorrect`, `judgeConfidence`, `judgeReasoning`
- `autoFixed`, `judgeInputTokens`, `judgeOutputTokens`, `judgeCost`

**AiApiLog** — AI call history
- `tenantId`, `conversationId?`, `agentName`, `model`, `temperature`, `maxTokens`
- `systemPrompt` (Text), `userContent` (Text), `responseText` (Text)
- `inputTokens`, `outputTokens`, `costUsd`, `durationMs`, `error?`
- `ragContext` (JSON: query, chunks, totalRetrieved, durationMs)

**Other models:** MessageTemplate, KnowledgeSuggestion, MessageRating, PropertyKnowledgeChunk, AutomatedMessage, AiConfigVersion, OpusReport

---

## 5. API Endpoints

### Authentication (`/auth`)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/signup` | Register tenant with Hostaway credentials |
| POST | `/auth/login` | Login, returns JWT |
| GET | `/auth/settings` | Current user settings |
| POST | `/auth/change-password` | Change password |

### Conversations (`/api/conversations`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/conversations` | List all conversations (paginated, filterable) |
| GET | `/api/conversations/:id` | Full conversation with messages, tasks |
| GET | `/api/conversations/:id/reservation` | Reservation details |
| PATCH | `/api/conversations/:id/star` | Toggle starred |
| PATCH | `/api/conversations/:id/resolve` | Mark resolved |
| PATCH | `/api/conversations/:id/ai-toggle` | Enable/disable AI |
| PATCH | `/api/conversations/:id/ai-mode` | Set AI mode (autopilot/copilot/off) |
| PATCH | `/api/conversations/ai-toggle-all` | Toggle AI globally |
| PATCH | `/api/conversations/ai-toggle-property` | Toggle AI per property |
| POST | `/api/conversations/:id/messages` | Send message |
| POST | `/api/conversations/:id/messages/translate` | Translate & send |
| POST | `/api/conversations/:id/translate-message` | Translate only |
| POST | `/api/conversations/:id/notes` | Internal notes (AI_PRIVATE/MANAGER_PRIVATE) |
| POST | `/api/conversations/:id/inquiry-action` | Accept/decline inquiry |
| POST | `/api/conversations/:id/cancel-ai` | Cancel pending AI reply |
| POST | `/api/conversations/:id/send-ai-now` | Force immediate AI reply |
| POST | `/api/conversations/:id/approve-suggestion` | Approve co-pilot suggestion |

### Properties (`/api/properties`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/properties` | List properties |
| GET | `/api/properties/ai-status` | Properties with AI status |
| GET | `/api/properties/:id` | Property details |
| PUT | `/api/properties/:id/knowledge-base` | Update knowledge base |
| POST | `/api/properties/:id/resync` | Resync from Hostaway + rebuild RAG |
| POST | `/api/properties/:id/reindex-knowledge` | Reindex RAG vectors |

### Tasks (`/api/tasks`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tasks` | List all tasks |
| POST | `/api/tasks` | Create task |
| GET | `/api/conversations/:cid/tasks` | Conversation tasks |
| POST | `/api/conversations/:cid/tasks` | Create conversation task |
| PATCH | `/api/tasks/:id` | Update task |
| DELETE | `/api/tasks/:id` | Delete task |

### Templates (`/api/templates`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/templates` | List templates |
| PATCH | `/api/templates/:id` | Update template |
| POST | `/api/templates/:id/enhance` | AI-enhance template |

### AI Config (`/api/ai-config`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/ai-config` | Current config |
| PUT | `/api/ai-config` | Update config |
| POST | `/api/ai-config/test` | Test AI with current config |
| GET | `/api/ai-config/versions` | Config version history |
| POST | `/api/ai-config/versions/:id/revert` | Revert to version |

### Tenant Config (`/api/tenant-config`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tenant-config` | Get all AI settings |
| PUT | `/api/tenant-config` | Update settings |

### Knowledge & Classifier (`/api/knowledge`)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/knowledge/seed-sops` | Seed tenant SOPs |
| GET | `/api/knowledge/classifier-status` | KNN classifier health |
| POST | `/api/knowledge/test-classify` | Test classification |
| GET | `/api/knowledge/chunk-stats` | RAG chunk stats |
| GET | `/api/knowledge/chunks` | View chunks |
| PATCH | `/api/knowledge/chunks/:id` | Update chunk |
| DELETE | `/api/knowledge/chunks/:id` | Delete chunk |
| GET | `/api/knowledge/evaluations` | Judge evaluations (paginated) |
| GET | `/api/knowledge/evaluation-stats` | Evaluation aggregates |
| GET | `/api/knowledge/classifier-thresholds` | Get thresholds |
| POST | `/api/knowledge/classifier-thresholds` | Update thresholds |
| GET | `/api/knowledge/classifier-examples` | DB training examples |
| POST | `/api/knowledge/classifier-examples` | Add training example |
| DELETE | `/api/knowledge/classifier-examples/:id` | Soft-delete example |
| PATCH | `/api/knowledge/classifier-examples/:id` | Update labels |
| GET | `/api/knowledge/all-examples` | All examples (hardcoded + DB) |
| POST | `/api/knowledge/classifier-reinitialize` | Force re-embed |
| GET | `/api/knowledge` | Knowledge suggestions |
| POST | `/api/knowledge` | Create suggestion |
| POST | `/api/knowledge/detect-gaps` | Detect knowledge gaps |
| POST | `/api/knowledge/bulk-import` | Bulk import suggestions |
| PATCH | `/api/knowledge/:id` | Update suggestion |
| DELETE | `/api/knowledge/:id` | Delete suggestion |

### AI Pipeline (`/api/ai-pipeline`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/ai-pipeline/feed` | Recent AI calls with pipeline data |
| GET | `/api/ai-pipeline/stats` | 24h aggregate stats |

### OPUS Reports (`/api/opus`)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/opus/generate` | Trigger Opus audit report |
| GET | `/api/opus/reports` | List reports |
| GET | `/api/opus/reports/:id` | Get report |
| GET | `/api/opus/reports/:id/raw` | Download raw data |

### Other
| Method | Path | Description |
|--------|------|-------------|
| POST | `/webhooks/hostaway/:tenantId` | Hostaway webhook handler |
| GET | `/api/events` | SSE real-time events (query: token) |
| GET | `/api/analytics` | Analytics data |
| GET | `/api/ai-logs` | AI API logs (paginated) |
| GET | `/api/ai-logs/:id` | Single AI log |
| POST | `/api/messages/:id/rate` | Rate AI message |
| GET | `/health` | Health check |
| GET/POST/etc | `/api/automated-messages/*` | CRUD for automated messages |

---

## 6. AI Pipeline — 9-Stage Flow

### Stage 1: Webhook Ingestion
- Entry: `POST /webhooks/hostaway/:tenantId`
- Returns 200 immediately, processes async
- Events: `message.received`, `reservation.created`, `reservation.updated`
- Logs: event name + reservationId + status + dates + guest count

### Stage 2: Message Processing (`handleNewMessage`)
- Conversation lookup: hostawayConversationId → reservationId → auto-create
- Deduplication by `hostawayMessageId`
- Guest name enrichment from Hostaway API if "Unknown Guest"
- Reservation resync if stale >1 hour (fallback for unreliable webhooks)
- Saves message with role (GUEST/HOST), channel, communicationType

### Stage 3: Debounce & Scheduling
- Default delay: **30 seconds** (configurable per-tenant via `debounceDelayMs`)
- New messages reset the timer
- Working hours: defer outside window to next morning
- SSE broadcast: `ai_typing` with `expectedAt` countdown
- BullMQ enqueue (non-fatal if Redis unavailable)

### Stage 4: 3-Tier RAG Classification

**Tier 1 — KNN Embedding Classifier** (`classifier.service.ts`)
- Embed query with OpenAI or Cohere (configurable)
- K=3 nearest neighbors from ~330 training examples
- Optional Cohere cross-encoder rerank (top-10 → top-3)
- Contextual gate: if best match is "contextual" AND similarity > 0.85 → return immediately
- Weighted voting: label passes if weight > 0.30 AND ≥2/3 neighbors agree
- Cost: ~$0.000001/call

**Tier 3 — Topic State Cache** (`topic-state.service.ts`)
- Fires when Tier 1 returns "contextual" (follow-ups: "ok", "yes", "5am")
- Re-injects previous SOP labels from in-memory cache
- TTL: 30 min per category, max 5 re-injections
- Topic switch detection: "also", "by the way", "another thing"

**Tier 2 — Intent Extractor** (`intent-extractor.service.ts`)
- Fires when Tier 1 topSimilarity < 0.75 AND Tier 3 didn't re-inject
- Claude Haiku with last 5 messages for context
- Returns: { topic, status, urgency, sops[] }
- Cost: ~$0.0001/call, latency: 300-500ms, fires ~20% of messages

**pgvector Property Knowledge** (`rag.service.ts`)
- Top-8 property chunks by cosine similarity (minimum 0.3)
- Optional Cohere rerank (top-8 → best 3)

### Stage 5: Context Assembly
- Conversation history: last 10 verbatim, older summarized (if memorySummaryEnabled)
- Property & guest info: name, dates, guest count, booking status
- Access codes: door code, WiFi — **never shown for INQUIRY status**
- Open tasks (up to 10)
- Knowledge base: up to 20 approved Q&A pairs
- Retrieved RAG/SOP chunks
- Local time (Africa/Cairo)

### Stage 6: AI Generation — Dual Persona

| Persona | Trigger | Temperature | Purpose |
|---------|---------|-------------|---------|
| Guest Coordinator (Omar) | CONFIRMED / CHECKED_IN | 0.25 | Handle guest requests during stay |
| Screening AI (Omar) | INQUIRY | 0.20 | Screen bookings against house rules |
| Manager Translator | Internal | — | Convert manager instructions to guest messages |

- Model: claude-haiku-4-5-20251001 (configurable per-tenant)
- Max tokens: 1024
- Prompt caching: 70% cost reduction on system prompt
- Retry: 5x exponential backoff (2s→32s) for 529 errors
- Image handling: download from Hostaway → base64 → multimodal content block

### Stage 7: Response Parsing & Escalation

**Guest Coordinator output:**
```json
{
  "guest_message": "Response text",
  "escalation": null | { "title": "kebab-case", "note": "details", "urgency": "immediate|scheduled|info_request" },
  "resolveTaskId": "optional",
  "updateTaskId": "optional"
}
```

**Screening AI output:**
```json
{
  "guest message": "Response text",
  "manager": { "needed": true, "title": "category", "note": "details" }
}
```

Escalation creates Task record + SSE `new_task` broadcast + AI_PRIVATE message.

### Stage 8: Delivery

| Mode | Behavior |
|------|----------|
| Auto-pilot | Send via Hostaway API → save to DB → SSE `message` |
| Co-pilot | Hold in `pendingAiReply.suggestion` → SSE `ai_suggestion` |

Channel detection: WhatsApp (`communicationType: 'whatsapp'`) vs channel messaging.

### Stage 9: Judge Self-Improvement (`judge.service.ts`)
- Fire-and-forget after AI response sent
- **Skip if:** topSim ≥ 0.75, Tier 3 re-injected, or majority neighbor support
- **Path A (Tier 2 feedback):** Use Tier 2 labels as correction, validate with 0.35 similarity check
- **Path B (Haiku judge):** Evaluate classification correctness → { retrieval_correct, correct_labels, confidence, reasoning }
- **Auto-fix:** If wrong AND topSim < 0.70 → add training example, reinitialize classifier (max 10/hour)
- **Low-sim reinforcement:** If correct BUT topSim < 0.40 → add example to boost Tier 1

---

## 7. Screening Rules

**Arab nationals:**
- Accepted: families (marriage cert required), married couples (cert required), female-only groups
- Rejected: single males, all-male groups, unmarried couples, mixed-gender non-family

**Lebanese & Emirati exception (effective March 1, 2026):**
- Solo travelers (male or female) accepted
- Groups still follow standard Arab rules

**Non-Arab nationals:** All configurations accepted

**Mixed nationality:** If ANY guest is Arab, apply Arab rules to entire party

**Documents:** Sent AFTER booking acceptance, never before

---

## 8. Escalation Rules

### Immediate (12 triggers)
Safety (fire, gas, flood, medical), locked out, angry guest, manager request, rule violation, rule pushback, review threat, urgent maintenance, guest image, noise complaint, past bad experience, payment dispute

### Scheduled (5 triggers)
Cleaning confirmed at time, maintenance scheduled, amenity delivery, next day arrangement, viewing appointment

### Info Request (8 triggers)
Pricing/discount, local recommendation, reservation change, refund, early/late check-in/out, long-term inquiry, transportation, unknown question

---

## 9. SOP Categories (20 classifiable + 4 baked-in)

### Classifiable (retrieved via Tier 1/2/3)
| Category | Description |
|----------|-------------|
| sop-cleaning | Housekeeping, mopping, $20 fee |
| sop-amenity-request | Towels, pillows, crib, blender, etc. |
| sop-maintenance | Broken items, leaks, AC, electrical, plumbing, pests |
| sop-wifi-doorcode | WiFi password, door code, connectivity |
| sop-visitor-policy | Visitors, family visits, passport verification |
| sop-early-checkin | Early check-in, bag drop, before 3pm |
| sop-late-checkout | Late checkout, after 11am, extending |
| sop-complaint | Dissatisfaction, review threats, quality |
| sop-booking-inquiry | Availability, new bookings, unit options |
| sop-booking-modification | Date changes, guest count, unit swaps |
| sop-booking-confirmation | Reservation verification, status |
| sop-long-term-rental | Monthly rentals, corporate stays |
| sop-booking-cancellation | Cancellation requests and policy |
| sop-property-viewing | Tours, photo/video requests |
| pricing-negotiation | Discounts, rates, budget concerns |
| pre-arrival-logistics | Directions, arrival coordination, airport transfer |
| payment-issues | Payment failures, receipts, disputes, refunds |
| post-stay-issues | Lost items, post-stay complaints, deposits |
| non-actionable | Greetings, test messages, thanks, working hours |
| contextual | Short follow-ups ("ok", "yes", "5am", "tomorrow") |

### Baked-in (always in system prompt, never classified)
- sop-scheduling — Working hours & scheduling logic
- sop-house-rules — Family-only, no smoking, no parties, quiet hours
- sop-escalation-immediate — Emergency escalation instructions
- sop-escalation-scheduled — Scheduled service escalation instructions

---

## 10. Configuration (TenantAiConfig)

| Field | Default | Description |
|-------|---------|-------------|
| agentName | "Omar" | AI persona name (1-50 chars) |
| agentPersonality | "" | Custom personality instructions |
| customInstructions | "" | Appended to system prompt (max 2000 chars) |
| model | claude-haiku-4-5-20251001 | AI model |
| temperature | 0.25 | Response randomness (0.0-1.0) |
| maxTokens | 1024 | Max output tokens |
| debounceDelayMs | 30000 | Message batching delay (ms) |
| aiEnabled | true | Global AI toggle |
| screeningEnabled | true | Pre-booking screening |
| ragEnabled | true | RAG retrieval |
| memorySummaryEnabled | true | Long conversation summarization |
| judgeThreshold | 0.75 | Skip judge if topSim above this |
| autoFixThreshold | 0.70 | Auto-fix if topSim below this |
| classifierVoteThreshold | 0.30 | Min weighted vote score |
| classifierContextualGate | 0.85 | Contextual label gate |
| embeddingProvider | "openai" | "openai" or "cohere" |
| workingHoursEnabled | false | Restrict AI to working hours |
| workingHoursStart | "08:00" | HH:mm format |
| workingHoursEnd | "01:00" | HH:mm format (supports midnight wrap) |
| workingHoursTimezone | "UTC" | IANA timezone |

**Allowed models:** claude-haiku-4-5-20251001, claude-sonnet-4-5, claude-opus-4-5, claude-sonnet-4-6, claude-opus-4-6

---

## 11. Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| DATABASE_URL | Yes | PostgreSQL connection string |
| JWT_SECRET | Yes | JWT signing key |
| ANTHROPIC_API_KEY | Yes | Claude API key |
| OPENAI_API_KEY | No | OpenAI embeddings (RAG disabled without it) |
| COHERE_API_KEY | No | Cohere embeddings + reranking |
| REDIS_URL | No | BullMQ queue (falls back to polling) |
| LANGFUSE_PUBLIC_KEY | No | Langfuse observability |
| LANGFUSE_SECRET_KEY | No | Langfuse observability |
| LANGFUSE_HOST | No | Default: https://cloud.langfuse.com |
| PORT | No | Server port (default: 3000) |
| NODE_ENV | No | development / production |
| RAILWAY_PUBLIC_DOMAIN | No | Public URL for webhooks |
| CORS_ORIGINS | No | Comma-separated (default: http://localhost:3000) |
| DRY_RUN | No | Restrict messages to specific conversation IDs |

---

## 12. SSE Events

| Event | Payload | Trigger |
|-------|---------|---------|
| ai_typing | conversationId, expectedAt | AI reply scheduled |
| ai_typing_clear | conversationId | AI reply cancelled or sent |
| ai_suggestion | conversationId, suggestion | Co-pilot mode: suggestion ready |
| message | conversationId, message{role, content, sentAt, channel} | New message (any role) |
| new_task | conversationId, task | Escalation created |
| task_updated | taskId, status | Task status changed |
| knowledge_suggestion | suggestion | New Q&A suggestion from AI |
| reservation_created | reservationId | New booking |
| reservation_updated | reservationId, conversationIds, status, checkIn, checkOut, guestCount | Booking modified |

Endpoint: `GET /api/events?token=<jwt>`
Transport: Server-Sent Events with Redis pub/sub (fallback: in-memory)

---

## 13. Observability

**Langfuse:** Traces every AI call with tenantId, model, tokens, cost, latency. Fire-and-forget.

**AiApiLog table:** Persistent log of every AI call with full metadata + RAG context snapshot. Queryable via `/api/ai-logs`.

**ClassifierEvaluation table:** Every judge evaluation with classifier labels, judge labels, correctness, auto-fix status. Queryable via `/api/knowledge/evaluations`.

**Frontend AI Pipeline** (`ai-pipeline-v5.tsx`): Real-time dashboard showing tier distribution, cost metrics, latency, self-improvement stats, classifier status.

---

## 14. Model Pricing

| Model | Input/1M | Output/1M | Usage |
|-------|----------|-----------|-------|
| claude-haiku-4-5-20251001 | $0.80 | $4.00 | Default (all AI calls) |
| claude-sonnet-4-6 | $3.00 | $15.00 | Optional upgrade |
| claude-opus-4-6 | $15.00 | $75.00 | OPUS reports, memory summarization |

**Cost per message (typical):** $0.002–0.007
**Monthly at 100 msgs/day:** ~$6–21

---

## 15. Critical Rules

1. Never break the main guest messaging flow — all features degrade gracefully
2. If Redis/OpenAI/Langfuse/Cohere env vars missing → fall back silently, never crash
3. AI always outputs valid JSON (no markdown, code blocks, or extra text)
4. Never show access codes (door code, WiFi) to INQUIRY-status guests
5. Never authorize refunds, credits, or discounts
6. Never guarantee specific service times
7. Escalate when in doubt — better to over-escalate than miss an issue
8. Never discuss manager, AI, or internal processes with guests
