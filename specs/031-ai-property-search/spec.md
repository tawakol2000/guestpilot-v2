# Feature Specification: AI-Powered Semantic Property Search

**Feature Branch**: `031-ai-property-search`  
**Created**: 2026-04-05  
**Status**: Draft  
**Input**: Replace naive substring amenity matching in property search with semantic AI scoring. Include current property in results. Dual-layer approach: AI self-assesses from SOP data AND search confirms with scoring.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Semantic Property Matching (Priority: P1)

A guest inquiring about a property sends a message listing their requirements in natural language (e.g., "I need a 3BR+ in a gated compound with a garden, fast internet, play area for kids, near malls"). The system searches all tenant properties — including the one the guest is currently viewing — and scores each against the guest's requirements using semantic understanding. The AI assistant receives scored results showing which requirements each property meets or doesn't meet, and responds intelligently: pitching the current property if it's the best match, or suggesting alternatives when they add value.

**Why this priority**: This is the core of the feature. Without semantic scoring, the search returns irrelevant results (2-bedroom apartments when the guest asked for 3BR+, properties missing most requirements). The current substring matching fails on natural language requirements like "gated compound", "near malls", or "well-lit" that don't appear as standard amenity tags.

**Independent Test**: Send a guest message with 5+ specific requirements to an inquiry for a property that matches most of them. Verify the search returns that property as the top result with a high score, correct met/unmet breakdown, and that the AI pitches it accordingly.

**Acceptance Scenarios**:

1. **Given** a guest is inquiring about Property A which has a garden, 3 bedrooms, internet, and is in a gated compound near malls, **When** the guest says "I need a 3BR with garden, fast internet, gated compound, near shopping", **Then** the search returns Property A as the top match with score 8+ and lists all four requirements as met.

2. **Given** a guest is inquiring about Property A which has 2 bedrooms and no pool, **When** the guest says "I need a 3BR with pool", **Then** the search returns Property A with a low score (listing "3BR" and "pool" as unmet) and returns alternative properties that better match, ranked by score.

3. **Given** a guest uses non-standard terminology like "well-lit", "play area for kids", "outdoor space", **When** the search runs, **Then** the scoring understands these semantically (e.g., "play area" matches "playgrounds" in a property description, "outdoor space" matches "garden or backyard" in amenities).

4. **Given** a tenant has 15 properties across two cities, **When** a guest asks for options in "New Cairo", **Then** only properties with New Cairo in their address are scored, and the scoring completes within 5 seconds.

---

### User Story 2 - Dual-Layer Current Property Awareness (Priority: P1)

The AI uses two reinforcing layers to assess the current property: (1) the property description and amenities from the SOP, which it can read and self-assess, and (2) the search results where the current property is scored and flagged. The current property never has a booking link in search results — instead it is presented as "This is the property the guest is viewing" with its match details. This prevents the AI from sending the guest a link to their own listing and ensures it pitches the property naturally.

**Why this priority**: Previously the current property was excluded from search results entirely, and the AI's self-assessment from SOP data was unreliable. The dual-layer approach means even if the AI misreads the SOP, the search scoring corrects it — and even if it ignores search results, the SOP data is there. Both layers reinforce each other.

**Independent Test**: Trigger a property search for requirements that match the current property. Verify the current property appears in results flagged as the guest's property with no booking link, and the AI presents it as "this apartment has everything you need" rather than linking to it.

**Acceptance Scenarios**:

1. **Given** the current property scores highest among all candidates, **When** the AI receives search results, **Then** the current property is flagged with a label like "This is the property the guest is viewing" and has no booking link, and the AI pitches it as the primary recommendation.

2. **Given** the current property scores below other candidates, **When** the AI receives search results, **Then** the current property still appears (flagged) alongside higher-scoring alternatives that include booking links.

3. **Given** the current property is unavailable for the requested dates, **When** the search checks availability, **Then** it is excluded from results (availability filtering still applies).

4. **Given** the AI has already read property data from get_sop and the search confirms the current property is the best match, **When** the AI responds, **Then** it uses BOTH sources to craft a confident, detailed response about why the property fits the guest's needs.

---

### User Story 3 - SOP-Guided Search Behavior (Priority: P2)

The property-info SOP is updated to instruct the AI to call the search tool when a guest lists multiple requirements or asks what's available, while still encouraging self-assessment from property data first. The SOP says: first check if the property matches from the description and amenities below; then call search to confirm your assessment and find alternatives if anything is missing. This preserves the AI's ability to self-assess while adding the safety net of scored search results.

**Why this priority**: The previous SOP said "if the guest asks for an amenity this property does NOT have, call search." This required the AI to self-assess — and it often got it wrong. The updated SOP keeps self-assessment as the first step but adds search as confirmation, eliminating the single point of failure.

**Independent Test**: Update the SOP text and verify the AI calls search_available_properties when a guest lists requirements, and that its response is informed by both the SOP data and search results.

**Acceptance Scenarios**:

1. **Given** a guest lists 5+ requirements, **When** the AI processes the message, **Then** it calls get_sop (to read property data) AND search_available_properties (to score and compare), and responds using both.

