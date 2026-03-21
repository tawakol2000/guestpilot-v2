# Quickstart: SOP Tool Routing

## Integration Scenarios

### Scenario 1: Standard Guest Message (Single SOP)

1. Guest sends: "The dishwasher is not working"
2. AI service builds system prompt + conversation history
3. **Call 1**: Claude with `get_sop` tool (forced)
   - Response: `{reasoning: "Guest reports broken appliance", categories: ["sop-maintenance"], confidence: "high"}`
4. App calls `getSopContent("sop-maintenance")` → returns maintenance SOP text
5. **Call 2**: Claude with SOP as tool_result + [extend_stay tool] (auto)
   - Response: text message following maintenance SOP procedure
6. Log to AiApiLog with sopCategories, sopConfidence, sopReasoning

### Scenario 2: Multi-Intent Message

1. Guest sends: "Can I get extra towels? Also what's the WiFi password?"
2. **Call 1**: `{categories: ["sop-amenity-request", "sop-wifi-doorcode"], confidence: "high"}`
3. App retrieves BOTH SOPs, concatenates content
4. **Call 2**: Claude responds addressing both requests using both SOPs

### Scenario 3: Non-Actionable Message

1. Guest sends: "Thanks so much!"
2. **Call 1**: `{categories: ["none"], confidence: "high", reasoning: "Simple thank you"}`
3. App skips SOP retrieval — returns minimal tool_result (no SOP needed)
4. **Call 2**: Claude responds naturally from conversation context

### Scenario 4: Escalation

1. Guest sends: "This is unacceptable, I want a full refund NOW"
2. **Call 1**: `{categories: ["escalate"], confidence: "high", reasoning: "Angry guest demanding refund"}`
3. App creates escalation Task for operator
4. **Call 2**: Claude responds with de-escalation following general guidelines

### Scenario 5: Contextual Follow-Up

1. Previous context: discussion about cleaning
2. Guest sends: "2pm"
3. **Call 1**: `{categories: ["sop-cleaning"], confidence: "high", reasoning: "Confirming cleaning time from ongoing discussion"}`
4. Normal SOP retrieval and response — no special handling needed

### Scenario 6: SOP Retrieval Failure

1. Guest sends: "I need more towels"
2. **Call 1**: `{categories: ["sop-amenity-request"], confidence: "high"}`
3. App tries `getSopContent("sop-amenity-request")` → throws error
4. App returns tool_result: "SOP temporarily unavailable. Respond helpfully based on your general knowledge."
5. **Call 2**: Claude responds with best-effort answer
6. Error logged for operator review

### Scenario 7: Tool Coexistence (Screening Agent)

1. INQUIRY guest sends: "Do you have apartments with a pool?"
2. **Call 1** (forced get_sop): `{categories: ["sop-booking-inquiry"], confidence: "high"}`
3. App retrieves booking inquiry SOP
4. **Call 2** with SOP + [search_available_properties tool] (auto)
   - Claude reads SOP, decides to search → calls search_available_properties
5. **Call 3**: property search results → Claude responds with availability + booking links

### Scenario 8: Tool Coexistence (Guest Coordinator)

1. CONFIRMED guest sends: "Can I stay 3 more nights?"
2. **Call 1** (forced get_sop): `{categories: ["sop-booking-modification"], confidence: "high"}`
3. App retrieves booking modification SOP
4. **Call 2** with SOP + [check_extend_availability tool] (auto)
   - Claude reads SOP, decides to check availability → calls check_extend_availability
5. **Call 3**: availability + pricing → Claude responds with extension options

## Sandbox Testing

The sandbox chat endpoint (`POST /api/ai-config/sandbox-chat`) follows the same flow but with a mock conversation context. This is the primary testing mechanism:

1. Open Sandbox tab in frontend
2. Type a guest message
3. Verify: classification logged in response metadata (categories, confidence, reasoning)
4. Verify: correct SOP content retrieved
5. Verify: AI response follows the SOP procedure

## Monitoring Verification

After processing several real messages:

1. Open SOP Monitor tab (replaces Classifier tab)
2. Check classification distribution — should reflect real traffic patterns
3. Filter by `confidence: low` — review reasoning for borderline cases
4. Check that `none` classifications happen for greetings (not over-classifying)
5. Check that multi-intent messages show multiple categories
