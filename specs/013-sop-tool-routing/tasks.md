# Tasks: SOP Tool Routing

**Input**: Design documents from `/specs/013-sop-tool-routing/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Organization**: Tasks grouped by user story. US1 and US2 are both P1 and form the big-bang cutover together.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Foundational)

**Purpose**: Create the SOP content store that both US1 (new tool flow) and US2 (delete classifier-data.ts) depend on.

- [X] T001 Create `backend/src/services/sop.service.ts` — move `SOP_CONTENT` map from `classifier-data.ts` (lines 458-534), export `getSopContent(category, propertyAmenities?)` preserving the `{PROPERTY_AMENITIES}` template replacement for `sop-amenity-request`. Export `SOP_CATEGORIES` array (22 string values) and `SOP_TOOL_DEFINITION` constant containing the full Anthropic tool schema with: name `get_sop`, `strict: true`, `reasoning` string field, `categories` array with 22-value enum, `confidence` enum (high/medium/low). Each enum value gets a lean ~20-token description with negative boundary. Add 3-5 `input_examples` targeting hardest disambiguation (cleaning vs maintenance, amenity vs property-description, greeting vs none).

**Checkpoint**: sop.service.ts compiles, exports all constants, getSopContent returns correct content for all 22 categories.

---

## Phase 2: User Story 1 — Tool-Based SOP Classification (Priority: P1) MVP

**Goal**: Every guest message is classified via a forced `get_sop` tool call. SOP content is retrieved and returned as tool_result for response generation.

**Independent Test**: Send a message via sandbox → verify classification (categories, confidence, reasoning) in response metadata → verify correct SOP content used in response.

- [X] T002 [US1] Implement 2-call SOP classification flow in `backend/src/services/ai.service.ts` — add a new function or modify `createMessage()` to support a pre-classification call: Call 1 uses `[SOP_TOOL_DEFINITION]` with `tool_choice: {type: "tool", name: "get_sop"}`, parses response for categories/confidence/reasoning, calls `getSopContent()` for each category (concatenating if multi-intent), then makes Call 2 with the SOP content as `tool_result` message and remaining tools (`search_available_properties` or `check_extend_availability`) with `tool_choice: auto`. Remove `get_sop` from Call 2 tools. Place `cache_control: {type: "ephemeral"}` on last tool definition and last system message block.

- [X] T003 [US1] Wire tool-based classification into `processInquiry()` in `backend/src/services/ai.service.ts` — replace the current flow that calls `retrieveRelevantKnowledge()` for SOP routing + builds `knowledgeText` with the new 2-call tool flow. The screening agent gets `get_sop` on Call 1, then `search_available_properties` on Call 2. Remove the 3-tier pipeline calls (classifyMessage, extractIntent, getSopContent, updateTopicState, getReinjectedLabels, getCachedTopicLabel). Keep property knowledge retrieval from rag.service.ts for property-specific context.

- [X] T004 [US1] Wire tool-based classification into guest coordinator flow in `backend/src/services/ai.service.ts` — same pattern as T003 but for CONFIRMED/CHECKED_IN guests. Call 1: forced `get_sop`. Call 2: SOP as tool_result + `check_extend_availability` tool with `auto`. Remove 3-tier pipeline calls from this path.

- [X] T005 [US1] Simplify `backend/src/services/rag.service.ts` — remove `classifyMessage()`, `extractIntent()`, `getSopContent()` calls and the entire 3-tier confidence routing logic from `retrieveRelevantKnowledge()`. Keep only the property knowledge chunk retrieval (embedding search + reranking). Remove imports of classifier, intent-extractor, and classifier-data. The function should now only return property-specific knowledge chunks, not SOP chunks.

- [X] T006 [US1] Update ragContext logging in `backend/src/services/ai.service.ts` — add new fields: `sopToolUsed: boolean`, `sopCategories: string[]`, `sopConfidence: string`, `sopReasoning: string`. Remove old classifier fields: `classifierUsed`, `classifierLabels`, `classifierTopSim`, `classifierMethod`, `classifierConfidence`, `boostApplied`, `boostSimilarity`, `boostLabels`, `originalLrConfidence`, `originalLrLabels`, `descriptionFeaturesActive`, `topDescriptionMatches`, `tier3Reinjected`, `tier3TopicSwitch`, `tier3ReinjectedLabels`, `centroidSimilarity`, `centroidThreshold`, `switchMethod`, `tier2Output`, `tierModes`, `confidenceTier`, `originalConfidenceTier`, `topCandidates`.

- [X] T007 [US1] Update `backend/src/routes/sandbox.ts` — replace the classifier pipeline (classifyMessage, extractIntent, getSopContent) with the new tool-based flow. The sandbox endpoint should follow the same 2-call pattern as the main ai.service.ts flow. Import `SOP_TOOL_DEFINITION` and `getSopContent` from sop.service.ts.

- [X] T008 [US1] Handle `escalate` classification in `backend/src/services/ai.service.ts` — when `categories` includes `"escalate"`, create a Task record for the operator using the existing task creation pattern. The SOP tool_result for escalate should instruct Claude to de-escalate while the operator is notified. Integrate with existing escalation-enrichment service signals.

**Checkpoint**: Sandbox chat works with tool-based classification. Send messages for all major SOP categories and verify correct classification + response. Multi-intent and `none` classifications work.

---

## Phase 3: User Story 2 — Remove Legacy Infrastructure (Priority: P1)

**Goal**: Delete all 3-tier classifier code, clean all imports, remove classifier routes and frontend components.

**Independent Test**: `npx tsc --noEmit` passes. Grep for deleted module names returns zero hits. Frontend builds without errors.

### Backend Service Deletion

- [X] T009 [P] [US2] Delete 8 legacy files: `backend/src/services/classifier.service.ts` (1,085 lines), `backend/src/services/classifier-data.ts` (534 lines), `backend/src/services/classifier-store.service.ts` (45 lines), `backend/src/services/intent-extractor.service.ts` (157 lines), `backend/src/services/topic-state.service.ts` (270 lines), `backend/scripts/train_classifier.py` (362 lines), `backend/config/intent_extractor_prompt.md` (348 lines), `backend/config/topic_state_config.json` (199 lines)

### Backend Import Cleanup

- [X] T010 [P] [US2] Clean `backend/src/server.ts` — remove imports and calls: `initializeClassifier`, `setClassifierThresholds`, `setBoostThreshold`, `loadLrWeightsMetadata` from classifier.service.ts. Remove the startup initialization block that loads classifier weights and sets thresholds from TenantAiConfig.

- [X] T011 [P] [US2] Clean `backend/src/services/judge.service.ts` — remove imports from classifier-store (`addExample`, `getExampleByText`) and classifier (`reinitializeClassifier`, `getMaxSimilarityForLabels`). Remove the Tier 2 feedback fast-path (lines ~245-299). Remove the auto-fix logic that adds training examples. Remove low-similarity reinforcement. Keep the core `evaluateAndImprove` function but simplify to work with tool classification data (sopCategories, sopConfidence, sopReasoning).

- [X] T012 [P] [US2] Clean `backend/src/services/opus.service.ts` — remove imports of `SOP_CONTENT` from classifier-data, `getClassifierStatus` and `getClassifierThresholds` from classifier. Update the daily audit report generation to read tool classification data from AiApiLog.ragContext (sopCategories, sopConfidence) instead of classifier-specific fields.

### Backend Route Cleanup

- [X] T013 [US2] Remove classifier routes from `backend/src/routes/knowledge.ts` — delete routes: test-classify, classify-test, batch-classify, classifier-examples (GET/POST/DELETE/PATCH), classifier-examples/:id/approve, classifier-examples/:id/reject, all-examples, retrain-classifier, classifier-reinitialize, training-distribution, generate-paraphrases, description-matrix. Remove corresponding methods from `backend/src/controllers/knowledge.controller.ts`: retrainClassifier, trainingDistribution, generateParaphrases, and all classifier example CRUD methods.

- [X] T014 [P] [US2] Remove intent prompt endpoints from `backend/src/controllers/ai-config.controller.ts` — remove GET/PUT `/api/ai-config/intent-prompt` handlers and the `getIntentPrompt`, `reloadIntentPrompt` imports from intent-extractor.service.ts. Remove route definitions in `backend/src/routes/ai-config.ts`.

- [X] T015 [P] [US2] Clean `backend/src/routes/ai-pipeline.ts` — remove imports of `getTopicCacheStats` from topic-state, `getTier2Stats` from intent-extractor, `getClassifierStatus` from classifier. Update the pipeline stats endpoint to return tool classification stats instead of tier stats.

- [X] T016 [US2] Full backend grep verification — search `backend/src/` for any remaining imports or references to: `classifier.service`, `classifier-data`, `classifier-store`, `intent-extractor`, `topic-state`, `classifyMessage`, `extractIntent`, `getSopContent` (from classifier), `TRAINING_EXAMPLES`, `BAKED_IN_CHUNKS`, `SOP_CONTENT` (from classifier-data), `updateTopicState`, `getReinjectedLabels`, `getCachedTopicLabel`, `initializeClassifier`. Fix any broken references found.

### Frontend Cleanup

- [X] T017 [P] [US2] Delete `frontend/components/classifier-v5.tsx` (1,980 lines)

- [X] T018 [P] [US2] Remove classifier API calls from `frontend/lib/api.ts` — delete: `apiGetClassifierStatus`, `apiGetClassifierThresholds`, `apiSetClassifierThresholds`, `apiTestClassify`, `apiClassifyDetailed`, `apiGetClassifierExamples`, `apiAddClassifierExample`, `apiDeleteClassifierExample`, `apiReinitializeClassifier`, `apiRetrainClassifier`, `apiGetEvaluationStats`, `apiGetEvaluations`, `apiApproveExample`, `apiRejectExample`, and any other classifier-specific functions.

- [X] T019 [P] [US2] Remove intent extractor prompt editor section from `frontend/components/configure-ai-v5.tsx` — find and remove the intent prompt GET/PUT UI section added in feature 012.

- [X] T020 [US2] Full frontend grep verification — search `frontend/` for any remaining references to: `classifier`, `ClassifierV5`, `tier1Mode`, `tier2Mode`, `tier3Mode`, `knn`, `retrain`, `ghost`, `intent-extractor`, `topicState`. Fix any broken references. Update `inbox-v5.tsx` NavTab type to remove `'classifier'` if still present.

**Checkpoint**: `npx tsc --noEmit` passes for backend. Frontend builds. Grep for deleted module names returns zero results across entire codebase.

---

## Phase 4: User Story 3 — SOP Classification Monitoring (Priority: P2)

**Goal**: Operators can view classification distribution, confidence breakdown, and recent classifications with reasoning.

**Independent Test**: Open the monitoring tab → see classification data from recent messages including categories, confidence, and reasoning text.

- [X] T021 [US3] Add `GET /api/knowledge/sop-classifications` endpoint in `backend/src/routes/knowledge.ts` and `backend/src/controllers/knowledge.controller.ts` — query `AiApiLog` records where `ragContext` contains `sopToolUsed: true`, extract sopCategories/sopConfidence/sopReasoning, support `?limit=50&offset=0&confidence=low` query params. Return `{classifications: [...], total: number}`.

- [X] T022 [US3] Modify `GET /api/knowledge/evaluation-stats` in `backend/src/controllers/knowledge.controller.ts` — return tool-based stats: total classifications, highConfidence/mediumConfidence/lowConfidence counts, categoryDistribution object (category → count). Read from AiApiLog.ragContext sopCategories/sopConfidence fields.

- [X] T023 [US3] Add monitoring API calls to `frontend/lib/api.ts` — add `apiGetSopClassifications(params)` and `apiGetSopStats()` functions calling the new/modified endpoints.

- [X] T024 [US3] Create `frontend/components/sop-monitor-v5.tsx` — new component with: (1) stats bar showing total classifications, high/medium/low confidence counts, (2) category distribution section (table or bar chart showing message count per SOP category), (3) recent classifications table with columns: timestamp, guest message (truncated), categories, confidence badge, reasoning text, conversation link. Support confidence filter dropdown (all/high/medium/low). Paginated with load-more.

- [X] T025 [US3] Wire SOP monitor into `frontend/components/inbox-v5.tsx` — replace the `'classifier'` NavTab value with `'sop-monitor'` (or add new value). Update the tab label from "Classifier" to "SOP Monitor". Render `<SopMonitorV5 />` for the new tab. Remove the `<ClassifierV5 />` import if still present.

- [X] T026 [US3] Update `frontend/components/ai-pipeline-v5.tsx` — remove Tier 1/2/3 health cards (classifier/haiku/cache percentage display). Remove tier routing display from feed entries (classifierLabels, classifierTopSim, classifierConfidence, classifierMethod, boostApplied, tier3Reinjected, tier3ReinjectedLabels, tier2Output). Add tool classification display: show sopCategories badges, sopConfidence badge, sopReasoning text for each feed entry.

**Checkpoint**: Monitoring tab shows real classification data. Category distribution and confidence breakdown display correctly. Recent classifications show reasoning.

---

## Phase 5: User Story 4 — Judge Adaptation (Priority: P3)

**Goal**: Judge evaluates tool classification quality using confidence and reasoning instead of 3-tier classifier metrics.

**Independent Test**: Process messages with mixed confidence levels. Verify judge flags low-confidence classifications for review.

- [X] T027 [US4] Update `JudgeInput` interface in `backend/src/services/judge.service.ts` — replace `classifierLabels`, `classifierMethod`, `classifierTopSim`, `neighbors`, `tier2Labels`, `tier3Reinjected` with `sopCategories: string[]`, `sopConfidence: 'high' | 'medium' | 'low'`, `sopReasoning: string`. Update `evaluateAndImprove()` callers in ai.service.ts to pass the new fields.

- [X] T028 [US4] Simplify judge evaluation logic in `backend/src/services/judge.service.ts` — remove the three-path evaluation (Tier 3 skip, Tier 2 feedback, standard). New logic: if `sopConfidence === 'high'` and `judgeMode === 'sampling'`, skip or sample at 30%. If `sopConfidence === 'low'`, always evaluate. If `sopConfidence === 'medium'`, evaluate based on judgeMode. Remove `addExample`/`reinitializeClassifier` calls (no training data to update). Keep the `callJudge()` function but update its prompt to evaluate tool classification quality instead of classifier accuracy.

**Checkpoint**: Judge fires for low-confidence classifications. High-confidence classifications are skipped in sampling mode. No errors from removed imports.

---

## Phase 6: Polish & Verification

- [X] T029 Run `npx tsc --noEmit` in `backend/` — verify zero TypeScript errors
- [X] T030 Run frontend build — verify zero compilation errors
- [ ] T031 Test via sandbox chat (requires running server — post-deploy) — send representative messages for all 22 categories, verify correct SOP classification and response quality
- [ ] T032 Commit all changes and push to `013-sop-tool-routing` branch

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — start immediately
- **Phase 2 (US1)**: Depends on Phase 1 (T001 — sop.service.ts)
- **Phase 3 (US2)**: Depends on Phase 2 (US1 must be wired before deleting old code)
- **Phase 4 (US3)**: Depends on Phase 2 (needs ragContext with new sop* fields to query)
- **Phase 5 (US4)**: Depends on Phase 3 (judge cleaned of old imports in US2)
- **Phase 6 (Polish)**: Depends on ALL phases complete

### User Story Dependencies

- **US1 (P1)**: Depends on Setup only — this is the MVP
- **US2 (P1)**: Depends on US1 — can't delete old code until new flow works
- **US3 (P2)**: Depends on US1 — needs classification data in ragContext to display
- **US4 (P3)**: Depends on US2 — judge cleanup happens in US2, adaptation in US4

### Parallel Opportunities

```
Phase 1: T001 (sequential — single file, foundation)
Phase 2: T002 → T003 → T004 (sequential — same file ai.service.ts)
          T005 (parallel with T002-T004 — different file rag.service.ts)
          T006 (after T003 — same file ai.service.ts)
          T007 (parallel — different file sandbox.ts, after T001)
          T008 (after T003 — same file ai.service.ts)
