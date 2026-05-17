# GuestPilot v2 — AI Guest Services Platform

Multi-tenant AI communication platform for serviced apartments. Integrates with Hostaway PMS, automates guest messaging across Airbnb/Booking/WhatsApp/Direct channels.

## Tech Stack
- **Backend:** Node.js + TypeScript + Express
- **Database:** PostgreSQL + Prisma ORM
- **AI:** OpenAI Responses API (GPT-5.4-Mini default, GPT-5-Nano for lightweight tasks)
- **Queue:** BullMQ + Redis (optional — falls back to polling)
- **Frontend:** Next.js 16 + React 19 + Tailwind 4 + shadcn/ui
- **Hosting:** Railway (backend), Vercel (frontend)

## Directory Structure
```
backend/
  src/
    controllers/        # Request handlers
    routes/             # Express route definitions
    services/           # Business logic (AI pipeline, tools, SOPs, FAQ, etc.)
    workers/            # BullMQ workers
    jobs/               # Scheduled jobs (debounce poll, FAQ maintenance, sync)
    middleware/         # Auth (JWT), error handling
    config/             # FAQ categories, SOP data, escalation rules, model pricing
  prisma/
    schema.prisma       # Database schema

frontend/
  app/                  # Next.js pages (login, dashboard)
  components/           # UI components (inbox-v5, configure-ai-v5, etc.)
  lib/                  # Utils, API client, Socket.IO client
```

## Key Services

| Service | Purpose |
|---------|---------|
| ai.service.ts | Core AI pipeline: prompt building, OpenAI Responses API, tool use loop, structured output |
| sop.service.ts | DB-backed SOPs with status variants + property overrides + dynamic tool schema |
| tool-definition.service.ts | System + custom tool definitions (cached 5min) |
| faq.service.ts | FAQ knowledge CRUD + retrieval (global + property-specific) |
| faq-suggest.service.ts | Auto-suggest FAQ entries from manager replies (GPT-5-Nano) |
| template-variable.service.ts | Resolve {VARIABLE} placeholders in system prompts → content blocks |
| summary.service.ts | Conversation summarization after AI response (GPT-5-Nano, >10 messages) |
| task-manager.service.ts | Escalation dedup — CREATE/UPDATE/RESOLVE/SKIP (GPT-5-Nano) |
| debounce.service.ts | Message batching (30s default) + working hours deferral |
| escalation-enrichment.service.ts | Keyword-based escalation signal detection |
| extend-stay.service.ts | Check extended/modified stay availability via Hostaway calendar |
| property-search.service.ts | Cross-sell alternative properties matching guest requirements |
| document-checklist.service.ts | Passport/marriage certificate tracking |
| tenant-config.service.ts | Per-tenant AI settings (cached 60s, auto-seeds prompts) |
| hostaway.service.ts | Hostaway API client (OAuth2, retry, all CRUD operations) |
| push.service.ts | Web Push notifications (VAPID) |
| webhook-tool.service.ts | Custom webhook invocation for user-defined tools |
| queue.service.ts | BullMQ wrapper (graceful fallback to polling if no Redis) |
| shadow-preview.service.ts | Feature 040 — lockOlderPreviews helper for Shadow Mode preview lifecycle |
| tuning-analyzer.service.ts | Feature 040 — fire-and-forget analyzer for edited shadow previews (gpt-5.4-mini, reasoning: high) |
| translation.service.ts | Feature 042 — inbound message translation to English (cached on Message.contentTranslationEn). Provider-abstracted (TranslationProvider interface) for easy swap. |
| reply-template.service.ts | Feature 043 — render tenant-editable approval/rejection templates with {GUEST_FIRST_NAME}, {REQUESTED_TIME}, {PROPERTY_NAME}, {CHECK_IN_TIME}, {CHECK_OUT_TIME} substitution. Falls back to system defaults in config/reply-template-defaults.ts. |
| scheduled-time.service.ts | Feature 043 — policy evaluator + auto-accept applier for late-checkout/early-check-in time requests. Within-threshold → auto-approve, send template, write Reservation.scheduledCheckInAt/Out, resolved Task + TaskActionLog. Outside threshold → falls through to manual escalation path. |
| tenant-state.service.ts | Feature 045 — GREENFIELD/BROWNFIELD detection + interview-progress summary read from `session/{conversationId}/slot/*` memory keys. Called every BUILD turn by build-controller.ts to populate the system-prompt `<tenant_state>` and `<interview_progress>` blocks. |
| build-tune-agent/preview/test-pipeline-runner.ts | Feature 045 — single-message dry-run of the tenant's reply pipeline for the `test_pipeline` tool. Reuses the real system prompt + SOP/FAQ context, but bypasses all 60s/5-min caches so freshly-written artifacts are visible immediately. Never hits Hostaway, never writes messages. |
| build-tune-agent/preview/test-judge.ts | Feature 045 — Sonnet 4.6 cross-family judge for `test_pipeline`. Version-stamped prompt (returned as `judgePromptVersion`) lets a regression surface as a score drift, not a silent judge change. Cross-family (Sonnet grading GPT-5.4 output) sidesteps self-enhancement bias. |

