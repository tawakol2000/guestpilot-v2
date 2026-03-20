# Tasks: AI Flow System Audit & Fix

**Input**: Design documents from `/specs/006-ai-flow-audit/`
**Prerequisites**: plan.md, spec.md, research.md (61 bugs + 7 additional), data-model.md, quickstart.md

**Tests**: Not explicitly requested — no test tasks included.

**Organization**: Tasks grouped by user story (5 stories from spec) + foundational phase. All CRITICAL and HIGH bugs map to US1/US2. MEDIUM bugs map to US3-US5. LOW deferred to Polish phase.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1-US5)
- Include exact file paths in descriptions

---

## Phase 1: Foundational (Blocking Prerequisites)

**Purpose**: Schema changes and shared infrastructure that MUST complete before story work begins.

- [x] T001 Generate unique placeholder IDs for existing empty `hostawayMessageId` records in production database — format: `'empty-' + message.id` (uses existing cuid as suffix, guarantees uniqueness). Run via a one-time admin endpoint or migration script in `backend/prisma/`. Must complete BEFORE T002 schema migration.

- [x] T002 Add `@@unique([conversationId, hostawayMessageId])` to Message model and `@@index([tenantId, conversationId])` to AiApiLog model in `backend/prisma/schema.prisma`

- [x] T003 Eliminate `_lastClassifierResult` module global in `backend/src/services/rag.service.ts` — return classifier result directly from `retrieveRelevantKnowledge()` as part of the return object. Add `classifierResult: { method: string; labels: string[]; confidence: number; topSimilarity: number; neighbors: Array<{labels: string[]; similarity: number}>; tier: string; topCandidates: Array<{label: string; confidence: number}>; queryEmbedding?: number[] } | null` field to the return type. Remove `_lastClassifierResult` global variable and `getLastClassifierResult()` export. Update all callers in `backend/src/services/ai.service.ts` (lines ~1242, ~1816) to use `ragResult.classifierResult` instead.

**Checkpoint**: Schema ready for migration. Thread-safety issue resolved. All story work can begin.

---

## Phase 2: User Story 1 — No Duplicate SOPs in AI Prompt (Priority: P1) 🎯 MVP

**Goal**: Each SOP appears at most once in the final prompt to Claude, regardless of how many tiers identified it.

**Independent Test**: Send a message that triggers both Tier 1 and Tier 2 with the same SOP. Verify pipeline shows chunks: 1 not chunks: 2.

### Implementation

- [x] T004 [US1] Add cross-tier deduplication of `retrievedChunks` in `backend/src/services/ai.service.ts` — after all tiers (RAG line ~1238, Tier 3 line ~1279, Tier 2 line ~1319) have added chunks, deduplicate by `category` before calling `buildPropertyInfo()`. Use a Set-based filter:
  ```
  const seen = new Set<string>();
  retrievedChunks = retrievedChunks.filter(c => {
    if (seen.has(c.category)) return false;
    seen.add(c.category);
    return true;
  });
  ```

- [x] T005 [P] [US1] Add `intentExtractorRan: boolean` flag to the return type of `retrieveRelevantKnowledge()` in `backend/src/services/rag.service.ts`. Set `true` when LOW path fires the intent extractor (line ~422). In `backend/src/services/ai.service.ts` line ~1292, skip the Tier 2 retry when `ragResult.intentExtractorRan === true`.

- [x] T006 [P] [US1] Fix message dedup in `backend/src/controllers/webhooks.controller.ts` — replace `findFirst` dedup check (lines 351-359) with `create + P2002 catch` pattern (same as conversation creation fix). Handle empty `hostawayMessageId` by returning early or generating a synthetic ID. (Depends on T002 schema constraint being applied.)

**Checkpoint**: Zero duplicate SOPs. Zero duplicate messages. Zero redundant Tier 2 calls.

---

## Phase 3: User Story 2 — Topic Switch Triggers Re-Classification (Priority: P2)

**Goal**: Topic switches detected via centroid distance, with keyword fallback. Switches trigger fresh classification.

**Independent Test**: Start cleaning conversation → send "what's the WiFi?" → verify centroid switch detected with numeric score → correct SOP retrieved.

### Implementation

- [x] T007 [US2] Swap topic switch detection order in `backend/src/services/topic-state.service.ts` — centroid check (lines 111-136) must run FIRST as the primary detection method. Move the keyword check block (lines 103-109) AFTER the centroid block and wrap it inside `if (!centroids)` so it only fires as a fallback when centroids are unavailable (no trained model). The current order is: keywords → centroid → default. New order: centroid → keyword-fallback → default.

