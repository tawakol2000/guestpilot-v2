# Battle Test Review -- Agent 17

**Agent:** Battle Test Agent 17
**Persona:** [TEST] Amal Sherif -- CHECKED_IN guest (Arabic)
**Reservation Status:** CHECKED_IN
**Channel:** AIRBNB
**Property:** B 4.05 (Alaa)
**Dates:** 2026-03-28 to 2026-04-06 (9 nights, 3 guests)
**Total Turns:** 16 (including duplicates from background timeouts)
**Model:** gpt-5.4-mini-2026-03-17
**Date:** 2026-03-30

---

## 1. Overall Grade: B+

Omar handles most requests competently with correct SOP routing and appropriate urgency levels. Language matching is a notable weakness -- guest writes entirely in Arabic but Omar always responds in English. Several SOP misclassifications and a missing tool call are documented below.

---

## 2. Full Conversation Transcript

| # | Speaker | Message | SOP Used | Escalation |
|---|---------|---------|----------|------------|
| 1 | Guest | مرحبا، أنا أمل وصلت الشقة. ممكن تعطيني كلمة سر الواي فاي لو سمحت؟ | sop-wifi-doorcode | wifi-password-request (info_request) |
| 1 | Omar | I'll check with the manager and get back to you shortly. | | |
| 2 | Guest | طيب وكمان عايزة كود الباب لو سمحت | sop-wifi-doorcode | wifi-and-door-code-request (immediate) |
| 2 | Omar | I'm checking the WiFi details and the door code now and will send them shortly. | | |
| 3 | Guest | هذه جوازات السفر لي ولعائلتي [+image] | sop-visitor-policy | passport-images-for-review (info_request) |
| 3 | Omar | Thanks, I'm checking these now and will update you shortly. | | |
| 4 | Guest | ممكن حد يجي ينضف الشقة؟ محتاجين تنظيف | sop-cleaning | None |
| 4 | Omar | Of course -- extra cleaning is available between 10:00 AM and 5:00 PM. What time would you like us to come by? | | |
| 5 | Guest | الساعة ٢ الظهر لو ممكن. وكمان محتاجين ملايات سرير زيادة عشان احنا ٣ أشخاص | sop-cleaning + sop-amenity-request | cleaning-and-linens-request (scheduled) |
| 5 | Omar | Noted -- I've requested cleaning for 2:00 PM and I'll check on the extra bed linens for you. | | |
| 6 | Guest | عندنا مشكلة في المطبخ، الحوض مسدود والمية مش بتنزل. ممكن حد يجي يصلحه؟ | sop-maintenance | kitchen-sink-blocked (immediate) |
| 6 | Omar | Thanks Amal -- I've noted the blocked kitchen sink and I'm sending it for urgent review now. Please avoid using it until it's checked. | | |
| 7 | Guest | سؤال: إيه مواعيد الهدوء هنا في الكمبوند؟ يعني لازم نبقى هاديين من الساعة كام؟ | escalate | quiet-hours-info-request (info_request) |
| 7 | Omar | I'll check on the quiet hours and get back to you shortly. | | |
| 8 | Guest | يا عمر الجيران اللي جنبنا عاملين حفلة وصوت الموسيقى عالي جداً ومش قادرين ننام. دي الساعة ١٢ بالليل! | sop-complaint | noise-complaint (immediate) |
| 8 | Omar | I'm sorry, Amal -- I've reported the noise issue now and asked for it to be handled urgently. | | |
| 9 | Guest | صديقتي عايزة تحجز شقة هنا في الكمبوند. ممكن تيجي تشوف الشقة قبل ما تحجز؟ | sop-visitor-policy | None |
| 9 | Omar | Sorry, only immediate family members are allowed to visit, so a friend can't come by to view the apartment. If it's an immediate family member, send their passport here and I'll check it. | | |
| 10 | Guest | طيب مش مشكلة. بس سؤال تاني - إيه وضع الأمن في الكمبوند؟ في حراسة ٢٤ ساعة؟ عشان أنا قلقانة شوية | property-info | compound-security-question (info_request) |
| 10 | Omar | I'm checking on that for you and will get back shortly. | | |
| 11 | Guest | يا عمر أنا عايزة أمدد الإقامة ٣ أيام كمان لغاية ٩ أبريل لو ممكن. إيه السعر؟ | pricing-negotiation | None |
| 11 | Omar | I can extend the stay until 9 April. Please submit the alteration request through Airbnb and it will be approved right away, and the updated total will show there. | | |
| 12 | Guest | وكمان يوم ما نمشي ممكن نعمل ليت تشيك اوت؟ نطلع الساعة ٢ الظهر بدل ١١ الصبح؟ | sop-late-checkout | None |
| 12 | Omar | Standard check-out is 11:00 AM. We can only confirm late checkout 2 days before your date since there may be guests checking in, so we'll let you know closer to then. | | |
| 13 | Guest | سؤال كمان - التأمين اللي دفعناه، هيرجع امتى بعد ما نمشي؟ وإزاي بيترجع؟ | payment-issues | security-deposit-return-question (info_request) |
| 13 | Omar | I've asked the manager to check the deposit return details for you, and I'll get back shortly with how it's processed after checkout. | | |
| 14 | Guest | يا عمر في صرصار في المطبخ!!! ابعتوا حد بسرعة!! | sop-maintenance | cockroach-in-kitchen (immediate) |
| 14 | Omar | Sorry Amal -- I've reported this urgently and asked for it to be checked right away. Please avoid using the kitchen area until someone arrives. | | |
| 15 | Guest | يا عمر احنا خلاص مشينا من الشقة. سبنا المفاتيح على الطاولة. شكراً على كل حاجة | (no SOP tool call) | None |
| 15 | Omar | Thanks Amal, noted -- I've recorded that you've checked out and left the keys on the table. Wishing you a safe trip. | | |
| 16 | Guest | يا عمر نسيت أسأل - في غسالة في الشقة؟ وفين المكواة لو في؟ | property-info + sop-amenity-request | iron-availability-check (info_request) |
| 16 | Omar | Yes, there is a washing machine in the apartment. I'll check on the iron and get back to you shortly. | | |