## AI Pipeline Flow
```
Guest Message → Hostaway Webhook → Save + SSE broadcast
  → scheduleAiReply() → PendingAiReply (30s debounce)
  → Poll job fires → generateAndSendAiReply()
      1. Load tenant config + system prompt
      2. Resolve template variables → content blocks
      3. Inject conversation summary (if >10 messages)
      4. SOP classification via forced get_sop tool call
      5. Fetch SOP content (status variant → property override → default)
      6. Tool use loop (max 5 rounds): get_faq, search_properties, extend_stay, etc.
      7. Structured JSON output (coordinator or screening schema)
      8. Escalation enrichment (keyword signals)
      9. Task manager dedup (GPT-5-Nano)
      10. Send via Hostaway → save → SSE broadcast → push notification
      11. Fire-and-forget: summary generation
```

## Models Used

| Purpose | Model | Notes |
|---------|-------|-------|
| Main pipeline | gpt-5.4-mini-2026-03-17 | Coordinator + Screening personas |
| SOP classification | gpt-5.4-mini-2026-03-17 | Forced get_sop tool call |
| Summaries | gpt-5-nano | Fire-and-forget, >10 messages |
| FAQ auto-suggest | gpt-5-nano | Classify manager replies as reusable FAQ |
| Task dedup | gpt-5-nano | Escalation matching (CREATE/UPDATE/SKIP) |

## System Tools

| Tool | Purpose | Agent Scope |
|------|---------|-------------|
| get_sop | SOP content by category | All statuses |
| get_faq | FAQ entries by category | All statuses |
| search_available_properties | Cross-sell properties | INQUIRY/PENDING |
| create_document_checklist | Screening doc setup | INQUIRY/PENDING |
| check_extend_availability | Extend stay availability | CONFIRMED/CHECKED_IN |
| mark_document_received | Mark passport/cert received | CONFIRMED/CHECKED_IN |

Custom tools: webhook-backed, user-defined parameters via Tools management page.

## Database Hierarchy
```
Tenant → Property → Reservation → Conversation → Message
                                              ↘ PendingAiReply
                                              ↘ Task
       → TenantAiConfig (system prompts, model settings)
       → SopDefinition → SopVariant (per-status) → SopPropertyOverride (per-listing)
       → ToolDefinition (system + custom tools)
       → FaqEntry (FAQ knowledge base)
       → AiApiLog (persistent AI call logs)
       → PushSubscription
       → AiConfigVersion (prompt history)
```

