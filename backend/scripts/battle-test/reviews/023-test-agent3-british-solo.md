# Battle Test Review: British Solo Traveler (James Wilson)

**Date**: 2026-04-01
**Persona**: James Wilson, British, solo male traveler, 1 guest
**Channel**: Booking.com
**Conversation ID**: cmng17c30000h1p48atrerwgg
**Reservation ID**: cmng17byt000f1p48au4565jc

---

## 1. Document Checklist (CRITICAL)

**PASS** -- `create_document_checklist` was called on message 2 with the correct parameters:

```json
{
  "reason": "British solo traveler inquiry for booking acceptance",
  "passports_needed": 1,
  "marriage_certificate_needed": false
}
```

Tool results confirmed:
- `passportsNeeded: 1`
- `marriageCertNeeded: false`

## 2. No Marriage Certificate

**PASS** -- Marriage certificate was never mentioned or requested throughout the entire conversation. The `marriage_certificate_needed: false` flag was correctly set for a non-Arab solo traveler, and no subsequent message referenced marriage documents.

## 3. Tool Calls by Turn

| Turn | Message | Tool Called | Categories | Notes |
|------|---------|-----------|------------|-------|
| 1 | "Hello, I'm interested in booking..." | None (no SOP needed) | none | Screening agent asked for nationality/party |
| 2 | "I'm James, British, travelling solo..." | `create_document_checklist` | none | passports=1, marriage_cert=false. Task created: "eligible-non-arab" |
| 3 | "How much is the nightly rate?" | `get_sop` | pricing-negotiation | Correctly escalated (AI has no pricing info) |
| 4 | "Is there parking available?" | `get_sop` | property-info | Answered from amenities list (free parking, street parking) |
| 5 | "Booking confirmed! What documents..." | `get_sop` | pre-arrival-logistics, property-info | Escalated to manager (doc requirements not in SOP) |
| 6 | "Here's my passport" (with image) | None | none | Escalated image for manager review |
| 7 | "Did you receive my passport?" | None | none | Confirmed receipt, no unnecessary escalation |
| 8 | "What are the check-in instructions?" | `get_sop` | pre-arrival-logistics | Self check-in, gate security instructions |
| 9 | "Is there a supermarket nearby?" | `get_sop` | property-info, property-description | Answered from property description (O1, Garden 8, Waterway malls) |
| 10 | "Great, looking forward to my stay" | -- | -- | **TIMEOUT** -- debounce batched with msg 11 |
| 11 | "Just checked in, place looks brilliant" | None | none | Simple acknowledgment, no SOP needed |
| 12 | "What's the WiFi password?" | `get_sop` | sop-wifi-doorcode | WiFi shared (silverpalm!). Door code NOT exposed. |
| 13 | "Can I get a late checkout?" | `get_sop` | sop-late-checkout | "2 days before" response (checkout >2 days away). No escalation. |
| 14 | "What time does the pool close?" | `get_sop` | property-info | Escalated (pool hours not in knowledge base) |
| 15 | "Cheers, thanks for all the help" | -- | -- | **NO REPLY** -- debounce race condition (see bugs) |

## 4. Agent Switching

**PASS** -- Agent switching worked correctly across all three phases:

| Phase | Status | Agent | System Prompt |
|-------|--------|-------|---------------|
| Messages 1-4 | INQUIRY | Omar (Screening) | "Guest Screening Assistant" |
| Messages 5-10 | CONFIRMED | Omar (Coordinator) | "Lead Guest Coordinator" |
| Messages 11-15 | CHECKED_IN | Omar (Coordinator) | "Lead Guest Coordinator" |

The transition from screening to coordinator was seamless after status change. The system prompt changed from screening-focused (nationality/party first) to coordinator-focused (handle requests, escalate when needed).

## 5. SOP Routing

**PASS** -- All SOP categories were correctly identified:

- `pricing-negotiation` for rate question (msg 3)
- `property-info` for parking (msg 4), amenities (msg 9, 14)
- `property-description` for nearby locations (msg 9)
- `pre-arrival-logistics` for documents (msg 5) and check-in (msg 8)
- `sop-wifi-doorcode` for WiFi password (msg 12)
- `sop-late-checkout` for late checkout (msg 13)

Notable SOP adherence:
- **Late checkout (msg 13)**: Checkout is April 15, current date April 1. More than 2 days before checkout, so AI correctly did NOT escalate and gave the standard "2 days before" response per SOP.
- **WiFi (msg 12)**: Shared WiFi credentials to CHECKED_IN guest (allowed). Did not expose door code (correctly withheld info not asked for).
- **Pricing (msg 3)**: Did not offer discounts, escalated as per SOP.

