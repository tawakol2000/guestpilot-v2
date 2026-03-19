# Implementation Plan: AI Engine Comprehensive Fix

**Branch**: `003-ai-engine-fix` | **Date**: 2026-03-19 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/003-ai-engine-fix/spec.md`

## Summary

Replace the broken KNN-3 classifier with logistic regression trained
on Cohere embeddings. Add three-tier confidence routing (high → 1 SOP,
medium → top 3 SOPs, low → intent extractor fallback). Add centroid-
based topic switch detection. Rebalance training data. Deploy as a
separate Railway service (`backend-new-ai`) sharing the same DB as the
existing `backend-advanced-ai`. Frontend auto-adapts to engine type
via `/classifier-status`.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+ (inference) + Python 3 (training)
**Primary Dependencies**: Express 4.x, Prisma ORM, Cohere SDK, sklearn (Python), numpy
**Frontend**: Next.js 16 + React 19 + Tailwind 4 + shadcn/ui
**Storage**: PostgreSQL (shared with existing service) + file-based LR weights JSON
**New Dependency**: Python 3 + sklearn + numpy + cohere SDK in Docker image
**Target Platform**: Railway (new service: `backend-new-ai`), Vercel (shared frontend)
**Project Type**: Web service (multi-tenant SaaS)
**Performance Goal**: Classification < 50ms total (25ms Cohere + <1ms LR)
**Constraints**: No GPU; Cohere API for embeddings; Python only for training; shared DB with old service

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Graceful Degradation | PASS | If LR weights missing → fall back to intent extractor. If Python retrain fails → old weights stay. If Cohere down → queue and retry. |
| II. Multi-Tenant Isolation | PASS | Training data shared globally (§II carve-out). SOP content per-tenant. Both services share DB safely. |
| III. Guest Safety | PASS | No changes to guest-facing behavior — only SOP retrieval quality improves. |
| IV. Structured AI Output | PASS | No changes to AI output format. Three-tier routing only changes what SOPs are injected, not the response format. |
| V. Escalate When In Doubt | PASS | Better classification = fewer missed escalations. Low-confidence messages still go through intent extractor. |
| VI. Observability | PASS | KNN kept as diagnostic. LR confidence + tier routing + LLM overrides all logged. Frontend auto-adapts to engine type. |
| VII. Self-Improvement | PASS | Judge still fires (evaluate_all mode). LR retrained on demand after examples change. Training data shared across both services. |

**Post-design re-check**: All gates pass. Separate Railway service doesn't violate any principle — both services share the same DB and write compatible data.

## Project Structure

### Documentation

```text
specs/003-ai-engine-fix/
├── plan.md              # This file
├── research.md          # 7 research decisions (LR, calibration, topic switch, rebalancing, deployment, three-tier, Python)
├── data-model.md        # ClassifierState, TopicCache, weights JSON, deployment config
├── quickstart.md        # Verification steps
├── contracts/
│   └── api.md           # New + modified API contracts
└── tasks.md             # /speckit.tasks output
```

### Source Code

```text
backend/
├── Dockerfile                           # Add Python 3 + sklearn
├── scripts/
│   └── train_classifier.py              # NEW: sklearn LR training + CV calibration + centroid computation
├── src/
│   ├── config/
│   │   └── classifier-weights.json      # NEW: LR weights + centroids + thresholds (generated)
│   ├── routes/
│   │   └── knowledge.ts                 # Add /retrain-classifier endpoint
│   ├── controllers/
│   │   └── knowledge.controller.ts      # Retrain handler
│   ├── services/
│   │   ├── classifier.service.ts        # LR inference + KNN diagnostic + three-tier routing
│   │   ├── topic-state.service.ts       # Centroid-based switch + multi-slot cache
│   │   ├── classifier-data.ts           # Rebalanced training examples
│   │   ├── rag.service.ts              # Three-tier SOP injection logic
│   │   └── intent-extractor.service.ts  # Kept for low-confidence fallback
│   └── ...

frontend/
├── components/
│   ├── ai-pipeline-v5.tsx               # Auto-adapt: LR confidence OR KNN sim
│   └── classifier-v5.tsx                # Auto-adapt: Retrain button (LR only)
└── lib/
    └── api.ts                           # Add retrainClassifier()
```

**Structure Decision**: Same repo, same codebase. New Railway service
deploys from `003-ai-engine-fix` branch. Frontend shared (auto-adapts
via `/classifier-status` engine type).

## Complexity Tracking

| Decision | Why Needed | Simpler Alternative Rejected |
|----------|-----------|------------------------------|
| Python in Docker | sklearn for LR training + cross-validation | Pure TS — sklearn handles regularization, multi-class, convergence better |
| Separate Railway service | Safe A/B testing without risking production | Same-service deploy — too risky for a classifier replacement |
| KNN kept as diagnostic | Pipeline dashboard debug value | Remove entirely — loses operator debug context |
| Three-tier routing | 92-96% accuracy vs 85-90% single-tier | Binary confident/not — loses medium-confidence accuracy gains |
