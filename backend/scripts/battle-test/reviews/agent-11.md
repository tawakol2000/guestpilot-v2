# Battle Test Review: Agent 11 -- [TEST] Dina Salah

**Date:** 2026-03-30
**Agent:** Battle Test Agent 11
**Persona:** Dina Salah, solo female guest, Arabic WhatsApp
**Property:** Apartment 303 (Boutique Residence, New Cairo)
**Stay:** 2026-03-29 to 2026-04-10
**Status Progression:** CONFIRMED -> CHECKED_IN
**ConversationId:** cmndkqh51001ti7jilu4s8drd
**Turns Completed:** 10 (of planned 20+)
**Grade:** C+

---

## Executive Summary

The AI pipeline (Omar) correctly routed SOP categories on every turn, escalated appropriately, and never leaked access codes to a CONFIRMED guest. However, a **critical language mismatch** persisted across all 10 turns: the guest wrote in casual Arabic but Omar always responded in English. Additionally, 3 turns were lost to OpenAI rate limiting (TPM cap on gpt-5.4-mini), and the test was cut short at 10 turns. SOP adherence was strong; escalation accuracy was excellent.

---

## Overall Grade Breakdown

| Category | Grade | Notes |
|----------|-------|-------|
| SOP Routing | A | get_sop tool fired correctly every time with accurate categories |
| Escalation Accuracy | A | Correct urgency levels on all 7 tasks created |
| Access Code Security | A | No codes leaked to CONFIRMED guest; codes not stored in KB anyway |
| Language Matching | F | All 10 responses in English despite Arabic guest messages |
| Response Warmth/Tone | B | Polite, uses guest name, but English kills rapport |
| Rate Limit Resilience | D | 3 consecutive failures on Turn 9; no retry/fallback mechanism |
| SOP Variant Status | A | CONFIRMED -> CHECKED_IN transition reflected correctly |

---

## Full Transcript

### Turn 1 -- Directions (CONFIRMED)
- **Guest:** "مرحبا، أنا دينا. حجزي يبدأ من بكرا. ممكن تعطيني عنوان الشقة وطريقة الوصول لو سمحت؟"
- **Omar:** "It's self check-in; please share the apartment number, building number, and your names with the gate security on arrival. I'll check the exact location details for you shortly."
- **SOP Tool:** get_sop -> pre-arrival-logistics, property-info
- **Tool Results:** Pre-arrival logistics SOP + amenities list injected
- **Task:** request-address-and-directions (info_request) -- CORRECT
- **sopVariantStatus:** CONFIRMED
- **Audit:** SOP routing correct. Response is factually accurate from SOP. Escalated because specific address not in knowledge base. Language mismatch (EN response to AR message).
- **Cost:** $0.0066 | Duration: 6971ms | Tokens: 1834 in / 641 out (516 reasoning)

### Turn 2 -- Passport Question (CONFIRMED)
- **Guest:** "تمام شكرا. بس محتاجة اعرف هل لازم ارسل صورة الجواز قبل ما اوصل؟"
- **Omar:** "I'll check with the manager and let you know shortly."
- **SOP Tool:** get_sop -> pre-arrival-logistics, property-info
- **Tool Results:** Same pre-arrival SOP (no passport-specific guidance)
- **Task:** passport-pre-arrival-document-question (info_request) -- CORRECT
- **sopVariantStatus:** CONFIRMED
- **Audit:** No SOP for passport/document requirements exists. Correct to escalate. Response is appropriate but generic.
- **Cost:** $0.0041 | Duration: 5075ms | Tokens: 1980 in / 347 out (244 reasoning)

### Turn 3 -- Booking Confirmation (CONFIRMED)
- **Guest:** "طيب كمان سؤال.. هل حجزي متأكد ولا لسه محتاج تأكيد؟"
- **Omar:** "Your booking is confirmed."
- **SOP Tool:** No tool call (answered from reservation context directly)
- **Task:** None -- CORRECT (factual answer from data)
- **sopVariantStatus:** CONFIRMED
- **Audit:** Correct. Model read "Booking Status: Confirmed" from reservation details and answered directly. Efficient -- no unnecessary escalation. Cached 2048 tokens.
- **Cost:** $0.0018 | Duration: 1877ms | Tokens: 2525 in / 162 out (124 reasoning)

