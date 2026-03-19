# Implementation Plan: AI Pipeline Overhaul

**Branch**: `002-ai-pipeline-overhaul` | **Date**: 2026-03-19 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/002-ai-pipeline-overhaul/spec.md`

## Summary

Overhaul the AI pipeline's observability, training data quality, and
self-improvement loop. The classifier currently achieves 44% accuracy
with a 63% empty-label rate. This plan adds accuracy metrics to the
existing pipeline dashboard, builds a gap analysis + suggested examples
workflow, makes the judge fire on every response (with manual toggle),
enables data-driven threshold tuning, and creates a pipeline snapshot
for cross-session AI continuity. Operator feedback (ratings) is P3.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+
**Primary Dependencies**: Express 4.x, Prisma ORM, Anthropic SDK, ioredis
**Frontend**: Next.js 16 + React 19 + Tailwind 4 + shadcn/ui
**Storage**: PostgreSQL + pgvector + Prisma ORM
**Testing**: Manual verification via quickstart.md
**Target Platform**: Railway (backend), Vercel (frontend)
**Project Type**: Web service (multi-tenant SaaS)
**Constraints**: All changes must preserve graceful degradation; no breaking changes to the guest messaging flow; Arabic RTL support required in UI

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Graceful Degradation | PASS | Judge mode toggle degrades gracefully (evaluate_all is safe default). Gap analysis is on-demand, not in critical path. Snapshot generation is fire-and-forget. |
| II. Multi-Tenant Isolation | PASS | Training examples shared globally (constitution §II carve-out). SOP content per-tenant. Judge mode per-tenant config. All other queries filter by tenantId. |
| III. Guest Safety | PASS | No changes to guest-facing behavior. Classifier improvements only affect SOP retrieval quality. |
| IV. Structured AI Output | PASS | No changes to AI output format. |
| V. Escalate When In Doubt | PASS | Better classifier accuracy means fewer missed escalations. |
| VI. Observability | PASS — this feature ENHANCES | Core purpose: add accuracy metrics, skip-reason logging, pipeline snapshots. |
| VII. Self-Improvement | PASS — this feature FIXES | Judge mode toggle, gap analysis, better training data coverage. |

**Post-design re-check**: All gates pass.

## Project Structure

### Documentation (this feature)

```text
specs/002-ai-pipeline-overhaul/
├── plan.md              # This file
├── research.md          # Phase 0: accuracy aggregation, gap analysis, judge toggle, snapshot format
├── data-model.md        # Phase 1: schema changes + new API endpoints
├── quickstart.md        # Phase 1: verification steps
├── contracts/
│   └── api.md           # Phase 1: new and modified API contracts
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (files modified + created)

```text
backend/
├── prisma/
│   └── schema.prisma                    # Add judgeMode + skipReason fields
├── src/
│   ├── routes/
│   │   ├── ai-pipeline.ts               # Add /accuracy + /snapshot endpoints
│   │   └── knowledge.ts                 # Add /gap-analysis + /batch-classify + /approve + /reject
│   ├── controllers/
│   │   └── knowledge.controller.ts      # Gap analysis + batch classify handlers
│   ├── services/
│   │   ├── judge.service.ts             # Judge mode toggle logic + skip-reason logging
│   │   ├── classifier.service.ts        # Batch classify support
│   │   ├── tenant-config.service.ts     # Add judgeMode to config
│   │   └── snapshot.service.ts          # NEW: pipeline snapshot generation
│   └── config/
│       └── ...                          # No config changes
│
frontend/
├── components/
│   ├── ai-pipeline-v5.tsx               # Add accuracy section + per-category breakdown
│   ├── examples-editor-v5.tsx           # Add "Suggested" tab with approve/reject
│   ├── classifier-v5.tsx                # Add judge mode toggle
│   └── inbox-v5.tsx                     # Connect rating buttons to self-improvement
└── lib/
    └── api.ts                           # Add new API client functions
```

**Structure Decision**: Existing web application structure. All changes
are enhancements to existing files. One new service file
(`snapshot.service.ts`).

## Complexity Tracking

No constitution violations to justify.
