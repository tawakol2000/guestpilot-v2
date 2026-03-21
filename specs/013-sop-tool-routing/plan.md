# Implementation Plan: SOP Tool Routing

**Branch**: `013-sop-tool-routing` | **Date**: 2026-03-21 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/013-sop-tool-routing/spec.md`

## Summary

Replace the entire 3-tier classifier system (LR/KNN embedding classifier, Haiku intent extractor, topic state cache) with a single `get_sop` tool call using Claude's native tool use. The AI classifies each guest message by selecting from a 22-value enum (20 SOPs + none + escalate), the app retrieves the matching SOP content, and returns it as a tool result for response generation. This eliminates ~2,800 lines of classification code, 5 backend services, 25+ API endpoints, a Python training pipeline, and the entire classifier frontend page.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+ (backend), Next.js 16 + React 19 (frontend), Python 3 (removed — training script deleted)
**Primary Dependencies**: Express 4.x, Prisma ORM, Anthropic SDK (`@anthropic-ai/sdk`), existing tool use infrastructure from features 010/011
**Storage**: PostgreSQL + Prisma ORM (no schema changes — existing classifier tables kept read-only)
**Testing**: Manual verification via sandbox chat endpoint + curl tests against live API
**Target Platform**: Railway (backend), Vercel (frontend)
**Project Type**: Web service (multi-tenant SaaS)
**Performance Goals**: Per-message cost ≤ $0.004, response latency increase ≤ 500ms vs current system
**Constraints**: Must coexist with property search tool (screening) and extend-stay tool (guest coordinator). Prompt caching minimum 4,096 tokens for Haiku.
**Scale/Scope**: ~3,000 lines removed, ~500 lines added/modified across backend + frontend

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Graceful Degradation | PASS | FR-018: SOP retrieval failure → respond without SOP, never crash. Tool handler errors return graceful fallback. |
| II. Multi-Tenant Isolation | PASS | SOP content per-tenant (from existing property knowledge). Classification logged per-tenant. No global state shared. |
| III. Guest Safety & Access Control | PASS | Classification doesn't affect access control logic — that stays in the system prompt. Escalation preserved via "escalate" category. |
| IV. Structured AI Output | PASS | Tool use with `strict: true` guarantees valid JSON output. Guest coordinator/screening output schemas unchanged. |
| V. Escalate When In Doubt | PASS | New "escalate" enum value gives the AI an explicit escape hatch. Existing escalation-enrichment service unchanged. Low-confidence classifications flagged for review. |
| VI. Observability by Default | PASS | FR-011: Every classification logged (categories, confidence, reasoning) to AiApiLog.ragContext. Tool invocation details stored. |
| VII. Self-Improvement with Guardrails | PARTIAL | Judge service needs adaptation — no longer evaluates 3-tier classifier. Repurposed to evaluate tool classification quality using confidence + reasoning fields. Auto-fix to training data removed (no classifier to train). |

**VII Justification**: The self-improvement loop was tightly coupled to the classifier's training data (add examples → retrain LR weights). With tool-based classification, there's no model to retrain. The judge shifts from "auto-fix classifier" to "monitor classification quality" — a simpler but still valuable role. Rate limiting and fire-and-forget guarantees preserved.

## Project Structure

### Documentation (this feature)

```text
specs/013-sop-tool-routing/
├── plan.md              # This file
├── research.md          # Phase 0: tool use research + codebase analysis
├── data-model.md        # Phase 1: entity changes
├── quickstart.md        # Phase 1: integration scenarios
├── contracts/           # Phase 1: API contract changes
└── tasks.md             # Phase 2: task breakdown (/speckit.tasks)
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── services/
│   │   ├── ai.service.ts           # MODIFY: add get_sop tool, forced choice, 2-call flow, remove 3-tier pipeline
│   │   ├── rag.service.ts          # MODIFY: remove SOP routing, keep property knowledge retrieval only
│   │   ├── sop.service.ts          # NEW: SOP content store (moved from classifier-data.ts)
│   │   ├── judge.service.ts        # MODIFY: simplify to evaluate tool classification quality
│   │   ├── opus.service.ts         # MODIFY: update daily audit to read tool classification data
│   │   ├── classifier.service.ts   # DELETE (1,085 lines)
│   │   ├── classifier-data.ts      # DELETE (534 lines) — SOP_CONTENT moves to sop.service.ts
│   │   ├── classifier-store.service.ts # DELETE (45 lines)
│   │   ├── intent-extractor.service.ts # DELETE (157 lines)
│   │   └── topic-state.service.ts  # DELETE (270 lines)
│   ├── controllers/
│   │   ├── knowledge.controller.ts # MODIFY: remove classifier training/retrain endpoints, keep KB management
│   │   └── ai-config.controller.ts # MODIFY: remove intent prompt endpoints, update sandbox with tool
│   ├── routes/
│   │   ├── knowledge.ts            # MODIFY: remove ~15 classifier routes, keep KB CRUD + add monitoring
│   │   ├── ai-pipeline.ts          # MODIFY: remove tier stats, add tool classification stats
│   │   └── sandbox.ts              # MODIFY: replace classifier pipeline with tool-based flow
│   └── config/
│       ├── intent_extractor_prompt.md  # DELETE (348 lines)
│       └── topic_state_config.json     # DELETE (199 lines)
├── scripts/
│   └── train_classifier.py         # DELETE (362 lines)
└── prisma/
    └── schema.prisma               # NO CHANGES — keep classifier tables read-only

frontend/
├── components/
│   ├── classifier-v5.tsx           # DELETE entirely (1,980 lines) — replaced by sop-monitor-v5.tsx
│   ├── sop-monitor-v5.tsx          # NEW: classification distribution, confidence, reasoning log
│   ├── ai-pipeline-v5.tsx          # MODIFY: remove tier 1/2/3 sections, add tool classification display
│   ├── inbox-v5.tsx                # MODIFY: replace 'classifier' tab with 'sop-monitor' tab
│   └── configure-ai-v5.tsx         # MODIFY: remove intent extractor prompt editor
├── lib/
│   └── api.ts                      # MODIFY: remove classifier API calls, add monitoring API calls
```

**Structure Decision**: Existing web application structure (backend/ + frontend/) maintained. New file `sop.service.ts` created to hold SOP content that was previously embedded in `classifier-data.ts`. New component `sop-monitor-v5.tsx` replaces `classifier-v5.tsx`.
