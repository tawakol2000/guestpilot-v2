# Battle Test 025 R2 -- SOP Agent 4: Booking Confirmation & Long-Term Rental

**Date:** 2026-04-02
**Persona:** Booking Confirm Test (CONFIRMED, Booking.com channel, 1 guest)
**Conversation:** cmngt2u6y000n12emrhy5rcid
**Reservation:** cmngt2u4m000l12em7oe3alwe (check-in 2026-04-06, check-out 2026-04-10)
**Model:** gpt-5.4-mini-2026-03-17
**Agent:** Omar

---

## Results Summary

| # | Guest Message | Expected SOP | Actual SOP (get_sop categories) | Correct? | Escalation | Notes |
|---|---|---|---|---|---|---|
| 1 | "Can you confirm my booking is in the system?" | sop-booking-confirmation | payment-issues, sop-booking-cancellation, none | NO | None | Wrong SOPs entirely -- picked payment + cancellation instead of confirmation |
| 2 | "What are my exact dates and how many guests?" | sop-booking-confirmation | (no get_sop call -- sopCategories: ["none"]) | NO | None | Answered from reservation data, skipped get_sop entirely |
| 3 | "Is this apartment available for a 1-month stay?" | sop-long-term-rental | (no get_sop call -- used check_extend_availability) | NO | None | Treated as extension, not long-term rental inquiry |
| 4 | "What's the monthly rate?" | sop-long-term-rental or pricing-negotiation | pricing-negotiation, none | PARTIAL | None | Got pricing-negotiation (acceptable) but missed sop-long-term-rental |
| 5 | "Can I cancel my booking? What's the policy?" | sop-booking-cancellation | sop-booking-cancellation | YES | info_request (booking-cancellation-policy) | Correct SOP + correct escalation |
| 6 | "Actually never mind, I'll keep the booking. Any discounts for longer stays?" | pricing-negotiation | pricing-negotiation | YES | None (resolved cancellation task) | Correct SOP, smart task management |
| 7 | "I want to pay by bank transfer, is that possible?" | payment-issues | payment-issues | YES | info_request (bank-transfer-payment-method) | Correct SOP + correct escalation |
| 8 | "Can you send me a receipt?" | payment-issues | payment-issues | YES | info_request (receipt-request) | Correct SOP + correct escalation |

**SOP Routing Accuracy:** 4/8 correct, 1/8 partial, 3/8 wrong
**Escalation Accuracy:** 4/4 -- every escalation-worthy turn was correctly escalated
**Primary Target SOPs:** sop-booking-confirmation 0/2, sop-long-term-rental 0/2

---

## Key Checks

### 1. Does sop-booking-confirmation ever get triggered?
**NO -- FAIL.** Neither turn 1 nor turn 2 triggered `sop-booking-confirmation`.

- Turn 1: "Can you confirm my booking is in the system?" was classified as `payment-issues, sop-booking-cancellation, none`. The AI's reasoning was "Guest is asking to confirm their reservation status in the system, which is a booking/reservation question" -- correct reasoning, wrong categories. The tool description for `sop-booking-confirmation` is "Verifying reservation exists, checking booking status/details" which should have matched.
- Turn 2: "What are my exact dates and how many guests?" did not trigger get_sop at all. The AI answered directly from reservation details (sopCategories: `["none"]`). This is defensible behavior -- the info was in the reservation context -- but the SOP should still have been consulted.

### 2. Does sop-long-term-rental ever get triggered?
**NO -- FAIL.** Neither turn 3 nor turn 4 triggered `sop-long-term-rental`.

- Turn 3: "Is this apartment available for a 1-month stay?" went straight to `check_extend_availability` tool instead of get_sop. The AI treated it as a date extension (extending from 4 nights to 30), not as a distinct long-term rental inquiry. The SOP explicitly says "Monthly stays, corporate housing, or stays longer than 3 weeks" -- a 1-month stay is the textbook case.
- Turn 4: "What's the monthly rate?" triggered `pricing-negotiation` only. The pricing-negotiation SOP itself says "For long-term stay pricing, also tag with sop-long-term-rental" but the AI did not follow this instruction. Escalation signals correctly detected `long_term_inquiry` but the SOP tool call did not include the category.

