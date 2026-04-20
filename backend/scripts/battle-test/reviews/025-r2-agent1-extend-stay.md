# 025-R2 Agent 1: Extend Stay Tool Validation

**Date:** 2026-04-02
**Conversation:** cmngt2tk8000512emn76owvss
**Reservation:** cmngt2tfz000312em7jbklvz0
**Guest:** [TEST] Extend Stay Test
**Property:** Boutique Residence (BR 103)
**Model:** gpt-5.4-mini-2026-03-17
**Branch:** 022-deep-code-cleanup

## Purpose

Validate that `check_extend_availability` tool is correctly invoked for date change requests. This was broken in Round 1 -- the AI never called the tool. Round 2 tests whether the deep code cleanup fixed the issue.

## Test Matrix

| Turn | Status | Message | Expected Tool | Actual Tool | check_extend called? | Tool Input | Response Summary |
|------|--------|---------|---------------|-------------|---------------------|------------|-----------------|
| 1 | CONFIRMED | "I'd like to extend my stay by 3 more nights, until April 15th" | check_extend_availability | check_extend_availability | YES | new_checkout: 2026-04-15 | Not available Apr 12-15, offered to ask manager |
| 2 | CONFIRMED | "Can I also check out 2 days later, on April 17th instead?" | check_extend_availability | check_extend_availability | YES | new_checkout: 2026-04-17 | Not available Apr 12-17, offered alternatives |
| 3 | CONFIRMED | "Actually, can I change my check-in to April 3rd instead?" | check_extend_availability | check_extend_availability | YES | new_checkin: 2026-04-03 | Booked from Apr 5, can't move earlier. Escalated (early-checkin-change-request) |
| -- | -> CHECKED_IN | (status change + resolve tasks) | -- | -- | -- | -- | -- |
| 4 | CHECKED_IN | "I'm checked in now, but I want to extend by 2 more nights" | check_extend_availability | check_extend_availability | YES | new_checkout: 2026-04-14 | Not available, escalated (extend-stay-unavailable) |
| 5 | CHECKED_IN | "What's the price for those extra nights?" | reference tool result | check_extend_availability | YES (re-checked) | new_checkout: 2026-04-14 | Re-checked, still unavailable, can't quote price |
| 6 | CHECKED_IN | "Can I get a late checkout on my last day?" | get_sop(sop-late-checkout) | get_sop(sop-late-checkout) | N/A | categories: [sop-late-checkout] | "Can only confirm 2 days before" -- correct SOP |
| 7 | CHECKED_IN | "What time is normal checkout?" | get_sop | get_sop(sop-late-checkout, pre-arrival-logistics) | N/A | categories: [sop-late-checkout, pre-arrival-logistics] | "11:00 AM" -- correct |
| 8 | CHECKED_IN | "What's the WiFi password?" | get_sop(sop-wifi-doorcode) | get_sop(sop-wifi-doorcode) | N/A | categories: [sop-wifi-doorcode] | "BR 103 / BR@12345678" -- correct, status is CHECKED_IN so codes shared |

## Results Summary

**check_extend_availability: 5/5 calls successful (100%)**
- Turns 1-5 all correctly invoked `check_extend_availability`
- Turn 3 correctly used `new_checkin` (not `new_checkout`) for early check-in request
- Turn 5 re-invoked the tool to re-check availability rather than just referencing history -- acceptable behavior

**get_sop: 3/3 calls successful (100%)**
- Turn 6: Correct SOP (`sop-late-checkout`) with correct "2 days before" policy
- Turn 7: Correct SOPs (`sop-late-checkout` + `pre-arrival-logistics`) -- answered 11:00 AM
- Turn 8: Correct SOP (`sop-wifi-doorcode`) -- shared codes because status is CHECKED_IN

**Escalation behavior:**
- Turn 3: Escalated early check-in change (correct -- can't resolve autonomously)
- Turn 4: Escalated extend-stay-unavailable (correct -- property blocked)
- Turns 1, 2, 5: No escalation (correct -- informed guest directly)

**Access code security:**
- WiFi + door code only shared when status = CHECKED_IN (Turn 8) -- correct

## Verdict: PASS

All 8 turns behaved correctly. The `check_extend_availability` tool is now reliably called for every date change request, across both CONFIRMED and CHECKED_IN statuses, for both check-in and check-out modifications. This is a complete fix from Round 1 where the tool was never invoked.

## Observations

1. **Tool re-invocation on Turn 5:** The AI re-checked availability when asked about pricing rather than referencing the prior tool result from Turn 4. This is slightly wasteful (extra 637ms + API cost) but safe behavior -- ensures fresh data.
2. **All responses unavailable:** The test property appears to have conflicting bookings blocking all extensions. This validates the tool correctly detects conflicts but means we didn't test the "available" path. A future test should use a property with open availability.
3. **message-delivery-failure tasks:** Every turn creates a delivery failure task (Hostaway 404) because this is a test reservation. These are expected and were resolved between turns.
4. **Prompt caching:** Turns 2+ show `cachedInputTokens: 2048`, indicating OpenAI prompt caching is working.
5. **sopVariantStatus:** Correctly reflects CONFIRMED for turns 1-3 and CHECKED_IN for turns 4-8.
