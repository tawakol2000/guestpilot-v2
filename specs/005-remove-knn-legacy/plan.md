# Implementation Plan: Remove KNN Legacy & Complete LR Migration

**Branch**: `005-remove-knn-legacy` | **Date**: 2026-03-19 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/005-remove-knn-legacy/spec.md`

## Summary

Fix two bugs where KNN cosine similarity is incorrectly used for LR-era decisions, update all comments/labels/defaults from KNN to LR across 11 files, and add centroid-based semantic topic switch detection using per-category centroids already stored in the LR training output.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+ (backend), Next.js 16 + React 19 (frontend)
**Primary Dependencies**: Express 4.x, Prisma ORM, Anthropic SDK
**Storage**: No schema changes — configuration via `topic_state_config.json`
**Testing**: Manual end-to-end via pipeline visualization dashboard
**Target Platform**: Railway (backend Docker), Vercel (frontend)
**Project Type**: Web service (backend + frontend)
**Performance Goals**: No regression — centroid cosine similarity is O(n) on embedding dimension (~1024), <1ms
**Constraints**: Must not break existing pipeline. Graceful fallback when centroids unavailable.
**Scale/Scope**: 11 files changed, ~100 lines of new code (centroid detection), ~50 lines of comment/label updates

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| §I Graceful Degradation | ✅ PASS | Centroid detection falls back to keyword-only when centroids unavailable. No new hard dependencies. |
| §II Multi-Tenant Isolation | ✅ PASS | Centroids are global (shared training data per constitution §II exception). Topic cache is per-conversation. |
| §III Guest Safety & Access Control | ✅ PASS | No changes to access code gating, screening, or financial rules. |
| §IV Structured AI Output | ✅ PASS | No AI prompt changes. |
| §V Escalate When In Doubt | ✅ PASS | No escalation logic changed. |
| §VI Observability | ✅ PASS | KNN diagnostic kept for pipeline display. Centroid switch events logged. |
| §VII Self-Improvement Guardrails | ✅ PASS | Judge now uses LR confidence (more accurate). No change to rate limits or validation. |
| Security | ✅ PASS | No new endpoints, no new secrets, no auth changes. |

**Gate result**: PASS — no violations.

## Project Structure

### Documentation (this feature)

```text
specs/005-remove-knn-legacy/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Audit findings + centroid design
├── data-model.md        # Interface changes + data flow
├── quickstart.md        # Testing & deployment guide
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (affected files)

```text
backend/src/
├── services/
│   ├── classifier.service.ts       # Export getCentroids(), update header comment
│   ├── rag.service.ts              # Fix tier decision to use LR confidence, update comment
│   ├── topic-state.service.ts      # Add centroid distance check, new embedding param
│   ├── rerank.service.ts           # Remove obsolete KNN comment
│   ├── opus.service.ts             # Update audit report headers
│   └── judge.service.ts            # Use LR confidence as primary (verify wiring)
├── controllers/
│   └── knowledge.controller.ts     # Fix reinforcement threshold to use LR confidence
├── routes/
│   └── knowledge.ts                # Update route comment
└── config/
    └── topic_state_config.json     # Add centroid_switch_threshold, centroid_min_examples

frontend/components/
├── ai-pipeline-v5.tsx              # Default to 'lr', update labels
└── classifier-v5.tsx               # No changes needed
```

**Structure Decision**: Existing web application structure. Changes span backend services, one controller, one route file, one config file, and one frontend component.

## Phase 0: Research

**Status**: ✅ Complete — see [research.md](research.md)

Key findings:
1. Two bugs: `rag.service.ts` and `knowledge.controller.ts` use KNN `topSimilarity` for LR-era decisions
2. 11 files need comment/label updates
3. Centroid detection: threshold 0.60, min 3 examples, configurable via `topic_state_config.json`
4. No new dependencies

## Phase 1: Design

**Status**: ✅ Complete — see [data-model.md](data-model.md)

Key design decisions:
- `getReinjectedLabels()` gains optional `messageEmbedding?: number[]` parameter
- New export `getCentroids()` from classifier.service.ts
- Config fields: `centroid_switch_threshold` (0.60), `centroid_min_examples` (3)
- Fallback: keyword-only when centroids unavailable

## Implementation Approach

### Change Group 1: Bug Fixes (P1)

**File: `backend/src/services/rag.service.ts`**
- Line ~501: Replace `classifierResult.topSimilarity` with `classifierResult.confidence` for the backward-compat tier field
- Line ~347: Update comment "use KNN classifier" → "use LR classifier"

**File: `backend/src/controllers/knowledge.controller.ts`**
- Line ~478: Replace `classifierTopSim < 0.40` with `(ragCtx?.classifierConfidence ?? ragCtx?.classifierTopSim ?? null)` and compare LR confidence
- Line ~372: Update comment

### Change Group 2: Comment/Label/Default Updates (P2)

**Backend files** (comment-only changes):
- `classifier.service.ts` lines 1-12: File header
- `rerank.service.ts` lines 2, 9: Remove obsolete KNN claim
- `opus.service.ts` lines 264-283: Audit report headers
- `knowledge.ts` line 31: Route comment
- `knowledge.controller.ts` line 372: Comment

**Frontend file** (`ai-pipeline-v5.tsx`):
- Line 1420: Default `'knn'` → `'lr'`
- Line 1434: Fallback comment
- Lines 2104-2106: Label "Tier 1: KNN" → "Tier 1: LR"
- Line 833: Comment update

### Change Group 3: Centroid Topic Switch (P3)

**File: `backend/src/services/classifier.service.ts`**
- Export new function `getCentroids()` that returns `_state?.centroids ?? null`
- Export existing `cosineSimilarity` (currently private) or add a `computeCentroidDistance(embedding, label)` helper

**File: `backend/src/services/topic-state.service.ts`**
- Import `getCentroids` from classifier.service
- Load `centroid_switch_threshold` and `centroid_min_examples` from config
- Modify `getReinjectedLabels()`:
  - Add `messageEmbedding?: number[]` parameter
  - After keyword check passes (no keyword found), before default re-inject:
    - If `messageEmbedding` provided AND centroids available for active topic:
      - Compute cosine similarity between embedding and centroid
      - If below threshold → topic switch detected → clear cache, return empty
      - Log: `[TopicState] Centroid switch detected (sim=X.XX < threshold=0.60)`
    - If no centroids or no embedding → fall back to existing behavior (keyword-only)

**File: `backend/config/topic_state_config.json`**
- Add to `global_settings`: `"centroid_switch_threshold": 0.60, "centroid_min_examples": 3`

**File: `backend/src/services/rag.service.ts`** (caller update)
- Where `getReinjectedLabels()` is called, pass the `queryEmbedding` if available

### Change Group 4: Verify Judge Wiring

**File: `backend/src/services/judge.service.ts`**
- Verify line ~216: `effectiveConfidence = input.confidence ?? input.classifierTopSim` — this is already correct (LR primary, KNN fallback)
- No code change needed — just verify and update the `KNN SIMILARITY` log label at line ~440

## Deployment

Standard push — no migration, no env vars, no retraining. The centroid feature activates automatically using centroids from the existing `classifier-weights.json`.