- [x] T008 [US2] Add numeric return fields to `getReinjectedLabels()` in `backend/src/services/topic-state.service.ts` — update return type to include `centroidSimilarity: number | null`, `centroidThreshold: number | null`, `switchMethod: 'keyword' | 'centroid' | null`. Populate these in both the centroid and keyword switch paths.

- [x] T009 [US2] Run centroid check independently of Tier 1 confidence in `backend/src/services/ai.service.ts` — add a NEW block AFTER the `updateTopicState(conversationId, retrievedSopLabels)` call at line ~1255 (inside the `if (retrievedSopLabels.length > 0)` branch). This block compares the new Tier 1 labels against the previously cached topic: if the cached topic exists AND the new labels differ from cached labels AND centroid distance confirms a real topic change, log the switch. This ensures topic transitions are tracked even when Tier 1 is confident on the new topic.

- [x] T010 [P] [US2] Pass centroid similarity data through to ragContext in `backend/src/services/ai.service.ts` — add `centroidSimilarity`, `centroidThreshold`, `switchMethod` fields to the ragContext object (~line 1395).

- [x] T011 [P] [US2] Add centroid data to pipeline feed in `backend/src/routes/ai-pipeline.ts` — include `centroidSimilarity`, `centroidThreshold`, `switchMethod` in the pipeline response object.

- [x] T012 [P] [US2] Display centroid score in frontend `frontend/components/ai-pipeline-v5.tsx` — in the Tier 3 section, show the centroid similarity score and threshold when available (e.g., "centroid: 0.35 < 0.60 → switch detected").

**Checkpoint**: Silent topic switches detected via centroid. Numeric scores visible in pipeline display.

---

## Phase 4: User Story 3 — AI Contextualizes SOP Rules with Reservation Data (Priority: P3)

**Goal**: AI cross-references SOP conditional logic with actual check-in dates instead of parroting generic text.

**Independent Test**: Send early check-in request for guest checking in tomorrow → verify AI escalates, not gives generic "2 days before" response.

### Implementation

- [x] T013 [US3] Add date cross-reference instruction to system prompt in `backend/config/ai-config.json` — add to both guestCoordinator and screeningAI system prompts:
  ```
  IMPORTANT: When an SOP mentions date-based conditions (e.g., "within 2 days of check-in"),
  ALWAYS compare against the check-in/check-out dates in RESERVATION DETAILS and the current
  local time to determine which branch applies. Never use the generic response when the date
  condition is met.
  ```

- [x] T014 [P] [US3] Inject escalation signals into prompt content blocks in `backend/src/services/ai.service.ts` — after `detectEscalationSignals()` at line ~1377, inject detected signals into the property info or a new content block section:
  ```
  if (escalationSignals.length > 0) {
    propertyInfo += '\n### SYSTEM SIGNALS\n' +
      escalationSignals.map(s => `⚠ ${s.signal}: ${s.description}`).join('\n');
  }
  ```

- [x] T015 [P] [US3] Pass `propertyAmenities` to `retrieveRelevantKnowledge()` in `backend/src/services/rag.service.ts` — add parameter, forward to `getSopContent()` in HIGH path (line ~377), MEDIUM path (line ~393), and LOW path (line ~431). Source amenities from `context.listing?.customKnowledgeBase?.amenities` in ai.service.ts.

**Checkpoint**: AI applies correct SOP branch based on actual dates. Escalation signals visible to Claude.

---

## Phase 5: User Story 4 — Pipeline Visualization Shows Complete Data (Priority: P4)

**Goal**: Dashboard displays all classification data with no empty sections or missing fields.

**Independent Test**: Open pipeline page after message processed → Tier 1 shows confidence/labels, Tier 3 shows centroid score, LLM override badge visible when applicable.

### Implementation

- [x] T016 [P] [US4] Fix `lmOverride` → `llmOverride` typo in `frontend/components/ai-pipeline-v5.tsx` — rename in type definition (line ~121) and all usages (lines ~710, ~882). Add `topCandidates` field to the pipeline type definition.

- [x] T017 [P] [US4] Add `llmOverride` to pipeline feed in `backend/src/routes/ai-pipeline.ts` — include `llmOverride: ragCtx?.llmOverride || null` in the pipeline response.

- [x] T018 [P] [US4] Remove dead `engineType` ternaries in `frontend/components/ai-pipeline-v5.tsx` — remove the `engineType` variable (line ~1352) and simplify all conditional paths at lines ~1641, ~1649-1653, ~1784 to LR-only.

- [x] T019 [P] [US4] Remove unused `classifierType` state in `frontend/components/classifier-v5.tsx` — line 859, remove unused `useState` and any `setClassifierType` calls.

- [x] T020 [P] [US4] Rename `knnDiagExpanded` to `diagnosticsExpanded` in `frontend/components/ai-pipeline-v5.tsx` — lines 596, 939, 955.

