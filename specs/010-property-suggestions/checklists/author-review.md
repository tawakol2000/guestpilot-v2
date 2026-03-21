# Author Pre-Implementation Review: Cross-Sell Property Suggestions

**Purpose**: Self-review checklist for the feature author — catch completeness gaps, ambiguities, and missing requirements before coding
**Created**: 2026-03-21
**Feature**: [spec.md](../spec.md)
**Depth**: Standard | **Audience**: Author | **Focus**: Full-spectrum

## Requirement Completeness

- [ ] CHK001 - Are requirements defined for what happens when the Hostaway availability API returns different listing IDs than what's in the local DB? (e.g., tenant added a new property on Hostaway but hasn't re-imported) [Gap]
- [ ] CHK002 - Is the behavior specified for when an inquiry guest has no dates yet (pre-booking inquiry with no check-in/check-out)? The tool needs dates for availability — what happens without them? [Gap, Spec §FR-002]
- [ ] CHK003 - Are requirements defined for the tool use timeout threshold? FR-014 says "fails or times out" but no specific timeout value is given [Clarity, Spec §FR-014]
- [ ] CHK004 - Is the maximum number of tool use round-trips per message specified? The plan says "cap at 1" but this isn't in the spec [Gap]
- [ ] CHK005 - Are requirements defined for how the AI presents suggested properties in the message? (list format, numbered, bullet points, plain text?) [Gap, Spec §FR-004]
- [ ] CHK006 - Is the "city" matching logic specified? FR-005a says "same city" but how is city parsed from the address field — exact match, fuzzy, or configurable? [Clarity, Spec §FR-005a]
- [ ] CHK007 - Are requirements defined for the screening agent system prompt addition? What instructions tell the AI when to use vs. not use the tool? [Gap]
- [ ] CHK008 - Is the tool result caching behavior specified? If a guest asks about pools twice, should the tool re-run or use cached results? [Gap, Spec §Edge Cases]

## Requirement Clarity

- [ ] CHK009 - Is "ordered by relevance" in FR-003 quantified? What determines relevance — number of matching amenities, property rating, capacity fit, or something else? [Ambiguity, Spec §FR-003]
- [ ] CHK010 - Is "key highlights" in FR-004 defined? Who generates them — the tool handler (static from property data) or Claude (dynamic from context)? [Ambiguity, Spec §FR-004]
- [ ] CHK011 - Is "semantically" in FR-007 specified with a concrete matching strategy? The research doc says synonym map — is that authoritative or just a suggestion? [Clarity, Spec §FR-007]
- [ ] CHK012 - Is "handled with tact" in FR-011 measurable? How does the AI distinguish a casual comment from a genuine interest signal? [Ambiguity, Spec §FR-011]
- [ ] CHK013 - Is "recent tool invocations" in FR-018 scoped with a time window? Last 24h? 7d? 30d? [Clarity, Spec §FR-018]

## Requirement Consistency

- [ ] CHK014 - Does US2 scenario 3 ("what's the WiFi password?") conflict with the screening-agent-only scope? INQUIRY guests should NOT receive WiFi passwords per Constitution §III (access codes gated by CONFIRMED/CHECKED_IN status) [Conflict, Spec §US2, Constitution §III]
- [ ] CHK015 - Does SC-004 ("guests who want to switch") align with the updated US3 wording which is about "interest/leads" not "switching"? [Consistency, Spec §SC-004 vs §US3]
- [ ] CHK016 - Are the tool schema's `required` fields consistent between the contract (amenities + reason required) and US3 scenario 3 ("I need a bigger place" — no amenities, only capacity)? If amenities is required but empty, does the tool handle that? [Consistency, Contract vs Spec §US3]
- [ ] CHK017 - Does FR-004's channel-aware link requirement account for the Channel enum? The Reservation model has WHATSAPP as a channel — FR-004 groups it with Direct but is that always correct? [Consistency, Spec §FR-004]

## Acceptance Criteria Quality

