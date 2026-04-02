# GuestPilot AI System Flow — Complete Reference

**Last updated:** 2026-04-03

---

## Architecture Overview

```
Guest Message (Airbnb/Booking/WhatsApp/Direct)
    ↓
Hostaway Webhook → webhooks.controller.ts
    ↓
Save message to DB → Socket.IO broadcast to browser
    ↓
scheduleAiReply() → PendingAiReply record
    ↓
[Debounce: wait for more messages — default 30s]
    ↓
Poll Job (30s) OR BullMQ worker picks up due replies
    ↓
generateAndSendAiReply() — MAIN PIPELINE
    ├── 1. Load tenant config + build system prompt
    ├── 2. Resolve template variables → content blocks
    ├── 3. Inject conversation summary (>10 messages)
    ├── 4. SOP classification (forced get_sop tool call)
    ├── 5. Fetch SOP content (cascading: override → variant → default)
    ├── 6. Tool use loop (max 5 rounds)
    ├── 7. Structured JSON output (json_schema enforcement)
    ├── 8. Escalation enrichment (keyword signals)
    ├── 9. Task manager dedup (GPT-5-Nano)
    ├── 10. Send via Hostaway → save → broadcast → push
    └── 11. Fire-and-forget: summary, FAQ auto-suggest
```

---

## Stage 1: Webhook Entry

**File:** `backend/src/controllers/webhooks.controller.ts` — `handleNewMessage()`

1. Webhook arrives at `POST /webhooks/hostaway/:tenantId`
2. Returns 200 immediately, processes async
3. `isGuest = data.isIncoming === 1`
4. Conversation lookup with fallback chain:
   - By `hostawayConversationId`
   - By `reservationId`
   - Auto-create reservation + conversation if neither exists
5. Guest name enrichment: if "Unknown Guest", calls Hostaway API to backfill
6. Deduplication by `hostawayMessageId`
7. Save message to DB (role: GUEST or HOST)
8. If guest message AND `reservation.aiEnabled === true`:
   - Call `scheduleAiReply(conversationId, tenantId, prisma)`
9. Socket.IO broadcast `message` event to all browser tabs
10. If manager reply to info_request task → trigger FAQ auto-suggest (fire-and-forget)

**AI disabled when:**
- `reservation.aiEnabled = false` (cancellation/checkout)
- `reservation.aiMode = 'off'`
- Host manually toggled AI off

---

## Stage 2: Debounce Service

**File:** `backend/src/services/debounce.service.ts` — `scheduleAiReply()`

1. Fetch tenant config (cached 60s)
2. **Working hours check:**
   - Within hours → `scheduledAt = now + debounceDelayMs` (default 30s)
   - Outside hours → `scheduledAt = nextWorkingHoursStart()` (defer to morning)
3. Upsert `PendingAiReply`:
   - Existing unfired → reset timer (debounce extension)
   - New → create with `fired: false`
4. **Adaptive debounce** (if enabled): detect rapid-fire messages, extend window
5. Socket.IO broadcast `ai_typing` event with `expectedAt` timestamp
6. BullMQ enqueue (non-fatal if Redis unavailable)

---

## Stage 3: Poll Job

**File:** `backend/src/jobs/aiDebounce.job.ts` — 30s interval

- Query: `PendingAiReply WHERE fired=false AND scheduledAt <= now()`
- For each due reply:
  1. Mark `fired = true` immediately (prevents double-firing)
  2. Gate check: skip if `aiEnabled=false` or `aiMode='off'`
  3. Build context with reservation/property/guest data
  4. Call `generateAndSendAiReply(context, prisma)` — fire-and-forget

---

## Stage 4: Main AI Pipeline

**File:** `backend/src/services/ai.service.ts` — `generateAndSendAiReply()`

### 4a. Template Variables & Content Blocks

**File:** `backend/src/services/template-variable.service.ts`

System prompts contain `{VARIABLE}` placeholders that get resolved into separate content blocks (keeps system prompt cacheable, dynamic data goes in user message).

**Variables (10):**

