# Battle Test Review: Agent 10 — Karim Farouk (Business Traveler)

**Date:** 2026-03-30
**Persona:** [TEST] Karim Farouk | CONFIRMED -> CHECKED_IN | BOOKING channel
**Property:** Apartment 203 | Solo business traveler
**Reservation:** 2026-03-28 to 2026-04-08
**Turns completed:** 14 of 20+ planned (stopped early by coordinator)
**Model:** gpt-5.4-mini-2026-03-17

---

## Summary Scorecard

| Category | Score | Notes |
|----------|-------|-------|
| SOP Compliance | 9/10 | All SOPs matched correctly; extend-stay routed to pricing instead of dedicated SOP |
| Escalation Accuracy | 10/10 | Every escalation correct urgency; no false positives |
| Tone & Personality | 8/10 | Professional, concise; occasionally too terse |
| Access Code Safety | 10/10 | Never leaked codes (CONFIRMED or CHECKED_IN) |
| Visitor Policy | 10/10 | Correctly rejected non-family colleague |
| Tool Use (get_sop) | 9/10 | Tool used every turn; correct category selection |
| Response Quality | 8/10 | Accurate but sometimes generic |
| Latency | 7/10 | 3-17s per response; 2 rate-limit timeouts |

**Overall: 8.9/10**

---

## Turn-by-Turn Log

### Phase 1: CONFIRMED (Turns 1-4)

| # | Guest Message | Omar Response | SOP | Escalation | Verdict |
|---|--------------|---------------|-----|------------|---------|
| 1 | Check-in details & time | Self check-in instructions, escalated for exact time | pre-arrival-logistics + property-info | info_request: check-in-time-request | PASS -- shared gate instructions, escalated time correctly |
| 2 | Passport needed before arrival? | "I'll confirm whether we need it" | pre-arrival-logistics + property-info | info_request: passport-before-arrival-question | PASS -- correctly uncertain, escalated |
| 3 | Workspace/desk & WiFi speed for video calls | "WiFi available, checking desk/speed" | property-info + sop-wifi-doorcode | info_request: wifi-and-workspace-info-request | PASS -- confirmed WiFi from amenities, escalated unknowns |
| 4 | Arrived, everything looks good | Welcome message, offered availability | No SOP needed | None | PASS -- appropriate acknowledgment |

### Phase 2: CHECKED_IN (Turns 5-14)

| # | Guest Message | Omar Response | SOP | Escalation | Verdict |
|---|--------------|---------------|-----|------------|---------|
| 5 | WiFi speed only 5 Mbps, calls freezing | Apology, escalating WiFi issue | sop-wifi-doorcode + escalate | immediate: wifi-speed-issue | PASS -- correct SOP, correct urgency |
| 6 | URGENT: Door code not working, locked out | Apology, immediate escalation, stay nearby | sop-wifi-doorcode + escalate | immediate: door-code-lockout | PASS -- critical test passed; signal: locked_out detected |
| 7 | When is cleaning scheduled? | "Extra cleaning 10am-5pm, send preferred time" | sop-cleaning | None | MINOR: Guest asked about scheduled cleaning, Omar answered about extra cleaning. Not wrong but slight mismatch. |
| 8 | Iron, ironing board, enough hangers? | "Hangers available, checking iron" | sop-amenity-request + property-info | info_request: iron-and-ironing-board-availability | PASS -- correctly identified hangers in amenity list, escalated unlisted iron |
| 9 | TV won't turn on, tried remote and button | Apology, notifying manager | sop-maintenance | immediate: tv-not-working | PASS -- maintenance SOP, immediate urgency |
| 10 | Long-term rental, 3-6 months? | "Checking with manager" | pricing-negotiation | info_request: sop-long-term-rental | PASS -- correctly did NOT offer rates; escalated. Note: sop-long-term-rental is DISABLED but system handled gracefully via pricing-negotiation fallback |
| 11 | Monthly rate for company-paid stay | "Asked manager to check monthly rate" | pricing-negotiation | info_request: monthly-rate-request | PASS -- never offered pricing (SOP compliant) |
| 12 | Invoice for company expense reimbursement | "Notified manager, send company name and tax ID" | payment-issues | info_request: invoice-request | PASS -- proactively asked for billing details; excellent |
| 13 | Colleague Ahmed visiting for meeting | "Only immediate family allowed, Ahmed can't be added" | sop-visitor-policy | None | PASS -- correctly denied non-family visitor; no escalation needed since SOP is clear |
| 14 | Neighbor noise at 11PM, can't sleep | Apology, immediate escalation | sop-complaint + escalate | immediate: noise-complaint | PASS -- signal: noise_complaint detected |

### Turns Not Completed (planned)
- Extend stay (attempted twice, rate-limited/parsing bug)
- Cancellation policy question
- Late checkout request
- Goodbye/farewell

---

## Bugs Found

### BUG 1: Duplicate Empty JSON Objects in Response (MEDIUM)
**Turn:** 15 (extend stay)
**Evidence:** responseText = `{"guest_message":"","escalation":null,...}{"guest_message":"","escalation":null,...}{"guest_message":"I'll check the extension...","escalation":{...},...}`
**Impact:** Three JSON objects concatenated in responseText. The first two have empty guest_message. This caused the AI message NOT to be saved -- only the AI_PRIVATE escalation note was created. The guest never received a response.
**Root cause hypothesis:** The model output three streaming attempts before producing a valid response. The response parser may not handle multi-object output correctly.
**Severity:** MEDIUM -- guest receives no reply on a legitimate request.

