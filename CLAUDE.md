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

## Recent Changes
- 029-inquiry-accept-reject: Added TypeScript 5.x on Node.js 18+ (backend), Next.js 16 + React 19 (frontend) + Express 4.x, Prisma ORM, axios, Tailwind 4, shadcn/ui