## 6. Errors and Issues

### BUG: Debounce Race Condition (Messages 10, 15)

**Severity: Medium**

Messages 10 and 15 (both casual/non-question messages) did not receive AI replies within the turn.ts timeout window (120s). Investigation shows:

- **Message 10** ("Great, looking forward to my stay"): Sent twice due to timeout retry. Both were eventually batched with message 11 by the debounce system (visible in msg 11's query field containing all three texts). The AI responded to the batch.
- **Message 15** ("Cheers, thanks for all the help"): Never received an AI reply. The PendingAiReply row had `fired=true` from a previous cycle, and the debounce job did not re-fire for this message. The `scheduledAt` was updated to `12:49:47` (close to msg time) but `fired` remained `true`, preventing processing.

**Root cause**: The single PendingAiReply row per conversation uses an atomic `fired` flag. Once set to `true` by a previous debounce cycle, subsequent messages that update `scheduledAt` don't reset `fired`, so the debounce job skips them.

### MINOR: Hostaway Delivery Failures (All Messages)

All AI replies show "Request failed with status code 404" for Hostaway delivery. This is expected in the test environment (no real Hostaway reservation). These failures create `message-delivery-failure` tasks which accumulate in the task list.

### MINOR: Turn Counter Gaps

Turn numbers jump (1, 2, 4, 6, 8, 10, 12, 13, 15, 17, 19, 20, 22) due to internal AI_PRIVATE messages counting as turns. Not a bug, just a counter behavior to be aware of.

## 7. No RAG/Classifier/Embedding References

**PASS** -- Zero RAG, classifier, or embedding activity detected across all 13 processed messages:

- All `ragContext` entries show `sopToolUsed: true` with inline tool loop
- `sopReasoning` consistently shows "No SOP classification -- handled inline via tool loop"
- `sopClassificationTokens` always `{ input: 0, output: 0 }`
- `sopClassificationDurationMs` always `0`
- No embedding calls, no KNN classifier, no vector searches

The entire pipeline operates through the `get_sop` tool call pattern.

## 8. Cost Summary

| Turn | Model | Input Tokens | Output Tokens | Cost (USD) | Cached |
|------|-------|-------------|---------------|------------|--------|
| 1 | gpt-5.4-mini | 2,539 | 163 | $0.00314 | 0 |
| 2 | gpt-5.4-mini | 1,692 | 147 | $0.00219 | 0 |
| 3 | gpt-5.4-mini | 1,822 | 314 | $0.00387 | 0 |
| 4 | gpt-5.4-mini | 1,718 | 132 | $0.00230 | 0 |
| 5 | gpt-5.4-mini | 2,017 | 304 | $0.00382 | 0 |
| 6 | gpt-5.4-mini | 3,209 | 627 | $0.00755 | 0 |
| 7 | gpt-5.4-mini | 2,843 | 807 | $0.00769 | 2,048 |
| 8 | gpt-5.4-mini | 2,028 | 243 | $0.00343 | 0 |
| 9 | gpt-5.4-mini | 2,367 | 203 | $0.00335 | 0 |
| 11 | gpt-5.4-mini | 2,809 | 120 | $0.00160 | 2,048 |
| 12 | gpt-5.4-mini | 1,934 | 84 | $0.00198 | 0 |
| 13 | gpt-5.4-mini | 2,172 | 146 | $0.00266 | 0 |
| 14 | gpt-5.4-mini | 2,125 | 375 | $0.00370 | 1,280 |

**Total**: ~$0.047 for 13 AI calls (messages 10 and 15 not processed)

## 9. Overall Assessment

### What Worked Well
- Document checklist tool correctly identified British solo = 1 passport, no marriage certificate
- SOP routing was accurate across all categories
- Agent switching (screening -> coordinator) was seamless
- Late checkout SOP logic was perfectly applied (>2 days = no escalation)
- WiFi shared to CHECKED_IN guest, door code appropriately withheld
- Escalation decisions were appropriate (unknown info -> manager)
- Prompt caching kicked in for some messages (2,048 and 1,280 cached tokens)

### What Needs Attention
- **Debounce race condition**: Message 15 never received a reply. The `fired` flag on PendingAiReply prevents re-processing. This could cause missed replies to real guests.
- **Double-send on timeout**: When turn.ts times out, retrying creates duplicate guest messages that get batched by debounce. The debounce handled it gracefully, but the duplicate messages pollute the conversation history.

### Grade: B+

Core AI functionality is excellent -- screening, SOP routing, tool calls, and agent switching all work correctly. The document checklist critical check passed perfectly. The debounce race condition on message 15 (no reply generated) is the only significant issue, preventing an A grade.
