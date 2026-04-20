# Document Checklist Flow Test #3: Saudi Family of 4

**Date:** 2026-04-01
**Persona:** [TEST] Khaled & Nour | Saudi | Married couple + 2 children (4 guests)
**ConversationId:** cmnfzayfe000hyo3murvu86tv
**ReservationId:** cmnfzaydc000fyo3mbs0pr12n
**PropertyId:** cmnacm2h400a5d5dbh0sy7x0w
**Channel:** WHATSAPP
**Model:** gpt-5.4-mini-2026-03-17

---

## Test Objective

Verify the full document checklist lifecycle:
1. Screening correctly handles Saudi family of 4
2. `create_document_checklist` creates 4-passport + marriage cert checklist
3. Submitting documents one by one updates the checklist via `mark_document_received`

## Verdict: FAIL -- Document Checklist System Broken

The entire document checklist system failed to function. The `create_document_checklist` tool was called but returned an error, and `mark_document_received` was never called for any of the 5 document submissions. The AI fell back to conversational memory to track documents, which is unreliable.

---

## Phase 1: INQUIRY -- Screening (Turns 1-5)

### Turn 1: Greeting
- **Guest:** "مرحبا، حابين نحجز شقة لعائلتنا"
- **AI:** "Thanks for your message. Please confirm your nationality and the full party composition..."
- **Agent:** Omar (Screening)
- **Tool calls:** None
- **Result:** PASS -- Correctly asked for nationality/composition before anything else

### Turn 2: Nationality + Composition (KEY TURN)
- **Guest:** "سعوديين، انا وزوجتي وعندنا طفلين"
- **AI:** "Thanks -- your family fits our house rules. I'll check with the manager and get back to you."
- **Agent:** Omar (Screening)
- **Tool call:** `create_document_checklist`
  - **Input:** `{ passports_needed: 4, marriage_certificate_needed: false, reason: "Saudi family of 4, inquiry booking" }`
  - **Result:** `{ error: "No reservation linked", created: false }`
- **Escalation:** "eligible-arab-family-pending-docs" -- correct
- **Bugs found:**
  1. **BUG (P0): `create_document_checklist` failed with "No reservation linked"** -- The conversation DOES have a reservationId (`cmnfzaydc000fyo3mbs0pr12n`) in the database, but the Railway server's `context.reservationId` was empty when the tool executed. Possible cause: Railway deployment is running an older version of the code that doesn't populate `reservationId` in the AI context, OR the conversation data on Railway doesn't match local DB.
  2. **BUG (P1): `marriage_certificate_needed: false`** -- The AI set this to false for a Saudi married couple. The prompt/SOP should instruct the AI that married couples from Arab countries need a marriage certificate.

### Turn 3: Property Suitability
- **Guest:** "هل الشقة تناسب عائلة مع اطفال؟"
- **AI:** "Yes, it's suitable for families with children. I'll check with the manager for confirmation."
- **Agent:** Omar (Screening)
- **Tool call:** `create_document_checklist` (retried!)
  - **Input:** `{ passports_needed: 4, marriage_certificate_needed: false, reason: "Saudi family with 2 adults and 2 children, inquiry for booking acceptance" }`
  - **Result:** `{ error: "No reservation linked", created: false }` (same failure)
- **Note:** AI retried the checklist creation on this turn -- shows it recognizes the task isn't complete. Same bugs as Turn 2.

### Turn 4: Pricing
- **Guest:** "كم التكلفة الاجمالية لأسبوع؟"
- **AI:** "I'll check with the manager on the weekly rate for your family of 4 and whether any better offer is available."
- **Agent:** Omar (Screening)
- **Tool call:** `get_sop` -> `pricing-negotiation`
  - **SOP content:** "NEVER offer discounts... If guest asks for better price... acknowledge and push back..."
  - **Result:** AI escalated correctly as "escalation-unknown-answer"
- **Result:** PASS -- Correct SOP lookup, correct escalation

### Turn 5: Manager Actions
- Listed tasks: 2 open (eligible-arab-family-pending-docs + message-delivery-failure)
- Resolved all tasks
- Changed status to CONFIRMED
- **Note:** No checklist was created despite AI's attempts. The `screeningAnswers` field remained `{}`

---

## Phase 2: CONFIRMED -- Document Submission (Turns 6-13)

### Turn 6: Ready to Send Passports
- **Guest:** "تم تأكيد الحجز الحمدلله، ابغى ارسل الجوازات"
- **AI:** "Perfect -- please send clear photos of the passports here for all guests, and I'll take care of it."
- **Agent:** Omar (Lead Guest Coordinator) -- CORRECT agent switch
- **System prompt:** Changed to "Lead Guest Coordinator" (was "Screening Assistant")
- **Tool calls:** None
- **Result:** PASS -- Correctly invited guest to send documents

