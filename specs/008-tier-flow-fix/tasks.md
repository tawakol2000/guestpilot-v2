# Tasks: Tier Flow Redesign — Tier 2 Always Fires, Full Pipeline Visibility

**Context**: Designed interactively — Tier 2 is blocked when Tier 3 re-injects, centroid fails silently, pipeline display shows blank sections. Redesigned flow: Tier 2 fires for all non-HIGH messages, Tier 3 is a backup, every tier shows scores.

## New Flow

```
Tier 1 (LR) — ALWAYS runs, ALWAYS displayed
    ↓
Tier 3 (Centroid) — ALWAYS runs if cache exists, ALWAYS displayed with score
    ├── Same topic → re-inject as BACKUP (available but Tier 2 takes priority)
    └── Topic switch → clear cache
    ↓
Tier 2 (Intent Extractor) — fires if Tier 1 NOT HIGH (≥0.85)
    ↓
Final: Tier 2 result > Tier 3 backup > Tier 1 labels
```

---

## Phase 1: Backend — Tier 2 Fires for MEDIUM + LOW

- [ ] T001 In `backend/src/services/ai.service.ts` — change the Tier 2 gate condition at line ~1353 from:
  ```
  if (ragResult.tier === 'tier2_needed' && !tier3Reinjected && !ragResult.intentExtractorRan)
  ```
  To:
  ```
  if (ragResult.confidenceTier !== 'high' && !ragResult.intentExtractorRan)
  ```
  This removes the `!tier3Reinjected` block — Tier 2 now fires even after Tier 3 re-injection. Also fires for MEDIUM (previously only LOW triggered Tier 2 in ai.service.ts).

- [ ] T002 In `backend/src/services/ai.service.ts` — when Tier 2 fires AND Tier 3 already re-injected, Tier 2 results REPLACE the Tier 3 re-injection (not append). Clear the Tier 3 chunks from `retrievedChunks` before adding Tier 2 chunks. If Tier 2 returns empty, KEEP the Tier 3 re-injection as fallback.

---

## Phase 2: Backend — Tier 3 Centroid Always Runs + Displays

- [ ] T003 In `backend/src/services/ai.service.ts` — run centroid/topic check ALWAYS when topic cache exists, not only when `ragResult.tier !== 'tier1'`. Move the Tier 3 block (lines ~1318-1348) to run BEFORE the tier gate check. The centroid check provides observability even when Tier 1 is confident — it detects if the topic changed even though Tier 1 classified the new message correctly.

- [ ] T004 In `backend/src/services/ai.service.ts` — store Tier 3 results (centroidSimilarity, centroidThreshold, switchMethod, reinjected, reinjectedLabels) in ragContext for EVERY message where topic cache exists — not just when re-injection happens. This ensures the pipeline display always shows Tier 3 data.

---

## Phase 3: Backend — Tier 1 Always Displayed

- [ ] T005 In `backend/src/services/ai.service.ts` — when Tier 3 fires and sets `ragResult.tier = 'tier3_cache'`, preserve the ORIGINAL Tier 1 data in ragContext. Currently the tier overwrite hides the Tier 1 classification. Add `ragContext.originalTier = originalTier` and `ragContext.originalConfidenceTier = originalConfidenceTier` BEFORE the Tier 3 overwrite.

- [ ] T006 [P] In `backend/src/routes/ai-pipeline.ts` — pass `originalTier` and `originalConfidenceTier` to the pipeline feed so the frontend can show Tier 1 scores even on cache hits.

---

## Phase 4: Frontend — Full Pipeline Visibility

- [ ] T007 [P] In `frontend/components/ai-pipeline-v5.tsx` — Tier 1 section: when `classifierConfidence` is null but `originalConfidenceTier` exists (Tier 3 cache hit), show the original Tier 1 data with a note "(overridden by Tier 3 cache)". Never show blank Tier 1.

- [ ] T008 [P] In `frontend/components/ai-pipeline-v5.tsx` — Tier 3 section: ALWAYS show centroid similarity score when available, not just on topic switch. Show:
  - Cache exists + centroid ran: `centroid: 0.78 > 0.60 → same topic (re-injected as backup)`
  - Cache exists + switch: `centroid: 0.35 < 0.60 → topic switch detected`
  - Cache exists + no centroid (fallback): `centroid: unavailable (keyword fallback)`
  - No cache: `-- No topic cache`

---

## Phase 5: Judge — Remove KNN Fallback

- [ ] T009 In `backend/src/services/judge.service.ts` — remove the KNN fallback from effectiveConfidence. Change from:
  ```
  const effectiveConfidence = input.confidence ?? input.classifierTopSim;
  ```
  To:
  ```
  const effectiveConfidence = input.confidence ?? 0;
  ```
  When LR confidence is null (screening agent, classifier didn't run), treat as 0 (lowest confidence) so the judge EVALUATES instead of skipping. Also remove any remaining references to `classifierTopSim` in skip conditions — KNN is gone.

- [ ] T010 In `backend/src/services/ai.service.ts` — stop passing `classifierTopSim` to the judge. In the `evaluateAndImprove()` call (~line 1880), remove `classifierTopSim` field or set it to `classifierSnap?.confidence ?? 0` (use LR confidence, not KNN sim).

---

## Phase 6: Verification

- [ ] T011 Run `npx tsc --noEmit` in `backend/` — zero TypeScript errors.

- [ ] T012 Run `next build` in `frontend/` — zero build errors.

- [ ] T013 Pull latest 5 pipeline logs from database and verify:
  - Tier 1 shows LR confidence + labels for ALL messages (no blank)
  - Tier 3 shows centroid score when cache exists
  - Tier 2 fires for MEDIUM and LOW confidence (not blocked by Tier 3)

---

## Dependencies

```
T001 → T002 (Tier 2 gate then replacement logic)
T003 → T004 (Tier 3 always-run then store results)
T005 → T006 (preserve original tier then pass to feed)
T007 ‖ T008 (parallel — different sections)
T009 → T010 → T011 (sequential verification)
```

## Notes

- Total: 11 tasks
- 3 backend files: ai.service.ts, ai-pipeline.ts
- 1 frontend file: ai-pipeline-v5.tsx
- No schema changes, no new services
- Key principle: Tier 2 is the tiebreaker. Tier 3 is backup. Tier 1 scores always visible.