### 3. Are booking confirmation responses still adequate without the SOP?
**YES, partially.** The AI answered correctly from the reservation context:
- Turn 1: "Yes -- your booking is confirmed and in the system for 2026-04-06 to 2026-04-10." (correct)
- Turn 2: "Your stay is confirmed for 2026-04-06 to 2026-04-10 for 1 guest." (correct)

But without the SOP, the AI misses the escalation rule: "For guests claiming they booked but no record found or there is a problem, escalate as immediate." If the booking HAD been missing, the AI would not know to escalate.

### 4. Are long-term rental responses adequate without the SOP?
**NO -- FAIL.** Turn 3 answered "It isn't available for a 1-month stay" and offered a 2-night extension. The long-term rental SOP says: "Ask: duration needed, move-in date, number of guests, any preferences. Escalate as long-term-rental with all details." Instead of gathering requirements and escalating, the AI shut down the request by treating it as an extension. This is a materially wrong response.

Turn 4 answered "There isn't a monthly rate for this apartment" -- also wrong. The SOP says "monthly rates are different and need manager approval. Tell the guest I will inform the manager." The AI should have escalated, not denied.

---

## Detailed Observations

### Strengths
1. **Payment SOP routing is excellent.** Turns 7 and 8 both correctly identified `payment-issues` with high confidence and escalated appropriately.
2. **Cancellation SOP routing is correct.** Turn 5 correctly matched `sop-booking-cancellation` and escalated as `info_request`.
3. **Task management is smart.** Turn 6 resolved the cancellation task when the guest said "never mind."
4. **Escalation discipline is strong.** All 4 escalation-worthy turns (5, 7, 8, and the auto-created delivery failures) were escalated with proper urgency levels.
5. **Response quality for "easy" SOPs is good.** Cancellation, payment, and pricing responses followed SOP guidance accurately.

### Issues

#### ISSUE 1: sop-booking-confirmation never selected -- ROUTING BUG
**Severity:** High
**Impact:** Booking confirmation SOP content is never injected. For simple "confirm my booking" queries this is fine (answer is in context), but for edge cases (no booking found, booking discrepancy) the AI won't know to escalate as immediate.
**Root Cause Hypothesis:** The tool description for `sop-booking-confirmation` ("Verifying reservation exists, checking booking status/details") is short and overlaps with what the AI can answer from reservation context. The AI "knows" the booking exists, so it doesn't think it needs an SOP. Meanwhile, the word "confirm" in the guest message may be priming the model toward `sop-booking-cancellation` (which also deals with booking lifecycle).
**Suggested Fix:** Strengthen the `sop-booking-confirmation` tool description to differentiate it clearly: "Guest is asking if their reservation exists, verifying booking details (dates, guests, unit), or checking booking status. Also use when the guest shares a confirmation number or asks 'did you receive my booking'. NOT for cancellation or modification."

#### ISSUE 2: sop-long-term-rental never selected -- ROUTING BUG
**Severity:** High
**Impact:** Monthly stay inquiries get treated as extensions (wrong tool) or pricing questions (incomplete SOP). The AI incorrectly denies long-term availability instead of gathering requirements and escalating to manager.
**Root Cause Hypothesis:** Two factors:
1. The `check_extend_availability` tool description likely matches "1-month stay" before get_sop is called (tool selection priority).
2. For pricing questions, the AI reads `pricing-negotiation` SOP which says "also tag with sop-long-term-rental" but the model already committed its tool call with only `pricing-negotiation`.
**Suggested Fix:**
- Add "NOT for monthly stays, corporate housing, or relocations (use get_sop with sop-long-term-rental first)" to `check_extend_availability` description.
- Add "Monthly rate, monthly stay, 1-month, corporate housing, relocating" as explicit trigger phrases in the `sop-long-term-rental` tool description.