### Turn 7: 1st Passport (Khaled) -- with image
- **Guest:** "جواز خالد" + image
- **AI:** "Received, thanks. I'll check it shortly."
- **Tool call:** `get_sop` -> `sop-visitor-policy` (WRONG classification!)
  - **SOP content:** "Guest wants to invite someone ELSE over... This SOP is for VISITOR requests only..."
  - **Note:** The SOP itself says "If the guest is asking about their OWN booking documents (passport, marriage cert, ID), this does not apply"
- **Escalation:** "passport-document-review" -- correct intent, wrong mechanism
- **Bug:** **`mark_document_received` was NOT called.** The AI used `get_sop` instead of `mark_document_received`. Since the checklist was never created, the AI has no awareness of the checklist tool for document tracking.
- **Result:** FAIL

### Turn 8: 2nd Passport (Nour) -- with image
- **Guest:** "جواز نور" + image
- **AI:** "Received, thanks. I'll check it shortly."
- **Tool calls:** None (no SOP lookup, no mark_document_received)
- **Action:** Updated existing task cmnfzi8fu004r10wwj77b2rrn
- **Result:** FAIL -- no checklist update

### Turn 9: 3rd Passport (Sara) -- with image
- **Guest:** "جواز سارة (بنتنا)" + image
- **AI:** "Received, thanks -- I'm checking Sarah's passport shortly."
- **Tool calls:** None
- **Action:** Updated existing task
- **Result:** FAIL -- no checklist update

### Turn 10: 4th Passport (Omar) -- with image
- **Guest:** "جواز عمر (ابننا)" + image
- **AI:** "Thanks, I'm checking it now."
- **Tool calls:** None
- **Escalation:** "passport-image-review" -- AI noted "image appears unclear/placeholder and needs manual review" (it detected the placehold.co test image!)
- **Result:** FAIL -- no checklist update

### Turn 11: Marriage Certificate -- with image
- **Guest:** "وهذي شهادة الزواج" + image
- **AI:** "Thanks, I've received it and I'm checking it now."
- **Tool calls:** None
- **Escalation:** "marriage-certificate-image-review" -- correct identification
- **Result:** FAIL -- no checklist update

### Checklist State After All Documents
```json
{}
```
**screeningAnswers is completely empty.** The checklist was never created and no documents were ever marked.

### Turn 12: "Did you receive everything?"
- **Guest:** "هل وصلكم كل شي؟"
- **AI:** "Yes, I received the passports. The marriage certificate is still under review."
- **Tool calls:** None
- **Note:** AI is relying on conversation memory, not the checklist system. It correctly remembered 4 passports and 1 marriage cert were sent, but the "still under review" is fabricated (no real review process).
- **Result:** Partially correct response, but based on chat memory not checklist

### Turn 13: Manager Actions
- Tasks: 2 open (empty-title task + message-delivery-failure)
- Resolved all
- Changed status to CHECKED_IN

---

## Phase 3: CHECKED_IN (Turns 14-19)

### Turn 14: Arrival
- **Guest:** "وصلنا!"
- **AI:** "Welcome, glad you arrived. Let me know if you need anything."
- **Agent:** Omar (Coordinator), sopVariantStatus: CHECKED_IN
- **Result:** PASS

### Turn 15: Document Status Check
- **Guest:** "هل كل الاوراق تمام؟"
- **AI:** "Yes -- we have received all the documents, and the marriage certificate is still under review."
- **Tool calls:** None
- **Note:** Still relying on chat memory. Consistent with Turn 12 answer.
- **Result:** Acceptable response, but no checklist backing

### Turn 16: WiFi Password
- **Guest:** "ممتاز، وش كلمة سر الواي فاي؟"
- **AI:** "I'll check the WiFi details for you shortly."
- **Tool call:** `get_sop` -> `sop-wifi-doorcode`
  - **SOP content:** Only covers issues with WiFi/door code, not the actual credentials
- **Escalation:** "wifi-password-request"
- **Note:** WiFi credentials are empty in the test property's customKnowledgeBase. The SOP for wifi-doorcode doesn't include the actual credentials -- they should come from the property context.
- **Bug (P2):** WiFi SOP doesn't tell the AI to look in the property context for credentials. It only covers error scenarios.
- **Result:** PASS for escalation behavior, but the WiFi info should ideally be auto-provided if present in property data

### Turn 17: Pool Question
- **Guest:** "الاطفال يبغون مسبح، فيه مسبح؟"
- **AI:** "There isn't a pool at the property, but we do have a gym and a garden/backyard area."
- **Tool call:** `get_sop` -> `property-info`
  - **SOP returned full amenities list** -- no pool listed
- **Result:** PASS -- Excellent response. Correctly checked amenities, told guest no pool, suggested alternatives.

