# Boutique Residence — AI Guest Services System (Guest Pilot V2)

## Project Overview
Multi-tenant AI guest services platform for serviced apartments.
Handles automated WhatsApp/messaging responses for hotel guests.
Integrated with Hostaway PMS via webhooks.

## Repo Structure
```
guest-pilot-v2/          ← git root
  CLAUDE.md              ← this file
  SPEC.md                ← implementation spec
  backend/               ← Node.js/TypeScript API
  frontend/              ← Client-facing UI
```

## Tech Stack
- **Backend:** Node.js + TypeScript + Express (`backend/` directory)
- **Database:** PostgreSQL via Prisma ORM (hosted on Railway)
- **AI:** Anthropic Claude API (`claude-haiku-4-5-20251001`)
- **Queue:** BullMQ + Redis (to be added on `advanced-ai` branch)
- **Hosting:** Railway (backend + PostgreSQL + Redis)
- **PMS Integration:** Hostaway webhooks + REST API

## Backend Directory Structure
```
backend/
  src/
    agents/         # AI agent logic (guestCoordinator, screeningAI, managerTranslator)
    services/       # Business logic services
    routes/         # Express route handlers
    workers/        # Background job workers (new — BullMQ)
    jobs/           # Scheduled jobs (aiDebounce.job.ts)
  prisma/
    schema.prisma   # Database schema
    migrations/     # Migration history
  scripts/          # Utility and test scripts
```

## Key Services
| File | Purpose |
|------|---------|
| `ai.service.ts` | Core AI generation logic |
| `debounce.service.ts` | Message batching before AI reply |
| `import.service.ts` | Hostaway property data sync |
| `conversation.service.ts` | Conversation state management |

## Branch Strategy
| Branch | Purpose | Deployed |
|--------|---------|---------|
| `main` | Production — current backend + frontend | Railway (main service) |
| `advanced-ai` | All AI upgrades — backend only | Railway (separate service) |

**Never merge `advanced-ai` → `main` until all upgrades are tested and stable.**

## Database Models (Key Hierarchy)
```
Tenant → Property → Reservation → Conversation → Message
                                              ↘ PendingAiReply
```
- All models have `tenantId` for multi-tenancy
- `PendingAiReply` table manages debounce state

## Environment Variables
```env
DATABASE_URL           # PostgreSQL connection string (Railway)
ANTHROPIC_API_KEY      # Claude API
HOSTAWAY_CLIENT_ID     # PMS integration
HOSTAWAY_CLIENT_SECRET
JWT_SECRET
REDIS_URL              # Redis (Railway) — needed for BullMQ
OPENAI_API_KEY         # For embeddings (text-embedding-3-small)
LANGFUSE_PUBLIC_KEY    # Observability
LANGFUSE_SECRET_KEY
LANGFUSE_HOST          # https://cloud.langfuse.com
```

## Critical Rules for AI Development
1. **Never break the main guest messaging flow** — all new features must degrade gracefully
2. **If Redis/OpenAI/Langfuse env vars are missing**, fall back silently, never crash
3. **Every DB query must include `tenantId`** — no cross-tenant data leaks ever
4. Follow existing TypeScript patterns (`AuthenticatedRequest` type, service factory pattern)
5. Always run `npx prisma generate` after schema changes
6. Always verify `npm run build` passes before committing

## Coding Patterns
- Services are initialized with `prisma` client passed as parameter
- Routes use `authenticateToken` middleware → sets `req.user = { tenantId, userId }`
- Error responses follow: `{ error: string, details?: any }`
- All async functions use `try/catch` with proper error logging
- Environment variable checks at service init time, not at call time

## What NOT To Do
- ❌ Do not use LangChain (use Vercel AI SDK or direct Anthropic SDK)
- ❌ Do not add Pinecone or external vector DBs (use pgvector on existing PostgreSQL)
- ❌ Do not hardcode prompts in JSON config files (move to database)
- ❌ Do not use numeric 1–10 eval scores (use binary pass/fail for LLM-as-judge)
- ❌ Do not make cross-tenant DB queries without explicit `tenantId` filter
- ❌ Do not use `localStorage` or browser storage APIs in any artifacts
- ❌ Do not commit directly to `main`