#### ISSUE 3: Turn 3 uses wrong tool entirely -- TOOL SELECTION BUG
**Severity:** High
**Response:** "It isn't available for a 1-month stay -- the apartment is booked starting 2026-04-12, so the maximum extension is 2 nights until 2026-04-12."
**Problem:** Guest asked about a 1-month stay -- a fundamentally different request type than extending a 4-night booking by 2 days. The AI should have called `get_sop` with `sop-long-term-rental`, gathered requirements, and escalated. Instead it used `check_extend_availability` and told the guest "no" -- potentially losing a valuable long-term rental lead.
**Expected:** "I'd be happy to help with a monthly stay. Could you share the dates you're looking at, and how many guests? Monthly rates are different from nightly rates, so I'll check with the manager and get back to you."

#### ISSUE 4: Turn 4 denies monthly rate instead of escalating -- POLICY VIOLATION
**Severity:** High
**Response:** "There isn't a monthly rate for this apartment, as it's not available for a month-long stay."
**Problem:** The SOP explicitly says "monthly rates are different and need manager approval. Escalate as long-term-rental. Tell the guest I will inform the manager for additional discount." The AI made up a policy ("there isn't a monthly rate") instead of following the SOP.
**Note:** The AI did detect `long_term_inquiry` as an escalation signal but still did not escalate.

#### ISSUE 5: Turn 1 selects completely wrong SOPs -- CLASSIFICATION ERROR
**Severity:** Medium
**Actual categories:** `payment-issues, sop-booking-cancellation, none`
**Expected:** `sop-booking-confirmation`
**Problem:** "Confirm my booking" was interpreted as a payment/cancellation question. The reasoning said "booking/reservation question" but the categories went to cancellation and payment. This is a pure classification error -- the model had `sop-booking-confirmation` in the enum with the description "Verifying reservation exists, checking booking status/details" and still didn't select it.

---

## Cost & Performance

| Turn | Input Tokens | Output Tokens | Cost USD | Duration (ms) | Cached |
|------|-------------|--------------|----------|---------------|--------|
| 1 | 2,806 | 112 | $0.0015 | 3,491 | 2,048 |
| 2 | 2,701 | 237 | $0.0025 | 3,218 | 2,048 |
| 3 | 3,066 | 302 | $0.0033 | 5,824 | 2,048 |
| 4 | 3,217 | 584 | $0.0060 | 6,652 | 2,048 |
| 5 | 3,175 | 331 | $0.0035 | 3,902 | 2,048 |
| 6 | 3,757 | 474 | $0.0050 | 7,351 | 2,560 |
| 7 | 3,481 | 459 | $0.0050 | 52,125 | 2,048 |
| 8 | 3,864 | 413 | $0.0046 | 6,236 | 2,560 |
| **Total** | **26,067** | **2,912** | **$0.0314** | **88,799** | |

Note: Turn 7 had anomalous 52s latency (vs ~5s typical). Likely a transient Railway/OpenAI delay.

---

## Verdict

**sop-booking-confirmation: MISSED** (0/2 triggers). The SOP exists, its tool description is adequate, but the model does not select it. Needs stronger tool description differentiation and possibly prompt-level instruction.

**sop-long-term-rental: MISSED** (0/2 triggers). The SOP exists but competes with `check_extend_availability` (tool priority) and `pricing-negotiation` (partial overlap). The AI incorrectly denies long-term availability and monthly rates instead of escalating to manager. This is the more damaging bug -- it potentially loses long-term rental business.

### Recommended Actions
1. **P0:** Update `check_extend_availability` tool description to exclude monthly/long-term inquiries, directing them to `get_sop` with `sop-long-term-rental` instead.
2. **P0:** Strengthen `sop-long-term-rental` tool description with explicit trigger phrases: "monthly stay, 1-month, monthly rate, corporate housing, relocation, long-term, 3+ week stay."
3. **P1:** Strengthen `sop-booking-confirmation` tool description to differentiate from cancellation/modification: "Use when guest asks 'is my booking confirmed', 'did you receive my reservation', 'can you confirm my dates'. NOT for cancellation or changes."
4. **P2:** Consider adding a system prompt instruction: "For any message mentioning 'monthly', 'month-long', or stays over 21 days, ALWAYS call get_sop with sop-long-term-rental before using check_extend_availability."