### Turn 18: Extra Baby Bed
- **Guest:** "نحتاج سرير اطفال اضافي"
- **AI:** "Let me check on that and get back to you shortly."
- **Tool call:** `get_sop` -> `sop-amenity-request`
  - **SOP content:** "Item NOT listed -> say 'Let me check on that' -> escalate as 'info_request'"
- **Escalation:** "extra-child-bed-request" (info_request)
- **Result:** PASS -- Perfect SOP adherence. Child bed not in ON REQUEST list, so "let me check" + escalate.

### Turn 19: Thank You
- **Guest:** "شكرا عمر على كل شي"
- **AI response timed out** (120s), but AI log shows empty response: `{ guest_message: "" }`
- **Bug (P2):** AI returned empty guest_message for a "thank you" message. Should respond with a polite acknowledgment.
- **Result:** FAIL

---

## Summary

### What Worked
| Area | Status | Notes |
|------|--------|-------|
| Screening flow | PASS | Correctly asked nationality before everything else |
| Agent switching | PASS | Screening -> Coordinator on status change to CONFIRMED |
| SOP routing | PASS | Correct categories: pricing-negotiation, property-info, sop-amenity-request, sop-wifi-doorcode |
| SOP adherence | PASS | Followed SOP instructions accurately (amenity request, pricing escalation) |
| Escalation quality | PASS | Clear task titles, relevant notes, correct urgency levels |
| Arabic understanding | PASS | All Arabic messages understood correctly |
| Image handling | PASS | Multimodal input processed, even detected placeholder images |
| Conversation memory | PARTIAL | Tracked document submissions via chat context, but unreliable |

### What Failed
| Bug | Severity | Description |
|-----|----------|-------------|
| create_document_checklist fails | P0 | Tool returns "No reservation linked" despite conversation having reservationId. The checklist is never created. Entire document tracking system non-functional. |
| marriage_certificate_needed=false | P1 | AI does not flag marriage certificate as needed for Saudi married couple. Prompt/SOP gap. |
| mark_document_received never called | P0 | Since checklist never created, AI never uses mark_document_received for any of the 5 document submissions. Falls back to manual escalation. |
| SOP misclassification on passport | P2 | Turn 7: passport submission classified as "sop-visitor-policy" instead of document submission |
| WiFi SOP incomplete | P2 | sop-wifi-doorcode only covers error scenarios, not serving the actual credentials |
| Empty response on "thank you" | P2 | AI returns empty guest_message for a gratitude message |

### Root Cause Analysis

The primary failure is **the `create_document_checklist` tool returning "No reservation linked"**. This is a deployment/context issue:

1. The conversation has `reservationId: cmnfzaydc000fyo3mbs0pr12n` in the database
2. The controller at `conversations.controller.ts:375` passes `reservationId: reservation.id` to the AI context
3. But when the tool executes on Railway (`ai.service.ts:1563`), `context.reservationId` is falsy
4. **Likely cause:** Railway deployment may be running an older version of the code that doesn't include `reservationId` in the AI context, OR the send-ai-now path on Railway has a different code path that doesn't populate it

The secondary failure cascade:
- No checklist created -> AI has no checklist awareness in subsequent turns
- No checklist -> `mark_document_received` tool is never invoked
- AI falls back to conversation memory for document tracking (unreliable)
- The SOP system doesn't have a "document-submission" category, so passport submissions get misrouted to "visitor-policy"

### Cost Summary
| Phase | Turns | Total Cost | Avg Cost/Turn |
|-------|-------|-----------|---------------|
| Screening (INQUIRY) | 4 | $0.01430 | $0.00358 |
| Document Submission (CONFIRMED) | 7 | $0.03769 | $0.00538 |
| Checked In | 6 | $0.01893 | $0.00316 |
| **Total** | **17** | **$0.07092** | **$0.00417** |

### Recommendations

1. **P0 -- Fix create_document_checklist "No reservation linked":** Verify Railway deployment has the latest code. Add logging to trace `context.reservationId` value at tool execution time. Consider adding the reservation lookup directly in the tool handler as a fallback.

2. **P1 -- Add marriage certificate logic to screening prompt:** The screening prompt/SOP should explicitly instruct the AI that married couples require a marriage certificate. Currently the AI is making its own judgment and getting it wrong.

3. **P1 -- Add "document-submission" SOP category:** When a guest sends a passport/document image during CONFIRMED status, the SOP should route to a document-handling procedure, not visitor-policy.

4. **P2 -- Improve WiFi SOP:** Include instruction for the AI to check property context for WiFi credentials and serve them directly if available.

5. **P2 -- Handle "thank you" messages:** Ensure the AI generates a non-empty response for gratitude messages.

6. **Deploy latest code to Railway:** The "No reservation linked" error may simply be a stale deployment. Redeploy and retest.
