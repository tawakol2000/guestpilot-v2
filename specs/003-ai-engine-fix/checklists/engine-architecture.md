# Engine Architecture Requirements Quality Checklist: AI Engine Fix

**Purpose**: Validate that the LR classifier, three-tier routing, topic switch, deployment strategy, and DB compatibility requirements are complete, unambiguous, and implementable.
**Created**: 2026-03-19
**Feature**: [spec.md](../spec.md)

## Classifier Requirements Completeness

- [x] CHK001 Is the LR training data source precisely defined — hardcoded examples only, DB examples only, or both merged? [Completeness, Spec §FR-001] — **Resolved**: T003 fetches "all active ClassifierExample + hardcoded TRAINING_EXAMPLES"
- [x] CHK002 Are requirements defined for what happens on first startup when no classifier-weights.json exists yet? [Gap, Spec §FR-001] — **Resolved**: Clarification: classifier refuses to process messages until retrain is run
- [x] CHK003 Is the LR softmax temperature parameter specified? [Clarity, Spec §FR-001] — **Resolved**: Using sklearn defaults (OneVsRest + LogisticRegression defaults). Sigmoid, not softmax.
- [x] CHK004 Are requirements defined for multi-label classification? [Gap] — **Resolved**: Clarification: OneVsRestClassifier for multi-label, all labels above per-label threshold returned
- [x] CHK005 Is the format of the LR weights JSON file specified with enough detail? [Completeness, Spec §data-model] — **Resolved**: data-model.md has full JSON schema with shapes

## Three-Tier Routing Requirements Clarity

- [x] CHK006 Are the three confidence thresholds documented as defaults with configurable range? [Clarity, Spec §FR-004] — **Resolved**: T012 adds configurable fields, T015 adds sliders with ranges
- [ ] CHK007 Is the medium tier prompt instruction precisely specified? [Clarity, Spec §US2] — **Deferred to implementation**: Exact prompt text is an implementation detail. T013 has the concept.
- [ ] CHK008 Is "top 3 candidate SOPs" defined — minimum confidence for candidates? [Ambiguity, Spec §FR-004] — **Deferred to implementation**: Take top 3 by sigmoid score regardless of absolute value. Can tune later.
- [x] CHK009 When intent extractor also returns no labels, is there a final fallback? [Gap, Spec §US2] — **Resolved**: Clarification: baked-in SOPs only + auto-escalation (info_request)
- [x] CHK010 What constitutes an "override" in medium tier? [Ambiguity, Spec §FR-004a] — **Resolved**: T014 specifies: override = LLM picks different category than classifier's top pick

## Topic Switch & Cache Requirements

- [x] CHK011 Is centroid-based switch threshold relative to calibration? [Consistency, Spec §FR-006] — **Resolved**: Per-topic thresholds computed during calibration (mean - 2*std)
- [x] CHK012 How does centroid switch interact with multi-slot cache? [Gap, Spec §US5+US6] — **Resolved**: T026 specifies: check ALL 3 slots, closest wins (return vs switch)
- [ ] CHK013 Is the confidence decay formula + boost quantified? [Clarity, Spec §FR-007] — **Deferred to implementation**: T025 has formula: `confidence * exp(-timeDelta / halfLifeMs)`. Boost amount left to implementation.
- [ ] CHK014 Does cache clear on classifier retrain? [Gap] — **Deferred to implementation**: Reasonable default = no (cache reflects conversation state, not classifier state). Can be decided during implementation.

## Deployment & DB Compatibility Requirements

- [x] CHK015 Is Railway service creation process specified? [Gap, Spec §FR-015] — **Resolved**: T032 specifies: manual creation in Railway dashboard
- [x] CHK016 Which env vars does the new service need? [Gap, Spec §FR-015] — **Resolved**: T033 specifies: copy all from backend-advanced-ai
- [x] CHK017 Is webhook migration process specified? [Gap, Spec §FR-015] — **Resolved**: T036 specifies: manual in Hostaway dashboard
- [x] CHK018 Can both services' judges conflict on same conversation? [Gap, Spec §FR-017] — **Resolved**: Clarification: no conflict — each tenant's webhooks point to ONE service
- [ ] CHK019 Is merge-back process defined? [Gap, Spec §FR-015] — **Deferred**: Merge happens when operator is satisfied with accuracy. Process = standard git merge + repoint webhooks + delete old service. Documented in spec assumptions.

## Calibration & Training Requirements

- [x] CHK020 Is leave-one-out CV computationally feasible? [Measurability, Spec §US3] — **Resolved**: Clarification: embed once, cache, reuse across folds. ~5s of sklearn math, no extra Cohere calls.
- [x] CHK021 How often does calibration re-run? [Gap, Spec §FR-003] — **Resolved**: On every retrain (calibration is part of the training script)
- [ ] CHK022 Is Python script error handling specified? [Gap, Spec §FR-012] — **Partially resolved**: Edge cases specify "Python crash → old weights remain." Detailed error handling (rate limits, convergence) left to implementation.
- [x] CHK023 Does rebalancing happen during retrain or separately? [Gap, Spec §FR-005] — **Resolved**: Rebalancing is a separate manual step (T018-T019). Retrain uses whatever examples exist.

## Frontend Auto-Adapt Requirements

- [x] CHK024 Are all differing UI elements listed? [Completeness, Spec §FR-016] — **Resolved**: contracts/api.md lists all differing fields. T029-T031 specify each UI change.
- [x] CHK025 Is pipeline feed format documented for both engines? [Completeness] — **Resolved**: contracts/api.md has both formats
- [x] CHK026 What does frontend show during transition (mixed entries)? [Gap] — **Resolved**: Frontend checks per-entry fields (if `classifierConfidence` exists → LR, else → KNN)

## Acceptance Criteria Measurability

- [x] CHK027 Can SC-001 be measured on new service independently? [Measurability] — **Resolved**: Yes — accuracy endpoint is per-tenant, new service serves test tenant
- [ ] CHK028 Is SC-002 achievable given circular judge validation? [Assumption] — **Acknowledged risk**: Judge is an LLM judging an LLM. Operator ratings (002-spec) provide human ground truth. Acceptable for now.
- [ ] CHK029 Is SC-003 testable with current data volume? [Measurability] — **Acknowledged**: Small sample size. Will grow as traffic increases. Can manually test topic switch scenarios.
- [ ] CHK030 Is SC-007 measurable per-language? [Gap] — **Deferred**: Per-language accuracy requires language detection on evaluations. Can be added to the accuracy endpoint later.

## Notes

- 22/30 items resolved via clarifications, analyze remediation, and task specifications
- 4 items deferred to implementation (prompt text, candidate minimum, decay boost, cache-on-retrain)
- 4 items acknowledged as acceptable risks or future enhancements
- No blocking gaps remain — all critical architecture decisions are made
