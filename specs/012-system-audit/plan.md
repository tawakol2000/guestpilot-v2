# Implementation Plan: Full System Audit & Cleanup

**Branch**: `012-system-audit` | **Date**: 2026-03-21 | **Spec**: [spec.md](./spec.md)
**Input**: Audit findings from 3 code audit agents + 2 live testing agents

## Summary

Fix 7 tenant isolation vulnerabilities, SSE tab-switching bug, auth/settings 401 bug, webhook auth grace period, sandbox tool context, ai-config performance, analytics 600% bug, and remove dead code. Add missing database indexes, health check endpoint, startup validation, and frontend error handling improvements.

No new features, no new entities, no schema migration. Pure fix-and-harden pass.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+ (backend), Next.js 16 + React 19 (frontend)
**Primary Dependencies**: Express 4.x, Prisma ORM, Anthropic SDK, Hostaway API
**Storage**: PostgreSQL + Prisma ORM (add indexes only — no migrations)
**Project Type**: Bug fix + hardening pass
**Constraints**: No system prompt changes (another session), no schema migrations (indexes only), Python stays in Dockerfile
**Scale/Scope**: ~20 files modified, 0 new files

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Graceful Degradation | PASS | Fixes improve graceful degradation (error boundaries, error handling) |
| II. Multi-Tenant Isolation | FIXING | 7 write vulnerabilities being patched (FR-001) |
| III. Guest Safety | N/A | No prompt changes |
| IV. Structured AI Output | N/A | No output format changes |
| V. Escalate When In Doubt | N/A | No escalation logic changes |
| VI. Observability | PASS | Debug logging removed, health check added |
| VII. Self-Improvement | N/A | No classifier changes |
| Security | FIXING | Webhook auth tightened (FR-002a), tenant isolation patched |

## Out of Scope

- System prompts (OMAR_SYSTEM_PROMPT, OMAR_SCREENING_SYSTEM_PROMPT) — another session
- Classifier training data — managed by judge/auto-fix
- Task field enum conversion — deferred
- Python removal from Dockerfile — needed for retrain button

## Implementation Phases

### Phase A: Security Fixes (P1)

1. **Add tenantId to all write operations** — 10 locations across 4 controllers:
   - `conversations.controller.ts`: markRead, updateLastMessage, toggleStar, resolve
   - `task.controller.ts`: update
   - `knowledge.controller.ts`: approve suggestion, delete suggestion
   - `automated-messages.controller.ts`: update, toggle, delete
   - Pattern: change `where: { id }` to `where: { id, tenantId }` or verify with findFirst before write

2. **Tighten webhook auth** — `middleware/webhook-auth.ts`:
   - If tenant has webhookSecret configured AND request has no Basic Auth → return 401
   - Remove grace period

3. **Fix auth/settings** — `controllers/auth.controller.ts` line 133:
   - Change `req.user?.tenantId` to `(req as any).tenantId`

### Phase B: Frontend Bugs (P1)

1. **Fix SSE tab switching** — find where SSE events trigger state updates that reset `navTab` in `inbox-v5.tsx`. The SSE reconnection likely re-fires initialization events that set the default tab. Fix: ensure `navTab` state is not affected by SSE events.

2. **Fix Analytics 600%** — find the AI Resolution Rate calculation in `analytics-v5.tsx` or the backend analytics endpoint and cap at 100% or fix the formula.

### Phase C: Backend Fixes (P2)

1. **Fix sandbox tool context** — `routes/sandbox.ts`: ensure tools are passed to `createMessage()` the same way `ai.service.ts` does (INQUIRY → property search, CONFIRMED → extend-stay)

2. **Fix ai-config slow endpoint** — `controllers/ai-config.controller.ts`: cache the config or avoid re-reading files on every request

3. **Remove dead code**:
   - `rag.service.ts`: remove deprecated `getLastClassifierResult()`
   - `import.service.ts`: remove debug URL field logging

### Phase D: Database Indexes (P2)

1. **Add indexes to schema.prisma**:
   - `@@index([tenantId, status])` on Conversation
   - `@@index([tenantId, category])` on PropertyKnowledgeChunk
   - `@@index([tenantId, status])` on Task
2. Run `npx prisma db push` (indexes only — non-destructive)

### Phase E: Frontend Hardening (P2)

1. **Add error boundary** — wrap main dashboard content in a React error boundary component
2. **Replace silent catches** — audit all `.catch(() => {})` in settings-v5.tsx, opus-v5.tsx, tasks-v5.tsx and add user-visible error feedback
3. **Add aria-labels** — icon-only buttons in inbox-v5.tsx

### Phase F: Infrastructure (P3)

1. **Add health check** — `GET /health` endpoint in app.ts, configure in railway.toml
2. **Startup validation** — check DATABASE_URL and JWT_SECRET at startup
3. **CORS production warning** — warn if CORS_ORIGINS not set when NODE_ENV=production
4. **Document COHERE_API_KEY** — add to .env.example