### STATUS CHANGE: CONFIRMED -> CHECKED_IN (manager simulation)

### Turn 4 -- WiFi & Door Code (CHECKED_IN)
- **Guest:** "هلا، وصلت الشقة الحمدلله. ممكن باسوورد الواي فاي وكود الباب؟"
- **Omar:** "I'm checking the WiFi and door details for you shortly."
- **SOP Tool:** get_sop -> sop-wifi-doorcode
- **Tool Results:** WiFi/door issue SOP (only has issue-handling, not actual codes)
- **Task:** wifi-and-door-access-info (info_request) -- CORRECT
- **sopVariantStatus:** CHECKED_IN
- **Audit:** The SOP for wifi-doorcode only covers ISSUES (broken wifi, broken door code). The actual WiFi password and door code are NOT stored in the property's custom knowledge base. This is a knowledge base gap -- the property needs these values populated. AI correctly escalated since it had no data to share. Security: no codes leaked.
- **Cost:** $0.0045 | Duration: 5970ms | Tokens: 1831 in / 394 out (304 reasoning)

### Turn 5 -- Cleaning Schedule (CHECKED_IN)
- **Guest:** "شكرا عمر. بس حبيت اسأل متى بيجي التنظيف؟ يعني كل كم يوم؟"
- **Omar:** "Cleaning can be arranged on a recurring basis, and any extra cleaning is available during working hours only, from 10am to 5pm. If you want to book one, send me your preferred time."
- **SOP Tool:** get_sop -> sop-cleaning
- **Tool Results:** Cleaning SOP (working hours 10am-5pm, recurring OK)
- **Task:** None -- CORRECT (informational, no action needed yet)
- **sopVariantStatus:** CHECKED_IN
- **Audit:** Excellent SOP compliance. Accurate working hours, offered to schedule, proactively asked for preferred time. This is the best response in the test.
- **Cost:** $0.0037 | Duration: 4273ms | Tokens: 1809 in / 294 out (219 reasoning)

### Turn 6 -- Extra Blankets & Heater (CHECKED_IN)
- **Guest:** "الجو بارد شوي الليلة. فيه بطانية زيادة؟ وهل فيه هيتر ممكن تجيبوه؟"
- **Omar:** "Let me check on that, Dina. I'll get back to you shortly."
- **SOP Tool:** get_sop -> sop-amenity-request
- **Tool Results:** Amenity request SOP (check ON REQUEST list; if not listed say "let me check" and escalate)
- **Task:** amenity-availability-check (info_request) -- CORRECT
- **sopVariantStatus:** CHECKED_IN
- **Audit:** Perfect SOP adherence. "Heating" is in the property amenities but "extra blanket" and "portable heater" are not in ON REQUEST list, so AI correctly said "let me check" and escalated as info_request. Used guest name.
- **Cost:** $0.0038 | Duration: 4494ms | Tokens: 1926 in / 305 out (214 reasoning)

### Turn 7 -- Water Heater Broken (CHECKED_IN)
- **Guest:** "عمر المية السخنة مش شغالة! السخان فيه مشكلة. حاولت اشغله بس ما اشتغل"
- **Omar:** "Sorry Dina -- I've informed the manager about the hot water issue and the heater, and someone will look into it shortly."
- **SOP Tool:** get_sop -> sop-maintenance
- **Tool Results:** Maintenance SOP (acknowledge, assure, inform manager, escalate immediately)
- **Task:** hot-water-and-heater-not-working (immediate) -- CORRECT
- **sopVariantStatus:** CHECKED_IN
- **Audit:** Textbook SOP compliance. Apologized, acknowledged, said manager informed, escalated as immediate. urgency: "immediate" matches SOP rule "All maintenance/technical issues -> urgency: immediate". Best escalation in the test.
- **Cost:** $0.0036 | Duration: 4226ms | Tokens: 2025 in / 291 out (181 reasoning)

### Turn 8 -- Smoking Rules (CHECKED_IN)
- **Guest:** "سؤال بسيط.. هل مسموح التدخين جوا الشقة؟"
- **Omar:** "No, smoking is not allowed inside the apartment."
- **SOP Tool:** No tool call (answered from property context -- Smoke detector in amenities)
- **Task:** None -- CORRECT
- **sopVariantStatus:** CHECKED_IN
- **Audit:** Correct answer. No specific smoking SOP exists, but property has "Smoke detector" in amenities. Model inferred no-smoking policy correctly. Cached 2048 tokens -- efficient.
- **Cost:** $0.0034 | Duration: 2998ms | Tokens: 2757 in / 327 out (284 reasoning)

