# Tasks: AI-Powered Semantic Property Search

**Input**: Design documents from `/specs/031-ai-property-search/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: No setup needed — this feature modifies existing files only. No new dependencies, no schema changes.

*(No tasks in this phase)*

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Remove old matching infrastructure before building new

- [X] T001 Delete the amenity synonym map file at backend/src/config/amenity-synonyms.json
- [X] T002 Remove all imports and references to amenity-synonyms.json in backend/src/services/property-search.service.ts (getSynonymsForAmenity, propertyHasAmenity functions, amenitySynonyms variable, fs/path imports for loading the JSON)

**Checkpoint**: Old synonym infrastructure removed. Property search will not compile until new scoring logic is added.

---

## Phase 3: User Story 1 — Semantic Property Matching (Priority: P1)

**Goal**: Replace substring amenity matching with a single gpt-5-nano semantic scoring call that understands natural language requirements.

**Independent Test**: Send a guest message with 5+ requirements to a property that matches most of them. Verify the search returns scored results with correct met/unmet breakdown.

### Implementation for User Story 1

- [X] T003 [US1] Add the nano scoring prompt constant and scoring output type definition at the top of backend/src/services/property-search.service.ts — define SCORING_MODEL, SCORING_PROMPT template, and ScoringResult interface matching the contract in contracts/search-tool-output.md

- [X] T004 [US1] Add a buildPropertyProfile helper function in backend/src/services/property-search.service.ts that assembles a rich text profile for a candidate property from: property.name, customKnowledgeBase.bedroomsNumber, customKnowledgeBase.personCapacity, property.address, property.listingDescription (first 500 chars), and customKnowledgeBase.amenities

- [X] T005 [US1] Add a scorePropertiesWithNano async function in backend/src/services/property-search.service.ts that: takes an array of property profiles + guest requirements string, builds the scoring prompt, calls OpenAI Responses API with gpt-5-nano and json_schema enforcement (schema from contracts/search-tool-output.md), parses and returns the scored results. Handle errors gracefully — return empty scores array on failure.

- [X] T006 [US1] Rewrite the main searchAvailableProperties function in backend/src/services/property-search.service.ts: keep city filtering and Hostaway availability check, remove the old amenity scoring/sorting logic (requestedAmenities, scored map, propertyHasAmenity calls), replace with: build profiles for available candidates → call scorePropertiesWithNano → filter scores below 5 → sort descending → take top 3 → build PropertyResult objects with score, met, unmet, note fields. Keep the existing booking link logic (getBookingLink function stays unchanged).

- [X] T007 [US1] Update the SearchResult and PropertyResult interfaces in backend/src/services/property-search.service.ts to match the new contract: add score, met, unmet, note, is_current_property, label fields to PropertyResult. Remove amenities_matched and highlights. Remove suggested_message from the result (AI crafts its own response from scored data).

- [X] T008 [US1] Add error handling in searchAvailableProperties: if scorePropertiesWithNano throws or returns empty, return a structured error response: { found: false, count: 0, properties: [], error: "Property scoring temporarily unavailable. Please answer from the property information above.", should_escalate: false }

**Checkpoint**: Semantic scoring works end-to-end. Search returns scored results with met/unmet breakdown. Old substring matching is fully replaced.

---

## Phase 4: User Story 2 — Current Property Awareness (Priority: P1)

**Goal**: Include the current property in search results, flag it, omit its booking link.

**Independent Test**: Trigger a search where the current property matches. Verify it appears flagged as "This is the property the guest is viewing" with no booking link.

### Implementation for User Story 2

- [X] T009 [US2] Remove the current property exclusion filter in backend/src/services/property-search.service.ts — change the candidates filter from `if (p.id === currentPropertyId) return false` to include all properties (remove that line). The current property now participates in scoring.

- [X] T010 [US2] After scoring and building results in searchAvailableProperties, flag the current property: set is_current_property: true, label: "This is the property the guest is viewing", booking_link: null for the result whose property.id matches currentPropertyId. All other results keep is_current_property: false, label: null, and their normal booking links.

- [X] T011 [US2] Add current_property_matched boolean to the SearchResult output — set to true if the current property appears in the final scored results (score >= 5).

**Checkpoint**: Current property appears in results when it matches, flagged with no booking link. Alternatives have links.

---

## Phase 5: User Story 3 — SOP-Guided Search Behavior (Priority: P2)

**Goal**: Update property-info SOP to guide dual-layer assessment: self-assess from SOP data, then call search to confirm.

**Independent Test**: Verify the SOP text instructs the AI to call search when guest lists requirements, and the AI follows through.

### Implementation for User Story 3

- [X] T012 [US3] Update the property-info SOP default text in backend/src/services/sop.service.ts — replace the current instruction "If the guest asks for an amenity or feature this property does NOT have (e.g. sea view, jacuzzi, sauna), call search_available_properties to check if another property matches. Present results as alternatives." with the new dual-layer instruction: "First check if this property matches the guest's requirements using the description and amenities below. When a guest lists multiple requirements or asks what's available, also call search_available_properties — it scores this property and alternatives together. If this property is the best match, pitch it confidently. Only suggest alternatives if they genuinely offer something this property lacks."

**Checkpoint**: SOP guides dual-layer assessment. AI self-assesses AND confirms via search.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Verify, clean up, and validate

- [X] T013 Verify TypeScript compilation passes with no errors by running tsc --noEmit in backend/
- [X] T014 Run a manual test via the Sandbox endpoint: send a guest message with 5+ requirements that match the current property. Verify scored results appear in AI Logs with correct met/unmet breakdown.
- [X] T015 Run quickstart.md scenario 4 (no good matches): verify empty results and graceful error messaging
- [X] T016 Run quickstart.md scenario 5 (scoring failure): temporarily break the API key and verify graceful fallback

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: Empty — no setup needed
- **Phase 2 (Foundational)**: Remove old infrastructure — BLOCKS Phase 3
- **Phase 3 (US1)**: Semantic scoring — depends on Phase 2. Core implementation.
- **Phase 4 (US2)**: Current property — depends on Phase 3 (needs scoring in place to flag current property)
- **Phase 5 (US3)**: SOP update — can run in parallel with Phase 4 (different file)
- **Phase 6 (Polish)**: Depends on Phases 3-5 complete

### User Story Dependencies

- **US1 (Semantic Matching)**: Foundational — all other stories depend on this
- **US2 (Current Property)**: Depends on US1 (needs scoring logic to exist)
- **US3 (SOP Update)**: Independent of US2 (different file — sop.service.ts vs property-search.service.ts)

### Within Each Phase

- T001 and T002 are sequential (delete file, then remove references)
- T003-T008 are sequential within US1 (each builds on the previous)
- T009-T011 are sequential within US2
- T012 is a single task (US3)
- T013-T016 are sequential (validate, then test scenarios)

### Parallel Opportunities

- US3 (T012, sop.service.ts) can run in parallel with US2 (T009-T011, property-search.service.ts) since they modify different files

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 2: Remove old synonym infrastructure
2. Complete Phase 3: Implement semantic scoring (T003-T008)
3. **STOP and VALIDATE**: Search returns scored results with met/unmet
4. The current property is still excluded at this point — but scoring works

### Incremental Delivery

1. Phase 2 → Old matching removed
2. Phase 3 (US1) → Semantic scoring works → Test with Sandbox
3. Phase 4 (US2) → Current property included and flagged → Test with real inquiry
4. Phase 5 (US3) → SOP updated → AI behavior changes
5. Phase 6 → Full validation

---

## Notes

- Total tasks: 16
- US1 (Semantic Matching): 6 tasks
- US2 (Current Property): 3 tasks
- US3 (SOP Update): 1 task
- Foundational: 2 tasks
- Polish: 4 tasks
- No schema changes, no frontend changes
- Files modified: property-search.service.ts (rewrite), sop.service.ts (edit)
- Files deleted: amenity-synonyms.json