**Checkpoint**: Pipeline display shows complete data. No dead code from KNN removal.

---

## Phase 6: User Story 5 — Accurate Pipeline Logs for Debugging (Priority: P5)

**Goal**: ragContext contains full SOP text. Operators can see exactly what Claude received.

**Independent Test**: Query AiApiLog entry → ragContext chunks show full SOP text, not truncated.

### Implementation

- [x] T021 [US5] Remove 200-char truncation from ragContext chunks in `backend/src/services/ai.service.ts` — at line ~1385, change `c.content.substring(0, 200)` to `c.content` (full text). Add a configurable max (e.g., 2000 chars) to prevent extreme cases.

**Checkpoint**: Full SOP text in logs. Debugging possible.

---

## Phase 7: Webhook & Debounce Fixes (CRITICAL/HIGH — cross-cutting)

**Purpose**: Fix remaining CRITICAL/HIGH bugs not covered by user stories.

- [x] T022 [P] Cancel pending AI reply when host sends a message — in `backend/src/controllers/webhooks.controller.ts` HOST path (line ~407), add `await cancelPendingAiReply(conversation.id, prisma)` and broadcast `ai_typing_clear` SSE event.

- [x] T023 [P] Add aiMode check before scheduling AI reply — in `backend/src/controllers/webhooks.controller.ts` line ~403, add `&& reservation.aiMode !== 'off'` to the guard condition.

- [x] T024 [P] Fix silent message drop for `conversationId=0` — in `backend/src/controllers/webhooks.controller.ts` line ~196, change `String(data.conversationId || '')` to `String(data.conversationId ?? '')`.

- [x] T025 Add atomic claim guard to poll job in `backend/src/jobs/aiDebounce.job.ts` — replace `markFired(pending.id)` call with:
  ```
  const claimed = await prisma.pendingAiReply.updateMany({
    where: { id: pending.id, fired: false },
    data: { fired: true },
  });
  if (claimed.count === 0) continue;
  ```

- [x] T026 [P] Unify aiMode whitelist in poll job `backend/src/jobs/aiDebounce.job.ts` — replace `reservation.aiMode === 'off'` blacklist (line ~36) with whitelist: `!['autopilot', 'auto', 'copilot'].includes(reservation.aiMode)`.

- [x] T027 Change judge service to lazy Anthropic init in `backend/src/services/judge.service.ts` — replace line 14 top-level `new Anthropic(...)` with lazy `getClient()` pattern (null check + create on first use, same as intent-extractor.service.ts lines 54-61).

- [x] T028 [P] Add empty labels guard to judge auto-fix in `backend/src/services/judge.service.ts` — add `if (validLabels.length > 0)` before `addExample()` at lines ~361 AND ~393 (both auto-fix and reinforcement paths).

- [x] T029 [P] Add dimension validation to `classifyWithLR()` in `backend/src/services/classifier.service.ts` — add check at line ~254: `if (embedding.length !== coefficients[0].length) throw new Error('Embedding dimension mismatch')`. Also add length validation to exported `cosineSimilarity()` at line ~494.

- [x] T030 Call `loadLrWeightsMetadata()` at end of `initializeClassifier()` in `backend/src/services/classifier.service.ts` — after `_initialized = true` at line ~233, add `loadLrWeightsMetadata()` call.

**Checkpoint**: No double-fires. Host replies cancel AI. Judge doesn't crash or poison data.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: MEDIUM/LOW cleanup, dead code removal, cosmetic fixes.

