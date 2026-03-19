# AI/ML Pipeline Requirements Quality Checklist: AI Pipeline Overhaul

**Purpose**: Validate that classifier, judge, self-improvement, and training data requirements are complete, unambiguous, and implementable — usable both pre-implementation (author gate) and during PR review.
**Created**: 2026-03-19
**Feature**: [spec.md](../spec.md)

## Classifier Requirements Completeness

- [ ] CHK001 Are minimum training example counts per category explicitly defined, or only flagged as "fewer than 10"? [Clarity, Spec §US2]
- [ ] CHK002 Is the behavior when Tier 1 returns empty labels fully specified — does the pipeline skip RAG entirely, fall through to Tier 2, or inject baked-in SOPs only? [Completeness, Spec §US2]
- [ ] CHK003 Are requirements defined for how the classifier handles multi-label messages (guest asks about cleaning AND amenities in one message)? [Gap]
- [ ] CHK004 Is the expected classifier behavior for non-English/non-Arabic languages specified (e.g., French, Turkish guests)? [Gap, Spec §FR-013]
- [ ] CHK005 Are requirements defined for what happens when the classifier is reinitialized mid-request (e.g., a gap-analysis approval triggers reinit while a classification is in flight)? [Edge Case]
- [ ] CHK006 Is the minimum acceptable similarity score for a "match" explicitly defined, or only implied by the vote threshold (0.30) and neighbor agreement (2/3)? [Clarity, Spec §US4]

## Judge & Self-Improvement Requirements Clarity

- [ ] CHK007 Is the "evaluate all" judge mode behavior precisely defined — does it skip contextual messages too, or truly evaluate every single AI response? [Ambiguity, Spec §FR-004]
- [ ] CHK008 Is the "30% sampling" rate in sampling mode a hard requirement or a target? Is it random per-message or per-conversation? [Clarity, Spec §FR-004]
- [ ] CHK009 Are requirements defined for what the judge does when it disagrees with a Tier 2 label that was already used for the AI response? (The response is already sent — does it still correct the training data?) [Gap, Spec §US3]
- [ ] CHK010 Is the auto-fix rate limit (currently 10/hour) still appropriate when judge mode is "evaluate all"? Are rate limit requirements updated for the new mode? [Consistency, Spec §US3]
- [ ] CHK011 Are requirements specified for how the judge handles messages in languages it may not understand well (Arabic, other languages)? [Gap, Spec §FR-013]
- [ ] CHK012 Is the skip-reason logging requirement specific about WHERE skip reasons are stored — in ClassifierEvaluation (existing table) or a new log? [Clarity, Spec §FR-005]

## Training Data & Gap Analysis Requirements

- [ ] CHK013 Is the gap analysis "underrepresented language" detection method specified — Unicode range heuristic, language detection library, or manual tagging? [Clarity, Spec §FR-002]
- [ ] CHK014 Are requirements defined for the maximum number of suggested examples a single gap-analysis run can generate? [Gap]
- [ ] CHK015 Is the validation threshold (similarity > 0.35) for gap-analysis examples documented as configurable or hardcoded? [Clarity, Spec §FR-003]
- [ ] CHK016 Are requirements specified for what happens when the intent extractor (used for labeling gap-fill examples) returns empty or ambiguous labels? [Edge Case, Spec §US2]
- [ ] CHK017 Is the "60% Arabic" language distribution target a hard requirement for gap-fill output, or a guideline? How is compliance measured? [Measurability, Spec §FR-013]
- [ ] CHK018 Are requirements defined for preventing the gap analysis from generating examples that duplicate existing hardcoded training data? [Gap]

## Threshold Tuning Requirements

- [ ] CHK019 Are all four tunable thresholds (vote: 0.30, contextual gate: 0.85, judge: 0.75, auto-fix: 0.70) listed with their current values AND the range of valid values? [Completeness, Spec §US4]
- [ ] CHK020 Is the batch-classify tool's accuracy calculation method specified — per-label accuracy, per-message accuracy, or both? [Clarity, Spec §FR-006]
- [ ] CHK021 Are requirements defined for how threshold changes interact with the existing training data? (Lowering vote threshold may surface previously-suppressed labels) [Gap, Spec §US4]
- [ ] CHK022 Is the contextual category rebalancing approach specified — reduce examples, adjust gate threshold, or both? [Ambiguity, Spec §US4 acceptance scenario 2]

## Self-Improvement Loop Consistency

- [ ] CHK023 Do the judge mode requirements (FR-004) align with the existing auto-fix threshold (0.70) and rate limit (10/hour) documented in the constitution? [Consistency, Constitution §VII]
- [ ] CHK024 Are the training example sources (manual, llm-judge, tier2-feedback, gap-analysis, low-sim-reinforce, operator-correction) consistently named across spec, data-model, and contracts? [Consistency]
- [ ] CHK025 Is the priority order between example sources defined — does an operator-correction override an llm-judge example for the same message? [Gap, Spec §FR-010]
- [ ] CHK026 Do the success criteria (SC-001: 80% accuracy, SC-003: 550 examples) have defined measurement periods and baselines that are consistent with each other? [Consistency, Spec §SC]

## Pipeline Snapshot Requirements

- [ ] CHK027 Is the snapshot format (markdown sections, metrics included) specified precisely enough for an AI session to parse it programmatically? [Clarity, Spec §FR-007]
- [ ] CHK028 Are requirements defined for snapshot generation failure — what happens if the DB query times out mid-snapshot? [Edge Case, Spec §Edge Cases]
- [ ] CHK029 Is the "plain-English health summary" in the snapshot generated by AI (LLM call) or computed from rules? Cost implications differ significantly. [Ambiguity, Spec §FR-007]

## Acceptance Criteria Measurability

- [ ] CHK030 Can SC-001 (44% → 80% accuracy) be measured with the current 9 total evaluations, or does the spec need to define a minimum evaluation count for statistical significance? [Measurability, Spec §SC-001]
- [ ] CHK031 Is SC-002 (empty-label rate < 10%) measured against all classifications or only judge-evaluated ones? [Ambiguity, Spec §SC-002]
- [ ] CHK032 Is SC-004 (judge evaluates 30%) measured when judge mode is "evaluate all" (would be 100%) or only after switching to "sampling"? [Ambiguity, Spec §SC-004]
- [ ] CHK033 Is SC-003 (550 examples in 30 days) achievable given that gap-fill is one-time and self-improvement generates ~5/week? (5/week × 4 weeks = 20 + 454 = 474, short of 550) [Measurability, Spec §SC-003]

## Multi-Tenant & Scaling Considerations

- [ ] CHK034 Are requirements defined for whether gap-analysis runs per-tenant or globally? [Gap, Spec §FR-014]
- [ ] CHK035 Is the classifier reinitalization scope specified — does approving one tenant's example reinitialize for all tenants or just that tenant? [Ambiguity]
- [ ] CHK036 Are requirements defined for how the snapshot handles multi-tenant data — per-tenant snapshot or system-wide? [Gap, Spec §FR-007]

## Notes

- Focus: AI/ML pipeline requirements (classifier, judge, self-improvement, training data)
- Depth: Standard
- Audience: Author (pre-implementation gate) + PR reviewer
- This checklist tests whether the REQUIREMENTS are well-written, not whether the implementation works
- Items with [Gap] indicate requirements that may need to be added to the spec
- Items with [Ambiguity] indicate requirements that need clarification
- Items with [Consistency] flag potential conflicts between spec sections
