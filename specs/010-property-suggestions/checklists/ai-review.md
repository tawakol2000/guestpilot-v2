# AI Reviewer Checklist: Cross-Sell Property Suggestions

**Purpose**: Checklist for Claude (AI reviewer) — validate requirements quality during implementation, flag issues before they become bugs
**Created**: 2026-03-21
**Feature**: [spec.md](../spec.md)
**Depth**: Standard | **Audience**: AI Reviewer | **Focus**: Full-spectrum

## Architectural Boundary Integrity

- [ ] CHK001 - Is the screening-agent-only boundary defined at the right abstraction level? FR-010 says "INQUIRY-status conversations" but what about reservations that transition from INQUIRY → CONFIRMED mid-conversation — does the tool disappear? [Consistency, Spec §FR-010]
- [ ] CHK002 - Does the spec define how the tool use loop interacts with the existing 3-tier classification pipeline? Tool use adds a second Claude call — does the classifier run on the first call, second call, or both? [Gap, Spec §FR-016]
- [ ] CHK003 - Is the separation between "tool decides to search" and "AI decides to escalate" clear? Both FR-010a (autonomous tool decision) and the escalation system (prompt-driven) rely on Claude's judgment — are the boundaries unambiguous? [Clarity, Spec §FR-010a vs §FR-012]
- [ ] CHK004 - Does the spec address prompt caching implications? The current system uses `cache_control: ephemeral` on the system prompt — adding tools changes the cached block composition. Is this impact documented? [Gap, Plan §Phase A]

## Data Flow & State Requirements

- [ ] CHK005 - Is the data flow from tool result → Claude → JSON response fully specified? Claude receives tool results and must still output the standard JSON format (`guest_message`, `escalation`). Is it clear that tool use is intermediate and the final output schema is unchanged? [Clarity, Spec §Architecture Decision]
- [ ] CHK006 - Are the conversation history implications of tool use defined? The tool use round-trip adds assistant + user messages to the API call. In subsequent messages in the same conversation, are these tool-use turns visible in the 6-message history window? [Gap]
- [ ] CHK007 - Is the property data freshness requirement specified? Properties are imported periodically — if amenities were added/removed since last import, the tool searches stale local data but checks live Hostaway availability. Is this mixed-freshness acknowledged? [Gap, Spec §Assumptions]
- [ ] CHK008 - Is the tool context injection documented? The contract says dates/city/tenant come from server-side context. Is it specified where this context is assembled and passed to the handler? [Completeness, Contract §Server-Side Context]

## Compliance & Safety Requirements

- [ ] CHK009 - Does FR-004's channel-aware link requirement address the case where the suggested property has no listing on the guest's channel? (e.g., property only listed on Airbnb but guest inquired via Booking.com) The fallback chain is specified but is it ordered by priority? [Clarity, Spec §FR-004]
- [ ] CHK010 - Is there a requirement preventing the AI from revealing that it's using a "tool" to the guest? Constitution §III says AI must not discuss its own nature. Tool use language like "let me search for you" may be fine, but "I'm running a property search tool" would violate this [Consistency, Constitution §III vs Spec §FR-008]
- [ ] CHK011 - Are multi-tenant isolation requirements explicit for the property search? The tool must only return properties belonging to the same tenant. Is this stated as a hard requirement or assumed? [Gap, Constitution §II]
- [ ] CHK012 - Does the spec prevent access code exposure in tool results? The tool returns property highlights — is there a requirement ensuring door codes/WiFi are NEVER included in search results? [Gap, Constitution §III]

## Error & Recovery Requirements

- [ ] CHK013 - Is the error cascade defined? If Hostaway API fails, the tool returns an error result to Claude. But what if Claude misinterprets the error and tells the guest something incorrect? Is there a validation step? [Coverage, Spec §FR-014]
- [ ] CHK014 - Is recovery defined for partial tool execution? If the amenity filter succeeds but the availability check fails mid-way (3 of 5 properties checked), does the tool return partial results or fail entirely? [Gap]
- [ ] CHK015 - Are requirements defined for tool handler exceptions that aren't API failures? (e.g., city parsing fails, amenity synonyms file is missing, DB query timeout) [Coverage, Spec §FR-014]
- [ ] CHK016 - Is the behavior specified when Claude calls the tool with invalid input? (e.g., empty amenities array despite it being required, or amenity strings in Arabic) [Edge Case, Contract §Tool Schema]

