# Battle Test 023 — Saudi Married Couple (Khalid & Noura Al-Saud)

**Date:** 2026-04-01
**Conversation ID:** `cmng17bqy000b1p487flo9gii`
**Reservation ID:** `cmng17bn200091p48zs3nazq6`
**Channel:** Airbnb
**Model:** gpt-5.4-mini-2026-03-17
**Agent:** Omar
**Total Turns Attempted:** 15
**Turns Completed:** 13 (2 timed out due to empty AI response bug)

---

## Summary

The AI successfully handled screening, document collection, and in-stay support for a Saudi married couple. The critical `create_document_checklist` tool fired correctly on turn 2 with `passports_needed=2` and `marriage_certificate_needed=true`. Agent switching from screening (INQUIRY) to coordinator (CONFIRMED/CHECKED_IN) worked. SOP routing via `get_sop` tool was accurate across all categories tested. Two bugs were found: (1) AI returns empty responses for positive/appreciation messages, causing polling timeouts, and (2) AI never responded in Arabic despite receiving Arabic messages.

---

## Turn-by-Turn Results

### Phase 1: INQUIRY (Screening)

| Turn | Guest Message | AI Response | Agent | Tool | SOP Category | Notes |
|------|--------------|-------------|-------|------|-------------|-------|
| 1 | "مرحبا، نبي نحجز شقة عندكم لمدة اسبوع" | "Thanks for your message. Please share your nationality and whether you'll be coming as a family, married couple, or group." | Omar (Screening) | None | none | Responded in English to Arabic message |
| 2 | "انا خالد من السعودية، معي زوجتي نورة، يعني شخصين" | "Thanks, Khalid. You and your wife are eligible for this stay, and I'll check with the manager to confirm the booking." | Omar (Screening) | `create_document_checklist` | none | **PASS**: passports_needed=2, marriage_certificate_needed=true |
| 3 | "كم سعر الليلة؟" | "I'm checking the nightly rate with the manager." | Omar (Screening) | `get_sop` | pricing-negotiation | Correctly deferred to manager |
| 4 | "هل يوجد مسبح؟" | "Yes, there is a swimming pool." | Omar (Screening) | `get_sop` | property-info | Correctly found pool in amenities |

### Phase 2: CONFIRMED (Coordinator)

| Turn | Guest Message | AI Response | Agent | Tool | SOP Category | Notes |
|------|--------------|-------------|-------|------|-------------|-------|
| 5 | "Booking confirmed, what do we need to send?" | "Please send your estimated arrival time..." | Omar (Coordinator) | `get_sop` | pre-arrival-logistics | Did NOT mention document checklist; focused on arrival logistics instead |
| 6 | "Here is Khalid's passport" [+image] | "Thanks, I'm checking this now." | Omar (Coordinator) | None | none | Escalated: unclear image (expected with placeholder) |
| 7 | "Here is Noura's passport" [+image] | "Thanks, I'm checking this now." | Omar (Coordinator) | None | none | Escalated + updated existing task |
| 8 | "Here is our marriage certificate" [+image] | "Thanks, I'm checking this now." | Omar (Coordinator) | None | none | Escalated: unclear document image |
| 9 | "Did you get all our papers?" | "I received the documents you sent, but the marriage certificate image still needs a clearer copy for review." | Omar (Coordinator) | `get_sop` | pre-arrival-logistics | Good awareness of document status |
| 10 | "What time can we check in?" | "Your booking starts on 8 April, and it's self check-in..." | Omar (Coordinator) | `get_sop` | pre-arrival-logistics | Correct SOP, self check-in info |

### Phase 3: CHECKED_IN (Coordinator)

| Turn | Guest Message | AI Response | Agent | Tool | SOP Category | Notes |
|------|--------------|-------------|-------|------|-------------|-------|
| 11 | "We checked in, everything is nice" | **EMPTY RESPONSE** | Omar (Coordinator) | None | none | **BUG**: AI returned guest_message="" |
| 11R | "We just arrived and checked in, the apartment looks great!" | **EMPTY RESPONSE** | Omar (Coordinator) | None | none | **BUG**: Same issue on retry |
| 12 | "What's the WiFi password?" | "Great to hear you're settled in. WiFi network: BR 104, password: BR@12345678." | Omar (Coordinator) | `get_sop` | sop-wifi-doorcode | Correct; access code shared (CHECKED_IN status) |
| 13 | "Is there a gym nearby?" | "Yes, there is a gym available in the building." | Omar (Coordinator) | `get_sop` | property-info | Correct; escalation signal `local_recommendation` detected |
| 14 | "What time is checkout?" | "Checkout is at 11:00 AM. If you need late checkout, please ask again closer to your date and we'll check then." | Omar (Coordinator) | `get_sop` | property-info, sop-late-checkout | Excellent multi-SOP routing |
| 15 | "شكرا جزيلا على كل شي" | **EMPTY RESPONSE** | Omar (Coordinator) | None | none | **BUG**: Same empty response for thank-you |

---

## Critical Check: Document Checklist

**PASS** -- `create_document_checklist` was called on Turn 2 with the correct parameters:

```json
{
  "reason": "Saudi married couple, 2 guests",
  "passports_needed": 2,
  "marriage_certificate_needed": true
}
```

Tool result confirmed:
```json
{
  "created": true,
  "passportsNeeded": 2,
  "marriageCertNeeded": true
}
```

---

## Arabic Language Support

**FAIL** -- The AI never responded in Arabic despite receiving 5 Arabic messages (turns 1, 2, 3, 4, 15). All responses were in English. The system prompt does not appear to contain language-matching instructions.