## Environment Variables
```
DATABASE_URL           # PostgreSQL (required)
JWT_SECRET             # Auth (required)
OPENAI_API_KEY         # OpenAI Responses API (required)
REDIS_URL              # BullMQ queue (optional — falls back to polling)
LANGFUSE_PUBLIC_KEY    # Observability (optional)
LANGFUSE_SECRET_KEY
LANGFUSE_HOST          # Default: https://cloud.langfuse.com
PORT                   # Default: 3000
NODE_ENV               # development / production
RAILWAY_PUBLIC_DOMAIN  # Public URL for webhooks
CORS_ORIGINS           # Comma-separated frontend URLs
DRY_RUN                # Restrict to specific conversation IDs
VAPID_PUBLIC_KEY       # Web Push (optional — push disabled without)
VAPID_PRIVATE_KEY
VAPID_SUBJECT          # mailto:support@guestpilot.com
STUDIO_PROVIDER        # "anthropic" (default) | "openai" — selects the
                       # Studio agent runtime. anthropic = Claude Agent SDK
                       # (Sonnet 4.6); openai = OpenAI Responses API
                       # (gpt-5.4 full, not mini — Studio is an authoring
                       # surface used dozens of times per week, not the
                       # high-volume guest-reply hot path, so the larger
                       # model is worth the spend). Both paths share the system prompt,
                       # the 18-tool registry, state-machine enforcement,
                       # and SSE wire contract; flip at deploy time for A/B.
                       # When openai, requires OPENAI_API_KEY (already set
                       # for the main guest-reply pipeline).
STUDIO_OPENAI_MODEL    # Optional override for the OpenAI Studio model.
                       # Default: gpt-5.4 (full, not mini — see
                       # STUDIO_PROVIDER for rationale). Set to
                       # `gpt-5.4-mini-2026-03-17` to fall back to the
                       # cheaper model for cost-sensitive deployments.
BUILD_AGENT_DIRECT_TRANSPORT  # Sprint 058-A F1 — when "true"/"1"/"yes"/"on",
                              # the BUILD tuning-agent bypasses the Claude
                              # Agent SDK's string-only systemPrompt surface
                              # and calls @anthropic-ai/sdk directly with a
                              # block-array system + cache_control markers
                              # on system blocks 0/1 and the last tool.
                              # Default OFF. Flip on in staging only after
                              # the MCP tool-call loop is reproduced in the
                              # direct path (tracked separately). See
                              # backend/src/build-tune-agent/runtime-direct.ts.
ANTHROPIC_API_KEY      # Studio Anthropic provider key. Required when
                       # STUDIO_PROVIDER=anthropic OR ENABLE_BUILD_MODE=true.
ENABLE_BUILD_MODE      # Gates POST /api/build/* routes. Default OFF.
ENABLE_BUILD_TRACE_VIEW   # Admin-only tool-call trace viewer. Default OFF.
ENABLE_RAW_PROMPT_EDITOR  # Admin-only raw system-prompt drawer. Default OFF.
STUDIO_POINTER_HMAC_KEY   # HMAC for index/section pointers + state-machine
                       # transition nonces. Falls back to JWT_SECRET when
                       # unset — set distinct value in production.
STUDIO_TRANSITION_HMAC_KEY # Optional; falls back to STUDIO_POINTER_HMAC_KEY.
STUDIO_DEBUG_TRACE     # Off by default. When truthy, every Studio assistant
                       # turn persists a `data-debug-trace` part in
                       # TuningMessage.parts with the byte-exact assembled
                       # system prompt + turn metadata. Adds ~30 KiB per
                       # turn. Required only when debugging — pair with
                       # `backend/scripts/dump-studio-conversation.ts` to
                       # read it back. See §Debugging Studio Conversations.
STUDIO_REASONING_EFFORT # OpenAI gpt-5.4 reasoning effort for the Studio
                       # agent. 'low' | 'medium' (default) | 'high'.
                       # Reasoning tokens are billed at the output rate
                       # and dominate per-turn cost — 'high' burns 3-8K
                       # reasoning tokens per round (~80% of per-round
                       # cost), 'medium' typically halves that, 'low'
                       # quarters it. Drop to 'low' on cost-sensitive
                       # tenants. Read every turn — flip without restart.
STUDIO_JUDGE_MODEL     # Override the test_pipeline cross-family judge
                       # model. Default 'claude-haiku-4-5' (down from
                       # 'claude-sonnet-4-6' on 2026-05-17 — Sonnet was
                       # overkill once verification_intent landed, Haiku
                       # cuts judge cost ~70% with no observed quality
                       # drop). Set to 'claude-sonnet-4-6' to roll back.
WASENDER_API_KEY       # Feature 044 WhatsApp doc-handoff. When absent, the
                       # doc-handoff feature is silently disabled.
WASENDER_BASE_URL      # Default: https://wasenderapi.com
WASENDER_TIMEOUT_MS    # Default: 20000
TRANSLATION_PROVIDER   # "google" (default). Future cases (deepl, openai)
                       # slot into resolveTranslationProvider() in
                       # backend/src/services/translation.service.ts.
RAILWAY_TOKEN          # Project-scoped Railway API token, used only by the
                       # `railway` CLI for diagnostics — NEVER read at app
                       # runtime. Lets log queries work non-interactively:
                       #   RAILWAY_TOKEN=$(grep ^RAILWAY_TOKEN= .env | cut -d= -f2) \
                       #     railway logs --since 1h
                       # Per-developer secret; do NOT commit. See
                       # §Diagnosing Production Failures below.
```