## Frontend Requirements Depth

- [ ] CHK017 - Is the Tools section data source specified? FR-018 says "available tools with name/description/status" — where does this tool registry live? Hardcoded in frontend, fetched from an API endpoint, or stored in DB? [Gap, Spec §FR-018]
- [ ] CHK018 - Are the frontend Tools section access controls defined? Can all managers see it, or only admins? Is it tenant-scoped? [Gap, Spec §FR-018]
- [ ] CHK019 - Is the "recent invocations" table in FR-018 specified with pagination, filtering, or sorting requirements? [Completeness, Spec §FR-018]
- [ ] CHK020 - Are loading/empty/error states defined for the Tools section? What if no tools have been invoked yet? What if the AiApiLog query fails? [Gap, Spec §FR-018]
- [ ] CHK021 - Is the pipeline view (FR-019) tool section specified with enough detail for implementation? What does "input, output, duration" look like visually — expandable section, inline, modal? [Clarity, Spec §FR-019]

## Observability & Auditability

- [ ] CHK022 - Is the observability data structure for tool use complete? FR-015 says "log search criteria, results returned, and guest interest." Is "guest interest" a boolean, a category, or inferred from the conversation? [Ambiguity, Spec §FR-015]
- [ ] CHK023 - Are requirements defined for tool use in the OPUS daily audit report? Constitution §VI mentions the daily audit aggregates AI activity — should tool invocations be included? [Gap, Constitution §VI]
- [ ] CHK024 - Are SSE event requirements defined for tool use? The system broadcasts `ai_typing` and `ai_typing_clear` — during the tool use loop (which takes extra seconds), should additional SSE events signal the extended processing? [Gap, Constitution §VI]

## Semantic Matching & Data Quality

- [ ] CHK025 - Is the amenity synonym map specified as exhaustive or extensible? Data model says it's a static config file — are requirements for adding/updating synonyms documented? [Completeness, Data Model §Amenity Synonym Map]
- [ ] CHK026 - Are multilingual amenity matching requirements specific? FR-009 says "respond in the same language" and edge cases say "search criteria are interpreted semantically regardless of language." But the synonym map is English-only. How does "مسبح" (pool in Arabic) match? [Gap, Spec §FR-007 vs §FR-009]
- [ ] CHK027 - Is the amenity matching precision vs recall tradeoff specified? Should the system prefer false negatives (miss a valid match) or false positives (suggest a property that doesn't quite match)? [Gap, Spec §FR-007]

## Reusability & Extensibility

- [ ] CHK028 - Is the tool handler interface contract specified beyond prose? FR-017 says "only a new action definition and handler" — but what's the handler signature, error contract, and context shape? [Clarity, Spec §FR-017]
- [ ] CHK029 - Is the per-agent tool assignment mechanism specified? FR-010 says screening-only, FR-017 says reusable infrastructure. How does the system decide which agent gets which tools? Configuration, code, or convention? [Gap, Spec §FR-010 vs §FR-017]
- [ ] CHK030 - Are requirements defined for tool versioning? If the tool schema changes (new parameters, different output), how are in-flight conversations handled? [Gap, Spec §FR-017]

## Notes

- 30 items covering architectural boundaries, compliance/safety, frontend depth, observability, and reusability
- Key issues I'd flag during implementation:
  - CHK001: INQUIRY → CONFIRMED transition mid-conversation (tool visibility changes)
  - CHK011: Multi-tenant isolation MUST be explicit, not assumed
  - CHK012: Access codes MUST be excluded from tool results (Constitution §III)
  - CHK014: WiFi question in US2 conflicts with screening-agent scope (inquiry guests don't get WiFi)
  - CHK026: Arabic amenity matching is unresolved — synonym map is English-only
