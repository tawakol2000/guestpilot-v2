# Tasks: Similarity Boost + Description-Enhanced Classification

**Input**: Design documents from `/specs/009-similarity-boost/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Not included (no automated test suite in this project; validation via pipeline display + manual acceptance).

**Organization**: Tasks grouped by user story for independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup — COMPLETE

**Purpose**: Create new config files and scaffold structures needed by all stories.

- [x] T001 Create `backend/src/config/sop_descriptions.json` with scaffold structure: `version`, `categories` object with all 20 category keys, `broad` flags, empty `descriptions.en` and `descriptions.ar` arrays. Use schema from data-model.md §New File. *(DONE — file created with full content)*
- [x] T002 [P] Add boost/cap/gap thresholds to `backend/config/topic_state_config.json` under `global_settings`: `boost_similarity_threshold: 0.80`, `boost_min_agreement: 3`, `lr_hard_cap: 3`, `lr_gap_filter: 0.10`

---

## Phase 2: Foundational (Blocking Prerequisites) — COMPLETE

**Purpose**: Update TypeScript interfaces and data flow types. No behavioral changes — all stories depend on these types.

- [x] T003 Update `ClassificationResult` interface in `backend/src/services/classifier.service.ts`: rename `knnDiagnostic` → `similarityBoost`, add fields `boostApplied`, `boostSimilarity`, `boostLabels`, `originalLrConfidence`, `originalLrLabels`, `descriptionFeaturesActive`, `topDescriptionMatches`. Update `method` type comment to include `lr_boost | lr_desc`. Use interface from data-model.md §Modified Interface: ClassificationResult.
- [x] T004 Update `ClassifierState` interface in `backend/src/services/classifier.service.ts`: add `descriptionEmbeddings: Map<string, number[][]> | null`, `descriptionCategories: string[] | null`, `descriptionFeaturesActive: boolean`. Initialize new fields to `null`/`false` in `_state` default.
- [x] T005 [P] Update `_lastClassifierResult` type and field mapping in `backend/src/services/rag.service.ts`: rename `knnDiagnostic`-derived fields to match new `similarityBoost` naming. Add new boost/description fields to the snapshot.
- [x] T006 [P] Update ragContext construction in `backend/src/services/ai.service.ts` (~line 1488): add `boostApplied`, `boostSimilarity`, `boostLabels`, `originalLrConfidence`, `originalLrLabels`, `descriptionFeaturesActive`, `topDescriptionMatches` from classifier snapshot. Use optional chaining for backward compat.
- [x] T007 Update all internal callers of `knnDiagnostic` to use `similarityBoost` in `backend/src/services/classifier.service.ts` — update the return object construction in `classifyMessage()` and any references in `judge.service.ts` or other consumers.

**Checkpoint**: All types compile. No runtime behavior change yet. All existing functionality preserved.

---

## Phase 3: User Story 1 — Near-Exact Matches Get HIGH Confidence (Priority: P1) 🎯 MVP — COMPLETE

**Goal**: When KNN finds a near-exact training match (sim ≥ 0.80, 3/3 neighbors agree), override LR with the KNN label at high confidence. Eliminates unnecessary Tier 2 calls for known messages.

**Independent Test**: Send "I need a pillow" → verify Tier 1 shows HIGH confidence (~99%), `sop-amenity-request`, method=`lr_boost` → Tier 2 does NOT fire.

### Implementation for User Story 1

- [x] T008 [US1] Add config reader for boost thresholds in `backend/src/services/classifier.service.ts`: load `boost_similarity_threshold` and `boost_min_agreement` from `topic_state_config.json` (same pattern as `centroid_switch_threshold`). Fall back to defaults (0.80, 3) if missing.
- [x] T009 [US1] Implement boost check in `classifyMessage()` in `backend/src/services/classifier.service.ts` (~line 432, after `runKnnDiagnostic`): check if `topSimilarity >= boost_threshold` AND all 3 neighbors share at least one common label (intersection of label arrays is non-empty). If YES: set `boostApplied=true`, override `labels` with shared label, set `confidence` to top-1 similarity, set `method='lr_boost'`, recompute `tier` from boosted confidence. If NO: set `boostApplied=false`, keep LR result.
- [x] T010 [US1] Populate boost metadata fields in the `ClassificationResult` return in `backend/src/services/classifier.service.ts`: `boostSimilarity`, `boostLabels`, `originalLrConfidence`, `originalLrLabels` (capture LR values before any override).

**Checkpoint**: KNN boost works. Send exact training matches → HIGH confidence, method=lr_boost. Novel messages → no boost, LR unchanged. Check ragContext in pipeline display for boost fields.

---

## Phase 4: User Story 2 — Description-Enhanced LR Catches Novel Phrasings (Priority: P2) — COMPLETE

**Goal**: Embed rich SOP descriptions, compute per-category cosine similarities as additional LR features, and retrain the LR on augmented 1044-dim vectors. Catches novel phrasings and Arabic messages without Tier 2.

**Independent Test**: Send an Arabic message about a maintenance issue not in training data → verify LR classifies correctly as `sop-maintenance` with MEDIUM+ confidence.

### Implementation for User Story 2

- [x] T011 [US2] Write all 60 SOP descriptions in `backend/src/config/sop_descriptions.json`: 15 narrow categories × 1 EN + 1 AR = 30 descriptions, 5 broad categories (sop-complaint, sop-amenity-request, sop-booking-inquiry, pricing-negotiation, post-stay-issues) × 3 EN + 3 AR = 30 descriptions. Each description is 2-4 natural sentences describing how guests phrase requests. No negation. Include synonyms, variant phrasings, domain-specific language. Arabic descriptions in MSA. See spec §FR-004/FR-005/FR-006 for constraints. *(DONE — 60 descriptions written via 4 parallel agents)*
- [x] T012 [US2] Implement description loading and embedding at startup in `initializeClassifier()` in `backend/src/services/classifier.service.ts` (~line 219): load `sop_descriptions.json`, flatten all description texts, call `embedBatch(texts, 'classification')`, store in `_state.descriptionEmbeddings` as `Map<string, number[][]>` (category → array of EN+AR embeddings). Store sorted category names in `_state.descriptionCategories` (alphabetical). If Cohere fails, log warning and continue with `descriptionEmbeddings = null`. Also check if `ClassifierWeights.weights.descriptionEmbeddings` exist and prefer those (skip API call) for cold start.
- [x] T013 [US2] Implement `computeDescriptionSimilarities()` function in `backend/src/services/classifier.service.ts`: takes `queryEmbedding` and `state.descriptionEmbeddings`, computes cosine similarity against all description embeddings using existing `cosineSimilarity()`, takes max per category, returns 20-dim feature vector (alphabetical category order) and `topDescriptionMatches` (top 3 by similarity with labels). Return null if descriptions not loaded.
- [x] T014 [US2] Implement dimension detection and fallback in `loadLrWeightsMetadata()` in `backend/src/services/classifier.service.ts` (~line 147): after loading weights, check `coefficients[0].length`. If 1024 → set `_state.descriptionFeaturesActive = false`, log warning "Description features disabled — old weights (1024-dim), retrain required". If 1044 → set `_state.descriptionFeaturesActive = true`. Any other value → log error, set false.
- [x] T015 [US2] Wire description features into `classifyMessage()` in `backend/src/services/classifier.service.ts`: after embedding query, call `computeDescriptionSimilarities()`. Populate `topDescriptionMatches` in result. If `descriptionFeaturesActive`: concatenate `[queryEmbedding(1024), descSimilarities(20)]` → 1044-dim vector, pass to `classifyWithLR()`, set `method='lr_desc'`. If not active: pass plain 1024-dim embedding to `classifyWithLR()`, set `method='lr_sigmoid'`. Description sims are always computed (for observability) even if features are disabled.
- [x] T016 [US2] Update Python training script in `backend/scripts/train_classifier.py`: accept `descriptions` field in stdin JSON input. Embed all descriptions using Cohere (`input_type="classification"`). For each training example, compute cosine similarity against all description embeddings, take max per category (alphabetical order), concatenate `[1024-dim embedding, 20-dim desc sims]` → 1044-dim. Train OneVsRestClassifier(LogisticRegression) on augmented vectors. Output coefficients (now 1044-wide), include `featureSchema` and `descriptionEmbeddings` in weights JSON output.
- [x] T017 [US2] Update `retrainClassifier` in `backend/src/controllers/knowledge.controller.ts`: read `sop_descriptions.json`, include descriptions in the stdin JSON payload sent to the Python training script. After training completes, the new weights (with description embeddings and featureSchema) are saved to file + DB as usual.

**Checkpoint**: With old weights → description features disabled (warning logged), boost still works. After retraining → augmented weights loaded, method=lr_desc. Test Arabic messages and novel phrasings for improved classification.

---

## Phase 5: User Story 3 — Hard Cap + Gap Filter Prevents Label Flood (Priority: P3) — COMPLETE

**Goal**: LR never returns more than 3 labels, and only labels close in score to the top label survive. Eliminates the 7-label problem.

**Independent Test**: Send an ambiguous message → verify at most 3 labels returned, all within 10pp of top score.

### Implementation for User Story 3

- [x] T018 [US3] Implement gap filter and hard cap in `classifyWithLR()` in `backend/src/services/classifier.service.ts` (~line 272): after existing per-category threshold filtering, apply gap filter (keep only labels within `lr_gap_filter` absolute percentage points of top score), then apply hard cap (`lr_hard_cap` labels max). Ensure at least 1 label is always returned (top-1) even if all scores are below thresholds. Read thresholds from `topic_state_config.json` global_settings (loaded in T008). Sort labels by confidence descending before returning.

**Checkpoint**: No message returns > 3 labels. Ambiguous messages return only labels close in score. top-1 always returned.

---

## Phase 6: User Story 4 — Rename KNN to Similarity Boost Everywhere (Priority: P4) — COMPLETE

**Goal**: Replace all "KNN", "knn", "Embedding Diagnostic" references with "Similarity Boost" terminology across backend and frontend.

**Independent Test**: Search codebase for "KNN", "knn" — zero results in active code except historical comments. Pipeline display shows "Similarity Boost" not "Embedding Diagnostic".

### Implementation for User Story 4

- [x] T019 [P] [US4] Rename `runKnnDiagnostic()` → `runSimilarityDiagnostic()` in `backend/src/services/classifier.service.ts`: update function name, all internal callers, and update the returned `method` field from `'knn_vote'` to `'similarity_boost'`. Update constants `K` and `MIN_NEIGHBOR_AGREEMENT` comments.
- [x] T020 [P] [US4] Search and rename remaining "KNN"/"knn" references across backend: `backend/src/services/ai.service.ts`, `backend/src/services/rag.service.ts`, `backend/src/services/judge.service.ts`, `backend/src/routes/ai-pipeline.ts`. Update log messages, comments, and variable names. Preserve `knn` references only in historical data handling (DB records already stored).
- [x] T021 [US4] Rename "Embedding Diagnostic" → "Similarity Boost" in `frontend/components/ai-pipeline-v5.tsx` (~line 957): update section label, any KNN-related display text, and field references that were renamed in backend.

**Checkpoint**: `grep -r "knn\|KNN" backend/src/ frontend/` returns zero active code references (historical comments/data OK). Pipeline display shows "Similarity Boost".

---

## Phase 7: User Story 5 — Pipeline Display Shows Classification Decision (Priority: P5) — COMPLETE

**Goal**: Pipeline visualization shows when Similarity Boost overrode LR, with numeric scores for boost and description matching.

**Independent Test**: Send a near-exact match → pipeline shows boost info. Send a novel phrasing → pipeline shows description match scores.

### Implementation for User Story 5

- [x] T022 [US5] Update pipeline feed endpoint in `backend/src/routes/ai-pipeline.ts` (~line 189): add `boostApplied`, `boostSimilarity`, `boostLabels`, `originalLrConfidence`, `originalLrLabels`, `descriptionFeaturesActive`, `topDescriptionMatches` to the pipeline object extraction from ragContext. Use contract from `contracts/pipeline-feed.md`.
- [x] T023 [US5] Update `PipelineFeedEntry` interface in `frontend/components/ai-pipeline-v5.tsx` (~line 98): add new boost and description fields matching backend contract. All new fields nullable.
- [x] T024 [US5] Update the Similarity Boost section (formerly "Embedding Diagnostic") in `frontend/components/ai-pipeline-v5.tsx` (~line 934): when `boostApplied=true` show boost similarity bar, neighbor agreement (3/3), original LR confidence, boosted confidence, tier change. When `boostApplied=false` show neighbor similarity, agreement count, "no boost — below threshold".
- [x] T025 [US5] Add "Description Matches" subsection in `frontend/components/ai-pipeline-v5.tsx` below the Similarity Boost section: show top 3 description similarities with category labels. Show `descriptionFeaturesActive` status indicator (active/disabled).
- [x] T026 [US5] Add boost badge to collapsed pipeline row in `frontend/components/ai-pipeline-v5.tsx` (~line 600): when `boostApplied=true`, show a small badge/pill indicating "Boosted" next to the confidence display.

**Checkpoint**: Pipeline display shows full classification decision path. Boost entries show override info. Description-enhanced entries show top matches. All data present for every classified message.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Diagnostics endpoint and final validation.

- [x] T027 Implement `GET /api/classifier/description-matrix` endpoint in `backend/src/controllers/knowledge.controller.ts`: compute cosine similarity between all pairs of description embeddings (using representative embedding per category: max across EN+AR variants). Return matrix with flagged pairs > 0.70. Return 503 if descriptions not loaded. See contract in `contracts/pipeline-feed.md §New Endpoint`.
- [x] T028 [P] Add route for `/api/classifier/description-matrix` in `backend/src/routes/` (knowledge routes or new classifier route): wire to controller, require JWT auth.
- [ ] T029 Run cross-class similarity validation: execute the diagnostic endpoint on deployed descriptions. Verify zero pairs > 0.70. If flagged pairs found, rewrite descriptions in `sop_descriptions.json` and re-validate.
- [ ] T030 Validate end-to-end quickstart workflow from `specs/009-similarity-boost/quickstart.md`: start server with old weights (verify fallback warning), write descriptions, retrain, verify augmented weights loaded, test boost + description features + cap/gap, check pipeline display.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 — BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Phase 2 — **MVP, deliver first**
- **US2 (Phase 4)**: Depends on Phase 2 — independent of US1
- **US3 (Phase 5)**: Depends on Phase 2 — independent of US1/US2
- **US4 (Phase 6)**: Depends on Phase 2 — independent of US1/US2/US3. **Note**: T019/T020 touch same files as T005/T006 (rag.service.ts, ai.service.ts). Run US4 AFTER Phase 2 changes are committed to avoid merge conflicts.
- **US5 (Phase 7)**: Depends on US1 + US2 backend work being complete (needs data to display)
- **Polish (Phase 8)**: Depends on US2 (descriptions must exist for diagnostic)

### User Story Dependencies

- **US1 (P1)**: Can start after Phase 2. No dependencies on other stories. ← **Start here**
- **US2 (P2)**: Can start after Phase 2. Independent of US1. Biggest effort (descriptions + training script).
- **US3 (P3)**: Can start after Phase 2. Independent of US1/US2. Smallest effort (1 task).
- **US4 (P4)**: Can start after Phase 2. Independent. Cross-cutting rename.
- **US5 (P5)**: Needs US1+US2 backend complete (to show boost + description data).

### Within Each User Story

- Config/types before logic
- Core computation before wiring into main flow
- Backend before frontend
- Training script after runtime description features (to mirror logic)

### Parallel Opportunities

- T001 and T002 can run in parallel (different files)
- T005 and T006 can run in parallel (different files)
- **US1, US2, US3, US4 can all start in parallel** after Phase 2 (if team capacity allows)
- T019 and T020 can run in parallel (different files)
- US3 is a single task — fastest to complete

---

## Parallel Example: After Phase 2

```
# All of these can run simultaneously after Phase 2:

Agent 1: US1 — T008 → T009 → T010 (boost logic, 3 tasks)
Agent 2: US2 — T011 (write 60 descriptions — biggest single task)
Agent 3: US3 — T018 (gap filter + cap — single task)
Agent 4: US4 — T019 + T020 in parallel, then T021 (rename, 3 tasks)

# After US1+US2 backend complete:
Agent 5: US5 — T022 → T023 → T024/T025/T026 (frontend, 5 tasks)

# After US2 complete:
Agent 6: Polish — T027 + T028 in parallel, then T029 → T030
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001-T002)
2. Complete Phase 2: Foundational (T003-T007)
3. Complete Phase 3: User Story 1 (T008-T010)
4. **STOP and VALIDATE**: Send exact training matches → HIGH confidence, lr_boost, no Tier 2
5. Deploy — immediate value, zero risk (boost is additive, only increases confidence)

### Incremental Delivery

1. Setup + Foundational → types ready
2. US1 (boost) → **MVP deployed** — handles ~40% of messages
3. US3 (cap/gap) → eliminates 7-label floods — 1 task, ships fast
4. US2 (descriptions) → biggest effort, requires retraining — handles novel phrasings + Arabic
5. US4 (rename) → cleanup — cosmetic, no risk
6. US5 (frontend) → shows full classification decision — operator visibility
7. Polish → diagnostics + validation

### Key Risk: T011 (Writing 60 Descriptions)

T011 is the single largest task — 60 hand-crafted natural language descriptions across 20 categories in 2 languages. This is creative/domain work that cannot be parallelized further. Plan accordingly:
- Expect 2-4 hours of focused writing
- Use spec §Research Findings for description writing guidelines
- Validate with cross-class diagnostic (T029) after embedding

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story is independently completable and testable
- No Prisma schema changes needed — all data fits in existing Json fields
- Total: 30 tasks across 8 phases
- Commit after each task or logical group
