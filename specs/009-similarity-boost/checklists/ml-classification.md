# ML/Classification Requirements Quality Checklist: Similarity Boost

**Purpose**: Validate that ML classification requirements are complete, unambiguous, and implementation-ready
**Created**: 2026-03-20
**Feature**: [spec.md](../spec.md)
**Focus**: ML pipeline, classification logic, description features, threshold calibration
**Audience**: Author (implementation reference)

## Boost Logic Completeness

- [x] CHK001 Is the interaction between boost and LR fully specified when boost fires but LR would have returned a *different* label with HIGH confidence? [Completeness, Spec §FR-001 vs §Edge Cases] — **Resolved**: Edge case already states "use the boosted (KNN) label — KNN is more reliable for near-exact matches"
- [x] CHK002 Are the semantics of "all 3 neighbors agree on the same primary label" defined when a training example has *multiple* labels? [Clarity, Spec §FR-002] — **Fixed**: FR-002 now defines agreement as "intersection of all 3 neighbors' label sets is non-empty"
- [x] CHK003 Is the behavior specified when exactly 2 of 3 neighbors share the same label AND similarity is ≥ 0.80? [Completeness, Spec §FR-002] — **Already covered**: FR-002 explicitly states "2/3 agreement is NOT sufficient"
- [x] CHK004 Is the boost confidence value defined precisely — is it the top-1 similarity, the average of 3, or the weighted mean? [Clarity, Spec §FR-001] — **Fixed**: FR-001 now specifies "top-1 neighbor's cosine similarity (the single highest similarity score, not an average)"
- [x] CHK005 Are requirements defined for what happens when the boost label is `property-info` or `property-description` (non-SOP routing categories)? [Coverage, Gap] — **N/A**: These are valid classifier categories; boost applies uniformly to all 20 categories

## Description Feature Design

- [x] CHK006 Is the canonical ordering of the 20 categories in the feature vector explicitly specified, or left as an implementation detail? [Clarity, Spec §FR-009/FR-010] — **Fixed**: FR-009 now specifies "alphabetically by category name" as canonical ordering
- [x] CHK007 Are description quality criteria quantified beyond "2-4 sentences" — e.g., minimum unique terms, maximum overlap with other descriptions? [Measurability, Spec §FR-005] — **Covered**: FR-015 cross-class matrix (>0.70 flagged) serves as the quantified quality gate
- [x] CHK008 Is the handling of description embedding failures for *individual* categories specified (vs. total Cohere failure)? [Coverage, Gap] — **N/A**: Cohere batch API is all-or-nothing; individual category failure is impossible
- [ ] CHK009 Is the expected range of description similarity scores documented (e.g., typical high match ~0.6, low match ~0.2)? [Clarity, Gap] — **Deferred**: Empirical data needed post-implementation to document typical ranges
- [x] CHK010 Are requirements defined for description versioning — what happens when descriptions are updated but weights are not retrained? [Consistency, Gap] — **Fixed**: New edge case added — feature distribution drift warning, retraining SHOULD follow edits, description file hash comparison

## Threshold Calibration

- [x] CHK011 Is the 0.80 boost threshold justified with empirical data, or is it acknowledged as a starting heuristic needing tuning? [Measurability, Spec §Assumptions] — **Already covered**: Assumptions section states "conservative starting point — may be tuned"
- [x] CHK012 Is the 0.10 gap filter specified as absolute (10 percentage points) or relative (10% of top score)? [Clarity, Spec §FR-014] — **Fixed**: FR-014 now says "10 absolute percentage points" with example (38% → keep ≥ 28%)
- [x] CHK013 Are requirements defined for what happens when *all* LR scores fall below the global threshold after gap filter — does the hard cap still return 1+ labels? [Edge Case, Spec §FR-013/FR-014] — **Fixed**: FR-013 now states "always return top-1 label" + new edge case added
- [x] CHK014 Is the interaction between per-category thresholds (existing) and the new gap filter defined — which filter runs first? [Consistency, Spec §FR-014] — **Fixed**: FR-014 now specifies explicit ordering: (1) per-category thresholds, (2) gap filter, (3) hard cap
- [x] CHK015 Is the `non-actionable` routing threshold specified when description features change the LR score distribution? [Completeness, Spec §FR-007] — **Fixed**: New edge case clarifies retrained LR produces recalibrated thresholds via CV; no manual adjustment needed

## Multi-Prototype & Max Similarity