- [ ] T031 [P] Update guest name during resync in `backend/src/controllers/webhooks.controller.ts` — in the resync block (~line 296), also update guest name when it differs from stored value (not just when it's "Unknown Guest").

- [ ] T032 [P] Validate `parseHostawayDate` output in `backend/src/controllers/webhooks.controller.ts` — add `isNaN(date.getTime())` check after parsing, fall back to `new Date()`.

- [x] T033 [P] Add LRU cap to topic state cache in `backend/src/services/topic-state.service.ts` — add max size (10,000 entries) with eviction of oldest entries when exceeded.

- [x] T034 [P] Add rate limiting to intent extractor in `backend/src/services/intent-extractor.service.ts` — add semaphore (max 10 concurrent Tier 2 calls).

- [ ] T035 [P] Remove dead code: `OMAR_SYSTEM_PROMPT` and `OMAR_SCREENING_SYSTEM_PROMPT` constants in `backend/src/services/ai.service.ts` (lines ~333-815). Also remove `BAKED_IN_CATEGORIES` export in `backend/src/services/intent-extractor.service.ts` (lines 44-47).

- [x] T036 [P] Fix `### CURRENT LOCAL TIME###` missing space in `backend/config/ai-config.json` — add space before closing `###` in both guestCoordinator and screeningAI templates.

- [ ] T037 [P] Extract escalation validation into shared helper in `backend/src/services/ai.service.ts` — create `validateEscalation(parsed)` function, call from both text branch (~line 1515) and image branch (~line 1633).

- [x] T038 [P] Reduce `WEBHOOK_DELIVERY_BUFFER_MS` from 30 minutes to 10 minutes in `backend/src/services/ai.service.ts` (line ~1172).

- [ ] T042 [P] Replace fragile `injectImageHandling` string.replace with template variable in `backend/src/services/ai.service.ts` (lines ~305-329) and `backend/config/ai-config.json` — add `{IMAGE_HANDLING}` placeholder to the system prompt template instead of relying on exact `'---\n\n## OUTPUT FORMAT'` pattern match. (FR-010)

- [ ] T043 [P] Fix DST transition in `nextWorkingHoursStart` in `backend/src/services/debounce.service.ts` (lines ~83-98) — replace `+ 24 * 60 * 60 * 1000` with timezone-aware date arithmetic. Also fix `getTodayMidnightInTimezone` (lines ~39-65) to use `Intl.DateTimeFormat` with explicit parts extraction instead of locale string parsing.

- [ ] T044 [P] Add global debounce to `reinitializeClassifier()` in `backend/src/services/classifier.service.ts` — coalesce calls within a 60-second window to prevent 50+ re-embeddings/hour under multi-tenant load. Track last reinit timestamp and skip if within the window.

- [ ] T039 Run `npx tsc --noEmit` in backend to verify zero TypeScript errors after all changes.

- [ ] T040 Run `next build` in frontend to verify zero build errors after all changes.

- [ ] T041 Update `AI_SYSTEM_FLOW-v7.md` — document all changes: centroid-primary topic switch, escalation signal injection, host reply cancellation, cross-tier dedup, and updated thresholds.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Foundational)**: No dependencies — start immediately. BLOCKS all other phases.
- **Phase 2 (US1 — Dedup)**: Depends on T003 (classifier result return)
- **Phase 3 (US2 — Topic Switch)**: Depends on T003
- **Phase 4 (US3 — SOP Context)**: Independent — can run in parallel with US1/US2
- **Phase 5 (US4 — Pipeline Display)**: Depends on T010/T011 (centroid data in feed)
- **Phase 6 (US5 — Logs)**: Independent
- **Phase 7 (Webhook fixes)**: Independent — can run in parallel with all US phases
- **Phase 8 (Polish)**: Depends on all prior phases

### Parallel Opportunities

```
Phase 1: T001 → T002 → T003 (sequential — schema then code)

Phase 2: T004 → T005 ‖ T006 (dedup first, then parallel)

Phase 3: T007 → T008 → T009, T010 ‖ T011 ‖ T012 (core logic sequential, data flow parallel)

Phase 4: T013, T014 ‖ T015 (all parallel — different files)

Phase 5: T016 ‖ T017 ‖ T018 ‖ T019 ‖ T020 (all parallel — different files/sections)

Phase 6: T021 (single task)

Phase 7: T022 ‖ T023 ‖ T024 ‖ T025 ‖ T026 ‖ T027 ‖ T028 ‖ T029 ‖ T030
          (all parallel — different files)

Phase 8: All tasks parallel (different files)
```

---

## Implementation Strategy

### MVP First (Phase 1 + Phase 2)

1. Complete T001-T003 (schema + thread safety)
2. Complete T004-T006 (cross-tier dedup + message dedup + Tier 2 flag)
3. **STOP and VALIDATE**: Zero duplicate SOPs in pipeline display
4. Deploy — immediate quality improvement

### Incremental Delivery

1. Phase 1 + Phase 2 → deploy (dedup fixes)
2. Phase 3 → deploy (topic switch improvement)
3. Phase 4 + Phase 7 → deploy (SOP context + webhook fixes)
4. Phase 5 + Phase 6 → deploy (display + logging)
5. Phase 8 → deploy (cleanup)

Each phase adds value independently. Phase 7 (webhook fixes) is highest-impact for reliability and can be parallelized with any user story phase.

---

## Notes

- Total: 44 tasks across 8 phases (T001-T044)
- 68 audit findings covered (2 already fixed, 18 LOW deferred to Phase 8, 48 explicitly addressed)
- Schema migration requires pre-migration cleanup (T001 before T002)
- Phase 7 contains the most parallelizable tasks (9 independent fixes)
- Run implementation checklist (`checklists/implementation.md`) after each phase
- Run operator checklist (`checklists/operator.md`) after deployment
- Run AI quality checklist (`checklists/ai-response-quality.md`) after full deployment
