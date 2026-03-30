# Battle Test Review -- Agent 21

**Agent:** Battle Test Agent 21
**Persona:** [TEST] Samira Fathy -- CHECKED_IN guest (Arabic speaker)
**Reservation Status:** CHECKED_IN
**Channel:** AIRBNB
**Property:** Apartment 202
**Dates:** 2026-04-01 to 2026-04-11 (10 nights, 3 guests)
**Total Turns Completed:** 9 (of 20+ planned; stopped early due to rate limits + coordinator halt)
**Model:** gpt-5.4-mini-2026-03-17
**Date:** 2026-03-30

---

## 1. Overall Grade: C+

Functional accuracy is solid -- SOP routing, escalation urgency, and policy knowledge are all correct. However, two critical failures dominate: (1) Omar never responds in Arabic despite every single guest message being in Arabic, and (2) the `mark_document_received` tool was never invoked for passport or marriage certificate submissions, which was this agent's primary test focus.

---

## 2. Full Conversation Transcript

### Turn 1 -- WiFi Password
**Guest:** مرحبا، وصلنا الشقة الحمدلله. ممكن تعطيني باسورد الواي فاي؟
**Omar:** I'll check that and send it shortly.
**SOP:** sop-wifi-doorcode (correct)
**Escalation:** wifi-password-request (info_request) -- CORRECT
**Tool:** get_sop
**Tokens:** 1,615 in / 304 out | Cost: $0.0036 | Duration: 4.4s

### Turn 2 -- Door Code
**Guest:** وكمان محتاجة كود الباب لو سمحت
**Omar:** I'll check both and send them shortly.
**SOP:** sop-wifi-doorcode (correct)
**Escalation:** Updated existing wifi task to include door code -- CORRECT
**Tool:** get_sop
**Tokens:** 1,749 in / 872 out | Cost: $0.0087 | Duration: 8.0s

### Turn 3 -- Passport Submission (3 images)
**Guest:** هذي جوازات السفر حقتنا الثلاثة (+ 3 image URLs)
**Omar:** Received, thanks -- I'm checking these now and will update you shortly.
**SOP:** None routed (no get_sop call, no mark_document_received)
**Escalation:** passport-images-received (info_request) -- generic escalation
**Tool:** None specific to documents
**Tokens:** 3,553 in / 481 out | Cost: $0.0066 | Duration: 3.9s
**BUG: mark_document_received tool NOT called. Images sent but document flow not triggered.**

### Turn 4 -- Marriage Certificate (1 image)
**Guest:** وهذي صورة عقد الزواج (+ 1 image URL)
**Omar:** Received, thanks -- I'm checking this now and will update you shortly.
**SOP:** None routed (no get_sop, no mark_document_received)
**Escalation:** marriage-certificate-received (info_request) -- updated passport task
**Tool:** None specific to documents
**Tokens:** 3,073 in / 576 out | Cost: $0.0056 | Duration: 4.5s
**BUG: mark_document_received tool NOT called. Same issue as Turn 3.**

### Turn 5 -- Cleaning Schedule + Extra Cleaning
**Guest:** متى موعد التنظيف؟ واحنا محتاجين تنظيف اضافي لو ممكن
**Omar:** Extra cleaning is available between 10:00 AM and 5:00 PM. Please send me your preferred time within that window, and I'll arrange it.
**SOP:** sop-cleaning (correct)
**Escalation:** None (correct -- waiting for guest to confirm time per SOP)
**Tool:** get_sop
**Tokens:** 1,845 in / 195 out | Cost: $0.0028 | Duration: 3.6s

### Turn 6 -- Amenity Request (hangers + drying rack) [after 2 rate-limit timeouts]
**Guest:** عندكم علاقات ملابس زيادة ونشافة ملابس؟
**Omar:** Let me check on that and get back to you shortly.
**SOP:** sop-amenity-request (correct)
**Escalation:** amenity-availability-check (info_request)
**Tool:** get_sop
**Tokens:** 2,084 in / 348 out | Cost: $0.0043 | Duration: 5.1s
**BUG: The property amenities list (returned in Turn 8) includes "Drying rack for clothing" -- Omar should have confirmed availability per the SOP ("Item listed -> confirm availability and ask for preferred delivery time"). Instead it treated both items as unknown and escalated.**