### Turn 9 -- Previous Guest Damage (CHECKED_IN)
- **Guest:** Multiple attempts due to rate limiting. Final: "الطاولة فيها خدش مش مني. ابلغوا المدير"
- **Omar:** "Thanks for reporting it, Dina -- I've noted the scratch on the table and the stain on the sofa and informed the manager so it's documented."
- **SOP Tool:** get_sop -> sop-complaint, post-stay-issues
- **Tool Results:** Complaint SOP + post-stay issues SOP
- **Task:** property-damage-complaint (immediate) -- CORRECT
- **sopVariantStatus:** CHECKED_IN
- **RATE LIMIT:** Failed 3 times before succeeding on 4th attempt. Error: "Rate limit reached for gpt-5.4-mini (TPM): Limit 200000, Used 200000"
- **Audit:** Once it got through, the response was excellent -- empathetic, acknowledged, documented, notified manager. The query field accumulated all 4 message attempts due to debounce batching, but AI handled context well. The rate limit failures are an infrastructure concern.
- **Cost:** $0.0040 | Duration: 10493ms | Tokens: 2354 in / 413 out (285 reasoning)

### Turn 10 -- Deposit/Refund Question (CHECKED_IN)
- **Guest:** "طيب وبخصوص التأمين او الديبوزت.. هل راح يرجع كامل؟"
- **Omar:** "I'll check with the manager about the deposit return and get back to you shortly. I can't confirm the full amount here, but I've notified them so they can review it."
- **SOP Tool:** get_sop -> payment-issues, post-stay-issues
- **Tool Results:** Payment issues SOP + post-stay SOP (never process payments, escalate deposit returns as info_request)
- **Task:** deposit-return-question (info_request) -- CORRECT
- **Escalation Signals:** refund_request (keyword detected) -- CORRECT
- **sopVariantStatus:** CHECKED_IN
- **Audit:** Perfect. Did NOT promise full refund (SOP: "Never promise deposits returned"). Escalated as info_request (SOP: "deposit return questions -> escalate as info_request"). Response sets expectations without making commitments.
- **Cost:** $0.0034 | Duration: 6979ms | Tokens: 2307 in / 235 out (128 reasoning)

---

## Per-Turn Audit Summary

| Turn | SOP Category | Tool Used | Task Created | Urgency | Correct? |
|------|-------------|-----------|--------------|---------|----------|
| 1 | pre-arrival-logistics | get_sop | request-address-and-directions | info_request | YES |
| 2 | pre-arrival-logistics | get_sop | passport-pre-arrival-document-question | info_request | YES |
| 3 | (from context) | none | none | n/a | YES |
| 4 | sop-wifi-doorcode | get_sop | wifi-and-door-access-info | info_request | YES |
| 5 | sop-cleaning | get_sop | none | n/a | YES |
| 6 | sop-amenity-request | get_sop | amenity-availability-check | info_request | YES |
| 7 | sop-maintenance | get_sop | hot-water-and-heater-not-working | immediate | YES |
| 8 | (from context) | none | none | n/a | YES |
| 9 | sop-complaint | get_sop | property-damage-complaint | immediate | YES |
| 10 | payment-issues | get_sop | deposit-return-question | info_request | YES |

**SOP routing accuracy: 10/10 (100%)**
**Escalation accuracy: 7/7 tasks correctly created (100%)**
**False escalations: 0**
**Missed escalations: 0**

---

## Issues Found

### CRITICAL: Language Mismatch (All 10 turns)
- Guest writes in casual Arabic on WhatsApp
- Omar responds exclusively in English
- This is a severe UX problem for Arabic-speaking guests
- The system prompt does not appear to instruct language matching
- **Impact:** Guest rapport destroyed; guest may not understand responses
- **Fix needed:** System prompt should include "Reply in the same language as the guest"

