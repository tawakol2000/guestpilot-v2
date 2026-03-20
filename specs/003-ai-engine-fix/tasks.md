# Tasks: AI Engine Comprehensive Fix

**Input**: Design documents from `/specs/003-ai-engine-fix/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: No test framework. Verification via quickstart.md + batch-classify.

**Organization**: Tasks grouped by user story. Deploys as separate Railway service (`backend-new-ai`).

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup — COMPLETE

- [x] T001 Update backend to include Python 3 + sklearn (nixpacks.toml created)
- [x] T002 Create `backend/scripts/train_classifier.py`
- [x] T003 Add `POST /api/knowledge/retrain-classifier` endpoint
- [x] T004 Add `apiRetrainClassifier()` to frontend API client

## Phase 2: Foundational — COMPLETE

- [x] T005 Refactor ClassifierState interface with LR fields
- [x] T006 Implement LR inference (classifyWithLR)
- [x] T007 Update classifyMessage() — LR primary + KNN diagnostic
- [x] T008 Update reinitializeClassifier() — load weights JSON
- [x] T009 Update classifier-status endpoint — classifierType: "lr"
- [x] T009a Update judge to use LR confidence for skip decisions

## Phase 3: US2 Three-Tier Routing — COMPLETE

- [x] T012 Add highConfidenceThreshold + lowConfidenceThreshold to schema
- [x] T013 Modify SOP injection with three-tier routing in rag.service.ts
- [x] T014 Add LLM override detection in ai.service.ts
- [x] T014a Add override rate monitoring in accuracy endpoint + dashboard
- [x] T015 Add tier threshold sliders to classifier settings UI

## Phase 5: US3 Calibration — COMPLETE

- [x] T016 Verify train_classifier.py includes LOO-CV + per-category thresholds
- [x] T017 Display calibration results in classifier settings UI

## Phase 10: Frontend Auto-Adapt — COMPLETE

- [x] T029 Pipeline dashboard auto-detects engine type (LR vs KNN)
- [x] T030 Classifier settings: retrain button + calibration + LR-only UI
- [x] T031 Pipeline feed entries: LR decision + KNN diagnostic

---

## Phase 6: US4 Rebalance Training Data (Priority: P1) — COMPLETE

- [x] T018 [P] [US4] Create rebalancing script/endpoint (GET /training-distribution + POST /generate-paraphrases)
- [x] T019 [P] [US4] Generate Arabic paraphrases for under-represented categories (Haiku paraphrase endpoint)
- [ ] T020 [US4] Run retrain after rebalancing (manual step — generate paraphrases for under-represented categories, then retrain)

## Phase 7: US5 Semantic Topic Switch (Priority: P1) — COMPLETE

- [x] T021 [US5] Modify topic-state.service.ts: centroid-based switch detection (already implemented)
- [x] T022 [US5] Update function signature + call site for message embedding (already implemented)
- [x] T023 [US5] Log topic switch method in ragContext (centroidSimilarity, centroidThreshold, switchMethod added to pipeline log)

## Phase 8: US6 Multi-Slot Topic Cache (Priority: P2) — COMPLETE

- [x] T024 [US6] Rewrite cache: 3-slot with TopicCacheSlot structure
- [x] T025 [US6] Implement confidence decay + boost on return (exponential half-life decay + return boost multiplier)
- [x] T026 [US6] Update getReinjectedLabels() to check all 3 slots (checks all live slots for centroid + reinjects all)

## Phase 9: US7 Short Message Augmentation (Priority: P2) — COMPLETE

- [x] T027 [US7] Prepend context for messages < 4 words before embedding
- [x] T028 [US7] Update classifyMessage() signature for cachedTopicLabel

## Phase 11: Deployment & Verification — TODO

- [ ] T032 Create `backend-new-ai` Railway service
- [ ] T033 Set env vars on new service
- [ ] T034 Run initial retrain
- [ ] T034a Verify classifier-weights.json + classifierType: "lr"
- [ ] T034b Run batch-classify on 50 messages — empty-label rate < 15%
- [ ] T036 Point test tenant webhook at new service
- [ ] T037 Generate pipeline snapshot
- [ ] T038 Run quickstart.md full verification

---

## Deferred Checklist Items (from engine-architecture.md)

These 8 items were deferred during clarification — revisit after MVP is running:
- CHK007: Medium tier prompt exact text — decide during T013 implementation ✅ (handled)
- CHK008: Minimum confidence for top-3 candidates — take top 3 regardless for now
- CHK013: Confidence boost amount on return-to-topic — decide during T025
- CHK014: Cache behavior on retrain — default: don't clear (cache = conversation state)
- CHK019: Merge-back process — standard git merge when proven
- CHK022: Python script detailed error handling — graceful failure + old weights
- CHK028: Circular judge validation risk — operator ratings provide human ground truth
- CHK029/CHK030: Small sample size + per-language metrics — will grow with traffic

**None of these block the MVP. All can be addressed after deployment.**
