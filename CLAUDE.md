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

## Recent Changes
- 029-inquiry-accept-reject: Added TypeScript 5.x on Node.js 18+ (backend), Next.js 16 + React 19 (frontend) + Express 4.x, Prisma ORM, axios, Tailwind 4, shadcn/ui