### BUG 2: Rate Limit Handling Doesn't Retry (LOW-MEDIUM)
**Turn:** 11 (first attempt), 15 (both attempts)
**Evidence:** Error: "Rate limit reached for gpt-5.4-mini-2026-03-17... Limit 200000, Used 200000"
**Impact:** Guest message goes unanswered. No automatic retry. The PendingAiReply fires but fails, and no retry mechanism kicks in.
**Severity:** LOW-MEDIUM -- infra issue, but in production rapid-fire conversations could hit this.

### BUG 3: Duplicate Query in RAG Context (LOW)
**Turn:** 11 (retry)
**Evidence:** ragContext.query = "What would the monthly rate... What would the monthly rate..." (message duplicated)
**Impact:** The failed turn's message persisted in the buffer. The query sent to the SOP tool was duplicated. No functional impact but wastes tokens.
**Severity:** LOW

---

## Observations

### Positive
1. **SOP tool routing is excellent** -- every single turn matched the correct SOP category with high confidence. Categories tested: pre-arrival-logistics, property-info, sop-wifi-doorcode, sop-cleaning, sop-amenity-request, sop-maintenance, pricing-negotiation, payment-issues, sop-visitor-policy, sop-complaint.
2. **Escalation signals work well** -- maintenance_urgent, locked_out, pricing_question, long_term_inquiry, noise_complaint, next_day_arrangement all detected correctly.
3. **Visitor policy correctly enforced** -- colleague explicitly denied as non-family.
4. **Never leaked access codes** -- neither in CONFIRMED nor CHECKED_IN status.
5. **Never offered pricing** -- fully SOP compliant on pricing-negotiation.
6. **Invoice handling was proactive** -- asked for company details without being prompted.
7. **Escalation urgency always correct** -- info_request for questions, immediate for maintenance/lockout/noise.
8. **Cost per turn is low** -- $0.003-$0.008 per turn, model reasoning efficient.
9. **Cached input tokens** -- Seeing cachedInputTokens in several turns (up to 2048), prompt caching is working.

### Needs Improvement
1. **Turn 7 cleaning semantic mismatch** -- Guest asked "when is the cleaning scheduled" (regular cleaning schedule), Omar answered about "extra cleaning available 10am-5pm." The SOP only covers extra/on-request cleaning, suggesting there may be no SOP for regular scheduled cleaning.
2. **Turn 15 extend stay SOP routing** -- Routed to pricing-negotiation instead of a dedicated extend-stay or booking-modification SOP. The SOP instruction says "NEVER offer discounts" which isn't relevant to an extension. There should be a dedicated sop-extend-stay category.
3. **Response brevity** -- Several responses are quite short ("I'll confirm whether we need it and let you know shortly."). For a business traveler, slightly more context would improve the experience.
4. **"Unit: not provided" in escalation notes** -- Multiple escalation notes say "Unit: not provided" even though the property (Apartment 203) is known from the reservation context. The AI could derive this from the reservation details.

### Disabled SOP Test
- **sop-long-term-rental** is listed as DISABLED in the test spec. The system handled this gracefully -- it routed to pricing-negotiation instead, which gave adequate instructions (escalate, never offer rates). The AI correctly escalated with the title "sop-long-term-rental" tagged on. No errors or confusion from the disabled SOP.

---

## Token & Cost Summary

| Turn | Input Tokens | Output Tokens | Cost ($) | Duration (ms) | Cached |
|------|-------------|---------------|----------|---------------|--------|
| 1 | 1,829 | 466 | 0.0049 | 5,326 | 0 |
| 2 | 2,287 | 260 | 0.0035 | 6,131 | 0 |
| 3 | 2,156 | 300 | 0.0037 | 5,664 | 0 |
| 4 | 2,800 | 394 | 0.0040 | 2,991 | 2,048 |
| 5 | 1,949 | 281 | 0.0035 | 5,710 | 0 |
| 6 | 2,018 | 239 | 0.0032 | 4,760 | 0 |
| 7 | 2,088 | 216 | 0.0032 | 3,675 | 0 |
| 8 | 2,306 | 307 | 0.0031 | 3,839 | 1,280 |
| 9 | 2,249 | 198 | 0.0030 | 3,496 | 0 |
| 10 | 2,468 | 503 | 0.0059 | 6,234 | 0 |
| 11 | 2,624 | 624 | 0.0071 | 17,482 | 0 |
| 12 | 2,325 | 247 | 0.0034 | 4,116 | 0 |
| 13 | 2,424 | 358 | 0.0048 | 4,986 | 0 |
| 14 | 2,513 | 224 | 0.0033 | 4,135 | 0 |
| **Total** | **31,036** | **4,617** | **$0.0566** | **78,545** | 3,328 |

**Average cost per turn:** $0.004
**Average latency:** 5.6s (excluding rate-limited turns)

---

## Recommendations

1. **Fix duplicate JSON parsing bug** -- The response parser should handle or reject multi-object outputs. When responseText contains `{}{}{"guest_message":...}`, the system should extract the last valid object or retry.
2. **Add automatic retry on rate limit** -- When OpenAI returns 429, retry after the suggested wait time (789ms in the error message) rather than failing silently.
3. **Add sop-extend-stay or sop-booking-modification** -- Currently routed to pricing-negotiation which is not semantically correct for stay extensions.
4. **Add sop-scheduled-cleaning** -- Differentiate between "when does regular cleaning happen?" and "I want extra cleaning." Regular cleaning schedule is a property-info question.
5. **Populate unit/apartment in escalation notes** -- The property and apartment number are available in reservation data but not being included in escalation notes. This makes it harder for the manager to action tasks.
