# Implementation Plan: Deep Code Cleanup

**Branch**: `022-deep-code-cleanup` | **Date**: 2026-03-29 | **Spec**: [spec.md](./spec.md)

## Summary

Surgically remove ~4,500+ lines of dead code across backend and frontend — dead services, orphaned routes, dead components, unused API functions, dead state variables, unused imports, and dead Prisma models. Zero new features. The goal is a cleaner, smaller codebase with identical functionality.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+ (backend), Next.js 16 + React 19 (frontend)
**Primary Dependencies**: Express 4.x, Prisma ORM, OpenAI SDK (backend); React 19, Tailwind 4 (frontend)
**Storage**: PostgreSQL + Prisma ORM (dropping 2-3 unused tables)
**Testing**: Manual verification — `npx tsc --noEmit` (backend), `npm run build` (frontend), end-to-end AI pipeline test
**Target Platform**: Railway (backend), Vercel (frontend)
**Project Type**: Web service + SPA
**Constraints**: Must not break any active feature. Every deletion verified by grep before execution.

## Constitution Check

*GATE: All principles checked — no violations.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Graceful Degradation | PASS | No active pipeline code touched. Only dead code removed. |
| II. Multi-Tenant Isolation | PASS | No tenant-scoped queries modified. |
| III. Guest Safety | PASS | No access control or screening code touched. |
| IV. Structured AI Output | PASS | No schema or output parsing changes. |
| V. Escalation | PASS | Escalation service untouched. |
| VI. Observability | PASS | AiApiLog, Langfuse, SSE untouched. ClassifierEvaluation model KEPT (active in knowledge routes). |
| VII. Self-Improvement | PASS | Judge service untouched. ClassifierExample model KEPT. |
| Security | PASS | No auth, JWT, or secret handling changes. |
| Dev Workflow | NOTE | Dropping tables requires `prisma db push`. Schema change is destructive but targets only confirmed-dead models. |

## Project Structure

### Files to DELETE (entire files)

```text
# Backend — dead services
backend/src/services/memory.service.ts          # ~136 lines, zero importers
backend/src/services/snapshot.service.ts         # ~274 lines, only called by dead ai-pipeline route

# Backend — dead routes + controllers
backend/src/routes/ai-pipeline.ts               # ~350 lines, all endpoints orphaned
backend/src/routes/automated-messages.ts         # ~30 lines, feature removed
backend/src/controllers/automated-messages.controller.ts  # ~120 lines, feature removed

# Frontend — dead components
frontend/components/ai-pipeline-v5.tsx           # ~2,375 lines
frontend/components/opus-v5.tsx                  # ~528 lines
frontend/components/sop-monitor-v5.tsx           # ~673 lines
frontend/components/theme-provider.tsx           # ~20 lines

# Frontend — dead hooks
frontend/hooks/use-mobile.ts
frontend/hooks/use-toast.ts
```

### Files to EDIT (remove dead code within)

```text
# Backend
backend/src/app.ts                              # Remove mounts for deleted routes
backend/src/services/ai.service.ts              # Remove dead vars, imports, constants, redundant branches
backend/src/services/import.service.ts           # Remove dead PLAN_LIMITS constant
backend/src/controllers/task.controller.ts       # Remove unused NextFunction import
backend/src/routes/knowledge.ts                  # Remove orphaned sop-classifications + evaluation-stats endpoints
backend/src/routes/ai-config.ts                  # Remove orphaned sandbox-chat endpoint
backend/prisma/schema.prisma                     # Remove OpusReport, ClassifierWeights, AutomatedMessage models

# Frontend
frontend/lib/api.ts                             # Remove 24+ dead functions + 3 dead types
frontend/components/analytics-v5.tsx            # Remove dead tooltip + hoveredDay state
frontend/components/ai-logs-v5.tsx              # Remove dead showRaw state
frontend/components/sandbox-chat-v5.tsx         # Remove dead reasoningEffort state
frontend/components/inbox-v5.tsx                # Remove dead component import comments
```

## Execution Order (4 commits)

### Commit 1: Frontend dead files + dead API functions
1. Delete 4 dead component files + 2 dead hooks
2. Remove 24+ dead functions + 3 dead types from `lib/api.ts`
3. Remove dead state variables from analytics, ai-logs, sandbox-chat
4. Clean dead import comments from inbox-v5.tsx
5. Verify: `npm run build` succeeds

### Commit 2: Backend dead services + routes
1. Delete memory.service.ts, snapshot.service.ts
2. Delete ai-pipeline route, automated-messages route + controller
3. Remove route mounts from app.ts
4. Remove orphaned endpoints from knowledge.ts and ai-config.ts
5. Remove dead code from ai.service.ts (imports, constants, variables, redundant branches)
6. Remove dead code from import.service.ts, task.controller.ts
7. Verify: `npx tsc --noEmit` succeeds

### Commit 3: Prisma schema cleanup
1. Remove OpusReport model
2. Remove ClassifierWeights model
3. Verify AutomatedMessage has zero remaining references, then remove
4. Run `npx prisma db push` to apply
5. Verify: application starts, AI pipeline processes a message

### Commit 4: Final verification
1. Run full end-to-end test: guest message → AI response
2. Verify all 11 frontend tabs render
3. Verify copilot suggestion flow works

## Verification Checklist

- [ ] Frontend builds with zero errors
- [ ] Backend compiles with zero errors
- [ ] All 11 inbox tabs render correctly
- [ ] AI pipeline processes guest message end-to-end (autopilot)
- [ ] Copilot suggestion generates and persists across refresh
- [ ] Schema push applies without errors
- [ ] No 404 errors on any active endpoint