2. **Given** a guest asks a simple single-attribute question like "what floor is the apartment on?", **When** the AI processes the message, **Then** it answers from the SOP/property description directly without calling search.

---

### Edge Cases

- What happens when a tenant has only 1 property? The search scores just that property and returns it — no alternatives exist. The AI pitches it or notes gaps.
- What happens when no properties score above the threshold? The search returns an empty result and the AI tells the guest none of the available properties match their specific requirements, then escalates to the manager.
- What happens when the scoring service is unavailable or times out? The search returns a graceful error. The AI falls back to self-assessment from SOP data alone (degraded but functional).
- What happens when a guest's requirements are vague (e.g., "a nice place")? The scoring handles this gracefully — it scores based on whatever attributes the guest mentioned, even if few.
- What happens when the guest mentions budget? The scoring considers budget as context but doesn't hard-filter by price (pricing is handled separately by the pricing SOP). The AI can note budget relevance in its response.
- What happens when property descriptions are empty or very short? The scoring works with whatever data is available — amenities alone may still provide signal, though scoring quality will be lower.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The property search MUST score all candidate properties semantically against the guest's natural language requirements, understanding synonyms, descriptions, and contextual meaning (e.g., "play area" matches "playgrounds", "near malls" matches "near O1 Mall").

- **FR-002**: The property search MUST include the current property (the one the guest is inquiring about) in the candidate list, not exclude it.

- **FR-003**: The search MUST return a score (0-10) for each candidate property, along with a list of which guest requirements are met and which are unmet.

- **FR-004**: The search MUST return a short human-readable note per property summarizing why it scored the way it did (e.g., "Strong match — gated compound with garden, near O1 Mall").

- **FR-005**: The current property in results MUST be clearly identified (e.g., labeled "This is the property the guest is viewing") and MUST NOT include a booking link.

- **FR-006**: Alternative properties in results MUST include channel-appropriate booking links (Airbnb link for Airbnb guests, etc.).

- **FR-007**: The search MUST filter out properties scoring below a minimum threshold (score 5 out of 10) to avoid returning irrelevant results.

- **FR-008**: The search MUST return at most 3 properties, sorted by score descending.

- **FR-009**: The search MUST check date availability via the booking platform before including a property in results.

- **FR-010**: The search MUST filter candidates by city/location before scoring.

- **FR-011**: The search MUST build a rich profile for each candidate including: property name, bedroom count, guest capacity, address, property description (first 500 characters), and full amenities list.

- **FR-012**: The search MUST use structured output so the scoring results are always parseable (not freeform text).

- **FR-013**: If the scoring service is unavailable or fails, the search MUST return a graceful error indicating the search could not be completed, rather than crashing or returning empty results silently.

- **FR-014**: The property-info SOP MUST be updated to instruct the AI to: (a) first self-assess from property data, (b) call search to confirm and find alternatives when a guest lists multiple requirements.

- **FR-015**: The previous substring-based amenity matching and synonym map MUST be removed entirely — they are replaced by semantic scoring.

- **FR-016**: The search MUST complete within 5 seconds for portfolios of up to 30 properties.

### Key Entities

- **Property Profile**: A composite view of a property assembled at search time — name, bedrooms, capacity, address, description excerpt, amenities list. Used as input to the scoring step.
- **Scored Property Result**: A property with its match score (0-10), met requirements list, unmet requirements list, human-readable note, booking link (null for current property), and current-property flag.
- **Search Result**: The complete response containing scored properties, the dates checked, city context, current property match status, and a suggested message for the AI.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: When a guest lists requirements that match the current property, the current property appears as the top result with score 7+ in at least 90% of cases (vs 0% today since it's excluded from search).

- **SC-002**: Semantic requirements like "gated compound", "near malls", "play area for children", "well-lit" correctly match properties whose descriptions contain these features, achieving 80%+ accuracy on natural language requirement matching (vs ~20% with substring matching).

- **SC-003**: The search completes within 5 seconds for portfolios of up to 30 properties, including availability checking and scoring.

- **SC-004**: The AI assistant's response quality improves: when a property matches the guest's requirements, the AI pitches it instead of suggesting inferior alternatives. Measured by reduction in manager overrides of AI property suggestions.

- **SC-005**: Per-search cost remains below $0.01 (the scoring uses the cheapest available model).

## Assumptions

- Tenant portfolios are small (5-30 properties). The scoring approach is designed for this scale and would need redesign for hundreds of properties.
- Property descriptions in the database contain meaningful text about the property's features, location, and surroundings. Empty descriptions will result in lower-quality scoring.
- The cheapest available AI model is capable of semantic understanding sufficient for property-requirement matching (understanding synonyms, contextual descriptions, and natural language).
- The existing city filtering (substring match on address) is sufficient for location-based filtering before scoring.
- Budget/pricing mentioned by guests is contextual information for the scorer but not a hard filter — actual pricing is managed through the booking platform and pricing SOP.

## Out of Scope

- Pricing/rate comparison between properties (handled by pricing SOP and booking platform rates).
- Map/visual property comparison in the frontend.
- Guest preference learning over time (remembering what a returning guest prefers).
- Multi-city search (guest asks for properties across different cities in one query).
- Pre-computed property embeddings or vector database — the semantic scoring happens at search time.