---

## 3. SOP Classification Accuracy

| # | Expected SOP | Actual SOP | Correct? | Notes |
|---|-------------|-----------|----------|-------|
| 1 | sop-wifi-doorcode | sop-wifi-doorcode | YES | |
| 2 | sop-wifi-doorcode | sop-wifi-doorcode | YES | |
| 3 | sop-screening / mark_document_received | sop-visitor-policy | NO | Guest submitting own passports for reservation, not a visitor. Should have triggered document checklist tool. |
| 4 | sop-cleaning | sop-cleaning | YES | |
| 5 | sop-cleaning + sop-amenity-request | sop-cleaning + sop-amenity-request | YES | |
| 6 | sop-maintenance | sop-maintenance | YES | |
| 7 | sop-quiet-hours | escalate | PARTIAL | Quiet hours SOP exists but model chose generic escalate. Still escalated correctly. |
| 8 | sop-complaint | sop-complaint | YES | |
| 9 | sop-property-viewing (DISABLED) | sop-visitor-policy | NO | Property viewing request misclassified as visitor policy. Friend wants to book own apartment, not visit guest's. |
| 10 | property-info | property-info | YES | |
| 11 | sop-extend-stay | pricing-negotiation | NO | Extend stay SOP exists; model classified as pricing. No escalation created. |
| 12 | sop-late-checkout | sop-late-checkout | YES | |
| 13 | payment-issues | payment-issues | YES | |
| 14 | sop-maintenance | sop-maintenance | YES | |
| 15 | sop-checkout | (none) | NO | No SOP tool called at all. Checkout notification should escalate to manager for key pickup/inspection. |
| 16 | property-info + sop-amenity-request | property-info + sop-amenity-request | YES | |

**Classification Accuracy:** 10/16 fully correct, 1 partial, 5 incorrect = **62.5% exact match, 68.75% with partials**

---

## 4. Escalation Accuracy

| # | Should Escalate? | Did Escalate? | Correct Urgency? | Notes |
|---|-----------------|--------------|-------------------|-------|
| 1 | YES | YES | YES (info_request) | WiFi not in KB |
| 2 | YES | YES | YES (immediate) | Door code access is urgent |
| 3 | YES | YES | YES (info_request) | Escalated for review, but wrong SOP context |
| 5 | YES | YES | YES (scheduled) | Cleaning time confirmed, correct flow |
| 6 | YES | YES | YES (immediate) | Maintenance = immediate per SOP |
| 7 | YES | YES | YES (info_request) | |
| 8 | YES | YES | YES (immediate) | Noise complaint = immediate per SOP |
| 9 | DEBATABLE | NO | N/A | Should have escalated as info_request for property viewing, instead declined outright |
| 11 | YES | NO | N/A | **BUG: Extend stay should always escalate to manager** |
| 12 | NO | NO | N/A | Correct: >2 days before checkout, per SOP do not escalate |
| 13 | YES | YES | YES (info_request) | Deposit return = info_request per SOP |
| 14 | YES | YES | YES (immediate) | Pest = immediate per SOP |
| 15 | YES | NO | N/A | **BUG: Checkout notification should escalate for key pickup/inspection** |

**Escalation Accuracy:** 10/13 correct = **76.9%**

---

## 5. Bugs & Issues Found