Phase 3: T009 ‖ T010 ‖ T011 ‖ T012 (all parallel — different files)
          T013 (sequential — large route file)
          T014 ‖ T015 (parallel — different files)
          T016 (after all above — grep verification)
          T017 ‖ T018 ‖ T019 (all parallel — different frontend files)
          T020 (after all above — frontend grep verification)
Phase 4: T021 → T022 (sequential — same controller)
          T023 (after T021/T022 — needs API shape)
          T024 (parallel with T021 — frontend, after T023 API shape known)
          T025 ‖ T026 (parallel — different frontend files)
Phase 5: T027 → T028 (sequential — same file judge.service.ts)
```

---

## Implementation Strategy

### MVP First (Phase 1 + Phase 2 = US1)

1. T001: Create sop.service.ts
2. T002-T008: Wire tool-based classification into ai.service.ts
3. **STOP and VALIDATE**: Test via sandbox — every SOP category classifies correctly
4. This gives a working system even if old code is still present

### Big-Bang Cutover (Phase 3 = US2)

5. T009-T020: Delete old services, clean imports, remove routes, update frontend
6. **STOP and VALIDATE**: tsc --noEmit passes, grep returns zero hits, frontend builds

### Monitoring (Phase 4 = US3)

7. T021-T026: Add monitoring endpoint + dashboard
8. **STOP and VALIDATE**: Monitor shows real classification data

### Judge (Phase 5 = US4)

9. T027-T028: Simplify judge for tool classification
10. **STOP and VALIDATE**: Judge evaluates low-confidence classifications

### Ship

11. T029-T032: Final verification + push

---

## Notes

- Total: 32 tasks across 6 phases
- MVP: 9 tasks (Phase 1 + Phase 2 — tool-based classification working)
- Big-bang cutover: 12 tasks (Phase 3 — remove everything old)
- Main bottleneck: ai.service.ts (T002-T004, T006, T008 are sequential — same file)
- Parallel wins: Phase 3 has many parallel deletions/cleanups across different files
- No database migrations — classifier tables kept read-only
- Python removed from classification path (train_classifier.py deleted)
