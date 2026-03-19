# GuestPilot v2 — AI Guest Services Platform

Multi-tenant AI communication platform for serviced apartments. Integrates with Hostaway PMS, automates guest messaging across Airbnb/Booking/WhatsApp/Direct channels.

## Tech Stack
- **Backend:** Node.js + TypeScript + Express
- **Database:** PostgreSQL + Prisma ORM + pgvector
- **AI:** Anthropic Claude API (Haiku 4.5 default), OpenAI/Cohere embeddings
- **Queue:** BullMQ + Redis (optional)
- **Frontend:** Next.js 16 + React 19 + Tailwind 4 + shadcn/ui
- **Hosting:** Railway (backend), Vercel (frontend)

## Directory Structure
```
backend/
  src/
    controllers/        # Request handlers (webhooks, conversations, auth, etc.)
    routes/             # Express route definitions
    services/           # Business logic
    workers/            # BullMQ workers (aiReply.worker.ts)
    jobs/               # Scheduled jobs (aiDebounce.job.ts)
    middleware/         # Auth (JWT), error handling
    config/             # AI config, SOP data, prompt files
  prisma/
    schema.prisma       # Database schema

frontend/
  app/                  # Next.js pages (login, dashboard)
  components/           # UI components (inbox-v5, ai-pipeline-v5, etc.)
  lib/                  # Utils, API client
```

## Key Services

| Service | Purpose |
|---------|---------|
| ai.service.ts | Core AI pipeline: prompt building, Claude API calls, response handling |
| classifier.service.ts | KNN-3 embedding classifier for SOP routing |
| judge.service.ts | LLM-as-Judge self-improvement + auto-fix |
| debounce.service.ts | Message batching (30s) + working hours deferral |
| rag.service.ts | pgvector retrieval for property knowledge |
| intent-extractor.service.ts | Tier 2 Haiku intent extraction |
| topic-state.service.ts | Tier 3 topic cache for contextual follow-ups |
| embeddings.service.ts | OpenAI/Cohere dual embedding provider |
| rerank.service.ts | Cohere cross-encoder reranking |
| memory.service.ts | Conversation summarization |
| escalation-enrichment.service.ts | Keyword-based escalation signals |
| tenant-config.service.ts | Per-tenant AI settings (cached 5min) |
| hostaway.service.ts | Hostaway API client |
| sse.service.ts | Server-Sent Events (Redis pub/sub or in-memory) |
| queue.service.ts | BullMQ job queue |
| observability.service.ts | Langfuse tracing |
| opus.service.ts | Daily audit reports (Claude Opus) |

## Branch Strategy

| Branch | Purpose | Deployed |
|--------|---------|----------|
| main | Production | Railway + Vercel |
| advanced-ai-v7 | AI upgrades (current dev) | Railway (separate service) |

## Database Hierarchy
```
Tenant → Property → Reservation → Conversation → Message
                                              ↘ PendingAiReply
                                              ↘ Task
```
All models have `tenantId` for multi-tenancy.

## Environment Variables
```
DATABASE_URL           # PostgreSQL (required)
JWT_SECRET             # Auth (required)
ANTHROPIC_API_KEY      # Claude API (required)
OPENAI_API_KEY         # Embeddings (optional — RAG disabled without)
COHERE_API_KEY         # Embeddings + reranking (optional)
REDIS_URL              # BullMQ queue (optional — falls back to polling)
LANGFUSE_PUBLIC_KEY    # Observability (optional)
LANGFUSE_SECRET_KEY
LANGFUSE_HOST          # Default: https://cloud.langfuse.com
PORT                   # Default: 3000
NODE_ENV               # development / production
RAILWAY_PUBLIC_DOMAIN  # Public URL for webhooks
CORS_ORIGINS           # Comma-separated frontend URLs
DRY_RUN                # Restrict to specific conversation IDs
```

## Critical Rules
1. **Never break the main guest messaging flow** — all new features degrade gracefully
2. **Missing env vars** (Redis, OpenAI, Langfuse, Cohere) → fall back silently, never crash
3. **AI output** must be valid JSON — no markdown, code blocks, or extra text
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

## Reference Docs
- `SPEC.md` — Complete system specification (endpoints, data model, AI pipeline, settings)
- `AI_SYSTEM_FLOW-v7.md` — Detailed 9-stage AI pipeline flow
- `CLASSIFIER_FRONTEND_CLAUDE_CODE.md` — Pending: classifier dashboard UI spec
- `JUDGE_SELF_IMPROVEMENT_CLAUDE_CODE.md` — Pending: judge service spec

## Active Technologies
- TypeScript 5.x on Node.js 18+ + Express 4.x, Prisma ORM, Anthropic SDK, ioredis, BullMQ (001-system-audit)
- PostgreSQL + pgvector + Prisma ORM (001-system-audit)
- TypeScript 5.x on Node.js 18+ (inference) + Python 3 (training) + Express 4.x, Prisma ORM, Cohere SDK, sklearn (Python) (003-ai-engine-fix)
- PostgreSQL + Prisma ORM + file-based weights JSON (003-ai-engine-fix)
- TypeScript 5.x on Node.js 18+ (inference) + Python 3 (training) + Express 4.x, Prisma ORM, Cohere SDK, sklearn (Python), numpy (003-ai-engine-fix)
- PostgreSQL (shared with existing service) + file-based LR weights JSON (003-ai-engine-fix)
- TypeScript 5.x on Node.js 18+ + Express 4.x, Prisma ORM, PostgreSQL (004-fix-duplicate-convos)
- PostgreSQL (existing) — one schema constraint change only (004-fix-duplicate-convos)
- TypeScript 5.x on Node.js 18+ (backend), Next.js 16 + React 19 (frontend) + Express 4.x, Prisma ORM, Anthropic SDK (005-remove-knn-legacy)
- No schema changes — configuration via `topic_state_config.json` (005-remove-knn-legacy)

## Recent Changes
- 001-system-audit: Added TypeScript 5.x on Node.js 18+ + Express 4.x, Prisma ORM, Anthropic SDK, ioredis, BullMQ