---

## Agent Switching

**PASS** -- Agent transitions were correct:
- Turns 1-4 (INQUIRY): `systemPromptPreview` shows "Guest Screening Assistant" -- screening agent
- Turns 5-15 (CONFIRMED/CHECKED_IN): `systemPromptPreview` shows "Lead Guest Coordinator" -- coordinator agent
- `sopVariantStatus` correctly reflected: INQUIRY -> CONFIRMED -> CHECKED_IN

---

## SOP Routing Summary

| SOP Category | Turns Hit | Correct? |
|-------------|-----------|----------|
| pricing-negotiation | 3 | Yes |
| property-info | 4, 13, 14 | Yes |
| pre-arrival-logistics | 5, 9, 10 | Yes |
| sop-wifi-doorcode | 12 | Yes |
| sop-late-checkout | 14 | Yes |
| none (no SOP needed) | 1, 2, 6, 7, 8, 11, 15 | Yes |

All SOP classifications were accurate.

---

## No RAG Confirmation

**PASS** -- No RAG/classifier/embedding references found in any AI logs. All SOP routing used the `get_sop` tool (inline tool loop). Every log entry shows:
- `sopReasoning: "No SOP classification -- handled inline via tool loop"`
- `sopClassificationTokens: { input: 0, output: 0 }`
- `sopClassificationDurationMs: 0`

---

## Bugs Found

### BUG 1: Empty Response for Positive/Appreciation Messages (HIGH)

**Severity:** High
**Affected turns:** 11, 11 retry, 15

When the guest sends a positive message that doesn't ask a question ("We checked in, everything is nice", "شكرا جزيلا على كل شي"), the AI returns `guest_message: ""`. The pipeline then does not save an AI message to the database, causing the polling loop to time out after 2 minutes.

**Root cause hypothesis:** The AI model decides these messages don't require a response and returns an empty string. The pipeline should either:
1. Force the AI to always respond (even with a brief acknowledgment like "Glad to hear! Let me know if you need anything.")
2. Handle empty `guest_message` gracefully -- save it as a "no response needed" state instead of hanging.

**Impact:** Guest messages go unanswered. In production, the guest would never receive a reply to their check-in announcement or thank-you, which feels rude and unresponsive.

### BUG 2: No Arabic Language Matching (MEDIUM)

**Severity:** Medium

The AI always responds in English regardless of the guest's language. When a guest writes in Arabic, the AI should match their language. This is especially important for Arab guests in a property located in Cairo.

---

## Cost Analysis

| Turn | Input Tokens | Output Tokens | Cost (USD) | Duration (ms) |
|------|-------------|---------------|------------|---------------|
| 1 | 2,551 | 318 | $0.00316 | 3,041 |
| 2 | 1,750 | 200 | $0.00264 | 4,176 |
| 3 | 1,846 | 535 | $0.00583 | 6,567 |
| 4 | 1,819 | 108 | $0.00218 | 3,414 |
| 5 | 1,999 | 495 | $0.00564 | 6,361 |
| 6 | 3,207 | 533 | $0.00532 | 4,345 |
| 7 | 3,345 | 424 | $0.00411 | 3,153 |
| 8 | 3,351 | 621 | $0.00590 | 4,433 |
| 9 | 2,534 | 509 | $0.00619 | 9,082 |
| 10 | 2,507 | 546 | $0.00558 | 7,359 |
| 11 | 2,846 | 178 | $0.00221 | 1,747 |
| 12 | 1,999 | 94 | $0.00209 | 3,730 |
| 13 | 2,125 | 182 | $0.00303 | 4,357 |
| 14 | 2,336 | 207 | $0.00334 | 42,821 |
| 15 | ~2,860 | ~142 | ~$0.00155 | ~1,756 |
| **Total** | **~37,075** | **~5,092** | **~$0.0588** | - |

Average cost per turn: ~$0.004
Average latency (excluding outliers): ~4.5s

Turn 14 had an anomalous 42.8s duration despite normal token counts -- possible API or network latency spike.

---

## Tasks Created

| Task | Turn | Urgency | Status |
|------|------|---------|--------|
| message-delivery-failure | 1 | immediate | resolved |
| eligible-arab-couple-pending-cert | 2 | info_request | resolved |
| unclear-passport-image-review | 6 | info_request | resolved |
| unclear-passport-image-review (updated) | 7 | info_request | (update to existing) |
| unclear-document-image-review (updated) | 8 | info_request | (update to existing) |
| message-delivery-failure | 12 | immediate | open |

Note: `message-delivery-failure` tasks are expected since this is a test reservation with no real Hostaway listing.

---

## Overall Assessment

| Category | Rating | Notes |
|----------|--------|-------|
| Document Checklist | PASS | create_document_checklist called correctly |
| Screening Flow | PASS | Nationality check, eligibility, manager escalation all correct |
| Agent Switching | PASS | Screening -> Coordinator transitions clean |
| SOP Routing | PASS | All categories matched accurately |
| Access Code Security | PASS | WiFi shared only after CHECKED_IN status |
| Image Handling | PASS | Placeholder images correctly flagged as unclear |
| Arabic Support | FAIL | All responses in English despite Arabic input |
| Empty Response Bug | FAIL | 3 turns returned empty guest_message |
| No RAG/Classifier | PASS | Pure tool-based SOP routing, no legacy pipeline |

**Final Verdict:** The core pipeline works well. Two actionable bugs need fixing: empty responses for non-question messages, and lack of language matching for Arabic input.
