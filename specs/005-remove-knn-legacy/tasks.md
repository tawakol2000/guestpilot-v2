# Tasks: Remove KNN Legacy & Complete LR Migration

**Input**: Design documents from `/specs/005-remove-knn-legacy/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md

**Tests**: Not requested — no test tasks included.

**Organization**: Tasks grouped by user story. No setup/foundational phase needed — all changes modify existing files.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: User Story 1 — All Decisions Use LR Confidence (Priority: P1) 🎯 MVP

**Goal**: Fix all decision paths to use LR sigmoid confidence instead of KNN cosine similarity.

**Independent Test**: Send a message where LR confidence ≥ 0.85 but KNN similarity is 0.47. Verify tier routing uses HIGH (single SOP injected), not LOW (Tier 2 fallback). Check pipeline visualization to confirm.

### Implementation

- [x] T001 [P] [US1] Fix tier decision in `backend/src/services/rag.service.ts` — replace `classifierResult.topSimilarity` with `classifierResult.confidence` at the backward-compat tier assignment (~line 501). Also update the `_lastClassifierResult` snapshot to include `confidence` field alongside existing `topSimilarity`.

- [x] T002 [P] [US1] Fix reinforcement threshold in `backend/src/controllers/knowledge.controller.ts` — replace `classifierTopSim < 0.40` (~line 478) with LR confidence check: `(ragCtx?.classifierConfidence ?? ragCtx?.classifierTopSim ?? null)` compared against 0.40. Update the associated log message.

- [x] T003 [US1] Verify judge wiring in `backend/src/services/judge.service.ts` — confirm `effectiveConfidence = input.confidence ?? input.classifierTopSim` (~line 216) correctly prefers LR. Update the log label at ~line 440 from "KNN SIMILARITY" to "CLASSIFIER DIAGNOSTIC (KNN)".

- [x] T004 [US1] Verify ai.service.ts passes LR confidence to judge — confirm `classifierConfidence` field is populated in the ragContext object passed to the judge (~line 1399-1402 of `backend/src/services/ai.service.ts`). If missing, add `classifierConfidence: classifierSnap?.confidence ?? null`.

**Checkpoint**: All decision paths now use LR confidence. KNN similarity is logged for observability only.

---

## Phase 2: User Story 2 — Clean Labels, Comments & Defaults (Priority: P2)

**Goal**: All user-facing labels, developer comments, and UI defaults accurately describe LR as the primary classifier.

**Independent Test**: Open the pipeline visualization dashboard — it should show "LR Engine" by default. Read the classifier service file header — it should describe LR. Run OPUS report — it should say "LR Embedding Classifier".

### Implementation

- [x] T005 [P] [US2] Update file header in `backend/src/services/classifier.service.ts` — replace lines 1-12 "KNN-3 Embedding Classifier" description with "LR Sigmoid Classifier (with KNN diagnostic for observability)". Update architecture bullet points to describe LR inference with three-tier confidence routing.

- [x] T006 [P] [US2] Update rerank comments in `backend/src/services/rerank.service.ts` — line 2: remove "KNN classifier" from description. Line 9: remove "1. KNN classifier: re-score top-10..." (obsolete — rerank not used in classifier path). Keep line 10 (RAG usage) unchanged.

- [x] T007 [P] [US2] Update comment in `backend/src/services/rag.service.ts` — line 347: "use KNN classifier for SOPs" → "use LR classifier for SOPs".

- [x] T008 [P] [US2] Update OPUS audit report text in `backend/src/services/opus.service.ts` — line 264: "Tier 1 — KNN Embedding Classifier" → "Tier 1 — LR Embedding Classifier". Line 266: "K=3 nearest neighbors by cosine similarity" → "LR sigmoid model with three-tier confidence routing (KNN diagnostic alongside)". Lines 272, 283: replace "topSimilarity" metric references with "LR confidence" as primary.

- [x] T009 [P] [US2] Update route comments in `backend/src/routes/knowledge.ts` — line 31: "(KNN + LR)" → "(LR primary, KNN diagnostic)". Update `backend/src/controllers/knowledge.controller.ts` line 372: "reinit of the KNN classifier" → "reinit of the LR classifier".

- [x] T010 [P] [US2] Remove KNN engine toggle and old KNN display branch in `frontend/components/ai-pipeline-v5.tsx`:
  - Remove `engineType` state and the `'knn' | 'lr'` toggle entirely — LR is the only engine now
  - Remove the entire KNN-only display branch (lines ~991-1046) — dead code with no engine toggle
  - Remove or simplify the engine badge (line ~1731) — always show "LR Engine" or remove the badge
  - Keep the collapsible KNN diagnostic section (lines ~936-988) but relabel "KNN Diagnostic" → "Embedding Diagnostic" since it shows similarity data still useful for debugging
  - Update flow diagram label (lines ~2104-2106): "Tier 1: KNN" → "Tier 1: LR"
  - Line 833: update comment

**Checkpoint**: All KNN-as-primary references removed. Dashboard shows LR only — no engine toggle. Old KNN display branch deleted. OPUS report describes LR.

---

## Phase 3: User Story 3 — Semantic Topic Switch Detection (Priority: P3)

**Goal**: Detect silent topic changes using centroid distance when keyword detection fails.

**Independent Test**: Start a conversation about cleaning, then send "what's the WiFi password?" without any switch keywords. Verify the pipeline shows "centroid switch detected" and classifies fresh as "sop-wifi-doorcode" instead of re-injecting the cleaning SOP.

### Implementation

- [x] T011 [P] [US3] Export centroid access from `backend/src/services/classifier.service.ts` — add `export function getCentroids(): Record<string, number[]> | null` that returns `_state?.centroids ?? null`. Also export the existing `cosineSimilarity` helper (change from private to exported).

- [x] T012 [P] [US3] Add centroid config to `backend/config/topic_state_config.json` — add two fields under `global_settings`: `"centroid_switch_threshold": 0.60` and `"centroid_min_examples": 3`.

- [x] T013 [US3] Add centroid distance check to `backend/src/services/topic-state.service.ts`:
  - Import `getCentroids` and `cosineSimilarity` from classifier.service
  - Load `centroid_switch_threshold` (default 0.60) and `centroid_min_examples` (default 3) from config
  - Modify `getReinjectedLabels()` signature: add `messageEmbedding?: number[]` parameter
  - After keyword check passes (no keyword found) and before the default re-inject block:
    - If `messageEmbedding` provided AND centroids available for active labels:
      - For each active label, compute cosine similarity between embedding and centroid
      - Use the max similarity across active labels
      - If max similarity < threshold → topic switch → clear cache, return `{ labels: [], reinjected: false, topicSwitchDetected: true }`
      - Log: `[TopicState] Centroid switch detected (sim=X.XX < threshold=0.60): "message..."`
    - Skip centroid check if centroid has < `centroid_min_examples` training examples (unreliable centroid)
    - If no centroids loaded or no embedding → fall through to existing keyword-only behavior

- [x] T014 [US3] Update caller in `backend/src/services/rag.service.ts` to pass `queryEmbedding` to `getReinjectedLabels()` — find where `getReinjectedLabels(conversationId, messageText)` is called and add the query embedding as third argument when available.

- [x] T015 [US3] Verify graceful fallback — confirm that when `classifier-weights.json` is missing (no centroids), `getCentroids()` returns null and `getReinjectedLabels()` falls back to keyword-only detection without errors.

**Checkpoint**: Silent topic switches detected via centroid distance. Keyword fallback works when centroids unavailable.

---

## Phase 4: Polish & Cross-Cutting Concerns

**Purpose**: Final verification and documentation

- [x] T016 Run TypeScript compilation check (`npx tsc --noEmit`) to verify no type errors across all changed files
- [x] T017 Update `AI_SYSTEM_FLOW-v7.md` — update Tier 3 section to document centroid-based topic switch detection alongside keyword detection. Add centroid threshold to the Key Thresholds table.
- [ ] T018 End-to-end verification — send 3 test messages through the live system: (1) a message where LR and KNN diverge to verify P1 fix, (2) check dashboard shows "LR" default to verify P2, (3) a silent topic switch to verify P3.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (US1)**: No dependencies — can start immediately
- **Phase 2 (US2)**: No dependencies — can start in parallel with Phase 1
- **Phase 3 (US3)**: T011 and T012 have no dependencies; T013 depends on T011+T012; T014 depends on T013
- **Phase 4 (Polish)**: Depends on all user stories complete

### User Story Dependencies

- **US1 (P1)**: Independent — no dependencies on US2 or US3
- **US2 (P2)**: Independent — no dependencies on US1 or US3
- **US3 (P3)**: Independent — T011 exports from classifier.service.ts but doesn't conflict with US1/US2 changes

### Parallel Opportunities

All three user stories can run in parallel (they touch different sections of the same files, but non-overlapping lines):

```
US1: T001 ‖ T002 → T003 → T004
US2: T005 ‖ T006 ‖ T007 ‖ T008 ‖ T009 ‖ T010  (all parallel)
US3: T011 ‖ T012 → T013 → T014 → T015
```

---

## Implementation Strategy

### MVP First (US1 Only)

1. Complete T001-T004 (fix LR confidence wiring)
2. **STOP and VALIDATE**: Verify tier routing and judge use LR confidence
3. Deploy — immediate accuracy improvement

### Incremental Delivery

1. US1: Bug fixes → deploy (classification accuracy improves)
2. US2: Label cleanup → deploy (developer/operator clarity)
3. US3: Centroid detection → deploy (topic switch accuracy improves)
4. Each story adds value independently

---

## Notes

- All changes modify existing files — no new files except potentially none
- No schema migration needed
- No new dependencies
- Centroid data already exists in classifier-weights.json from training
- Total: 18 tasks across 4 phases
