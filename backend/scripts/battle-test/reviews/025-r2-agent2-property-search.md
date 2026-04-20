# Battle Test 025 R2 -- Property Search Tool (search_available_properties)

**Date:** 2026-04-02
**Agent:** Omar (gpt-5.4-mini-2026-03-17)
**Persona:** [TEST] Property Search Test (2 guests)
**Reservation:** cmngt2tq8000912ems3ccutl1
**Conversation:** cmngt2ts6000b12em6chlv8y0
**Status:** CONFIRMED
**Channel:** WhatsApp

---

## Results Table

| Turn | Message | Expected Tool | Actual Tool | search_available_properties Called? | Correct? | Response Summary |
|------|---------|---------------|-------------|-------------------------------------|----------|------------------|
| 1 | "Does the apartment have a sea view?" | get_sop(property-info), then search_available_properties | get_sop(property-info) | NO | FAIL | Correctly noted no sea view (garden views). Did NOT search for alternatives. |
| 2 | "Do you have any apartments with a jacuzzi?" | search_available_properties | get_sop(property-info) | NO | FAIL | Noted no jacuzzi. Escalated as info_request. Did NOT search. |
| 3 | "We need a 4-bedroom apartment, this one is too small" | search_available_properties | get_sop(property-info, pricing-negotiation) | NO | FAIL | Noted 2 bedrooms. Escalated as info_request. Did NOT search. |
| 4 | "Is there a balcony?" | get_sop(property-info) | get_sop(property-info) | N/A | PASS | Correctly confirmed balcony from amenities list. No escalation. |
| 5 | "Do you have any villas instead of apartments?" | search_available_properties | get_sop(property-info, escalate) | NO | FAIL | Noted it's an apartment. Escalated as info_request. Did NOT search. |
| 6 | "What about a place with a private garden?" | search_available_properties | get_sop(property-info) | NO | PARTIAL | Property has "Garden or backyard" and "direct garden access" -- AI reasonably answered the property has this feature. Debatable whether search was needed. |
| 7 | "How many bedrooms does this apartment have?" | get_sop(property-info) | get_sop(property-info) | N/A | PASS | Correctly answered 2 bedrooms with en-suite bathrooms. No escalation. |
| 8 | "Is there parking available?" | get_sop(property-info) | get_sop(property-info) | N/A | PASS | Correctly confirmed private parking + free street parking. No escalation. |

---

## Scorecard

| Metric | Result |
|--------|--------|
| **search_available_properties triggered** | 0/5 expected calls (0%) |
| **Property info from data (turns 4,7,8)** | 3/3 correct (100%) |
| **SOP routing accuracy** | 8/8 correct property-info routing (100%) |
| **Escalation quality** | 3/3 correct escalations when search was unavailable |
| **Response quality** | 8/8 appropriate responses (100%) |
| **Total cost** | $0.0236 USD across 8 turns |
| **Avg response time** | ~6.4 seconds |

---

## ROOT CAUSE FOUND

### search_available_properties is not available for CONFIRMED reservations

**File:** `src/services/tool-definition.service.ts`, line 134
**Value:** `agentScope: 'INQUIRY,PENDING'`

The `search_available_properties` tool has its `agentScope` set to `INQUIRY,PENDING` only. Since this test reservation has status `CONFIRMED`, the tool is **filtered out** before being sent to the AI model. The AI literally cannot call the tool -- it is not in its tool list.

This explains why the AI consistently falls back to escalating with `info_request` urgency when guests ask for amenities the property does not have. The AI's behavior is actually correct given its available tools: it uses `get_sop(property-info)`, reads the SOP instruction to call `search_available_properties`, but cannot comply because the tool does not exist in its context.

### Fix

Change `agentScope` in `src/services/tool-definition.service.ts` (line 134) from:
```
agentScope: 'INQUIRY,PENDING',
```
to:
```
agentScope: 'INQUIRY,PENDING,CONFIRMED,CHECKED_IN',
```

This would make the tool available for all active reservation statuses, enabling cross-selling at any stage of the guest journey.

**Note:** The same scope change may also need to be applied in the database if tool definitions are stored there (the `ToolDefinition` model). The seed definitions in `tool-definition.service.ts` are only used if the database has no entries yet.

---

## Key Findings

### 1. AI response quality is high despite the missing tool
Even without `search_available_properties`, the AI responded appropriately:
- Correctly identified missing amenities (sea view, jacuzzi) from property data
- Created well-titled escalation tasks with good context
- Never fabricated property alternatives or made up availability
- Answered positively when the property HAS the amenity (balcony, parking, garden)

### 2. Turn 6 (private garden) is a judgment call
The guest asked for "a place with a private garden." The property has "Garden or backyard" in amenities and "direct garden access" in its description. The AI treated this as the property having the feature. This is reasonable -- the question is ambiguous about whether the guest wants an alternative property or is asking about this one.

### 3. SOP instruction creates a contradiction
The `property-info` SOP says: "If the guest asks for an amenity or feature this property does NOT have, call search_available_properties." But for CONFIRMED reservations, the tool doesn't exist. This creates a silent conflict where the SOP instructs the AI to do something it cannot do.

### 4. Every turn triggered message-delivery-failure tasks
All turns except Turn 8 created `message-delivery-failure` tasks because the Hostaway API returned 404 for this test conversation. This is expected for test data but clutters the task list.

### 5. Previous test (024, Turn 3) had the same finding
The 024-sop-agent5-property-local review identified this exact issue: "search_available_properties tool was NOT triggered." The root cause was never investigated until now.

---

## Verdict

**Overall: BLOCKED (0/5 search calls)**

The `search_available_properties` tool cannot fire for CONFIRMED reservations because the `agentScope` excludes it. This is a configuration bug, not a prompt or model issue. The fix is a one-line change to the agentScope. After fixing, a retest should show the AI calling the tool for turns 1, 2, 3, and 5.
