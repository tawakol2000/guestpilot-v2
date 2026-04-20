# Document Checklist Flow Test: Non-Arab Solo Traveler

**Date:** 2026-03-30
**Branch:** 022-deep-code-cleanup
**Persona:** [TEST] James Wilson | British | Solo male (1 guest)
**ConversationId:** cmnfzay9k000byo3mj22dihfo
**ReservationId:** cmnfzay7o0009yo3mot6hp55m
**PropertyId:** cmnacm2g000a3d5dbh191mowv
**Model:** gpt-5.4-mini-2026-03-17

---

## Summary

| Check | Result | Details |
|-------|--------|---------|
| Screening: non-Arab solo accepted | PASS | AI correctly identified British solo = eligible |
| create_document_checklist called | PARTIAL | Tool called with correct params, but **failed** |
| Params: passports_needed=1 | PASS | Correct value in toolInput |
| Params: marriage_certificate_needed=false | PASS | Correct value in toolInput |
| mark_document_received called on passport submission | FAIL | Never called — checklist didn't exist |
| AI confirms all documents complete | N/A | No checklist to track against |
| No marriage certificate ever requested | PASS | Never mentioned across all turns |
| Agent transition INQUIRY -> CONFIRMED -> CHECKED_IN | PASS | Screening agent -> coordinator agent at correct boundaries |
| WiFi/credential delivery (CHECKED_IN only) | PASS | Correctly escalated (creds not in knowledge base) |

**Overall: FAIL — critical bug in create_document_checklist tool**

---

## Critical Bug Found

### BUG: `create_document_checklist` fails with "No reservation linked"

**Turn 2** — AI correctly called `create_document_checklist` with:
```json
{
  "reason": "British solo traveler, 1 guest",
  "passports_needed": 1,
  "marriage_certificate_needed": false
}
```

**But the tool returned:**
```json
{
  "error": "No reservation linked",
  "created": false
}
```

**Impact:** The entire document tracking flow is broken. Without a checklist:
- Turn 6: AI doesn't know to tell guest to send passport via chat (escalates instead)
- Turn 7: `mark_document_received` is never called when passport image is sent
- Turn 10: AI can't confirm all documents are complete (no tracking)

**Root Cause Hypothesis:** The `create_document_checklist` tool handler likely requires a linked reservation, but during INQUIRY status the reservation may not be fully associated with the conversation, or the tool handler doesn't have access to the reservation context from the screening agent's tool execution path.

**Severity:** HIGH — this completely breaks the automated document flow for all guests.

---

## Turn-by-Turn Log

### Phase 1: INQUIRY — Screening

#### Turn 1: Opening message
- **Guest:** "Hi, I'd like to book your apartment for a week"
- **Omar:** "Hi James -- please tell me your nationality and who will be staying with you."
- **Agent:** Screening (INQUIRY)
- **Tool calls:** None
- **Tokens:** 2,542 in / 119 out | Cost: $0.0028
- **Result:** PASS — correct screening question

#### Turn 2: Nationality + solo status (KEY TURN)
- **Guest:** "British, from London. Just me travelling solo"
- **Omar:** "Thanks, James -- this looks fine for our house rules. I'll check with the manager and get back to you."
- **Agent:** Screening (INQUIRY)
- **Tool calls:**
  - `create_document_checklist` called with:
    ```json
    {
      "reason": "British solo traveler, 1 guest",
      "passports_needed": 1,
      "marriage_certificate_needed": false
    }
    ```
  - **Result:** `{"error": "No reservation linked", "created": false}`
- **Escalation:** "eligible-non-arab" task created (info_request)
- **Tokens:** 1,553 in / 283 out (205 reasoning) | Cost: $0.0034
- **Result:** PARTIAL — correct tool call + correct params, but tool execution failed

#### Turn 3: Property description
- **Guest:** "Great! What's the apartment like?"
- **Omar:** "It's a signature suite in Silver Palm, a gated community in New Cairo..."
- **Agent:** Screening (INQUIRY)
- **Tool calls:** `get_sop` with categories: ["property-description"]
- **Result:** PASS — accurate property description from SOP

