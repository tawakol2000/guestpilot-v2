# Quickstart: AI-Powered Semantic Property Search

## Test Scenarios

### Scenario 1: Current property is the best match

**Setup**: Guest inquiring about Apartment 102 (Silver Palm, 3BR, garden, gated compound, near O1 Mall)

**Guest message**: "I need a 3BR with garden, fast internet, gated compound, play area for kids, near malls, washer"

**Expected**:
1. AI calls get_sop → gets property-info SOP with property description + amenities
2. AI calls search_available_properties with the guest's requirements
3. Search scores all properties including Apt 102
4. Apt 102 scores 8-9/10 with most requirements met
5. Apt 102 appears as top result with `is_current_property: true`, no booking link
6. AI responds: pitches the current property, lists what matches, mentions what's missing (if anything)
7. AI does NOT suggest inferior 2BR alternatives as primary recommendations

### Scenario 2: Current property is a poor match

**Setup**: Guest inquiring about Apartment 205 (2BR, no pool, no sea view)

**Guest message**: "I need a 4BR with pool and sea view"

**Expected**:
1. Search scores Apt 205 low (2-3/10) — misses 4BR, pool, sea view
2. Alternative properties with pool/more bedrooms score higher
3. AI responds: notes the current property doesn't match well, presents alternatives with booking links

### Scenario 3: Non-standard terminology

**Guest message**: "I need somewhere well-lit with outdoor space for kids to run around, close to shopping"

**Expected**:
- "well-lit" matches properties with balcony, large windows, open layout descriptions
- "outdoor space for kids" matches "playgrounds", "garden or backyard", "suitable for children"
- "close to shopping" matches "near O1 Mall", "shopping centers"

### Scenario 4: No good matches

**Setup**: Guest asks for amenities no property has

**Guest message**: "I need a beachfront villa with private pool and helipad"

**Expected**:
1. All properties score below 5
2. Search returns empty results
3. AI tells guest no properties match and escalates to manager

### Scenario 5: Scoring service failure

**Setup**: OpenAI API unavailable or nano call times out

**Expected**:
1. Search returns error response with message
2. AI falls back to answering from SOP property data alone
3. No crash, no silent failure

### Scenario 6: Single-property tenant

**Setup**: Tenant with only 1 property

**Expected**:
1. Search scores just that property
2. Returns it as the only result (if score >= 5)
3. AI pitches it or notes gaps — no alternatives to show

## Verification Checklist

- [ ] Current property appears in search results when it matches
- [ ] Current property has `is_current_property: true` and no booking link
- [ ] Alternative properties have booking links
- [ ] Scores are reasonable (high for good matches, low for poor)
- [ ] Met/unmet lists are accurate
- [ ] Non-standard terminology works (semantic matching)
- [ ] Properties below score 5 are filtered out
- [ ] At most 3 properties returned
- [ ] City filtering still works
- [ ] Availability checking still works
- [ ] Error handling works (API failure → graceful error)
- [ ] SOP text updated — AI calls search for multi-requirement queries
- [ ] Synonym map file deleted
- [ ] AI Logs show the scoring tool call with full details
