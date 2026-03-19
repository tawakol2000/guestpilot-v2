# GuestPilot AI System Flow — Complete Reference

**Last updated:** 2026-03-19
**Branch:** 003-ai-engine-fix (merged into advanced-ai-v7)

---

## Architecture Overview

```
Guest Message (Airbnb/Booking/WhatsApp)
    ↓
Hostaway Webhook → webhooks.controller.ts
    ↓
Save message to DB → SSE broadcast to browser
    ↓
scheduleAiReply() → PendingAiReply record
    ↓
[Debounce: wait for more messages — default 30s]
    ↓
30s Poll Job picks up due replies
    ↓
generateAndSendAiReply() — MAIN PIPELINE
    ├── 1. Fetch all messages + build tiered memory context
    ├── 2. Filter current window messages (30-min buffer for Hostaway delays)
    ├── 3. RAG Pipeline:
    │   ├── Tier 1: LR Classifier (embed → sigmoid → confidence tier)
    │   │   ├── HIGH (≥0.85): use top-1 SOP directly
    │   │   ├── MEDIUM (0.55–0.85): inject top-3 SOPs
    │   │   └── LOW (<0.55): fall through to Tier 2
    │   ├── Tier 3: Topic State Cache (re-inject if follow-up)
    │   ├── Tier 2: Intent Extractor / Haiku (if Tier 1 LOW confidence)
    │   └── pgvector retrieval + Rerank for property knowledge
    ├── 4. Build property info (booking status, access codes, retrieved SOPs)
    ├── 5. Assemble content blocks + select system prompt
    ├── 6. Claude Haiku API call (with prompt caching)
    ├── 7. Parse JSON response → handle escalation
    ├── 8. Send via Hostaway API → save to DB → SSE broadcast
    └── 9. Judge evaluation (fire-and-forget background)
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
   - Log: `[Webhook] AI reply scheduled for conv X (aiMode=autopilot)`
9. If `reservation.aiEnabled === false`:
   - Log: `[Webhook] AI DISABLED for conv X`
10. SSE broadcast `event: message` to all browser tabs

**AI disabled when:**
- `reservation.aiEnabled = false` (set by cancellation/checkout webhook)
- `reservation.aiMode = 'off'`
- Host manually toggled AI off in dashboard

---

## Stage 2: Debounce Service

**File:** `backend/src/services/debounce.service.ts` — `scheduleAiReply()`

1. Fetch tenant config (cached 5 min)
2. **Working hours check:**
   - If within hours → `scheduledAt = now + debounceDelayMs` (default 30000ms)
   - If outside hours → `scheduledAt = nextWorkingHoursStart()` (defer to morning)
   - Config: `workingHoursEnabled`, `workingHoursStart` (HH:MM), `workingHoursEnd`, `workingHoursTimezone`
3. Upsert `PendingAiReply`:
   - If existing unfired reply → reset timer (debounce extension)
   - If new → create record with `fired: false`
4. SSE broadcast `ai_typing` event with `expectedAt` timestamp
5. Also enqueue in BullMQ (non-fatal if Redis unavailable)

---

## Stage 3: Poll Job

**File:** `backend/src/jobs/aiDebounce.job.ts` — `startAiDebounceJob()`

- Runs every **30 seconds** via `setInterval`
- Query: `PendingAiReply WHERE fired=false AND scheduledAt <= now()`
- For each due reply:
  1. Mark `fired = true` immediately (prevents double-firing)
  2. Gate check: skip if `aiEnabled=false` or `aiMode='off'`
  3. Build context object with all reservation/property/guest data
  4. Call `generateAndSendAiReply(context, prisma)` — fire-and-forget

---

## Stage 4: Main AI Pipeline

**File:** `backend/src/services/ai.service.ts` — `generateAndSendAiReply()`

### 4a. Message History & Memory

1. Fetch ALL messages from DB for this conversation
2. **Tiered memory context** (if enabled AND message count > 10):
   - Recent 10 messages: verbatim
   - Older messages: summarized via Haiku (~5 bullet points)
   - Summary cached in `Conversation.conversationSummary`
3. **Current window messages** — guest messages since debounce window started:
   - Buffer: `windowStartedAt - 30 minutes` (handles Hostaway webhook delays)
   - If no guest messages in window → AI skips responding (logs "No guest messages")
4. Fetch open tasks (up to 10)
5. Fetch approved knowledge Q&A
6. Get local time (Africa/Cairo timezone)

### 4b. RAG Pipeline

**Entry:** `retrieveRelevantKnowledge(tenantId, propertyId, query, prisma, topK=8, agentType)`

#### Tier 1 — LR Embedding Classifier

**File:** `backend/src/services/classifier.service.ts` — `classifyMessage()`

1. **Embed guest message** — `embedText(query, 'classification')`
   - Provider: OpenAI `text-embedding-3-small` (1536d) or Cohere `embed-multilingual-v3.0` (1024d)
   - Cohere uses `input_type: 'classification'` for optimized classification embeddings
2. **LR sigmoid inference** — `classifyWithLR()`:
   - Computes dot product + intercept per class (OneVsRest)
   - Applies sigmoid: `prob = 1 / (1 + exp(-logit))`
   - Filters labels above per-category threshold (trained from LOO-CV confidence distributions)
3. **Three-tier routing** based on `maxConfidence`:
   - `HIGH (≥0.85)`: top-1 SOP label injected directly
   - `MEDIUM (0.55–0.85)`: top-3 SOP candidates injected (LLM picks best fit)
   - `LOW (<0.55)`: no reliable prediction → falls through to Tier 2 intent extractor
4. **KNN diagnostic** runs in parallel (for pipeline display only — does not affect routing):
   - Cosine similarity with all training examples → top-3 neighbors
   - Method logged as `knn_vote`
5. Returns: `{ labels, confidence, tier, topCandidates, method: 'lr_sigmoid', knnDiagnostic, topK, neighbors }`

**Training pipeline:** `backend/scripts/train_classifier.py` (Python 3 + sklearn)

- Input: all training examples as JSON piped from Node.js via `execFile`
- Embeds with Cohere `embed-multilingual-v3.0` (batch 96)
- Trains `OneVsRestClassifier(LogisticRegression, C=1.0, class_weight='balanced')`
- Runs full leave-one-out cross-validation (LOO-CV) — no extra API calls (uses cached embeddings)
- Computes per-category thresholds: `mean - 2*std` of LOO confidence scores
- Computes class centroids (mean embedding per category)
- Writes `backend/src/config/classifier-weights.json` with coefficients, intercepts, thresholds, centroids, calibration
- Triggered via: `POST /api/knowledge/retrain-classifier` (UI "Retrain Classifier" button)
- Last trained: 89.27% LOO-CV accuracy, 22 classes, 354 examples

**Training data:** `backend/src/services/classifier-data.ts`
- ~354 examples (base + Arabic paraphrases + auto-generated from judge)
- 22 categories: sop-cleaning, sop-amenity-request, sop-maintenance, sop-wifi-doorcode, sop-visitor-policy, sop-early-checkin, sop-late-checkout, sop-complaint, sop-booking-inquiry, pricing-negotiation, pre-arrival-logistics, sop-booking-modification, sop-booking-confirmation, payment-issues, post-stay-issues, sop-long-term-rental, sop-booking-cancellation, sop-property-viewing, non-actionable, contextual, and more

**Weights file:** `backend/src/config/classifier-weights.json`
- Loaded at startup and on every reinit
- Contains: `classes`, `coefficients` [n_classes × embedding_dim], `intercepts` [n_classes], `thresholds.perCategory`, `centroids`, `calibration`, `trainedAt`
- Server throws if weights missing and a message arrives (requires retrain before first use)

**Embedding providers:** `backend/src/services/embeddings.service.ts`

| Provider | Model | Dimensions | input_type | Cost |
|----------|-------|-----------|------------|------|
| OpenAI | text-embedding-3-small | 1536 | N/A | $0.02/1M |
| Cohere | embed-multilingual-v3.0 | 1024 | classification / search_query / search_document | $0.12/1M |

- Toggle via settings UI or `TenantAiConfig.embeddingProvider`
- Dual pgvector columns: `embedding` (OpenAI) + `embedding_cohere` (Cohere)
- Switching triggers full re-embed (~30s)
- Training always uses Cohere `embed-multilingual-v3.0` regardless of inference provider

**Rerank:** `backend/src/services/rerank.service.ts`
- Model: Cohere `rerank-v3.5` (multilingual, 100+ languages including Arabic)
- Cross-encoder: processes query + document tokens jointly (better than cosine on compressed vectors)
- Used in RAG retrieval only (top-8 → top-3) — no longer used in the classifier path
- Cost: ~$2/1000 searches
- Gracefully disabled when `COHERE_API_KEY` missing

#### Tier 3 — Topic State Cache

**File:** `backend/src/services/topic-state.service.ts`

- Fires when Tier 1 returns `contextual` (short follow-up like "ok", "yes", "5am")
- Checks in-memory cache for previous topic labels
- **Re-injects** previous SOPs if:
  - Cache not expired (default 30-min TTL per category)
  - Reinject count < 5 (prevents infinite loops)
  - No topic-switch keywords detected ("also", "by the way", "another thing")
- **Clears cache** if topic switch detected
- Updates cache when new SOP labels are classified

#### Tier 2 — Intent Extractor (Haiku)

**File:** `backend/src/services/intent-extractor.service.ts` — `extractIntent()`

- Fires when Tier 1 `confidence < 0.55` (LOW tier) AND Tier 3 didn't re-inject
- Reads last 5 messages (3 guest + 2 host) for conversation context
- Calls Claude Haiku with intent extraction prompt
- Prompt: `backend/config/intent_extractor_prompt.md` (26 examples, disambiguation rules)
- Returns: `{ topic, status, urgency, sops[] }`
- Cost: ~$0.0001/call | Latency: 300-500ms | Fires on ~20% of messages

#### pgvector Property Knowledge Retrieval

**File:** `backend/src/services/rag.service.ts`

- Embeds query with `embedText(query, 'search_query')`
- SQL: `1 - (embedding <=> query::vector) as similarity` (cosine distance)
- Gets top-8 property chunks from pgvector (property-info, property-description, property-amenities, learned-answers)
- **Rerank** (if enabled): Cohere cross-encoder re-scores top-8 → picks best 3
- Minimum similarity threshold: 0.3
- Agent-specific filtering:
  - `guestCoordinator`: excludes sop-screening-*, baked-in categories
  - `screeningAI`: excludes service/maintenance/scheduling categories

#### SOP Content Retrieval

- For each classified label → lookup SOP text from `SOP_CONTENT` dictionary
- `sop-amenity-request` has `{PROPERTY_AMENITIES}` placeholder → dynamically replaced with property-specific amenities from `customKnowledgeBase.amenities`
- 4 **baked-in SOPs** always in system prompt (never retrieved):
  - Working hours & scheduling
  - House rules (family-only, no smoking, no parties)
  - Escalation — immediate (emergencies, breakdowns, complaints)
  - Escalation — scheduled (confirmed service visits)

### 4c. Property Info Building

**Function:** `buildPropertyInfo()` in `ai.service.ts`

1. **Booking status** (human-readable):
   - `INQUIRY` → "Inquiry (pre-booking)"
   - `CONFIRMED` + today → "Confirmed (Checking in today)"
   - `CHECKED_IN` + checkout today → "Checked In (Checking out today)"
   - etc.
2. **Reservation details**: guest name, booking status, check-in/out dates, guest count
3. **Access info** — **SECURITY: skipped for INQUIRY status** (door codes, WiFi never shown to inquiry guests)
4. **Retrieved SOP chunks** appended with category labels

### 4d. Agent Selection & System Prompt

**Decision:** `context.reservationStatus === 'INQUIRY' ? screeningAI : guestCoordinator`

| Agent | Purpose | Output Format |
|-------|---------|--------------|
| `guestCoordinator` | Handle guest requests during active stay | `{"guest_message": "...", "escalation": {...}}` |
| `screeningAI` | Screen inquiry guests against house rules | `{"guest message": "...", "manager": {"needed": bool, ...}}` |

System prompts: embedded in `ai.service.ts` (lines 337-877)

### 4e. Claude API Call

**Function:** `createMessage()` in `ai.service.ts`

- Model: `claude-haiku-4-5-20251001` (tenant configurable)
- Prompt caching: `cache_control: { type: 'ephemeral' }` (70% cost reduction on system prompt)
- Retry: exponential backoff (2s→4s→8s→16s→32s) for overloaded errors
- Logs to `AiApiLog` table with full metadata + ragContext JSON

### 4f. Response Handling

1. **Parse JSON** from Claude response (strip code fences, JSON.parse)
2. **Escalation handling:**
   - Create `Task` record if escalation present
   - SSE broadcast `new_task` event
   - Save private AI note (AI_PRIVATE message)
3. **Copilot mode:** If `aiMode === 'copilot'`, save suggestion for host approval instead of auto-sending
4. **Autopilot mode:** Send via Hostaway API → save AI message to DB → SSE broadcast `event: message`

---

## Stage 5: Self-Improvement Judge

**File:** `backend/src/services/judge.service.ts` — `evaluateAndImprove()`

Runs fire-and-forget AFTER the AI response is already sent.

**Skip conditions:**
- Tier 3 re-injected (contextual follow-ups shouldn't become training examples)
- LR `confidence >= judgeThreshold` (0.75) AND `tier === 'high'` — classifier was confident
- Majority neighbor support (≥2/3 KNN neighbors agree on labels — diagnostic)

**Path 1 — Tier 2 feedback (cheapest):**
- If Tier 2 fired and returned different labels than Tier 1
- **Systemic guard:** Validate Tier 2 labels have ≥0.35 cosine similarity to existing training examples with same label → prevents confident-but-wrong labels from poisoning
- If valid → add as training example (`source: 'tier2-feedback'`), reinitialize classifier

**Path 2 — Full judge (Claude Haiku):**
- Call Haiku with: guest message, classifier labels, confidence, AI response
- Judge returns: `{ retrieval_correct, correct_labels, confidence, reasoning }`
- If incorrect AND `topSim < autoFixThreshold` (0.70):
  - Add as training example (`source: 'llm-judge'`)
  - Reinitialize classifier
  - Rate limit: max 10 auto-fixes/hour

**Low-sim reinforcement:**
- If judge says correct BUT `topSim < 0.40`:
  - Add anyway to boost Tier 1 confidence for similar messages

**Storage:**
- New examples → `ClassifierExample` table (per-tenant)
- Evaluation logs → `ClassifierEvaluation` table (observability)

---

## Stage 6: OPUS Daily Audit

**File:** `backend/src/services/opus.service.ts`

Manual trigger via `POST /api/opus/generate`. Collects 24h of pipeline data and sends to Claude Opus for comprehensive system review.

**Data collected:**
- Every AI API call with full pipeline trace (Tier 1/2/3 details, retrieved SOPs, AI response)
- All classifier evaluations (judge decisions)
- Auto-generated training examples
- Message volume by role and channel
- Current settings and thresholds
- Task/escalation stats

**Opus prompt:** Explains the full architecture, asks for: executive summary, per-message pipeline review, classification accuracy, auto-fix review, cost analysis, SOP coverage, threshold recommendations, system health score (1-10), action items.

**Output:** Stored as markdown in `OpusReport` table. Downloadable as `.md` or raw JSON from the OPUS page.

---

## Key Thresholds & Parameters

| Parameter | Default | Configurable | Location |
|-----------|---------|-------------|----------|
| LR HIGH confidence | 0.85 | No | classifier.service.ts |
| LR LOW confidence (Tier 2 fallback) | 0.55 | No | classifier.service.ts |
| LR per-category threshold | varies | No (computed at train time) | classifier-weights.json |
| KNN neighbors (K) | 3 | No | classifier.service.ts (diagnostic only) |
| Vote threshold (KNN diagnostic) | 0.30 | Yes (UI) | classifier.service.ts |
| Contextual gate | 0.85 | Yes (UI) | classifier.service.ts |
| Judge threshold | 0.75 | Yes (UI) | judge.service.ts |
| Auto-fix threshold | 0.70 | Yes (UI) | judge.service.ts |
| Tier 2 sim check | 0.35 | No | judge.service.ts |
| Low-sim reinforce | 0.40 | No | judge.service.ts |
| Max auto-fixes/hour | 10 | No | judge.service.ts |
| Debounce delay | 30000ms | Yes (DB) | debounce.service.ts |
| Poll interval | 30000ms | No | aiDebounce.job.ts |
| Webhook buffer | 30 min | No | ai.service.ts |
| Memory summary threshold | 10 msgs | No | ai.service.ts |
| Topic state decay | 30 min | Config file | topic-state.service.ts |
| Max topic re-inject | 5 | Config file | topic-state.service.ts |
| RAG pgvector top-K | 8 | No | rag.service.ts |
| RAG min similarity | 0.3 | No | rag.service.ts |
| Embedding provider | openai | Yes (UI) | embeddings.service.ts |
| Training embedding model | Cohere embed-multilingual-v3.0 | No | train_classifier.py |

---

## File Map

```
backend/src/
├── controllers/
│   └── webhooks.controller.ts         # Entry: handleNewMessage()
├── jobs/
│   └── aiDebounce.job.ts              # 30s poll job
├── services/
│   ├── ai.service.ts                  # generateAndSendAiReply() + system prompts
│   ├── debounce.service.ts            # scheduleAiReply() + working hours
│   ├── classifier.service.ts          # LR classifier (primary) + KNN diagnostic
│   ├── classifier-data.ts             # Training examples + SOP content
│   ├── classifier-store.service.ts    # DB storage for auto-generated examples
│   ├── embeddings.service.ts          # Dual provider (OpenAI/Cohere)
│   ├── rerank.service.ts              # Cohere cross-encoder (RAG only)
│   ├── rag.service.ts                 # pgvector retrieval + Rerank + three-tier routing
│   ├── intent-extractor.service.ts    # Tier 2 Haiku intent extraction
│   ├── topic-state.service.ts         # Tier 3 topic cache
│   ├── judge.service.ts               # Self-improvement judge
│   ├── memory.service.ts              # Conversation summarization
│   ├── escalation-enrichment.service.ts # Keyword-based escalation signals
│   ├── opus.service.ts                # Daily Opus audit report
│   ├── sse.service.ts                 # Real-time push to browser (Redis pub/sub)
│   ├── hostaway.service.ts            # Hostaway API client
│   └── tenant-config.service.ts       # Per-tenant AI settings
├── scripts/
│   └── train_classifier.py            # Python: embed + train LR + LOO-CV + write weights JSON
├── config/
│   ├── baked-in-sops.ts               # 4 always-injected SOPs (270 tokens)
│   ├── classifier-weights.json        # LR weights (coefficients, intercepts, thresholds, centroids)
│   ├── intent_extractor_prompt.md     # Tier 2 prompt (26 examples)
│   ├── topic_state_config.json        # Tier 3 decay + switch keywords
│   └── ai-config.json                 # Persona configs (guestCoordinator, screeningAI)
├── routes/
│   ├── knowledge.ts                   # Classifier settings API
│   └── opus.ts                        # OPUS report API
└── prisma/
    └── schema.prisma                  # All models + vector columns

