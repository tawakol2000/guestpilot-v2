# Implementation Plan: Full System Audit

**Branch**: `001-system-audit` | **Date**: 2026-03-19 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-system-audit/spec.md`

## Summary

Comprehensive hardening of the GuestPilot v2 platform addressing 50+
identified issues across security, race conditions, memory leaks, error
handling, and data integrity. The audit is organized into 7 user stories
spanning P0 (critical security + double-fire bugs) through P3
(observability improvements). Key technical approaches: Basic Auth for
webhook verification, atomic swap pattern for classifier concurrency,
`express-rate-limit` + `helmet` for auth hardening, and database-level
unique constraints for deduplication.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+
**Primary Dependencies**: Express 4.x, Prisma ORM, Anthropic SDK, ioredis, BullMQ
**New Dependencies**: `express-rate-limit@^8.3.1`, `rate-limit-redis@^4.3.1`, `helmet@^8.1.0`
**Storage**: PostgreSQL + pgvector + Prisma ORM
**Testing**: Manual verification via quickstart.md (no test framework in project)
**Target Platform**: Railway (backend), Vercel (frontend)
**Project Type**: Web service (multi-tenant SaaS)
**Performance Goals**: Zero duplicate AI messages under concurrent load; memory stable over 24h
**Constraints**: All fixes must degrade gracefully (Constitution Principle I); no breaking changes to the guest messaging flow
**Scale/Scope**: ~50 file modifications across backend services, middleware, schema, and config

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Graceful Degradation | PASS | All new middleware (rate-limit, webhook-auth, helmet) degrades gracefully if Redis/config unavailable. Webhook auth has grace period for unconfigured tenants. |
| II. Multi-Tenant Isolation | PASS — this audit FIXES violations | FR-004 adds tenantId verification to task operations. Webhook auth validates per-tenant secrets. |
| III. Guest Safety & Access Control | PASS — this audit FIXES violations | FR-003 removes credentials from logs. FR-008 ensures JSON parse failures escalate rather than silently drop. |
| IV. Structured AI Output | PASS | FR-016 adds validation of AI output fields (urgency enum, title/note length). |
| V. Escalate When In Doubt | PASS — this audit REINFORCES | FR-008 creates escalation on pipeline failures. Error handling improvements ensure no silent drops. |
| VI. Observability by Default | PASS | SSE error logging improved (no more silent `catch {}`). Webhook auth logs warnings for unconfigured tenants. |
| VII. Self-Improvement with Guardrails | PASS — this audit FIXES violations | FR-007 adds mutex to classifier reinitialization. FR-017 prevents duplicate training examples. |
| Security & Data Protection | PASS — this audit FIXES violations | FR-001 webhook auth, FR-002 JWT secret enforcement, FR-003 credential log scrubbing, FR-015 security headers. |
| Development Workflow | PASS | Database changes use raw SQL migrations for constraints Prisma can't express natively. No destructive migrations. |

**Post-design re-check**: All gates still pass. No constitution violations introduced.

## Project Structure

### Documentation (this feature)

```text
specs/001-system-audit/
├── plan.md              # This file
├── research.md          # Phase 0: Hostaway auth, mutex patterns, rate limiting
├── data-model.md        # Phase 1: Schema constraint changes
├── quickstart.md        # Phase 1: Verification steps
├── contracts/
│   └── middleware.md    # Phase 1: New middleware contracts
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (files modified)

```text
backend/
├── prisma/
│   └── schema.prisma                    # Add unique constraints
├── prisma/migrations/
│   └── add_audit_constraints.sql        # Raw SQL for partial indexes + vector column
├── src/
│   ├── app.ts                           # Add helmet, trust proxy, JWT validation
│   ├── middleware/
│   │   ├── auth.ts                      # Remove fallback JWT secret
│   │   ├── rate-limit.ts                # NEW: rate limiters
│   │   └── webhook-auth.ts              # NEW: Basic Auth verification
│   ├── routes/
│   │   ├── auth.ts                      # Add rate limit middleware
│   │   └── webhooks.ts                  # Add webhook auth + rate limit
│   ├── controllers/
│   │   └── webhooks.controller.ts       # Remove TODO, use auth middleware
│   ├── services/
│   │   ├── ai.service.ts                # Scrub logs, validate AI output, write-ahead, JSON fallback escalation
│   │   ├── classifier.service.ts        # Atomic swap pattern, reinit dedup
│   │   ├── classifier-store.service.ts  # Upsert for deduplication
│   │   ├── debounce.service.ts          # Upsert for PendingAiReply
│   │   ├── hostaway.service.ts          # Add retry with exponential backoff
│   │   ├── judge.service.ts             # Cache cleanup, tenant isolation
│   │   ├── sse.service.ts               # Connection cleanup, empty Set deletion, error logging
│   │   ├── topic-state.service.ts       # Periodic cleanup interval
│   │   └── tenant-config.service.ts     # Reduce cache TTL
│   └── jobs/
│       └── aiDebounce.job.ts            # Cleanup on shutdown
└── package.json                          # Add helmet, express-rate-limit, rate-limit-redis
```

**Structure Decision**: Existing web application structure (backend/ +
frontend/). All changes are to the backend. No new services or models —
only modifications to existing files plus two new middleware files.

## Complexity Tracking

No constitution violations to justify. All changes are direct fixes to
identified bugs, security gaps, and missing constraints. No new
abstractions or architectural changes introduced.
