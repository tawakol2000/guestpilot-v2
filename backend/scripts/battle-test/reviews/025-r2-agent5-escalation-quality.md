# 025-R2 Escalation Quality Test

**Date:** 2026-04-02
**Conversation:** cmngt2udb000t12em86qxoe4f
**Reservation:** cmngt2uat000r12em8487khxd (CONFIRMED, check-in Apr 1)
**Model:** gpt-5.4-mini-2026-03-17
**Messages sent:** 8

---

## Results Summary

### Checklist (from previous round issues)

| Check | Result |
|-------|--------|
| No sop-tool-escalation tasks | PASS -- zero found |
| No duplicate tasks for same issue | PARTIAL -- pharmacy + restaurant are separate local-rec tasks (supermarket correctly updated restaurant task via updateTaskId) |
| Local rec escalations = info_request (not immediate) | PASS -- all info_request |
| Total tasks reasonable | PASS -- 4 real escalation tasks for 8 messages (+ 8 message-delivery-failure from test env) |

### Overall: PASS (significant improvement over R1)

---

## Task Summary Table

| # | Task Title | Urgency | Type | Duplicate? | Correct Urgency? |
|---|-----------|---------|------|------------|-------------------|
| 1 | nearest-pharmacy-info-request | info_request | local-rec | No | YES |
| 2 | nearest-supermarket-info-request (was nearby-restaurant, updated by msg 3) | info_request | local-rec | Partial -- pharmacy is separate | YES |
| 3 | cleanliness-complaint-review-threat (was cleanliness-complaint-on-arrival, updated by msg 5) | immediate | complaint | No -- correctly merged | YES |
| 4 | ac-noise-maintenance-issue | immediate | maintenance | No | YES |

**Note:** 8x `message-delivery-failure` tasks are expected -- this is a test reservation with no real Hostaway listing (404 on send).

---

## Per-Message Breakdown

### Message 1: "Where's the nearest pharmacy?"
- **SOP:** local-recommendations (via get_faq)
- **Escalation:** nearest-pharmacy-info-request (info_request)
- **Verdict:** CORRECT -- info_request urgency, not immediate

### Message 2: "Is there a good restaurant nearby?"
- **SOP:** local-recommendations (via get_faq)
- **Escalation:** nearby-restaurant-info-request (info_request) -- NEW task
- **Verdict:** CORRECT urgency, but created a second local-rec task instead of updating the pharmacy one
- **Note:** The AI saw the open pharmacy task but chose to create a separate one -- minor issue

### Message 3: "Where's the nearest supermarket?"
- **SOP:** local-recommendations (via get_faq)
- **Escalation:** Used updateTaskId to update the restaurant task (title -> nearest-supermarket-info-request)
- **Verdict:** CORRECT -- consolidated note references all 3 requests, updated existing task
- **Note:** Good behavior -- the AI recognized the pattern and merged on the 3rd request

### Message 4: "The apartment wasn't clean when we arrived"
- **SOP:** sop-complaint
- **Escalation:** cleanliness-complaint-on-arrival (immediate)
- **Verdict:** CORRECT -- immediate urgency for cleanliness complaint per SOP

### Message 5: "I'm going to leave a bad review"
- **SOP:** sop-complaint
- **Escalation:** Used updateTaskId to update the cleanliness task (title -> cleanliness-complaint-review-threat, note updated)
- **Verdict:** EXCELLENT -- correctly linked review threat to existing cleanliness complaint, updated urgency note to emphasize the escalation

### Message 6: "Can my friend visit tonight?"
- **SOP:** sop-visitor-policy
- **Escalation:** null (no escalation)
- **Response:** Correctly denied -- "only immediate family members are allowed"
- **Verdict:** CORRECT -- handled autonomously per SOP, no unnecessary escalation

### Message 7: "The AC is making a loud noise"
- **SOP:** sop-maintenance
- **Escalation:** ac-noise-maintenance-issue (immediate)
- **Verdict:** CORRECT -- all maintenance issues should be immediate per SOP

### Message 8: "Can we get extra towels?"
- **SOP:** sop-amenity-request
- **Escalation:** null (no escalation)
- **Response:** Correctly noted towels aren't on the on-request list
- **Verdict:** CORRECT -- handled autonomously, no unnecessary escalation

---

## Improvements vs R1

1. **sop-tool-escalation tasks eliminated** -- the fix from last round worked
2. **Local recommendations now info_request** -- was immediate in R1, now correctly info_request
3. **updateTaskId working** -- messages 3 and 5 correctly updated existing tasks instead of duplicating
4. **No over-escalation** -- visitor policy and amenity request handled without unnecessary tasks
5. **Total real tasks: 4** for 8 messages (was 8+ in R1)

## Remaining Issues (Minor)

1. **Pharmacy vs restaurant not consolidated** -- message 2 created a new task instead of updating the pharmacy task. Message 3 then correctly updated message 2's task. Ideally all 3 local-rec requests should merge into one task.
2. **Towel response could be better** -- "Extra towels aren't listed as an on-request item" is technically correct but could be more helpful (e.g., "I'll check with the manager" or escalate as info_request). Most guests expect towels to be available.

---

## Token/Cost Summary

| Message | Input Tokens | Output Tokens | Reasoning Tokens | Cost (USD) | Duration |
|---------|-------------|---------------|-------------------|------------|----------|
| 1 (pharmacy) | 3,261 | 199 | 132 | $0.0019 | 6.3s |
| 2 (restaurant) | 2,790 | 449 | 382 | $0.0044 | 7.1s |
| 3 (supermarket) | 3,170 | 626 | 516 | $0.0061 | 9.0s |
| 4 (cleanliness) | 3,163 | 320 | 238 | $0.0035 | 4.9s |
| 5 (review threat) | 3,414 | 406 | 294 | $0.0043 | 5.0s |
| 6 (visitor) | 3,311 | 225 | 174 | $0.0026 | 3.5s |
| 7 (AC noise) | 3,460 | 280 | 213 | $0.0034 | 4.1s |
| 8 (towels) | 3,505 | 563 | 516 | $0.0058 | 6.3s |
| **Total** | **26,074** | **3,068** | **2,465** | **$0.032** | **46.2s** |