## Critical Rules
1. **Never break the main guest messaging flow** — all features degrade gracefully
2. **Missing env vars** (Redis, Langfuse) → fall back silently, never crash
3. **AI output** must be valid JSON — structured via json_schema enforcement
4. **Never expose access codes** (door code, WiFi) to INQUIRY-status guests
5. **Never commit secrets** — .env files, API keys, credentials
6. **Escalate when in doubt** — better to over-escalate than miss an issue

## Build & Run
```bash
# Backend
cd backend && npm install && npm run dev

# Frontend
cd frontend && npm install && npm run dev

# Database
cd backend && npx prisma db push    # apply schema
cd backend && npx prisma studio     # browse data
```

## Diagnosing Production Failures

When something fails in prod (failed send, AI error, crash, slow response), check sources in this order — cheapest to most expensive:

1. **Database first** — most errors leave a trail.
   - `Message.deliveryStatus`/`deliveryError` for send failures (prefixed `Hostaway <status>: ...` or `INTERNAL_ERROR: ...`)
   - `AiApiLog.error` for AI pipeline failures (includes the full system+user prompt that was in flight)
   - `WebhookLog.error` for Hostaway webhook ingestion failures
   - `TuningSuggestion`/`BuildArtifactHistory` for tuning + studio writes
   Query via `npx prisma studio` or a one-off `npx tsx -e ...` script in `backend/scripts/`.

2. **Langfuse** — see `~/.claude/projects/.../memory/reference_langfuse_access.md` for credentials + endpoints. Covers the AI generations that flowed through `ai.service.ts traceAiCall` and `diagnostic.service.ts` spans (~5% of total OpenAI calls — most of the studio + test_pipeline + judge surface bypasses it).

3. **Railway logs** — the catch-all when (1) and (2) don't surface the cause (uncaught exceptions, route handlers that errored before persisting, infrastructure / boot issues).

   ```bash
   # CLI is installed at /opt/homebrew/bin/railway (v4.31+).
   # Project-scoped token lives in backend/.env as RAILWAY_TOKEN
   # (read-only, per-developer). When invoking the CLI from a shell that
   # already sourced backend/.env, no extra env wiring is needed; from
   # a bare shell, prefix the command:

   cd backend
   RAILWAY_TOKEN=$(grep '^RAILWAY_TOKEN=' .env | cut -d= -f2) railway logs --since 1h | tail -50

   # Common queries:
   railway logs                                      # live tail (current deploy)
   railway logs --since 4h --lines 500               # historical window
   railway logs --since 6h | grep ShadowPreview      # filter by source tag

   # Common gotcha: every redeploy starts a new container and the
   # default tail only covers the latest deploy. For an error that
   # happened on a previous deploy, pass --deployment-id <id> (find
   # IDs in the Railway dashboard → service → Deployments).

   # If `railway` says Unauthorized:
   #   - The token in .env is per-developer (project-scoped, not account-
   #     scoped). It is the user's secret. Rotate it via the Railway
   #     dashboard → Project Settings → Tokens if compromised.
   #   - For interactive account-level access (`railway list`,
   #     `railway environment`), the project token isn't enough — run
   #     `railway login` once to persist account creds to ~/.railway.
   ```