### BUG-17-1: mark_document_received tool NOT triggered on passport submission
- **Severity:** HIGH
- **Turn:** 3
- **Details:** Guest sent passport images with `--imageUrls=https://placehold.co/600x400.jpg` and message "هذه جوازات السفر لي ولعائلتي". The AI classified as `sop-visitor-policy` instead of recognizing this as a document submission for the reservation's screening checklist. The `mark_document_received` tool was NOT invoked. This was the primary document flow test for Agent 17.
- **Expected:** AI should recognize guest submitting their own passport (not a visitor's) and use the `mark_document_received` tool to update the screening checklist.
- **Root Cause Hypothesis:** The SOP tool's `sop-visitor-policy` description starts with "Guest wants to invite someone ELSE over" but the model may be pattern-matching on "passport" without reading the full context.

### BUG-17-2: Extend stay request not escalated
- **Severity:** MEDIUM
- **Turn:** 11
- **Details:** Guest asked to extend from April 6 to April 9. The AI classified as `pricing-negotiation` instead of `sop-extend-stay`. No escalation was created. Omar told the guest to submit alteration via Airbnb without checking availability or confirming with manager.
- **Expected:** Should use `sop-extend-stay` SOP and escalate to manager for availability check.

### BUG-17-3: Checkout notification not escalated
- **Severity:** LOW-MEDIUM
- **Turn:** 15
- **Details:** Guest informed they left the apartment and left keys on the table. No SOP tool was called and no escalation was created. Manager should be notified of early checkout for key retrieval and apartment inspection.
- **Expected:** Should escalate as `info_request` or `scheduled` so manager knows to collect keys and inspect.

### BUG-17-4: Property viewing misclassified as visitor policy
- **Severity:** LOW
- **Turn:** 9
- **Details:** Guest asked if friend can VIEW an apartment to book their own stay. This is a property viewing / sales inquiry, not a visitor request. Omar denied it citing visitor policy (family only). While `sop-property-viewing` is DISABLED, the AI should have escalated rather than outright denying.
- **Expected:** Escalate as info_request since the request doesn't fit standard SOPs.

### BUG-17-5: All responses in English despite Arabic-only conversation
- **Severity:** MEDIUM
- **Turn:** All
- **Details:** Guest sent ALL 16 messages in Arabic. Omar responded in English every single time. The system prompt or language matching logic should detect the guest's language and respond accordingly.
- **Expected:** Omar should respond in Arabic (or at least match the guest's language).

---

## 6. Language Handling

- **Guest Language:** Arabic (100% of messages)
- **AI Response Language:** English (100% of responses)
- **Language Match:** NO -- 0% match rate
- **Assessment:** This is a significant UX issue. A native Arabic speaker writing in Egyptian dialect should receive Arabic responses.

---

## 7. Tone & Quality Assessment

- **Professionalism:** Good -- Omar is polite, clear, and concise
- **Empathy:** Adequate -- apologizes for maintenance/pest issues
- **Response Length:** Appropriate -- short and to the point
- **Personalization:** Uses guest name (Amal) in several responses
- **Over-promising:** Minor issue in Turn 11 where Omar said "I can extend the stay until 9 April" without checking availability
- **SOP Adherence:** Good for recognized SOPs, but misses unrecognized scenarios

---

## 8. Tool Usage

| Tool | Expected Uses | Actual Uses | Notes |
|------|--------------|-------------|-------|
| get_sop | 16 | 15 | Not called on checkout notification (Turn 15) |
| mark_document_received | 1 | 0 | **Never triggered despite passport image submission** |
| property-info | 2 | 2 | Correctly used for amenity/security questions |

---

## 9. Task Summary

**Total Tasks Created:** 11 (includes 1 duplicate from background timeout)

| Task | Urgency | Status |
|------|---------|--------|
| wifi-and-door-code-request | immediate | open |
| passport-images-for-review | info_request | open |
| cleaning-and-linens-request | scheduled | open |
| kitchen-sink-blocked | immediate | open |
| quiet-hours-info-request | info_request | open |
| quiet-hours-policy-question (duplicate) | info_request | open |
| sop-tool-escalation (noise) | immediate | open |
| noise-complaint | immediate | open |
| compound-security-question | info_request | open |
| security-deposit-return-question | info_request | open |
| cockroach-in-kitchen | immediate | open |
| iron-availability-check | info_request | open |

---

## 10. Performance Metrics

- **Avg Response Time:** ~5-8 seconds (acceptable)
- **Avg Cost per Turn:** ~$0.004 USD
- **Reasoning Tokens (avg):** ~250
- **Cache Hit Rate:** Low -- only 2 turns showed cachedInputTokens > 0
- **SOP Tool Duration:** 0-75ms (fast, mostly cached)

---

## 11. Recommendations

1. **Fix language matching** -- highest-impact UX improvement. Guest writes Arabic, Omar should respond in Arabic.
2. **Fix mark_document_received** -- passport submissions for the reservation itself should trigger document checklist, not visitor policy.
3. **Add sop-extend-stay routing** -- extend stay requests should not fall through to pricing-negotiation.
4. **Add checkout notification handling** -- even if no formal SOP exists, checkout notices should escalate to manager.
5. **Improve property-viewing vs visitor-policy disambiguation** -- the model conflates "friend visiting apartment" with "friend viewing apartment to book."
