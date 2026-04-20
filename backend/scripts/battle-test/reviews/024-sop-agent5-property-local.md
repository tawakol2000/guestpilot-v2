# Battle Test 024 — SOP Routing: Property Info, Local Recommendations, Pre/Post-Stay

**Date:** 2026-04-01
**Agent:** Omar (gpt-5.4-mini-2026-03-17)
**Persona:** Tom & Emily Parker (British couple, 2 guests)
**Reservation:** cmng5jvbd000rl3b6pbvv7g8o
**Conversation:** cmng5jvda000tl3b6m2xa4m6f
**Phases:** CONFIRMED (Turns 1-5) -> CHECKED_IN (Turns 6-10)

---

## Results Table

| Turn | Message | Expected SOP | Actual SOP | Expected Tool | Actual Tool | Correct? | Response Summary |
|------|---------|-------------|------------|---------------|-------------|----------|------------------|
| 1 | "What does the apartment look like? How many bedrooms and bathrooms?" | property-info | property-description, property-info | get_sop | get_sop | YES | Accurately described 2 bedrooms, 2 en-suite bathrooms, pool/garden access, outdoor lounge, garden views |
| 2 | "Is there a swimming pool?" | property-info | property-info | get_sop | get_sop | YES | Confirmed swimming pool from amenities list |
| 3 | "Do you have any apartments with a sea view? We'd love a view" | property-info | property-info | search_available_properties | get_sop | PARTIAL | Correctly noted no sea view in amenities. Escalated as info_request. Did NOT call search_available_properties tool |
| 4 | "How do we get to the apartment from Cairo airport?" | pre-arrival-logistics | pre-arrival-logistics | get_sop | get_sop | PARTIAL | Correctly routed to pre-arrival-logistics SOP. Escalated because property data lacks specific airport directions. Did not provide any directions at all |
| 5 | "What's the address and how do we get through the compound gate?" | pre-arrival-logistics | property-info, pre-arrival-logistics | get_sop | get_sop | YES | Correctly gave gate instructions (share apartment/building number and names with security). Escalated for exact address since it's not in property data |
| 6 | "Can you recommend a good restaurant nearby?" | local-recommendations | none, escalate | get_sop | get_sop | YES | Correctly escalated as info_request. No local knowledge available. Response was brief: "I'll check and get back to you shortly" |
| 7 | "Where's the nearest pharmacy?" | local-recommendations | escalate | get_sop | get_sop | YES | Correctly escalated as info_request. No local knowledge. Response: "I'll check the nearest pharmacy options and get back to you shortly" |
| 8 | "Is there a shopping mall close by?" | local-recommendations | property-description, escalate | get_sop | get_sop | YES | Answered using property description data (mentions O1 Mall access). Smart use of available info. Also created sop-tool-escalation task |
| 9 | "We're checking out tomorrow, what should we know?" | sop-late-checkout / property-info | sop-late-checkout | get_sop | get_sop | YES | Correctly routed to sop-late-checkout. Provided checkout time (11 AM) and late checkout policy. No unnecessary escalation |
| 10 | "We left a jacket in the apartment after checkout, can you check?" | post-stay-issues | post-stay-issues | get_sop | get_sop | YES | Correctly followed SOP: asked for item description, escalated as immediate with proper task title "lost-item-after-checkout" |

---

## Scorecard

| Metric | Result |
|--------|--------|
| **SOP routing accuracy** | 9/10 correct (90%) |
| **Tool selection accuracy** | 9/10 correct for get_sop, 0/1 for search_available_properties |
| **Escalation accuracy** | 7/7 correct escalations (100%) |
| **Response quality** | 8/10 — all responses were appropriate and followed SOPs |
| **Total cost** | $0.033 USD across 10 turns |
| **Avg response time** | ~6.2 seconds |

---

## Key Findings

### 1. search_available_properties tool was NOT triggered (Turn 3)
**Severity: Medium**
When the guest asked "Do you have any apartments with a sea view?", the AI used `get_sop` with `property-info` category, saw that "sea view" is not in the amenities list, and escalated. This is a *reasonable* fallback, but the `search_available_properties` tool exists precisely for this scenario -- when a guest wants something the current property doesn't have. The AI never attempted to call it.

**Root cause hypothesis:** The AI may not have `search_available_properties` in its tool definitions, or it may not be primed to consider cross-selling other properties when the current one lacks a requested feature.

### 2. Local recommendations correctly escalate (Turns 6-8)
All three local recommendation queries correctly escalated because the AI has no local knowledge beyond what's in the property description. Turn 8 (shopping mall) was especially smart -- it used the property description's mention of "O1 Mall" to provide a partial answer while also flagging for escalation. This is ideal behavior.

### 3. Pre-arrival logistics partially answered (Turns 4-5)
Turn 4 (airport directions) escalated entirely without providing any information -- it could have at least mentioned "Silver Palm, New Cairo" from the property description. Turn 5 was better, providing gate instructions from the SOP while escalating for the exact address.

### 4. Post-stay SOP followed perfectly (Turn 10)
The AI asked for a description of the lost item before promising anything, escalated as `immediate` urgency, and created a well-titled task. This exactly follows the SOP.

### 5. Checkout procedures handled well (Turn 9)
Correctly routed to `sop-late-checkout`, provided the 11 AM checkout time, and explained the late checkout policy without confirming any late checkout.

### 6. Property info queries highly accurate (Turns 1-2)
The AI accurately pulled bedroom/bathroom counts, amenities, and property features from the injected property data.

### 7. Escalation signals working
System signals were correctly detected: `transportation` (Turn 4), `local_recommendation` (Turns 6-8). These signals helped the AI decide when to escalate.

### 8. sop-tool-escalation auto-task behavior
When the AI includes `escalate` in the `get_sop` categories, a `sop-tool-escalation` task is automatically created BEFORE the AI even responds. This happened in Turns 6, 7, and 8. In Turn 8, this created a duplicate escalation effect -- the auto-task was created but the AI then answered the question directly using property data. This is not harmful but creates unnecessary tasks.

---

## Issues to Investigate

1. **search_available_properties tool not being called** -- Check if it's included in the tool definitions and if the system prompt guides the AI to use it when a guest wants amenities the current property doesn't have.

2. **Turn 4 could provide partial info** -- The AI knows the property is in "Silver Palm, New Cairo" from the property description but didn't share this when asked about airport directions. The SOP says "Share property address and location from your knowledge."

3. **sop-tool-escalation double-task** -- When AI categories include `escalate`, a task is auto-created. If the AI then also creates its own escalation task, two tasks are created for the same issue. Consider deduplication logic.

---

## Verdict

**Overall: GOOD (8/10)**

SOP routing is working well across the board. The `get_sop` tool consistently selects the right categories. The main gap is the `search_available_properties` tool never being triggered -- this is a missed upselling opportunity. Local recommendation handling is appropriately conservative (always escalates). Post-stay and checkout SOPs are followed precisely.
