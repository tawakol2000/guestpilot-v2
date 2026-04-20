# Battle Test 024 — SOP Agent Test: Extend Stay + Checkout Flows

**Date:** 2026-04-01
**Persona:** David Chen (CONFIRMED -> CHECKED_IN, solo, Canadian)
**Conversation:** cmng5jv1p000hl3b6ngzcg2q0
**Reservation:** cmng5juzl000fl3b6ktkgn6t4
**Model:** gpt-5.4-mini-2026-03-17

---

## Results Table

| Turn | Message | Expected SOP | Actual SOP | Expected Tool | Actual Tool | Correct? | Response Summary |
|------|---------|-------------|------------|---------------|-------------|----------|------------------|
| 1 | "Hi, can I check in a few hours early? My flight lands at noon" | sop-early-checkin | sop-early-checkin | get_sop | get_sop | YES | Correctly told guest early check-in confirmed 2 days before, offered bag storage + O1 Mall tip. No escalation (>2 days out). |
| 2 | "Can I also get a late checkout on my last day?" | sop-late-checkout | sop-late-checkout | get_sop | get_sop | YES | Correctly said can only confirm 2 days before departure, standard checkout 11 AM. Created escalation task (scheduled). |
| 3 | "Actually, I'd like to extend my stay by 3 more nights" | sop-booking-modification | pricing-negotiation + escalate | check_extend_availability | get_sop only | PARTIAL | Routed to pricing-negotiation instead of sop-booking-modification. check_extend_availability tool NOT called. AI claimed apartment unavailable (possibly fabricated). Did escalate correctly. |
| 4 | "What's the price for the extra nights?" | pricing-negotiation | pricing-negotiation | get_sop | get_sop | YES | Correctly referenced prior unavailability context. Did not offer pricing (correct per SOP). |
| 5 | "Can I change my check-in date to 2 days earlier?" | sop-booking-modification | escalate (no SOP match) | check_extend_availability | get_sop only | PARTIAL | Escalated correctly but no specific SOP found — classified as generic "escalate". check_extend_availability not called. Response was appropriate. |
| 6 | "I've checked in, everything looks great" | none (ack) | none | none | none | YES | Simple acknowledgment, no SOP needed, no escalation. Perfect. |
| 7 | "I'd like to extend my stay by 2 more nights, can you check availability?" | sop-booking-modification | pricing-negotiation | check_extend_availability | get_sop only | FAIL | **AI produced malformed JSON** — multiple empty JSON blocks concatenated with the real response. Message saved as AI_PRIVATE (parse failure). Retried once, same result. Guest got no response. |
| 8 | "Can I get a late checkout on my last day, maybe until 2pm?" | sop-late-checkout | sop-late-checkout + pricing-negotiation | get_sop | get_sop | PARTIAL | Correctly hit sop-late-checkout, but context pollution from failed turn 7 caused the query to include extend-stay text. AI conflated topics — mentioned "apartment isn't available for 2 extra nights" in a late checkout response. |
| 9 | "What time is the normal checkout?" | sop-late-checkout or property-info | sop-late-checkout | get_sop | get_sop | YES | Perfect response. "Standard checkout is 11:00 AM." Offered to check late checkout closer to date. Clean, concise. |
| 10 | "Is there a gym or fitness center nearby?" | property-info or local-recommendations | property-description + property-info | get_sop | get_sop | YES | Correctly pulled property description + amenities. Confirmed gym exists. Accurate answer from knowledge base. |

---

## Scorecard

| Metric | Value |
|--------|-------|
| Total turns | 10 |
| Fully correct | 6 |
| Partially correct | 3 |
| Failed | 1 |
| Accuracy | 60% full / 90% partial-or-better |

---

## Critical Findings

### BUG: Malformed JSON on Extend Stay (Turn 7) — CRITICAL

The AI produced concatenated JSON output for extend-stay requests when status is CHECKED_IN:

```
{"guest_message":"","escalation":null,...}{"guest_message":"","escalation":null,...}{"guest_message":"I'll check that...","escalation":{...},...}
```

This happened on BOTH attempts (turn 7 original and retry). The pattern is always: one or more empty JSON blocks followed by the real response. The JSON parser correctly rejects this, but the guest receives no response at all. This is a **production-breaking bug** for extend-stay requests from checked-in guests.

**Root cause hypothesis:** The model may be producing multiple "attempts" in a single completion when handling extend-stay + pricing SOP together. The empty JSON blocks look like aborted first attempts before the model settles on a response.

**Recommendation:** Add JSON response extraction that handles concatenated JSON — parse the last valid JSON block, or strip empty-message blocks before parsing.

