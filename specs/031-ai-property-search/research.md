# Research: AI-Powered Semantic Property Search

## R1: Nano Model Capability for Property Scoring

**Decision**: Use gpt-5-nano with json_schema enforcement for semantic property scoring.

**Rationale**: gpt-5-nano is already used in the codebase for task dedup, FAQ suggest, and conversation summaries — all semantic understanding tasks. It handles synonym matching, contextual reasoning, and structured output reliably at the lowest cost tier ($0.05/1M tokens). A property scoring call with 10-20 candidates at ~100 tokens each = ~2000 tokens input, well within context limits.

**Alternatives considered**:
- gpt-5.4-mini: More capable but 10x more expensive. Overkill for scoring properties against a requirements list.
- Pre-computed embeddings: Would require vector DB infrastructure (overkill for 5-30 properties), and doesn't provide the met/unmet breakdown we need.
- Expanded synonym map: Brittle, can't handle freetext like "near malls" or "well-lit", endless maintenance.

## R2: Scoring Prompt Design

**Decision**: Single prompt with all candidate properties, structured JSON output via json_schema.

**Rationale**: One API call is simpler, faster, and cheaper than per-property calls. With 5-30 properties at ~100 tokens each, the total input is 500-3000 tokens — well within nano's context. The structured output schema guarantees parseable results.

**Prompt structure**:
- Guest requirements as a freetext block (exactly as the AI extracted them)
- Structured property profiles: name, bedrooms, capacity, address, description (500 chars), amenities
- Instructions: score 0-10, list met/unmet requirements, provide short note
- json_schema enforcement on the output

**Output schema**:
```json
{
  "scores": [
    {
      "index": 1,
      "score": 8,
      "met": ["garden", "3BR", "fast internet", "gated compound"],
      "unmet": ["dryer"],
      "note": "Strong match — gated compound with garden, near O1 Mall"
    }
  ]
}
```

## R3: Current Property Inclusion Strategy

**Decision**: Include current property in candidate list, flag in results with "This is the property the guest is viewing", omit booking link.

**Rationale**: The root cause of the original failure was excluding the current property from search. Including it lets the scoring tool confirm what the SOP data shows. Omitting the booking link prevents the AI from sending the guest a link to their own listing. The flag lets the AI craft appropriate messaging ("this apartment has everything you need" vs "here are some options").

**Alternatives considered**:
- Score current property separately: Adds complexity, two API calls instead of one.
- Include with booking link: Risk of AI sending guest a link to their own listing.
- Don't include, fix SOP only: Doesn't solve the self-assessment reliability problem.

## R4: Availability Check Ordering

**Decision**: Check Hostaway availability BEFORE scoring to minimize tokens sent to nano.

**Rationale**: The Hostaway availability API returns listing IDs for available properties. Filtering unavailable properties before scoring means we send fewer candidates to nano (cheaper, faster). A tenant with 20 properties might have only 8 available for specific dates — scoring 8 is cheaper than scoring 20.

**Flow**: Load all properties → filter by city → check availability → build profiles for available only → score via nano.

## R5: SOP Text Update Strategy

**Decision**: Update the property-info SOP to guide dual-layer assessment: self-assess first, then call search to confirm and find alternatives.

**Rationale**: The previous SOP said "if the property does NOT have [amenity], call search." This required the AI to self-assess — which it often got wrong. The new SOP says: "Check the property data below. When a guest lists multiple requirements or asks what's available, also call search_available_properties to confirm your assessment and find alternatives." This preserves self-assessment as the first layer and adds search as a safety net.

**SOP text change** (in sop.service.ts, property-info default):
```
Before: "If the guest asks for an amenity or feature this property does NOT have 
(e.g. sea view, jacuzzi, sauna), call search_available_properties to check if 
another property matches. Present results as alternatives."

After: "First check if this property matches the guest's requirements using the 
description and amenities below. When a guest lists multiple requirements or asks 
what's available, also call search_available_properties — it scores this property 
and alternatives together. If this property is the best match, pitch it 
confidently. Only suggest alternatives if they genuinely offer something this 
property lacks."
```

## R6: Error Handling and Fallback

**Decision**: If nano scoring fails (timeout, API error, malformed output), return a structured error that the AI can handle gracefully.

**Rationale**: Per Constitution §I (Graceful Degradation), the search must never crash. The AI still has property data from get_sop and can self-assess as a degraded fallback.

**Error response**:
```json
{
  "found": false,
  "count": 0,
  "properties": [],
  "error": "Property scoring temporarily unavailable. Please answer from the property information above.",
  "should_escalate": false
}
```