4. **OpenAI dashboard** (https://platform.openai.com/usage) — last resort for total spend, request volume, and per-request inspection. The dashboard shows ALL OpenAI calls (854/day vs Langfuse's ~36) but doesn't filter by tenant / message id.

## Debugging Studio Conversations

When the Studio agent does something weird, dump the entire conversation to a single markdown file with the full tool i/o and system prompt — much faster than chasing `TuningMessage.parts` JSON by hand.

```bash
cd backend

# List recent conversations for a tenant (latest 20):
npx tsx scripts/dump-studio-conversation.ts --list <tenantId>

# Dump a specific conversation to /tmp/studio-dump-<id>-<iso>.md:
npx tsx scripts/dump-studio-conversation.ts <conversationId>

# Custom output path:
npx tsx scripts/dump-studio-conversation.ts <conversationId> --out /tmp/foo.md
```

The dump includes:
- Conversation metadata + final state-machine snapshot
- Every TuningMessage with FULL tool input + output (no truncation) and every data-part
- `BuildToolCallLog` cross-reference table (per-tool timing + success per turn)
- Reconstructed system prompt using CURRENT templates + tenant state

**Per-turn byte-exact prompt capture (opt-in)**: set `STUDIO_DEBUG_TRACE=true` in `backend/.env` to persist a `data-debug-trace` part on every assistant turn going forward. The trace stores the EXACT assembled system prompt the agent saw that turn — not a reconstruction. Adds ~30 KiB per turn to `TuningMessage.parts`; off by default. The dump script flags whether traces are present at the top of the output.

**Token cost + cache hit rate (always on, 2026-05-17)**: every Studio turn on the OpenAI path now persists one `AiApiLog` row with `agentName='studio'`, containing the full assembled system prompt, user message, final response text, and aggregate input / cached-input / reasoning / output tokens. Query it directly:

```ts
await prisma.aiApiLog.findMany({
  where: { tenantId, agentName: 'studio' },
  orderBy: { createdAt: 'desc' },
  take: 20,
  select: { createdAt: true, model: true, inputTokens: true, cachedInputTokens: true, reasoningTokens: true, outputTokens: true, costUsd: true, error: true },
});
```

The dump script does NOT need this row — it reads from `TuningMessage.parts` — but the column-based query is much faster for "what's my hit rate today?" / "which turn cost the most?" lookups.

**Langfuse coverage (2026-05-17)**: the Studio OpenAI runner now emits one `trace.generation('tuning-agent.query')` per internal model round AND one `trace.span('studio.tool.<name>')` per tool invocation (with truncated input + output). The trace root also carries the system prompt + user message as `input`. Open https://cloud.langfuse.com → filter by `userId` = tenantId and you get a complete per-round timeline.

## Testing AI Behaviour End-to-End

When verifying a SOP / FAQ / system-prompt change actually changes the AI's reply, drive the same pipeline the Studio `studio_test_pipeline` tool uses — do NOT script your own OpenAI calls and do NOT mock a fake conversation.

**The pipeline**: `runPipelineDry()` in [backend/src/build-tune-agent/preview/test-pipeline-runner.ts](backend/src/build-tune-agent/preview/test-pipeline-runner.ts) sends ONE test message through a simplified, side-effect-free version of the guest-reply pipeline:
- Reuses the tenant's real system prompt + ALL enabled SOPs + ALL active FAQs.
- Bypasses the 60s tenant-config cache and 5-min SOP cache so freshly-written artifacts are visible immediately.
- Does NOT hit Hostaway, write messages, broadcast SSE, or run task-manager dedup.
- Returns `{ reply, replyModel, latencyMs, action }` where `action` is the structured escalation/scheduledTime decision.

**Minimum test harness** (one-off scripts go under `backend/scripts/`):

```ts
import * as dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';
import { runPipelineDry } from '../src/build-tune-agent/preview/test-pipeline-runner';

const prisma = new PrismaClient();
const { reply, latencyMs } = await runPipelineDry({
  tenantId: 'cmmth6d1r000a6bhlkb75ku4r',
  testMessage: 'whats the door code',
  context: { reservationStatus: 'INQUIRY', channel: 'DIRECT' },
  prisma,
});
console.log(reply); // ~10s, ~$0.05 with gpt-5.4-mini at ~8k input tokens
await prisma.$disconnect();
```

Reference implementation: [backend/scripts/verify-merged-sops.ts](backend/scripts/verify-merged-sops.ts) sweeps multiple `(message, status)` combinations against a `mustContain` / `mustNotContain` matcher and prints a pass/fail summary.

**Cost / latency**: ~$0.05–0.10 per call (8–20K input tokens, ~100 output). 93–98% prompt-cache hits kick in from the second call onward when calls share `(tenantId, isInquiry)`. Budget ~$0.30 for a 5-call run.

**What this catches** that a structural test cannot:
- Whether the model actually reads inline status sections (e.g. `### When booking is X` SOP subsections).
- Whether the FAQ layer overrides the SOP guidance (e.g. a global FAQ leaking access codes that the SOP body would otherwise gate).
- Whether reasoning prose drifts from intended phrasing (`"after booking"`, `"shared before arrival"`, etc.).

**Gotchas**:
- `{ACCESS_CONNECTIVITY}` / `{CHECKIN_SITUATION}` / `{CHECKOUT_SITUATION}` template variables are NOT resolved in the dry runner — `collectSopContext` passes no `variableDataMap`, so unresolved `{TOKEN}` placeholders are stripped by `applyTemplates`. Test on the model's *deferral phrasing* (status differentiation), not on whether the literal access codes appear.
- The runner uses `gpt-5.4-mini-2026-03-17` for both inquiry + coordinator personas. Production also defaults to mini.
- `OPENAI_API_KEY` must be in the environment (loaded via `dotenv.config()` from `backend/.env`).

## Branch Strategy
Feature branches merge directly to `main`. No long-lived dev branches.

## Reference Docs
- `SPEC.md` — Complete system specification
- `AI_SYSTEM_FLOW.md` — Detailed AI pipeline flow
- `.specify/memory/constitution.md` — Project constitution (non-negotiable principles)

## Active Technologies
- TypeScript 5.x on Node.js 18+ (backend), Next.js 16 + React 19 (frontend) + Express 4.x, Prisma ORM, axios, Tailwind 4, shadcn/ui (029-inquiry-accept-reject)
- PostgreSQL + Prisma ORM (new fields on Tenant, new InquiryActionLog model) (029-inquiry-accept-reject)
- TypeScript 5.x on Node.js 18+ (backend), Next.js 16 + React 19 (frontend) + Express 4.x, Prisma ORM, axios (backend); React 19, Tailwind 4, shadcn/ui (frontend) (030-booking-alterations)
- PostgreSQL + Prisma ORM — 2 new models (BookingAlteration, AlterationActionLog), 2 new enums (030-booking-alterations)
- TypeScript 5.x on Node.js 18+ + Express 4.x, OpenAI SDK (Responses API), Prisma ORM, axios (031-ai-property-search)
- PostgreSQL (existing Property model with `customKnowledgeBase` JSON field, `listingDescription` text field) (031-ai-property-search)
- TypeScript 5.x on Node.js 18+ (backend); Next.js 16 + React 19 (frontend) + Express 4.x, Prisma ORM, OpenAI SDK (Responses API), Socket.IO, BullMQ (optional); React 19, Tailwind 4, shadcn/ui (040-autopilot-shadow-mode)
- PostgreSQL via Prisma. Schema changes applied with `npx prisma db push` per constitution §Development Workflow. (040-autopilot-shadow-mode)
- TypeScript 5.x on Node.js 18+ (backend); Next.js 16 + React 19 (frontend) + Express 4.x, Prisma ORM, axios (backend); React 19, Tailwind 4, existing inbox-v5 bubble rendering (frontend) (042-translation-toggle)
- PostgreSQL via Prisma — one new nullable column `Message.contentTranslationEn String?`. Applied with `npx prisma db push` per constitution §Development Workflow. No migration of existing rows required (null = not yet translated, lazily filled). (042-translation-toggle)
- TypeScript 5.x on Node.js 18+ (backend); Next.js 16 + React 19 (frontend) — same as CLAUDE.md. + Express 4.x, Prisma ORM, OpenAI SDK (Responses API + strict json_schema), Socket.IO, axios (backend); React 19, Tailwind 4, shadcn/ui, existing `inbox-v5.tsx` Actions-card region (frontend). (043-checkin-checkout-actions)
- PostgreSQL via Prisma. New fields on `Property` (×2), `Tenant` (×2 fallback), `Reservation` (×2 override). Extend `Task` with `metadata Json?` + new values for the existing `type String` column. One new table `AutomatedReplyTemplate`. (043-checkin-checkout-actions)
- TypeScript 5.x on Node.js 18+ (backend); Next.js 16 + React 19 (frontend). Same as CLAUDE.md. + Express 4.x, Prisma ORM, axios (backend) + React 19, Tailwind 4, shadcn/ui (frontend). New external dependency: WAsender HTTP API (existing external account, credentials via env). (044-doc-handoff-whatsapp)
- PostgreSQL via Prisma. Changes: two new columns on `Tenant` (manager recipient, security recipient, reminder HH:MM, handoff HH:MM, feature on/off) — actually four + bool = five fields. Extend `Reservation.screeningAnswers.documentChecklist` JSON structure with per-slot image refs (backward-compatible JSON extension, no schema migration needed for that). One new table `DocumentHandoffState` (reservation-scoped, holds per-message-type scheduled fire time, status, attempt count, last error, provider message ID). Applied with `npx prisma db push` per constitution §Development Workflow. (044-doc-handoff-whatsapp)
- TypeScript 5.x on Node 18+ (frontend only) + Next.js 16, React 19, Tailwind 4, shadcn/ui, `ai` (SDK), existing studio/build components, `next/font/google` for Inter Tight + JetBrains Mono (046-studio-redesign)
- N/A — no backend or schema changes; all data comes from existing endpoints (046-studio-redesign)
- TypeScript 5.x on Node.js 18+ (backend only — no frontend changes) + `@anthropic-ai/claude-agent-sdk` 0.2.109 (SDK transport), `@anthropic-ai/sdk` (direct transport when `BUILD_AGENT_DIRECT_TRANSPORT=true`), `langfuse` Node SDK (observability), `zod/v4` (tool schemas), Prisma ORM (read-only — no schema changes) (047-studio-token-efficiency)
- PostgreSQL via Prisma — **no schema changes**. Reads existing `SopDefinition`/`SopVariant`/`FaqEntry`/`TenantAiConfig`/`AgentMemory`/`TuningConversation` tables. (047-studio-token-efficiency)

## Recent Changes
- 029-inquiry-accept-reject: Added TypeScript 5.x on Node.js 18+ (backend), Next.js 16 + React 19 (frontend) + Express 4.x, Prisma ORM, axios, Tailwind 4, shadcn/ui