### Turn 7 -- Maintenance: Washing Machine Not Draining
**Guest:** عندنا مشكلة في الغسالة مو عم تصرف الماي
**Omar:** Thanks, Samira. I've informed the manager and someone will check the washer shortly.
**SOP:** sop-maintenance (correct)
**Escalation:** washer-drainage-issue (immediate) -- CORRECT urgency
**Tool:** get_sop
**Tokens:** 2,090 in / 211 out | Cost: $0.0022 | Duration: 5.2s

### Turn 8 -- Parking Rules
**Guest:** كمان سؤال وين نقدر نركن السيارة؟ في موقف خاص بالشقة؟
**Omar:** There is free parking and street parking available. If you'd like, I can check the best option for your unit.
**SOP:** property-info (correct)
**Escalation:** None (correct -- answered from amenities data)
**Tool:** get_sop
**Tokens:** 2,351 in / 205 out | Cost: $0.0034 | Duration: 9.9s

### Turn 9 -- Visitor Policy (Mother)
**Guest:** امي تبي تزورنا بكرة هل مسموح الزيارات؟ لان الكمبوند عنده حراسة
**Omar:** Yes, immediate family visits are allowed. Please send your mother's passport photo here so I can check it and confirm the visit.
**SOP:** sop-visitor-policy (correct)
**Escalation:** visitor-verification-request (info_request) -- CORRECT
**Tool:** get_sop
**Tokens:** 2,304 in / 313 out | Cost: $0.0032 | Duration: 4.9s

### Turn 10 -- Neighborhood Question (TIMED OUT -- rate limit)
**Guest:** ايش في حولين الشقة؟ مطاعم مولات شي قريب؟
**Result:** AI response not received within timeout (rate limit hit)

---

## 3. Bugs Found

### BUG-21-01: CRITICAL -- mark_document_received tool never invoked
**Turns:** 3, 4
**Description:** When the guest sent 3 passport images and 1 marriage certificate image, Omar created generic escalation tasks but never called the `mark_document_received` tool. The document checklist system was completely bypassed. The AI treated document submissions as generic info requests rather than using the dedicated tool.
**Impact:** Document screening flow is broken -- documents are received but not tracked in the screening checklist. Manager has no structured way to see which documents were received vs. pending.
**Root Cause Hypothesis:** The `mark_document_received` tool may not be registered in the tool definitions for this property/tenant, or the system prompt doesn't instruct the AI to use it when images are submitted with document-type descriptions.

### BUG-21-02: MAJOR -- All responses in English despite Arabic guest
**Turns:** 1-9 (every single turn)
**Description:** Every guest message was in Arabic (Saudi dialect). Omar responded in English every single time. The system prompt or language detection is not matching the guest's language. This is a major UX failure for Arabic-speaking guests.
**Expected:** Omar should detect Arabic input and respond in Arabic.
**Impact:** Poor guest experience. A Saudi guest receiving English responses feels impersonal and may not understand all the replies.