frontend/
├── components/
│   ├── inbox-v5.tsx                   # Main app shell + SSE handler
│   ├── classifier-v5.tsx              # Classifier settings + thresholds + provider toggle
│   ├── ai-pipeline-v5.tsx             # Pipeline visualization page
│   └── opus-v5.tsx                    # OPUS audit report page
└── lib/
    └── api.ts                         # All API client functions
```

---

## Cost Per Message (typical)

| Component | Model | Cost | When |
|-----------|-------|------|------|
| Embedding (inference) | OpenAI or Cohere | ~$0.0001 | Every message |
| LR Classifier | Local (no API call) | ~$0 | Every message |
| Rerank (RAG) | Cohere rerank-v3.5 | ~$0.002 | If Cohere key set |
| Tier 2 | Haiku | ~$0.0001 | ~20% of messages (LOW tier) |
| Judge | Haiku | ~$0.0001 | ~50% of messages |
| AI Response | Haiku | ~$0.002 | Every reply |
| Memory summary | Haiku | ~$0.0002 | Conversations >10 msgs |
| **Total** | | **~$0.002-0.005** | |

Monthly at 100 msgs/day: **~$6-15/month**

**Training cost (one-time per retrain):**
- Cohere embed of all examples: ~$0.004 (354 examples × 50 avg tokens)
- LOO-CV: no extra API calls (uses cached embeddings)

---

## Deployment

### Services

| Service | Platform | Builder | Notes |
|---------|---------|---------|-------|
| `guestpilot-v2` | Railway | Docker (`backend/Dockerfile`) | 003-ai-engine-fix branch |
| `backend-advanced-ai` | Railway | Nixpacks | advanced-ai-v7 branch |
| Frontend | Vercel | Next.js | Points to `guestpilot-v2` backend |

### Docker Build (`backend/Dockerfile`)

```dockerfile
FROM node:18-slim
# Python 3 + pip required for train_classifier.py
RUN apt-get install python3 python3-pip python3-venv
RUN pip3 install --break-system-packages scikit-learn numpy cohere
# Node app
WORKDIR /app
COPY package*.json prisma/ src/ scripts/ config/ tsconfig.json ./
RUN npm install && npx prisma generate && npm run build
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
```

**Key notes:**
- `--break-system-packages` required on Debian 12 (PEP 668)
- `config/` directory must be copied — contains files loaded at module import time
- Railway service root must be set to `/backend` so `backend/railway.toml` is the active config
- `backend/railway.toml` uses `builder = "dockerfile"` and `dockerfilePath = "Dockerfile"` (relative to service root)

### First-Deploy Checklist

1. Set all env vars on the Railway service (copy from old service)
2. Deploy → wait for build to succeed
3. Click "Retrain Classifier" in the UI — requires `COHERE_API_KEY` to be set
4. Verify accuracy shown in UI (expect ~89% LOO-CV)
5. Send a test message to verify end-to-end pipeline
