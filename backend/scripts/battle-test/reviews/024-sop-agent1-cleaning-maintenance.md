# Battle Test 024 -- SOP Routing: Cleaning, Maintenance, Amenities, WiFi/Doorcode

**Date:** 2026-04-01
**Persona:** Sara Mostafa (CHECKED_IN guest, 2 guests)
**Conversation:** cmng5junu0005l3b6885jw68b
**Model:** gpt-5.4-mini-2026-03-17
**Agent:** Omar

---

## Results Summary

| # | Guest Message | Expected SOP | Actual SOP | Correct? | Response Summary | Escalation |
|---|---|---|---|---|---|---|
| 1 | "We'd like to get the apartment cleaned please" | sop-cleaning | sop-cleaning | YES | Mentioned hours (10am-5pm), asked for preferred time | None |
| 2 | "Can we do 2pm tomorrow?" | sop-cleaning | sop-cleaning | YES | Confirmed 2pm tomorrow, will arrange | cleaning-schedule-request (scheduled) |
| 3 | "Can we get extra towels and pillows?" | sop-amenity-request | sop-amenity-request | YES | "Let me check on that" (items not in ON REQUEST list) | amenity-request (info_request) |
| 4 | "The air conditioning isn't working, it's blowing warm air" | sop-maintenance | sop-maintenance | YES | Acknowledged, assured manager informed | ac-not-cooling (immediate) |
| 5 | "Also the bathroom faucet is leaking" | sop-maintenance | sop-maintenance | YES | Reported the leak, someone will check | bathroom-faucet-leak (immediate) |
| 6 | "What's the WiFi password?" | sop-wifi-doorcode | sop-wifi-doorcode | YES | Provided WiFi name (BR 103) and password (BR@12345678) | None |
| 7 | "The WiFi keeps disconnecting, very slow" | sop-wifi-doorcode | sop-wifi-doorcode | YES | Apologized, reported the issue | wifi-connectivity-issue (immediate) |
| 8 | "I'm locked out, the door code isn't working" | sop-wifi-doorcode | sop-wifi-doorcode + escalate | YES | Apologized, checking right away | door-code-lockout (immediate) |
| 9 | "Can we get an iron and ironing board?" | sop-amenity-request | sop-amenity-request | YES | "Let me check on that" (items not in ON REQUEST list) | amenity-request (info_request) |
| 10 | "There's a weird smell coming from the kitchen drain" | sop-maintenance | sop-maintenance | YES | Acknowledged, manager informed | kitchen-drain-smell (immediate) |

---

## SOP Routing Accuracy: 10/10 (100%)

Every message was routed to the correct SOP category via the `get_sop` tool. The model showed high confidence on all classifications. No misroutes or fallbacks.

---

## SOP Adherence Analysis

### sop-cleaning (Turns 1-2)
- **Turn 1:** Correctly mentioned working hours (10am-5pm) and asked for time. However, the SOP content returned does not mention a $20 fee -- so the SOP definition itself may be missing the fee information. Omar cannot mention what isn't in the SOP.
- **Turn 2:** Correctly confirmed the time and escalated as "scheduled". Good follow-up handling -- recognized context from previous turn.

### sop-amenity-request (Turns 3, 9)
- **Turn 3:** Items (towels, pillows) not in ON REQUEST AMENITIES list, so correctly said "Let me check on that" and escalated as `info_request`. Textbook SOP adherence.
- **Turn 9:** Same pattern for iron/ironing board. Correctly followed the "not listed" branch.

### sop-maintenance (Turns 4, 5, 10)
- **Turn 4:** AC not cooling -- acknowledged, assured manager informed, escalated as "immediate". Perfect SOP adherence.
- **Turn 5:** Leaking faucet -- same pattern. Correctly created separate escalation task.
- **Turn 10:** Kitchen drain smell -- correctly classified as maintenance (SOP explicitly lists "smell"). Immediate escalation.

### sop-wifi-doorcode (Turns 6, 7, 8)
- **Turn 6:** WiFi password request -- provided credentials directly (BR 103 / BR@12345678). Guest is CHECKED_IN so this is appropriate. No escalation needed.
- **Turn 7:** WiFi issue -- apologized and escalated per SOP. Correct.
- **Turn 8:** Door code lockout -- apologized and escalated as "immediate". SOP says "this is a big issue and needs sorting right away" -- Omar followed this. Also triggered the `locked_out` escalation signal. Additionally requested `escalate` category alongside `sop-wifi-doorcode`.

---

## Observations

### Strengths
1. **100% SOP routing accuracy** -- the `get_sop` tool call correctly identified the right SOP category every single time.
2. **Correct escalation urgency** -- all maintenance issues got "immediate", amenity unknowns got "info_request", cleaning schedule got "scheduled".
3. **Context awareness** -- Turn 2 correctly understood the scheduling follow-up related to the cleaning request from Turn 1.
4. **Escalation signal detection** -- Turn 8 detected `locked_out` as an escalation signal in addition to the SOP routing.
5. **Concise, professional tone** -- all responses are short, empathetic, and action-oriented.
6. **No hallucination** -- Omar never invented information not in the SOP or property context.
7. **Guest status compliance** -- WiFi/doorcode info was provided because guest is CHECKED_IN. Would need a separate test to verify INQUIRY status is blocked.

### Issues Found
1. **Missing $20 cleaning fee** -- The test expected a $20 fee mention for cleaning, but the SOP content itself does not include fee information. This is a content gap in the SOP definition, not a model failure. **Action: review SOP definition for sop-cleaning to add fee if applicable.**
2. **No door code shared on lockout** -- Turn 8 did not re-share the door code (1050503#) when the guest said it wasn't working. The SOP says to "escalate immediately" for door code issues, which Omar did. However, sharing the code could help the guest try again. This is debatable -- if the code genuinely isn't working, re-sharing won't help.
3. **Task update collision on Turn 9** -- Omar tried to update the existing amenity-request task from Turn 3 (`updateTaskId`) instead of creating a new one. The iron request is a different amenity than towels/pillows. This could cause the original task to lose its context. Minor issue but worth monitoring.
4. **message-delivery-failure tasks** -- Multiple delivery failure tasks appeared because Hostaway returns 404 for test conversations. Expected in test environment, but these clutter the open tasks list and consume context window space.

### Performance
- Average response time: ~7s (range: 4.5s to 19s, Turn 1 was slowest likely due to cold start)
- Average cost per turn: ~$0.004 USD
- Model: gpt-5.4-mini-2026-03-17 with temperature 0.25
- Reasoning tokens used: 38-516 per turn (median ~200)
- Input token cache hits observed on some turns (1,280 cached tokens when consecutive)

---

## Verdict: PASS

SOP routing is working flawlessly. The `get_sop` tool correctly identifies the right SOP category for every message type tested. Response quality is high -- concise, follows SOP instructions, creates appropriate escalations with correct urgency levels. The only content gap (missing cleaning fee) is in the SOP definition itself, not the AI's behavior.