- [ ] CHK018 - Can SC-002 ("90% of property suggestions include only genuinely available properties") be measured without a test harness? How would you count false availability? [Measurability, Spec §SC-002]
- [ ] CHK019 - Can SC-007 ("adding a new capability requires no changes to the core AI response flow") be objectively validated? Is there a definition of "core flow" boundaries? [Measurability, Spec §SC-007]
- [ ] CHK020 - Is SC-005 ("not degraded by more than 3 seconds") measured from which point — from when Claude decides to call the tool, or from the overall guest message to AI reply latency? [Clarity, Spec §SC-005]

## Scenario Coverage

- [ ] CHK021 - Are requirements defined for concurrent tool calls? What if Claude tries to call the tool multiple times in one response (parallel tool use)? [Coverage, Gap]
- [ ] CHK022 - Are requirements defined for the tool returning partial results? (e.g., 5 properties match amenities but only 2 are available — does the tool return 2 or re-search?) [Coverage, Gap]
- [ ] CHK023 - Are requirements defined for what happens when the guest's inquiry channel differs from the property's available listing URLs? (e.g., guest inquired via Airbnb but the suggested property only has a Booking.com URL) [Coverage, Spec §FR-004]
- [ ] CHK024 - Is the flow specified for when a guest switches language mid-conversation? The tool returns English property names — does the AI translate them? [Coverage, Spec §FR-009]

## Edge Case Coverage

- [ ] CHK025 - Is the behavior defined when `customKnowledgeBase.amenities` is empty or null for properties in the portfolio? The search would find no amenity matches [Edge Case, Gap]
- [ ] CHK026 - Is the behavior defined when the Hostaway API rate-limits the availability check? (429 response during tool execution) [Edge Case, Spec §FR-014]
- [ ] CHK027 - Is the behavior defined when ALL tenant properties are in the same city but none have the requested amenity? Should the AI say "none of our properties have X" vs. "this property doesn't have X"? [Edge Case, Spec §FR-013]
- [ ] CHK028 - Is the behavior defined for very short inquiry dates (same-day, 1-night)? Hostaway availability filtering might behave differently for very short windows [Edge Case, Gap]

## Non-Functional Requirements

- [ ] CHK029 - Are Hostaway API rate limiting requirements documented? How many availability calls per minute are allowed before throttling? [Gap, Dependency]
- [ ] CHK030 - Is the token cost impact specified? Tool definition adds ~150 tokens per call — is this budgeted into the per-message cost tracking? [Gap, Constitution §Cost Awareness]
- [ ] CHK031 - Are observability requirements complete? FR-015 covers logging but does Langfuse tracing need to capture tool use spans? [Coverage, Constitution §VI]

## Dependencies & Assumptions

- [ ] CHK032 - Is the assumption that listing URLs are returned by Hostaway's API validated? The research found these fields exist in docs but are they populated for all tenants? [Assumption, Spec §Assumptions]
- [ ] CHK033 - Is the assumption that `availabilityDateStart`/`availabilityDateEnd` filters return ONLY available listings validated against Hostaway's actual behavior? [Assumption, Spec §Assumptions]
- [ ] CHK034 - Is the dependency on existing amenity data quality documented? If `customKnowledgeBase.amenities` has inconsistent formatting across properties, the synonym matching may fail [Dependency, Spec §FR-007]

## Reusability Requirements

- [ ] CHK035 - Is the tool handler registry interface specified with enough detail to add a second tool without guessing? (function signature, context injection, error handling contract) [Completeness, Spec §FR-017]
- [ ] CHK036 - Is the tool definition schema documented as a pattern that future tools must follow? [Completeness, Spec §FR-017]
- [ ] CHK037 - Are requirements defined for which agents can receive which tools? Currently "screening only" — is there a mechanism for per-agent tool assignment? [Coverage, Spec §FR-010, §FR-017]

## Notes

- 37 items covering all requirement areas
- Key risk areas: Hostaway API assumptions (CHK032-033), screening-agent WiFi conflict (CHK014), missing inquiry-without-dates scenario (CHK002)
- Reusability section ensures FR-017/SC-007 are actionable, not aspirational
