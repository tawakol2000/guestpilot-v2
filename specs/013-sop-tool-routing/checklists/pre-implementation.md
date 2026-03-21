# Pre-Implementation Requirements Quality: SOP Tool Routing

**Purpose**: Validate that spec, plan, and research are complete and unambiguous enough for implementation. For Claude to check before coding.
**Created**: 2026-03-21
**Actor**: Claude (implementer)
**Timing**: Before `/speckit.implement`

## Requirement Completeness

- [X] CHK001 - Is the complete list of 20 SOP enum values documented with their exact string identifiers? [Completeness, Spec §FR-002]
- [X] CHK002 - Are lean descriptions specified for all 22 enum values (20 SOPs + none + escalate) including negative boundaries? [Completeness, Spec §FR-015]
- [X] CHK003 - Is the SOP content for all 20 categories available in the codebase with exact retrieval paths? [Completeness, Research §Decision 7]
- [X] CHK004 - Are the 3-5 tool-level `input_examples` defined for the hardest disambiguation cases? [Completeness, Research §Decision 5]
- [X] CHK005 - Is every file to DELETE explicitly listed with its path and line count? [Completeness, Research §Decision 10]
- [X] CHK006 - Is every file to MODIFY listed with specific changes described? [Completeness, Plan §Project Structure]
- [X] CHK007 - Are all import references to deleted services catalogued for cleanup? [Completeness, Research §Decision 11]

## Requirement Clarity

- [X] CHK008 - Is the two-call flow precisely defined — what tools/tool_choice on each call? [Clarity, Research §Decision 6]
- [X] CHK009 - Is the tool_result content for `none` classifications explicitly specified (empty string, JSON, or skip)? [Clarity, Quickstart §Scenario 3]
- [X] CHK010 - Is the tool_result content for `escalate` classifications specified — does it include SOP content or just trigger task creation? [Clarity, Quickstart §Scenario 4]
- [X] CHK011 - Is the graceful degradation behavior for SOP retrieval failure specified with exact tool_result content? [Clarity, Spec §FR-018]
- [X] CHK012 - Is the `get_sop` tool `description` field text specified (not just the enum descriptions)? [Clarity, Research §Decision 1]
- [X] CHK013 - Is the behavior when `confidence: "low"` clearly defined — log only, or also escalate? [Ambiguity, Spec §US1 scenario 4]

## Requirement Consistency

- [X] CHK014 - Are the SOP category names consistent between the enum definition, SOP_CONTENT keys, and ragContext logging? [Consistency, Data Model §SOP Category Enum]
- [X] CHK015 - Do the ragContext field changes in data-model.md align with what ai.service.ts will actually log? [Consistency, Data Model vs Research §Decision 12]
- [X] CHK016 - Are the removed endpoints in contracts/api-changes.md consistent with the routes listed for modification in the plan? [Consistency, Contracts vs Plan]
- [X] CHK017 - Is the monitoring endpoint response shape consistent between contracts/api-changes.md and what the frontend sop-monitor component will consume? [Consistency, Contracts §GET /api/knowledge/sop-classifications]

## Scenario Coverage

- [X] CHK018 - Are requirements defined for how the sandbox endpoint adopts the new tool-based flow? [Coverage, Spec §Edge Cases]
- [X] CHK019 - Are requirements defined for what happens when the same message triggers both `escalate` AND another SOP category? [Coverage, Edge Case, Gap]
- [X] CHK020 - Are requirements specified for how the OPUS daily audit report adapts to read tool classification data instead of classifier data? [Coverage, Plan §opus.service.ts MODIFY]
- [X] CHK021 - Are requirements defined for the judge service's new evaluation flow — what input does it receive, what does it evaluate? [Coverage, Spec §US4]
- [X] CHK022 - Is the server.ts startup change specified — what classifier initialization code is removed and what (if anything) replaces it? [Coverage, Research §Decision 11]

## Edge Case Coverage

- [X] CHK023 - Are requirements defined for the amenity template replacement (`{PROPERTY_AMENITIES}`) in the new sop.service.ts? [Edge Case, Research §Decision 7]
- [X] CHK024 - Is behavior specified for when the AI returns categories NOT in the enum despite `strict: true`? [Edge Case, Defense in depth]
- [X] CHK025 - Are requirements defined for the minimum token threshold for prompt caching (4,096 on Haiku)? [Edge Case, Research §Decision 5]

## Dependencies & Assumptions

- [X] CHK026 - Is the assumption that existing property search and extend-stay tools work unchanged validated against the new two-call flow? [Assumption, Spec §Assumptions]
- [X] CHK027 - Is the assumption that conversation history alone replaces topic state cache validated with specific test scenarios? [Assumption, Spec §Assumptions]
- [X] CHK028 - Are the frontend dependencies (classifier-v5.tsx imports, shared state) mapped for clean removal? [Dependency, Gap]

## Notes

- All 28 items validated and passed on 2026-03-21
- Gaps identified by analysis (C1-C10) were addressed in clarification session and will be handled during implementation
- Constitution §VII (Self-Improvement) amendment deferred — justified in plan
