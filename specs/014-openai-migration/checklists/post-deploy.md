# Post-Deploy Acceptance: OpenAI GPT-5.4 Mini Migration

**Purpose**: Validate the deployed system meets spec requirements after migration.
**Created**: 2026-03-22
**Actor**: User + Claude
**Timing**: After deploy to advanced-ai-v7

## Core Pipeline Quality

- [ ] CHK027 - Does the spec define how to validate that all 22 SOP categories still classify correctly after model change? [Measurability, Spec §SC-001]
- [ ] CHK028 - Are the "representative test messages" for SC-001 documented or left to ad-hoc testing? [Completeness, Gap]
- [ ] CHK029 - Is the 50+ message sample for quality comparison (SC-006) defined — which messages, from which conversations? [Clarity, Spec §SC-006]
- [ ] CHK030 - Are multilingual accuracy test scenarios specified (Arabic, English at minimum)? [Coverage, Spec §US1 scenario 2]

## Cost & Caching Acceptance

- [ ] CHK031 - Is the method for measuring per-message cost defined (which logs, which calculation)? [Measurability, Spec §SC-002]
- [ ] CHK032 - Is the baseline "previous model cost" documented for the 50% reduction comparison? [Clarity, Spec §SC-002]
- [ ] CHK033 - Is the method for measuring cache hit rate defined (API headers, logs, or dashboard)? [Measurability, Spec §SC-004]
- [ ] CHK034 - Are cache warmup expectations defined — how many messages before 80% hit rate? [Clarity, Spec §SC-004]
- [ ] CHK035 - Is the reasoning token usage verifiable — can operators see which messages used reasoning? [Measurability, Spec §SC-007]

## Model Selection & Configuration

- [ ] CHK036 - Are the specific model tier options defined with exact model strings for the Configure AI dropdown? [Completeness, Spec §FR-013]
- [ ] CHK037 - Is the estimated per-message cost for each tier documented for display in the UI? [Completeness, Spec §US4]
- [ ] CHK038 - Is the behavior defined when a tenant switches model tier mid-conversation? [Edge Case, Gap]

## Observability Acceptance

- [ ] CHK039 - Are the specific fields that must appear in the pipeline log defined (model, tokens, cached, reasoning, cost)? [Completeness, Spec §FR-015]
- [ ] CHK040 - Is the cost calculation accuracy requirement (within 5%) testable from logged data? [Measurability, Spec §SC-009]
- [ ] CHK041 - Is the Langfuse integration expected to work unchanged or does it need updating? [Coverage, Gap]

## SDK Removal Verification

- [ ] CHK042 - Is there a defined method to verify no Anthropic SDK code remains (grep, build check)? [Measurability, Spec §SC-010]
- [ ] CHK043 - Is the ANTHROPIC_API_KEY env var removal verified — server starts without it? [Coverage, Gap]
- [ ] CHK044 - Is the OPUS tab removal from the frontend verified? [Coverage, Spec §FR-016]

## Notes

- This checklist is for live verification after deployment
- Cost/caching items (CHK031-035) require collecting data over several hours of real traffic
- Items marked [Gap] may require spec updates before they can be verified
