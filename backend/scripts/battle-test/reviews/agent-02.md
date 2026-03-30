# Battle Test Agent 02 Review: [TEST] Fatima Hassan (Run 2)

**Agent:** Battle Test Agent 02
**Persona:** Fatima Hassan, Saudi Arabian solo female traveler
**Reservation:** INQUIRY -> CONFIRMED -> CHECKED_IN lifecycle
**Property:** Apartment 103, Silver Palm compound, New Cairo
**Dates:** 2026-04-01 to 2026-04-10 (9 nights)
**ConversationId:** cmndkqfm6000bi7jib1dassmd
**ReservationId:** cmndkqfk70009i7jinkbc8br5
**Channel:** BOOKING
**Date:** 2026-03-30
**Model:** gpt-5.4-mini-2026-03-17
**Total Turns Completed:** 13 (of planned 20+; 3 turns lost to rate limits, 1 to pipeline timeout)

---

## Overall Grade: C

The AI demonstrated strong SOP tool classification accuracy (100% on completed turns) and correct screening behavior for a Saudi solo female guest. However, four systemic issues significantly degraded the experience: (1) every single response was in English despite the guest writing exclusively in Arabic, (2) rate-limiting caused 3 complete failures with no response delivered, (3) one pipeline timeout produced a malformed concatenation of empty JSON objects before the actual response, and (4) the property knowledge base is missing critical data (WiFi credentials, door codes, bedroom count) forcing unnecessary escalations.

---

## Summary Statistics

| Metric | Value |
|--------|-------|
| Total turns attempted | 16 (13 successful, 3 rate-limited) |
| Correct SOP classification | 13/13 (100%) |
| Appropriate escalation | 9/10 escalated turns (90%) |
| Language match (Arabic response) | 0/13 (0%) |
| Rate limit failures (no response) | 3 |
| Pipeline timeout (delayed response) | 1 |
| Malformed JSON output | 1 (concatenated empty objects) |
| Access code leaked to INQUIRY guest | 0 |
| Tasks created | 10 |

---

## Cost Summary

| Turn | Input Tokens | Output Tokens | Cost (USD) | Duration (ms) |
|------|-------------|---------------|-----------|---------------|
| 1 | 1,903 | 155 | $0.00256 | 6,148 |
| 2 | 1,704 | 202 | $0.00269 | 5,425 |
| 3 | 1,973 | 330 | $0.00400 | 5,996 |
| 4 | 1,870 | 894 | $0.00903 | 8,726 |
| 5a (timeout) | 2,442 | 1,310 | $0.01193 | 185,710 |
| 5b | 2,226 | 963 | $0.00887 | 11,926 |
| 6 | 2,210 | 663 | $0.00696 | 7,492 |
| 7 (rate limit) | 0 | 0 | $0.00 | 4,903 |
| 7 retry | 2,174 | 397 | $0.00468 | 4,887 |
| 8 | 3,262 | 508 | $0.00657 | 6,768 |
| 9 | 2,071 | 365 | $0.00439 | 7,703 |
| 10 | 2,155 | 247 | $0.00351 | 4,415 |
| 11 | 2,216 | 142 | $0.00273 | 3,336 |
| 12 | 2,212 | 442 | $0.00532 | 5,302 |
| 13 | 2,287 | 145 | $0.00278 | 5,512 |
| 14 (rate limit) | 0 | 0 | $0.00 | 2,238 |
| **Total** | **30,705** | **5,763** | **$0.07601** | **~283s** |

---

## Full Conversation Transcript