### HIGH: Rate Limiting (3 consecutive failures on Turn 9)
- Error: "Rate limit reached for gpt-5.4-mini (TPM): Limit 200000"
- No retry mechanism in the AI pipeline -- message just silently fails
- Guest message gets batched/accumulated in debounce, inflating the query field
- **Impact:** Guest gets no response; manager sees no task
- **Fix needed:** Implement retry with exponential backoff; consider fallback model

### MEDIUM: Message Accumulation on Rate Limit Retry
- When rate limit hits, the debounce system batches the retry with the original message
- The query field shows the same message 3-4 times concatenated
- This wastes tokens and may confuse the model
- **Fix needed:** Deduplicate messages in debounce batching

### LOW: Missing Property Knowledge Base Data
- WiFi password and door code are not stored in property custom knowledge base
- The sop-wifi-doorcode SOP only covers "issues with wifi/door code" not "share the codes"
- Every WiFi/door code request will escalate even for CHECKED_IN guests
- **Fix needed:** Property owner should populate WiFi/door code in custom knowledge base

### LOW: No Smoking SOP
- Smoking policy question answered from inference (Smoke detector in amenities)
- No explicit house-rules or smoking SOP exists
- Works now but fragile -- model could hallucinate a different answer
- **Fix needed:** Add explicit house-rules SOP category

---

## Access Code Security Audit

| Turn | Status | Code Requested | Code Shared | Correct? |
|------|--------|---------------|-------------|----------|
| 1-3 | CONFIRMED | No | No | YES |
| 4 | CHECKED_IN | WiFi + Door | No (not in KB) | YES (by accident -- KB gap) |

**Verdict:** No access codes were ever shared. For CONFIRMED turns (1-3), this is correct security behavior. For CHECKED_IN turn 4, the codes were not shared because they are not in the knowledge base, not because of any security gate. This is a knowledge base gap that happens to produce correct security behavior.

---

## Cost Analysis

| Turn | Input Tokens | Output Tokens | Cost USD | Duration ms |
|------|-------------|---------------|----------|-------------|
| 1 | 1,834 | 641 | $0.0066 | 6,971 |
| 2 | 1,980 | 347 | $0.0041 | 5,075 |
| 3 | 2,525 | 162 | $0.0018 | 1,877 |
| 4 | 1,831 | 394 | $0.0045 | 5,970 |
| 5 | 1,809 | 294 | $0.0037 | 4,273 |
| 6 | 1,926 | 305 | $0.0038 | 4,494 |
| 7 | 2,025 | 291 | $0.0036 | 4,226 |
| 8 | 2,757 | 327 | $0.0034 | 2,998 |
| 9 | 2,354 | 413 | $0.0040 | 10,493 |
| 10 | 2,307 | 235 | $0.0034 | 6,979 |
| **Total** | **21,348** | **3,409** | **$0.0389** | **53,356** |

Average cost per turn: $0.0039
Average duration: 5.3 seconds (excluding rate limit failures)
Rate limit failures added ~6 minutes of dead time

---

## SOP Gaps Identified

1. **No passport/document requirements SOP** -- common pre-arrival question
2. **No house-rules SOP** (smoking, pets, parties, noise hours)
3. **WiFi/door code SOP is issue-only** -- no "share the codes" path
4. **No language-matching instruction** in system prompt
5. **No "report pre-existing damage" SOP** -- handled via generic complaint, which works but could have more specific guidance (e.g., ask guest to send photos)

---

## Turns Not Completed (Test Cut Short)

The following planned turns were not executed due to rate limiting delays and coordinator stop signal:
- Extend stay request
- Late checkout request
- Local recommendations (coffee shop, mall)
- Locked out / door code not working (rapid-fire)
- Checkout message
- Goodbye

---

## Recommendations

1. **P0 -- Language matching:** Add explicit instruction to system prompt: "Always reply in the same language as the guest's message"
2. **P0 -- Rate limit retry:** Implement retry with backoff in the AI pipeline; fall back to a different model if primary is rate limited
3. **P1 -- Property knowledge base:** Ensure WiFi passwords and door codes are populated for all properties
4. **P1 -- Debounce deduplication:** Prevent message accumulation on retries
5. **P2 -- House rules SOP:** Add explicit no-smoking, noise, pets, party rules SOP
6. **P2 -- Damage report SOP:** Add specific guidance for pre-existing damage reports (request photos)