| Variable | Scope | Description |
|----------|-------|-------------|
| CONVERSATION_HISTORY | Both | Recent messages (last 20) |
| RESERVATION_DETAILS | Both | Guest name, dates, count, channel, status |
| CURRENT_MESSAGES | Both | Messages since debounce window |
| ACCESS_CONNECTIVITY | Coordinator only | Door code, WiFi — **NEVER for INQUIRY** |
| PROPERTY_DESCRIPTION | Both | Listing description |
| AVAILABLE_AMENITIES | Both | Standard amenities list |
| ON_REQUEST_AMENITIES | Both | On-request amenities |
| OPEN_TASKS | Both | Active tasks for this conversation |
| DOCUMENT_CHECKLIST | Both | Pending document requirements |
| CURRENT_LOCAL_TIME | Both | Local time (Africa/Cairo) |

**Two resolution modes:**
1. **Explicit blocks** — `<!-- CONTENT_BLOCKS -->` delimiter in prompt, `<!-- BLOCK -->` separators
2. **Auto-derive** — scan for `{VARIABLE}` patterns, one block per variable

**Property overrides:** Per-listing customTitle + notes appended to variable output.

### 4b. Conversation Summary

**File:** `backend/src/services/summary.service.ts`

- Fires after AI response, only when conversation has >10 messages
- Summarizes messages outside the 10-message window (keeps last 10 in full context)
- Model: GPT-5-Nano with `reasoning: { effort: 'minimal' }`
- Max 150 words, enforced at sentence boundary
- Stored in `Conversation.conversationSummary`
- Injected as first content block: `### CONTEXT SUMMARY (earlier messages) ###`
- Extends existing summary (incremental, doesn't re-summarize everything)

### 4c. SOP Classification

**Function:** `classifyMessageSop()` in `ai.service.ts`

- **Single forced tool call** to `get_sop` — the AI selects which SOP category applies
- Tool schema dynamically built from enabled SOP definitions (`sop.service.ts`)
- Returns: `{ categories, confidence, reasoning, inputTokens, outputTokens, durationMs }`
- Model: same as main pipeline (GPT-5.4-Mini)

**SOP content retrieval** — cascading priority:

```
1. SopPropertyOverride (propertyId + current status)
2. SopPropertyOverride (propertyId + DEFAULT)
3. SopVariant (current status)
4. SopVariant (DEFAULT)
5. Empty string (no content for this category)
```

**Template variables in SOPs:** SOP content can include `{ON_REQUEST_AMENITIES}`, `{PROPERTY_AMENITIES}`, and custom variables — resolved at fetch time.

### 4d. Tool Use Loop

**Function:** `createMessage()` → tool handling in `ai.service.ts`

The AI can call tools during response generation. Max 5 rounds of tool calls before forcing a final response.

**System tools:**

| Tool | Handler | Purpose |
|------|---------|---------|
| `get_sop` | `sop.service.ts` | Fetch SOP content by category |
| `get_faq` | `faq.service.ts` | Fetch FAQ entries by category |
| `search_available_properties` | `property-search.service.ts` | Cross-sell properties |
| `check_extend_availability` | `extend-stay.service.ts` | Check availability for date changes |
| `mark_document_received` | `document-checklist.service.ts` | Mark passport/cert received |
| `create_document_checklist` | `document-checklist.service.ts` | Create screening checklist |
| Custom tools | `webhook-tool.service.ts` | User-defined webhook calls |

**Tool tracking in ragContext:**
```typescript
ragContext.tools = [
  { name: 'get_sop', input: { categories: ['sop-cleaning'] }, results: '## SOP...', durationMs: 45 },
  { name: 'get_faq', input: { category: 'cleaning-housekeeping' }, results: '...', durationMs: 32 },
]
ragContext.toolNames = ['get_sop', 'get_faq']  // All tools used
ragContext.toolName = 'get_sop'                 // First tool (backward compat)
```

### 4e. Agent Selection & System Prompt

**Decision:** `status === 'INQUIRY' ? screeningAI : guestCoordinator`

| Agent | Purpose | Output Schema |
|-------|---------|--------------|
| Coordinator | Handle guest requests during stay | `{ guest_message, escalation?, resolveTaskId?, updateTaskId? }` |
| Screening | Screen inquiry guests against house rules | `{ "guest message", manager: { needed, title, note } }` |

System prompts stored in `TenantAiConfig` (DB), with seed defaults. Editable via Configure AI page. Version history + rollback supported.

### 4f. OpenAI Responses API Call

**Function:** `createMessage()` in `ai.service.ts`

- API: OpenAI Responses API (`client.responses.create()`)
- Model: tenant-configurable (default `gpt-5.4-mini-2026-03-17`)
- Structured output: `text.format = { type: 'json_schema', name: 'coordinator_response', strict: true, schema: {...} }`
- Prompt caching: `prompt_cache_key` + `prompt_cache_retention: '24h'` → ~90% cache hit
- Reasoning effort: configurable per-tenant (auto/none/low/medium/high)
- Retry: exponential backoff for rate limits
- Streaming: via `stream: true`, chunks broadcast via Socket.IO
- Image handling: download from Hostaway → base64 data URL → content block
- All calls logged to `AiApiLog` table with full metadata + ragContext

**Cache stats from OpenAI:**
```
usage.input_tokens_details.cached_tokens → ragContext.cachedInputTokens
usage.input_tokens → ragContext.totalInputTokens
```

### 4g. Escalation Handling

**File:** `backend/src/services/escalation-enrichment.service.ts`

- Keyword pattern matching (English + Arabic) across 25 trigger categories
- Three urgency tiers: immediate, scheduled, info_request
- Signals stored in `ragContext.escalationSignals[]`
- Supplements AI judgment — does not override

### 4h. Task Manager Dedup

**File:** `backend/src/services/task-manager.service.ts`

- Model: GPT-5-Nano (`reasoning: { effort: 'minimal' }`)
- Compare new escalation against open tasks for the conversation
- Decision: CREATE / UPDATE (append note) / RESOLVE (mark complete) / SKIP (duplicate)
- **Fast path:** No open tasks → CREATE without API call
- **Fallback:** On any error → CREATE (never lose an escalation)
- Cost: ~$0.00005/call, latency <500ms

---

## Stage 5: Delivery

**File:** `ai.service.ts` — response handling

| Mode | Behavior |
|------|----------|
| Autopilot | Send via Hostaway API → save to DB → Socket.IO broadcast |
| Co-pilot | Hold in `pendingAiReply.suggestion` → Socket.IO `ai_suggestion` |

- Channel detection: WhatsApp (`communicationType: 'whatsapp'`) vs standard messaging
- Web Push notification to manager (fire-and-forget)
- Socket.IO `ai_typing_clear` event after response sent

---

## Stage 6: Post-Processing (Fire-and-Forget)

### Conversation Summary
- **Trigger:** After AI response, if conversation has >10 messages
- **Model:** GPT-5-Nano
- See Stage 4b for details

### FAQ Auto-Suggest
- **Trigger:** When manager replies to an info_request escalation
- **File:** `backend/src/services/faq-suggest.service.ts`
- **Model:** GPT-5-Nano (Responses API + json_schema)
- **Input:** Task note (AI's escalation summary) + manager reply text
- **Classification:** Is the reply reusable property knowledge? → question/answer/category extraction
- **Dedup:** First-100-char question fingerprint
- **Output:** `FaqEntry` with status=SUGGESTED, broadcast via Socket.IO `faq_suggestion`
- **Lifecycle:** Manager approves with one tap (SUGGESTED → ACTIVE), or dismisses

---

## Key Parameters

| Parameter | Default | Configurable | Location |
|-----------|---------|-------------|----------|
| Debounce delay | 30000ms | Yes (DB) | debounce.service.ts |
| Adaptive debounce | false | Yes (DB) | debounce.service.ts |
| Poll interval | 30000ms | No | aiDebounce.job.ts |
| Summary threshold | 10 messages | No | summary.service.ts |
| Summary max words | 150 | No | summary.service.ts |
| Tool rounds max | 5 | No | ai.service.ts |
| Prompt cache retention | 24h | No | ai.service.ts |
| SOP cache TTL | 5 min | No | sop.service.ts |
| Tenant config cache | 60s | No | tenant-config.service.ts |
| Tool definition cache | 5 min | No | tool-definition.service.ts |
| FAQ stale threshold | 90 days | No | faqMaintenance.job.ts |
| FAQ suggestion expiry | 28 days | No | faqMaintenance.job.ts |
| Task manager fallback | CREATE | No | task-manager.service.ts |

---

## File Map

```
backend/src/
├── controllers/
│   ├── webhooks.controller.ts         # Hostaway webhook handler
│   ├── messages.controller.ts         # Send messages, notes, FAQ auto-suggest trigger
│   ├── conversations.controller.ts    # Conversation CRUD, AI toggle, suggestions
│   ├── ai-config.controller.ts        # System prompts, versions, template variables
│   ├── faq.controller.ts              # FAQ CRUD
│   ├── task.controller.ts             # Task CRUD
│   ├── auth.controller.ts             # Login, signup
│   └── properties.controller.ts       # Property management, knowledge base
├── jobs/
│   ├── aiDebounce.job.ts              # 30s poll for due AI replies
│   ├── faqMaintenance.job.ts          # Stale FAQ cleanup (90d/28d)
│   ├── messageSync.job.ts             # Hostaway message sync
│   └── reservationSync.job.ts         # Hostaway reservation sync
├── services/
│   ├── ai.service.ts                  # MAIN: generateAndSendAiReply() + createMessage()
│   ├── template-variable.service.ts   # {VARIABLE} → content block resolution
│   ├── sop.service.ts                 # DB-backed SOPs, variants, overrides, tool schema
│   ├── tool-definition.service.ts     # System + custom tool definitions
│   ├── faq.service.ts                 # FAQ retrieval (global + property)
│   ├── faq-suggest.service.ts         # Auto-suggest FAQ from manager replies
│   ├── summary.service.ts             # Conversation summarization (GPT-5-Nano)
│   ├── task-manager.service.ts        # Escalation dedup (GPT-5-Nano)
│   ├── debounce.service.ts            # Message batching + working hours
│   ├── queue.service.ts               # BullMQ wrapper (Redis optional)
│   ├── escalation-enrichment.service.ts # Keyword-based escalation signals
│   ├── extend-stay.service.ts         # Stay extension availability checker
│   ├── property-search.service.ts     # Cross-sell property search
│   ├── document-checklist.service.ts  # Passport/cert tracking
│   ├── webhook-tool.service.ts        # Custom webhook tool execution
│   ├── tenant-config.service.ts       # Per-tenant AI config (cached 60s)
│   ├── hostaway.service.ts            # Hostaway API client (OAuth2)
│   ├── push.service.ts                # Web Push (VAPID)
│   └── socket.service.ts             # Socket.IO broadcast
├── config/
│   ├── faq-categories.ts              # 15 fixed FAQ categories
│   ├── baked-in-sops.ts               # Legacy SOP content (now DB-backed)
│   ├── model-pricing.json             # Per-model $/1M rates
│   ├── escalation_rules.json          # Keyword patterns + urgency signals
│   └── amenity-synonyms.json          # Fuzzy matching for property search
├── routes/
│   ├── sandbox.ts                     # AI testing sandbox endpoint
│   └── *.ts                           # Route definitions per domain
└── prisma/
    └── schema.prisma                  # All models

frontend/
├── components/
│   ├── inbox-v5.tsx                   # Main chat interface (conversations + messages)
│   ├── sandbox-chat-v5.tsx            # AI testing sandbox
│   ├── configure-ai-v5.tsx            # System prompt editor + AI settings
│   ├── ai-logs-v5.tsx                 # AI API call log viewer
│   ├── sop-editor-v5.tsx              # SOP management (variants + overrides)
│   ├── tools-v5.tsx                   # Tool definition management
│   ├── faq-v5.tsx                     # FAQ knowledge base
│   ├── listings-v5.tsx                # Property knowledge base editor
│   ├── tasks-v5.tsx                   # Escalation/task management
│   ├── analytics-v5.tsx               # Metrics dashboard
│   ├── calendar-v5.tsx                # Reservation calendar
│   ├── overview-v5.tsx                # Guest overview dashboard
│   ├── settings-v5.tsx                # Tenant administration
│   └── webhook-logs-v5.tsx            # Webhook audit trail
└── lib/
    ├── api.ts                         # All API client functions + types
    ├── socket.ts                      # Socket.IO client
    └── utils.ts                       # Tailwind class merging
```

---

## Cost Per Message (typical)

| Component | Model | Cost | When |
|-----------|-------|------|------|
| SOP classification | GPT-5.4-Mini | ~$0.0003 | Every message (forced tool call) |
| AI Response | GPT-5.4-Mini | ~$0.001 | Every reply (~90% cached) |
| Task dedup | GPT-5-Nano | ~$0.00005 | When escalation detected |
| Summary | GPT-5-Nano | ~$0.0001 | Conversations >10 msgs |
| FAQ suggest | GPT-5-Nano | ~$0.00005 | Manager replies to info_request |
| **Total** | | **~$0.001-0.004** | |

Monthly at 100 msgs/day: **~$3-12/month**