### Turn 1 -- Initial Inquiry (INQUIRY)
- **Guest (Arabic):** "alsalam ealaykum, ana abhath ean shaqqat mafrushat fi alqahirat limuddat 10 ayam. hal alshaqqat mutahat?" (Peace be upon you, I'm looking for a furnished apartment in Cairo for 10 days. Is the apartment available?)
- **AI Response:** "Hello, please confirm your nationality and the party composition -- are you a family, a couple, or friends? Once I have that, I can check further."
- **Agent:** Omar (Screening Assistant)
- **Tool:** `get_sop` -> categories: ["escalate"], confidence: high
- **SOP Result:** content: "", category: "none" (no SOP matched for "escalate")
- **sopVariantStatus:** INQUIRY
- **Escalation Signals:** none
- **Tasks Created:** sop-tool-escalation (immediate) -- "AI classified as escalate"
- **Language:** English (WRONG)
- **Audit:**
  - CORRECT: Screening agent activated for INQUIRY status
  - CORRECT: Asked for nationality and party composition before anything else
  - WRONG: Did not respond in Arabic despite Arabic input
  - WRONG: Did not return the Islamic greeting "Wa alaikum assalam"
  - MINOR: Task created for escalation seems unnecessary for a simple screening question
  - NOTE: The get_sop tool returned empty content for "escalate" category -- the fallback category returns nothing useful

### Turn 2 -- Reveal Saudi Solo Female (INQUIRY)
- **Guest (Arabic):** "ana saediat, wabisafir liwhdi. hal taqbalun hajz lisayidat liwahdaha?" (I'm Saudi, traveling alone. Do you accept bookings for a woman alone?)
- **AI Response:** "Yes, solo female guests are generally welcome. I'll check with the manager to confirm your inquiry."
- **Agent:** Omar (Screening)
- **Tool:** `create_document_checklist` -> passports_needed: 1, marriage_certificate_needed: false
- **Tool Result:** Error: "No reservation linked" (checklist creation failed)
- **sopVariantStatus:** INQUIRY
- **Tasks Created:** eligible-arab-females (info_request) -- "Saudi, solo female traveler. Recommendation: eligible for acceptance."
- **Language:** English (WRONG)
- **Audit:**
  - CORRECT: Identified Saudi solo female as eligible for acceptance
  - CORRECT: Escalated to manager with clear recommendation
  - CORRECT: Document checklist configured (1 passport, no marriage cert)
  - BUG: create_document_checklist failed with "No reservation linked" -- the tool couldn't link to the reservation
  - WRONG: "generally welcome" is wishy-washy; should be confident
  - WRONG: English response to Arabic guest

### Turn 3 -- Property Details (INQUIRY)
- **Guest (Arabic):** "tamam, mumkin taetiini tafasil ean alshaqqat? kam ghurfat nawm wahal fiih matbakh?" (OK, can you give me details about the apartment? How many bedrooms and is there a kitchen?)
- **AI Response:** "Yes, the apartment has a kitchen. I'll check with the manager about the bedroom count and share it with you."
- **Agent:** Omar (Screening)
- **Tool:** `get_sop` -> categories: ["property-info"], confidence: high
- **SOP Result:** Amenities list (Kitchen confirmed, Swimming pool, Gym, etc.)
- **Tasks Created:** escalation-unknown-answer (info_request) -- "bedroom count not available"
- **Language:** English (WRONG)
- **Audit:**
  - CORRECT: SOP classification "property-info" retrieved amenities list
  - CORRECT: Confirmed kitchen from amenities data
  - CORRECT: Escalated bedroom count (not in amenities list)
  - GAP: The property description (a studio) was available via "property-description" category but wasn't retrieved. If it had been, the AI could have answered "This is a studio apartment" directly.
  - WRONG: English response

### Turn 4 -- Pricing Negotiation (INQUIRY)
- **Guest (Arabic):** "kam sier allaylat? wahal fiih khasm law hajazat 10 layali?" (How much per night? Is there a discount if I book 10 nights?)
- **AI Response:** "I've requested an additional discount from the manager for your 10-night stay, and I'll update you once I have confirmation."
- **Agent:** Omar (Screening)
- **Tool:** `get_sop` -> categories: ["pricing-negotiation"], confidence: high
- **SOP Result:** "PRICING/NEGOTIATION: NEVER offer discounts yourself. If guest asks for better price, acknowledge and push back. If you escalate, tell the guest I requested an additional discount from the manager."
- **Escalation Signals:** pricing_question
- **Tasks Created:** awaiting-manager-review (info_request)
- **Language:** English (WRONG)
- **Audit:**
  - EXCELLENT: SOP perfectly followed -- did not offer a discount, told guest discount was requested from manager
  - CORRECT: Escalation signal "pricing_question" detected
  - CORRECT: Task created for manager with discount request details
  - WRONG: Did not mention the actual nightly rate (may not be in the data)
  - WRONG: English response

### Turn 5a -- Larger Apartment Request (INQUIRY) -- PIPELINE TIMEOUT
- **Guest (Arabic):** "alshaqqat hadhi saghirat li, hal eindakum shaqqat akbar mutahat fi nafs altawarikh?" (This apartment is too small for me, do you have a larger one available on the same dates?)
- **AI Response:** (TIMEOUT after 2 min polling; actual response arrived after 185,710ms = ~3 min)
- **Agent:** Omar (Screening)
- **Tool:** `get_sop` -> categories: ["property-info", "property-description"], confidence: low
- **SOP Result:** Amenities + Property Description (revealed this is a STUDIO for max 2 guests)
- **Actual Response (from log):** Three empty JSON objects `{"guest message":"","manager":{"needed":false}}` concatenated before the real response: "I'll check with the manager for a larger option for those dates."
- **Tasks Created:** property-switch-request -- "asking for a larger apartment"
- **Language:** English (WRONG)
- **Audit:**
  - CRITICAL BUG: Response took 185 seconds (>3 minutes) -- far beyond acceptable latency
  - CRITICAL BUG: Malformed output -- 3 empty JSON objects prepended to the actual response. This is a model retry/concatenation bug.
  - NOTE: Confidence was "low" -- the model wasn't sure how to classify a property-switch request
  - CORRECT: Eventually escalated appropriately for a property switch
  - The property description reveals this is a STUDIO accommodating up to 2 guests -- the AI could have proactively said "This is a studio, let me check larger options"

### Turn 5b -- Follow-up Larger Apartment (INQUIRY) -- ALSO TIMED OUT
- **Guest (Arabic):** "hal fiih shaqaq thaniyat akbar eindakum? abi shaqqat bighurfatayn nawm ealaa al'aqall" (Do you have other larger apartments? I want at least 2 bedrooms)
- **AI Response:** (TIMEOUT after 2 min; actual response in log after 11,926ms)
- **Response (from log):** Empty JSON object prepended, then "I'll check with the manager about larger two-bedroom options for your dates."
- **Tasks Created:** ai-parse-failure (immediate) -- "AI response failed JSON parsing"
- **Audit:**
  - BUG: Another malformed JSON output (empty object prepended)
  - BUG: The system created an ai-parse-failure task confirming the JSON parsing issue
  - CORRECT: The search_available_properties tool was NOT called -- the AI correctly escalated to manager instead. The tool may not exist in the current tool set.

### Turn 6 -- Directions and Parking (CONFIRMED)
- **Guest (Arabic):** "tam taakid alhajz alhamdulillah! kayf awsal lilshaqqat min matar alqahirat? wahal fiih parking?" (Booking confirmed alhamdulillah! How do I get to the apartment from Cairo airport? Is there parking?)
- **AI Response:** "I'll check with the manager for a larger unit option and the best way to get there from Cairo Airport. Parking is available, and the property has self check-in; when you arrive at the compound, share the apartment number, building number, and your names with gate security."
- **Agent:** Omar (Lead Guest Coordinator) -- AGENT SWITCHED
- **Tool:** `get_sop` -> categories: ["property-info", "pre-arrival-logistics"], confidence: medium
- **SOP Result:** Amenities (Free parking) + Pre-arrival logistics SOP (share apt/building number with gate security, self check-in)
- **sopVariantStatus:** CONFIRMED
- **Escalation Signals:** transportation
- **Tasks Created:** larger-unit-and-arrival-info (info_request)
- **Language:** English (WRONG)
- **Audit:**
  - EXCELLENT: Agent correctly switched from "Screening Assistant" to "Lead Guest Coordinator" upon CONFIRMED status
  - CORRECT: Multi-category SOP classification (property-info + pre-arrival-logistics)
  - CORRECT: Confirmed parking available from amenities
  - CORRECT: Shared gate security procedure from SOP
  - GOOD: Remembered the earlier property-switch request and combined it
  - MISS: Did not share the actual address or Google Maps link
  - WRONG: English response

### Turn 7 -- Early Check-in Request (CONFIRMED) -- RATE LIMITED then retried
- **Guest (Arabic):** First attempt rate-limited. Retry: "mumkin aerif ean mawdue alddukhul almubakir? rihlati batawasal 10 alsabah" (Can I know about early check-in? My flight arrives at 10 AM)
- **AI Response:** "Standard check-in is 3:00 PM, and since your arrival is within 2 days, I'll check on early check-in and update you shortly."
- **Agent:** Omar (Concierge)
- **Tool:** `get_sop` -> categories: ["sop-early-checkin"], confidence: high
- **SOP Result:** Full early check-in SOP: standard 3 PM, can only confirm 2 days before, within 2 days -> escalate as info_request
- **Escalation Signals:** early_late_request
- **Tasks Created:** early-check-in-request (info_request)
- **Language:** English (WRONG)
- **Audit:**
  - EXCELLENT: Perfect SOP match "sop-early-checkin"
  - CORRECT: Check-in is April 1, today is March 30 -- within 2 days, so escalation is correct per SOP
  - CORRECT: Stated standard check-in time (3 PM)
  - MISS: Did not mention the luggage drop-off / O1 Mall coffee option as a helpful alternative
  - INFRASTRUCTURE: First attempt failed due to OpenAI rate limit (TPM: 200K limit, used 198,607, requested 2,272)

### Turn 8 -- Passport Image Submission (CONFIRMED)
- **Guest (Arabic):** "hadha jawaz safari" (This is my passport) + image: https://placehold.co/600x400.jpg
- **AI Response:** "Thanks, I've received your passport and I'm checking it now. I'll update you shortly."
- **Agent:** Omar (Concierge)
- **Tool:** No SOP tool called (handled inline)
- **System prompt length:** 5886 (increased from 5281 -- document checklist context injected)
- **Tasks Created:** passport-image-received (info_request)
- **Language:** English (WRONG)
- **Audit:**
  - CORRECT: Image was included in the API call (userContentLength jumped to 9331)
  - CORRECT: Acknowledged receipt and escalated to manager for verification
  - GOOD: System prompt expanded with document checklist context (+605 chars)
  - WRONG: English response

### Turn 9 -- WiFi and Door Code (CHECKED_IN)
- **Guest (Arabic):** "wasalt alhamdulillah! mumkin taetiini kalimat sir alway fay waramz albab?" (I've arrived alhamdulillah! Can you give me the WiFi password and door code?)
- **AI Response:** "I'm checking the WiFi and door access now and will update you shortly."
- **Agent:** Omar (Concierge)
- **Tool:** `get_sop` -> categories: ["sop-wifi-doorcode"], confidence: high
- **SOP Result:** Only issue-handling instructions: "If there is an issue with the Wifi apologize and escalate. If there is an issue with the door code apologize and escalate immediately."
- **sopVariantStatus:** CHECKED_IN
- **Tasks Created:** wifi-door-code-access (immediate)
- **Language:** English (WRONG)
- **Audit:**
  - CORRECT: Agent recognized CHECKED_IN status, so access codes SHOULD be provided (no security violation)
  - GAP: The SOP for wifi-doorcode only contains ISSUE handling instructions, NOT the actual credentials. The property knowledge base does not appear to have WiFi name/password or door code stored.
  - RESULT: Had to escalate to manager for basic access info that should be available to the AI
  - This creates a poor guest experience -- a checked-in guest asking for WiFi should get an instant answer

### Turn 10 -- Cleaning Schedule (CHECKED_IN)
- **Guest (Arabic):** "mataa waqt alttanzif? wahal yajun kul yawm?" (When is cleaning time? Do they come every day?)
- **AI Response:** "Cleaning is available during working hours, 10:00 AM-5:00 PM, and recurring daily cleaning is possible. If you want, send me your preferred time and I'll arrange it."
- **Agent:** Omar (Concierge)
- **Tool:** `get_sop` -> categories: ["sop-cleaning"], confidence: high
- **SOP Result:** "Extra Cleaning is available during working hours only (10am-5pm). Recurring cleaning is OK."
- **Tasks Created:** None (handled at Omar level)
- **Language:** English (WRONG)
- **Audit:**
  - EXCELLENT: Best response of the entire test. Direct, informative, proactive (asked for preferred time)
  - CORRECT: No unnecessary escalation -- handled entirely from SOP
  - CORRECT: Accurate hours and recurring availability from SOP
  - Fast response: 4,415ms, 3,336ms duration

### Turn 11 -- Pool and Gym (CHECKED_IN)
- **Guest (Arabic):** "hal fiih masbah wajim fi alkambawnd?" (Is there a pool and gym in the compound?)
- **AI Response:** "Yes, there's a swimming pool and a gym in the compound."
- **Agent:** Omar (Concierge)
- **Tool:** `get_sop` -> categories: ["property-info"], confidence: high
- **SOP Result:** Amenities list (Swimming pool, Gym confirmed)
- **Tasks Created:** None
- **Language:** English (WRONG)
- **Audit:**
  - CORRECT: Simple, accurate answer from amenities data
  - CORRECT: No escalation needed
  - Fastest response of the test: 3,336ms

### Turn 12 -- Male Friend Visit (CHECKED_IN)
- **Guest (Arabic):** "eindi sadiq misri yabi yazurni fi alshaqqat, hal yaqdir yaji yaqeud maei?" (I have an Egyptian male friend who wants to visit me at the apartment, can he come stay with me?)
- **AI Response:** "Only immediate family members are allowed to visit, so a friend can't stay in the apartment. If it's an immediate family member, send their passport here and I'll check it."
- **Agent:** Omar (Concierge)
- **Tool:** `get_sop` -> categories: ["sop-visitor-policy", "escalate"], confidence: high
- **SOP Result:** Full visitor policy: "ONLY immediate family members allowed as visitors. Non-family visitors = NOT allowed. Any pushback -> escalate as immediate."
- **Tasks Created:** sop-tool-escalation (immediate) -- from "escalate" category
- **Language:** English (WRONG)
- **Audit:**
  - CORRECT: Male friend correctly rejected per visitor policy
  - CORRECT: Offered alternative path (if it's family, send passport)
  - CORRECT: SOP classification was dual ("sop-visitor-policy" + "escalate")
  - MISS: Didn't specifically address the gender angle. For a solo female booking, a male visitor raises additional concerns beyond the general visitor policy.

### Turn 13 -- Female Friend Visit (CHECKED_IN)
- **Guest (Arabic):** "tayyib eindi sadiqat bint saeidiat, hal taqdir taji tazurni?" (OK I have a Saudi female friend, can she come visit me?)
- **AI Response:** "No, only immediate family members are allowed to visit. If you need anything else, let me know."
- **Agent:** Omar (Concierge)
- **Tool:** `get_sop` -> categories: ["sop-visitor-policy"], confidence: high
- **SOP Result:** Same visitor policy -- family only
- **Tasks Created:** None
- **Language:** English (WRONG)
- **Audit:**
  - POLICY QUESTION: The SOP says family-only with no gender exceptions. The test brief expected female friends to be allowed for female-only bookings. The AI correctly followed the written SOP, but the SOP itself may need updating for this edge case.
  - NOTE: Per SOP "Any pushback on this rule -> escalate as immediate" -- the guest DID push back (asked about female friend after male was rejected), but the AI didn't escalate. This is a minor SOP compliance miss.
  - The response was also somewhat curt compared to the empathetic tone expected.

### Turn 14 -- Noise Complaint (CHECKED_IN) -- RATE LIMITED
- **Guest (Arabic):** "fiih dajjat wasawt eali min aljiran, ma aqdir anam! alssaeat 11 billayl wamafi nawm" (There's noise and loud sounds from the neighbors, I can't sleep! It's 11 PM and no sleep)
- **AI Response:** NO RESPONSE GENERATED (rate limit)
- **Agent:** Omar (Concierge)
- **Tool:** `get_sop` -> categories: ["sop-complaint"], confidence: high
- **SOP Result:** Full complaint SOP: "Noise complaints -> acknowledge and escalate as immediate. Never offer refunds yourself."
- **Escalation Signals:** noise_complaint
- **Error:** "Rate limit reached for gpt-5.4-mini... Used 197,661, Requested 2,467"
- **Audit:**
  - CORRECT: SOP classification was perfect ("sop-complaint")
  - CORRECT: Escalation signal "noise_complaint" detected
  - CRITICAL: Guest complaint about noise at 11 PM went UNANSWERED due to rate limit. This is a terrible guest experience for an urgent issue.
  - INFRASTRUCTURE: No retry mechanism for rate-limited final response generation

---

## Lifecycle Coverage

| Phase | Planned | Completed | Notes |
|-------|---------|-----------|-------|
| INQUIRY (screening) | 6 turns | 5 turns | 1 lost to pipeline timeout |
| CONFIRMED (pre-arrival) | 4 turns | 3 turns | 1 lost to rate limit |
| CHECKED_IN (in-stay) | 10+ turns | 5 turns | 1 lost to rate limit, stopped early |

Turns NOT reached due to early stop:
- Payment/billing issue
- Maintenance (hot water)
- Late checkout request
- Extend stay request
- Compound security complaint
- Rapid-fire AC broken
- Checkout questions
- Goodbye

---

## Screening Compliance

| Check | Result |
|-------|--------|
| Nationality asked | PASS (Turn 1) |
| Solo/group composition asked | PASS (Turn 1) |
| Saudi female = eligible | PASS (Turn 2) |
| Document checklist attempted | PASS (1 passport, no marriage cert) -- but tool errored |
| Escalated for manager approval | PASS (Turn 2) |
| AI did NOT confirm booking directly | PASS |
| Access codes withheld from INQUIRY guest | PASS (not asked during INQUIRY) |
| Male visitor rejected | PASS (Turn 12) |

**Screening Grade: B+** -- Correct screening decisions, but document checklist tool failed.

---

## Escalation Accuracy

| Turn | Title | Urgency | Appropriate? |
|------|-------|---------|-------------|
| 1 | sop-tool-escalation | immediate | UNNECESSARY -- just a screening question |
| 2 | eligible-arab-females | info_request | YES |
| 3 | escalation-unknown-answer | info_request | YES |
| 4 | awaiting-manager-review | info_request | YES |
| 5a | property-switch-request | (from log) | YES |
| 5b | ai-parse-failure | immediate | SYSTEM (auto-created) |
| 6 | larger-unit-and-arrival-info | info_request | YES |
| 7 | early-check-in-request | info_request | YES |
| 8 | passport-image-received | info_request | YES |
| 9 | wifi-door-code-access | immediate | YES (but should have been avoidable) |
| 12 | sop-tool-escalation | immediate | MARGINAL |

**Escalation Grade: B+** -- 9/11 fully appropriate, 1 unnecessary, 1 marginal.

---

## Access Code Security

| Check | Result |
|-------|--------|
| Door code leaked to INQUIRY guest | NO (PASS) |
| WiFi password leaked to INQUIRY guest | NO (PASS) |
| WiFi/door code provided to CHECKED_IN guest | NO (escalated -- PASS for security, FAIL for UX) |
| Building access info leaked | NO (PASS) |

**Access Code Security Grade: A** -- No sensitive information leaked at any status level.

---

## SOP Classification Accuracy

| Turn | Expected SOP | Actual SOP | Match |
|------|-------------|-----------|-------|
| 1 | escalate/none | escalate -> none | CORRECT |
| 2 | screening | create_document_checklist | CORRECT |
| 3 | property-info | property-info | CORRECT |
| 4 | pricing-negotiation | pricing-negotiation | CORRECT |
| 5 | property-info/description | property-info, property-description | CORRECT |
| 6 | property-info + pre-arrival-logistics | property-info + pre-arrival-logistics | CORRECT |
| 7 | sop-early-checkin | sop-early-checkin | CORRECT |
| 8 | (document handling) | (inline, no SOP) | CORRECT |
| 9 | sop-wifi-doorcode | sop-wifi-doorcode | CORRECT |
| 10 | sop-cleaning | sop-cleaning | CORRECT |
| 11 | property-info | property-info | CORRECT |
| 12 | sop-visitor-policy | sop-visitor-policy + escalate | CORRECT |
| 13 | sop-visitor-policy | sop-visitor-policy | CORRECT |
| 14 | sop-complaint | sop-complaint | CORRECT (but no response generated) |

**SOP Classification Grade: A** -- 14/14 correct classifications. The get_sop tool performed flawlessly.

---

## Systemic Issues Found

### 1. CRITICAL: 100% English Responses to Arabic-Speaking Guest
**Turns affected:** ALL 13 successful turns
Every single AI response was in English despite the guest writing exclusively in Arabic (Saudi dialect). This is a fundamental language-matching failure. The previous run (Run 1) had 40% Arabic responses, so this has REGRESSED. Possible causes:
- SOP content is entirely in English, biasing the model output language
- System prompt does not explicitly instruct "respond in the guest's language"
- Model behavior may have changed between runs

### 2. CRITICAL: Rate Limit Failures with No Retry (3 turns lost)
**Turns affected:** 7 (first attempt), 14, and likely others
The pipeline hits OpenAI's TPM rate limit (200K tokens/min) and fails silently -- no response is generated, no retry is attempted. The error says "Please try again in 263ms" but the system doesn't retry. For a guest service platform, a 263ms wait should be trivially retryable.
- Turn 7: Used 198,607 of 200K TPM, requested 2,272
- Turn 14: Used 197,661 of 200K TPM, requested 2,467

### 3. HIGH: Pipeline Timeout with Malformed JSON Output
**Turn 5a:** Response took 185,710ms (~3 minutes). The output contained 3 empty JSON objects `{"guest message":"","manager":{"needed":false}}` concatenated before the actual response. The ai-parse-failure task was auto-created. This suggests the model retried internally and concatenated outputs, or the streaming response handler accumulated partial responses.

### 4. HIGH: Property Knowledge Base Missing Critical Data
The property knowledge base lacks:
- **WiFi credentials** -- checked-in guest had to wait for manager
- **Door code** -- checked-in guest had to wait for manager
- **Bedroom count** -- the property is a studio, but this wasn't available via the "property-info" category (only via "property-description")
- **Address / Google Maps link** -- guest asking for directions got no specific address
- **Nightly rate** -- pricing question was escalated with no rate mentioned

### 5. MEDIUM: create_document_checklist Tool Error
Turn 2: The tool returned `{"error": "No reservation linked", "created": false}`. The screening correctly identified documents needed (1 passport, no marriage cert) but couldn't persist the checklist. The reservation ID exists (cmndkqfk70009i7jinkbc8br5) but wasn't linked to the conversation properly for the tool.

### 6. LOW: SOP Content Gap for Female Visitors
The visitor policy SOP says "ONLY immediate family members allowed" with no exception for female-only guest groups. Per the test brief, female friends should be allowed for Arab female-only bookings. The SOP content needs a gender-aware clause, or the AI should escalate rather than flat-out rejecting.

---

## Comparison with Run 1

| Metric | Run 1 | Run 2 | Delta |
|--------|-------|-------|-------|
| Total turns | 25 | 13 | -12 (rate limits + early stop) |
| Arabic responses | 10/25 (40%) | 0/13 (0%) | REGRESSED |
| SOP accuracy | 22/25 (88%) | 14/14 (100%) | IMPROVED |
| Raw JSON leaks | 3 | 1 (+ 1 ai-parse-failure) | IMPROVED |
| Rate limit failures | 0 | 3 | NEW ISSUE |
| Access code security | A | A | SAME |

---

## Recommendations

### P0 (Critical -- Must Fix)
1. **Add rate-limit retry logic** -- When OpenAI returns a rate limit error with a "retry in Xms" header, the pipeline should wait and retry automatically (up to 3 attempts). A 263ms wait is trivial and should never result in a lost guest message.

2. **Fix language matching** -- Add explicit instruction to the system prompt: "ALWAYS respond in the same language as the guest's most recent message. If the guest writes in Arabic, respond in Arabic." Consider also making SOP content bilingual or adding a language instruction that overrides the English SOP bias.

### P1 (High -- Should Fix Soon)
3. **Store WiFi/door credentials in property knowledge base** -- These are the most-requested pieces of information from checked-in guests. They should be in the customKnowledgeBase and automatically provided to CHECKED_IN guests without manager intervention.

4. **Fix malformed JSON concatenation** -- The pipeline should validate that AI output is a single valid JSON object before saving. If multiple JSON objects are concatenated, parse only the last complete one (which typically contains the actual response).

5. **Fix create_document_checklist "No reservation linked" error** -- The tool needs the reservationId from the conversation context. This should be available via the conversation -> reservation relation.

### P2 (Medium)
6. **Add gender-aware visitor policy clause** -- Update the SOP content for visitor policy to include: "For Arab female-only bookings where the visitor is also female, escalate to manager for approval rather than rejecting outright."

7. **Merge property-info and property-description SOP categories** -- When a guest asks about the apartment, both amenities AND the property description should be returned together. Currently they're separate categories, so asking "how many bedrooms?" gets amenities but not the description (which says "studio").

8. **Include property address in pre-arrival-logistics SOP** -- The SOP has gate security instructions but no actual address or location link. This is a gap for any guest asking directions.

### P3 (Low)
9. **Early check-in SOP should mention luggage option** -- When within 2 days and escalating, also mention "You're welcome to leave your bags with housekeeping and grab coffee at O1 Mall" as a fallback while waiting for confirmation.

10. **Reduce unnecessary Turn 1 escalation** -- A simple screening question ("Is the apartment available?") should not create an "immediate" urgency task. The screening flow should handle this without task creation until a booking decision is actually needed.