### ISSUE: check_extend_availability Tool Never Called

Across 3 extend-stay requests (turns 3, 5, 7), the `check_extend_availability` tool was **never called**. Instead, the AI:
- Turn 3: Used get_sop with `pricing-negotiation` + `escalate`, then fabricated that the apartment was unavailable
- Turn 5: Escalated directly without checking availability
- Turn 7: Failed with malformed JSON

The extend-stay flow appears to have no working `check_extend_availability` tool integration. Either:
1. The tool is not available in the tool definitions provided to the model
2. The SOP for booking modifications does not instruct the AI to use it
3. The model doesn't know when to use it

**Recommendation:** Verify that `check_extend_availability` is registered as a tool in the AI pipeline and that the booking-modification SOP explicitly instructs the AI to call it.

### ISSUE: No sop-booking-modification SOP Exists

Turns 3 and 5 both expected `sop-booking-modification` but the AI never selected it. Turn 3 fell back to `pricing-negotiation`, turn 5 fell back to generic `escalate` (empty SOP content returned). This suggests there is no `sop-booking-modification` category defined in the SOP variants.

**Recommendation:** Create a dedicated `sop-booking-modification` SOP variant that covers: extend stay, change dates, shorten stay, add guests. It should instruct the AI to use `check_extend_availability` for date extensions.

### ISSUE: Context Pollution from Failed Messages (Turn 8)

The failed extend-stay messages (turn 7) leaked into the query for turn 8. The `ragContext.query` field contained:
```
"I'd like to extend my stay by 2 more nights, can you check availability? I'd like to extend my stay by 2 more nights, can you check availability? Can I get a late checkout on my last day, maybe until 2pm?"
```

This caused the AI to pull both `sop-late-checkout` AND `pricing-negotiation` SOPs and conflate the two topics in its response.

**Root cause:** Unanswered guest messages (where AI response failed) accumulate in the query builder and pollute subsequent SOP lookups.

**Recommendation:** The debounce/query builder should exclude messages that already have a failed AI_PRIVATE response, or at minimum not duplicate them.

---

## What Worked Well

1. **SOP early-checkin (Turn 1):** Perfect routing, perfect response, correct SOP variant for CONFIRMED status (>2 days before check-in).
2. **SOP late-checkout (Turns 2, 9):** Consistently correct routing. Correctly differentiated between requesting late checkout (escalate) and asking about checkout time (inform only).
3. **Property info (Turn 10):** Pulled accurate amenity data from knowledge base. Correctly identified the gym amenity.
4. **Escalation behavior:** When in doubt, the AI escalated correctly. Task titles and notes were descriptive and actionable.
5. **No-SOP acknowledgment (Turn 6):** Correctly recognized a simple greeting and responded minimally without unnecessary SOP routing.
6. **Pricing SOP (Turn 4):** Did not offer pricing or discounts, correctly per SOP. Referenced context from prior unavailability.

---

## Cost Summary

| Turn | Input Tokens | Output Tokens | Cost (USD) | Duration (ms) |
|------|-------------|---------------|------------|----------------|
| 1 | 1,663 | 168 | $0.0024 | 5,328 |
| 2 | 1,791 | 388 | $0.0043 | 4,747 |
| 3 | 2,274 | 354 | $0.0043 | 8,233 |
| 4 | 2,603 | 602 | $0.0061 | 9,264 |
| 5 | 2,263 | 623 | $0.0060 | 8,847 |
| 6 | 2,610 | 220 | $0.0024 | 2,067 |
| 7 | 1,974 | 964 | $0.0089 | 9,790 |
| 8 | 2,632 | 388 | $0.0051 | 9,025 |
| 9 | 2,151 | 91 | $0.0022 | 4,004 |
| 10 | 2,328 | 178 | $0.0031 | 5,170 |
| **Total** | **22,289** | **3,976** | **$0.0448** | **66,475** |

Average cost per turn: $0.0045 | Average latency: 6.6s

---

## Action Items

1. **[P0]** Fix malformed JSON output on extend-stay requests — add last-valid-JSON extraction or strip empty blocks
2. **[P0]** Investigate why `check_extend_availability` tool is never called — verify tool registration and SOP instructions
3. **[P1]** Create `sop-booking-modification` SOP variant covering date changes, extensions, and booking adjustments
4. **[P1]** Fix context pollution — prevent failed/unanswered messages from duplicating in the SOP query builder
5. **[P2]** Turn 2 escalated late-checkout as "scheduled" even though checkout is >2 days away — per SOP, it should NOT escalate when >2 days before checkout (only inform)