#### Turn 4: Pricing
- **Guest:** "How much per night?"
- **Omar:** "I've checked with the manager about the nightly rate."
- **Agent:** Screening (INQUIRY)
- **Tool calls:** `get_sop` with categories: ["pricing-negotiation"]
- **Escalation:** Task updated with pricing request
- **Tokens:** 1,940 in / 590 out (516 reasoning) | Cost: $0.0056
- **Result:** PASS — correct SOP lookup + escalation (screening agent doesn't have rate info)

#### Turn 5: Manager Actions
- Resolved 3 tasks (eligible-non-arab, ai-parse-failure, message-delivery-failure)
- Changed status: INQUIRY -> CONFIRMED
- **Result:** PASS

---

### Phase 2: CONFIRMED — Document Submission

#### Turn 6: Where to send passport
- **Guest:** "Booking confirmed, where do I send my passport?"
- **Omar:** "I'll check with the manager and get back to you shortly."
- **Agent:** Coordinator (CONFIRMED) -- agent transition confirmed
- **Tool calls:** `get_sop` with categories: ["pre-arrival-logistics"]
- **Escalation:** "passport-submission-instructions" task created
- **Tokens:** 1,987 in / 480 out (385 reasoning) | Cost: $0.0054
- **Result:** FAIL — Should have told guest to send passport via chat. Escalated because no document checklist exists.
- **Note:** SOP returned pre-arrival logistics (directions, gate instructions) — no document-specific SOP matched.

#### Turn 7: Passport image submission (KEY TURN)
- **Guest:** "Here's my passport" + image (https://placehold.co/600x400.jpg)
- **Omar:** "Thanks, James -- I've received your passport and I'm checking it now."
- **Agent:** Coordinator (CONFIRMED)
- **Tool calls:** NONE — `mark_document_received` was NOT called
- **Escalation:** "passport-received-for-review" task created (info_request)
- **Tokens:** 3,050 in / 452 out (342 reasoning) | Cost: $0.0045
- **Result:** FAIL — should have called `mark_document_received` with document_type="passport"
- **Note:** Image was included in prompt (8,709 char user content vs ~1,600 for text-only turns). AI acknowledged but escalated manually.

#### Turn 9: Passport receipt confirmation
- **Guest:** "Did you receive my passport?"
- **Omar:** "Yes, James -- I received your passport."
- **Agent:** Coordinator (CONFIRMED)
- **Tool calls:** None
- **Tokens:** 2,647 in / 154 out (112 reasoning) | Cost: $0.0018
- **Result:** PASS — correctly confirmed receipt based on conversation history

#### Turn 10: Anything else needed?
- **Guest:** "Do you need anything else from me?"
- **Omar:** "No, James -- nothing else is needed for now. If we need anything further, I'll let you know shortly."
- **Agent:** Coordinator (CONFIRMED)
- **Tool calls:** None
- **Tokens:** 2,725 in / 318 out (261 reasoning) | Cost: $0.0033
- **Result:** ACCEPTABLE — said nothing else needed (correct for solo non-Arab = passport only), but no programmatic confirmation via checklist

---

### Phase 3: CHECKED_IN

#### Turn 12: Check-in confirmation
- **Guest:** "Just checked in, everything looks great"
- **Omar:** "Glad to hear that, James."
- **Agent:** Coordinator (CHECKED_IN) -- status transition confirmed
- **Tool calls:** None
- **Tokens:** 2,704 in / 209 out (169 reasoning) | Cost: $0.0023
- **Result:** PASS — no mention of pending documents, warm acknowledgment

#### Turn 13: WiFi password
- **Guest:** "What's the WiFi password?"
- **Omar:** "I'll check the WiFi details and get back to you shortly, James."
- **Agent:** Coordinator (CHECKED_IN)
- **Tool calls:** `get_sop` with categories: ["sop-wifi-doorcode"]
- **SOP returned:** Instructions for WiFi/doorcode issues only — no actual credentials
- **Escalation:** "wifi-password-request" task created
- **Tokens:** 1,938 in / 286 out (196 reasoning) | Cost: $0.0036
- **Result:** PASS — correctly escalated (WiFi password not in knowledge base). Status is CHECKED_IN so credentials are allowed.

---

## Cost Summary

| Phase | Turns | Total Input Tokens | Total Output Tokens | Total Cost |
|-------|-------|--------------------|---------------------|------------|
| INQUIRY (Screening) | 4 | 7,785 | 1,322 | $0.0159 |
| CONFIRMED (Coordinator) | 4 | 10,409 | 1,466 | $0.0150 |
| CHECKED_IN (Coordinator) | 2 | 4,642 | 495 | $0.0059 |
| **Total** | **10** | **22,836** | **3,283** | **$0.0368** |

---

## Issues Found

### P0 (Critical)
1. **`create_document_checklist` fails with "No reservation linked"** — Tool is called correctly by the screening agent with the right parameters (passports_needed=1, marriage_certificate_needed=false), but the tool handler returns an error. This breaks the entire automated document tracking pipeline. The downstream `mark_document_received` tool is never invoked because there's no checklist to mark against.

### P1 (High)
2. **No document submission SOP exists** — When guest asks "where do I send my passport?", the `get_sop` tool returns "pre-arrival-logistics" SOP (directions/gate instructions) instead of document submission instructions. A dedicated SOP category for document submission is needed.

### P2 (Medium)
3. **Duplicate query in RAG** — Several turns show the query doubled in ragContext (e.g., "How much per night? How much per night?", "Great\\! What's the apartment like? Great\\! What's the apartment like?"). Minor but suggests a query construction bug.

### P3 (Low)
4. **Message delivery failures (expected)** — All Hostaway delivery attempts fail with 404. Expected for test conversations but creates noise in task queue.
5. **AI parse failure task on Turn 3** — First attempt timed out, retry created a parse failure task. May be related to the response containing special characters or the duplicate message.

---

## Recommendations

1. **Fix `create_document_checklist` tool handler** — Investigate why "No reservation linked" error occurs during INQUIRY. The reservation IS linked to the conversation (reservationId exists). Likely the tool handler needs to look up the reservation via the conversation's reservationId rather than expecting it passed differently.

2. **Add document-submission SOP** — Create a "document-submission" SOP category that instructs Omar to tell guests to send documents via chat and lists what's needed based on the checklist.

3. **Fix duplicate query bug** — The query string is being concatenated with itself before being passed to the RAG context. Trace the query construction path.

4. **Test with checklist fix** — Once P0 is fixed, re-run this test to validate the full automated flow: create_document_checklist -> guest sends image -> mark_document_received -> AI confirms completion.

---

## What Worked Well

- Screening correctly identified British solo traveler as eligible (non-Arab = all configs OK)
- `create_document_checklist` was called with exactly the right parameters (passports_needed=1, marriage_certificate_needed=false)
- No marriage certificate was ever mentioned or requested across all 13 turns
- Agent transitions (screening -> coordinator) happened correctly at status boundaries
- SOP tool routing was accurate for property-description, pricing-negotiation, pre-arrival-logistics, sop-wifi-doorcode
- AI maintained friendly, professional tone throughout
- Credential access rules respected (WiFi only available at CHECKED_IN status)
- Graceful degradation: even with broken document tracking, AI still managed the conversation reasonably