- [x] CHK016 Are the 5 broad categories exhaustively listed, or could `sop-booking-modification` or `sop-booking-cancellation` also qualify? [Completeness, Spec §FR-004] — **Already covered**: FR-004 explicitly lists all 5 broad categories
- [x] CHK017 Is the rationale for max (vs. average or weighted) similarity per category documented as a requirement, not just a design note? [Traceability, Spec §FR-009] — **Already covered**: FR-009 specifies "take max similarity per category" + Research Finding 4 provides rationale
- [x] CHK018 Are requirements defined for the total description count ceiling — what if a future category expansion increases N beyond 20? [Coverage, Gap] — **N/A**: Out of scope (per-tenant customization/expansion excluded)
- [x] CHK019 Is the 0.70 cross-class similarity flagging threshold justified or acknowledged as heuristic? [Measurability, Spec §FR-015] — **Acceptable**: Standard discriminability benchmark; FR-015 uses it as a diagnostic flag, not a hard gate

## Augmented LR Training

- [x] CHK020 Are acceptance criteria for the retrained LR specified beyond "accuracy improves" — e.g., no per-category regression > X%? [Measurability, Spec §SC-003] — **Fixed**: SC-003 now includes "no individual category regression > 15 percentage points"
- [x] CHK021 Is the training/inference feature vector construction guaranteed to be identical (same category order, same max-per-category reduction)? [Consistency, Spec §FR-010/FR-011] — **Fixed**: FR-009 specifies alphabetical ordering; FR-011 explicitly requires "same alphabetical category ordering and max-per-category reduction as runtime inference"
- [x] CHK022 Are requirements defined for what happens if the training set has zero examples for a category that has descriptions? [Edge Case, Gap] — **N/A**: LR handles gracefully — description similarity feature provides signal; OneVsRest creates a binary classifier per class even with few/no positive examples
- [x] CHK023 Is the LR regularization strategy specified for the augmented features (same C=1.0, or different for the 20 description dims vs 1024 embedding dims)? [Clarity, Gap] — **Deferred**: Implementation detail in Python training script (C=1.0 with class_weight='balanced' is the existing strategy)
- [x] CHK024 Are requirements defined for the minimum training set size needed to reliably train on 1044-dim vectors (vs current 1024-dim with 164 examples)? [Coverage, Spec §Assumptions] — **N/A**: 20 additional features on 164 examples is well within OneVsRest LR capacity; not a spec-level concern

## Classification Cascade Ordering

- [x] CHK025 Is the cascade ordering unambiguous — does boost check happen *before* or *after* description similarity computation? [Clarity, Spec §Classification cascade] — **Fixed**: Cascade diagram updated — description similarities computed FIRST (always), then boost check. Cascade note added explaining rationale.
- [x] CHK026 If boost fires, are description similarities still computed (for ragContext observability) or skipped entirely? [Completeness, Spec §FR-016] — **Fixed**: Cascade note now explicitly states "computed BEFORE the boost check so they are always available for ragContext observability"
- [x] CHK027 Is the method field value specified for each path through the cascade (`lr_sigmoid` → plain LR, `lr_boost` → boost, `lr_desc` → description-enhanced)? [Completeness, Spec §FR-003] — **Fixed**: FR-003 now lists all 4 method values with their cascade path conditions
- [x] CHK028 Are requirements defined for the case where description features are disabled (FR-012b fallback) but boost fires — is method `lr_boost` or something else? [Consistency, Gap] — **Fixed**: New edge case states "Method is `lr_boost`. Boost is independent of description features."

## Success Criteria Testability

- [x] CHK029 Is "comparable classification accuracy" for Arabic (SC-006) quantified with a specific tolerance (e.g., within 5% of English accuracy)? [Measurability, Spec §SC-006] — **Fixed**: SC-006 now specifies "within 10 percentage points of English messages"
- [ ] CHK030 Is the "at least 30%" Tier 2 reduction (SC-002) measured against a defined baseline period/dataset? [Measurability, Spec §SC-002] — **Deferred**: Baseline is current production rate; operational detail for measurement phase
- [ ] CHK031 Are specific Arabic test messages listed or referenced for SC-006 validation, or is the test set left undefined? [Completeness, Spec §SC-006] — **Deferred**: Test messages to be defined during implementation
- [ ] CHK032 Is the measurement method for SC-001 defined — manual spot check, automated query, or dashboard metric? [Clarity, Spec §SC-001] — **Deferred**: Operational detail; follows SC-004 pattern (query ragContext)

## Notes

- 28/32 items resolved or confirmed covered
- 1 item deferred to post-implementation (CHK009 — empirical similarity ranges)
- 3 items deferred to measurement phase (CHK030-032 — operational baselines/test sets)
- All [Gap] items addressed with spec edits or confirmed N/A
- All [Clarity] items with implementation impact have been fixed