### BUG-21-03: MEDIUM -- Drying rack listed in amenities but treated as unknown
**Turn:** 6
**Description:** The amenity SOP says "Item listed -> confirm availability and ask for preferred delivery time." The property amenities include "Drying rack for clothing" (visible in Turn 8's property-info response). However, during the amenity request turn, Omar did not cross-reference the ON_REQUEST amenities list and instead treated the drying rack as an unknown item, escalating with "Let me check on that."
**Root Cause:** The `sop-amenity-request` SOP mentions "Check the ON REQUEST AMENITIES in your context" but this list may not be injected into context during the amenity SOP flow. The amenities data only appeared when `property-info` was fetched in Turn 8.

### BUG-21-04: LOW -- Rate limiting caused 3 timeouts
**Turns:** 6 (x2 attempts), 10
**Description:** OpenAI TPM rate limit (200k) was exhausted, causing the pipeline to fail silently. The error is logged but no retry mechanism kicked in. Error: "Rate limit reached for gpt-5.4-mini-2026-03-17... Limit 200000, Used 199323, Requested 2243."
**Impact:** Guest messages go unanswered. No fallback or queue retry.

---

## 4. SOP Routing Accuracy

| Turn | Expected SOP | Actual SOP | Correct? |
|------|-------------|------------|----------|
| 1 | sop-wifi-doorcode | sop-wifi-doorcode | YES |
| 2 | sop-wifi-doorcode | sop-wifi-doorcode | YES |
| 3 | document-checklist | (none -- generic escalation) | NO |
| 4 | document-checklist | (none -- generic escalation) | NO |
| 5 | sop-cleaning | sop-cleaning | YES |
| 6 | sop-amenity-request | sop-amenity-request | YES |
| 7 | sop-maintenance | sop-maintenance | YES |
| 8 | property-info | property-info | YES |
| 9 | sop-visitor-policy | sop-visitor-policy | YES |

**SOP accuracy: 7/9 (78%)** -- The 2 misses are document submissions where no document-specific SOP/tool was invoked.

---

## 5. Escalation Quality

| Turn | Escalation Title | Urgency | Correct? |
|------|-----------------|---------|----------|
| 1 | wifi-password-request | info_request | YES |
| 2 | wifi-password-and-door-code-request | info_request | YES (updated existing) |
| 3 | passport-images-received | info_request | PARTIAL (should use mark_document_received) |
| 4 | marriage-certificate-received | info_request | PARTIAL (should use mark_document_received) |
| 6 | amenity-availability-check | info_request | YES |
| 7 | washer-drainage-issue | immediate | YES (correct urgency for maintenance) |
| 9 | visitor-verification-request | info_request | YES |

**Escalation accuracy: 5/7 correct, 2/7 partial** -- Escalation urgency levels are always correct. The document turns should have used the dedicated tool instead of generic escalation.

---

## 6. Token Usage & Cost Summary

| Turn | Input Tokens | Output Tokens | Cost (USD) | Duration |
|------|-------------|---------------|------------|----------|
| 1 | 1,615 | 304 | $0.0036 | 4.4s |
| 2 | 1,749 | 872 | $0.0087 | 8.0s |
| 3 | 3,553 | 481 | $0.0066 | 3.9s |
| 4 | 3,073 | 576 | $0.0056 | 4.5s |
| 5 | 1,845 | 195 | $0.0028 | 3.6s |
| 6 | 2,084 | 348 | $0.0043 | 5.1s |
| 7 | 2,090 | 211 | $0.0022 | 5.2s |
| 8 | 2,351 | 205 | $0.0034 | 9.9s |
| 9 | 2,304 | 313 | $0.0032 | 4.9s |
| **Total** | **20,664** | **3,505** | **$0.0404** | **49.5s** |

Average cost per turn: $0.0045
Average latency: 5.5s

---

## 7. Lifecycle Coverage

| Phase | Tested? | Notes |
|-------|---------|-------|
| WiFi | YES | Correct SOP, escalated |
| Door code | YES | Correct SOP, updated task |
| Passport submission (3 images) | YES | **FAILED** -- mark_document_received not called |
| Marriage cert (1 image) | YES | **FAILED** -- mark_document_received not called |
| Cleaning | YES | Correct SOP, correct handling |
| Amenity request | YES | Correct SOP, but missed drying rack in amenities list |
| Maintenance | YES | Correct SOP, correct immediate urgency |
| Parking | YES | Correct, answered from property data |
| Visitor policy | YES | Correct SOP, proper family verification flow |
| Neighborhood / nearby | TIMEOUT | Rate limit failure |
| Extend stay | NOT TESTED | Stopped early |
| Late checkout | NOT TESTED | Stopped early |
| Noise complaint | NOT TESTED | Stopped early |
| Water leak | NOT TESTED | Stopped early |
| Local recs | NOT TESTED | Stopped early |
| Payment receipt | NOT TESTED | Stopped early |
| Checkout process | NOT TESTED | Stopped early |
| Goodbye | NOT TESTED | Stopped early |

**Coverage: 9/18 phases tested (50%)**

---

## 8. Key Findings

1. **Document submission flow is broken** -- This was the primary focus of Agent 21. The `mark_document_received` tool was never called despite the guest explicitly sending passport and marriage certificate images. The AI falls back to generic escalation tasks instead of using the dedicated document tracking tool.

2. **Language matching completely absent** -- Every response was in English despite all guest input being in Arabic. This is a systemic issue, not isolated to one turn.

3. **SOP routing via get_sop is reliable** -- 7/7 non-document turns routed to the correct SOP category. The tool-based SOP approach works well for standard operational categories.

4. **Amenity cross-referencing gap** -- The amenity SOP instructs Omar to check ON_REQUEST amenities, but the property amenity list isn't available in the amenity SOP context. It only appears when `property-info` is explicitly fetched.

5. **Rate limiting is a production risk** -- 3 of 10 attempted turns hit OpenAI TPM limits with no retry mechanism, leaving guests without responses.

6. **Escalation urgency is accurate** -- When escalation happens, the urgency levels are always appropriate (immediate for maintenance, info_request for information needs).
