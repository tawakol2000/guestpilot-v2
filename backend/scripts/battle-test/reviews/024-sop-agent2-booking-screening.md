# Battle Test 024 — SOP Agent: Booking & Screening Flow

**Date:** 2026-04-01
**Persona:** Lina & Ahmad Barakat (INQUIRY, Jordanian married couple + 2 kids, 4 guests)
**Conversation:** `cmng5juvm000bl3b6ouohn14a`
**Reservation:** `cmng5juto0009l3b6fmpr0jpj`
**Model:** gpt-5.4-mini-2026-03-17 (agent: Omar)

---

## Results Summary

| Turn | Message | Expected SOP | Actual SOP (get_sop) | Correct? | Tools Called | Response Summary |
|------|---------|-------------|---------------------|----------|-------------|------------------|
| 1 | "Hi, we're interested in booking your apartment for a family vacation" | none/screening | none (inline screening) | YES | none | Asked for nationality + guest composition. Correct screening-first behavior. |
| 2 | "We're Jordanian, I'm Ahmad, my wife Lina, and our 2 kids aged 8 and 5" | create_document_checklist (passports=4, marriage_cert=true) | none | PARTIAL | create_document_checklist (passports=4, marriage_cert=**false**) | Checklist created but **marriage_certificate_needed=false** -- should be true for Arab married couple. Escalated correctly as eligible. |
| 3 | "How much per night?" | pricing-negotiation | pricing-negotiation | YES | get_sop | Correctly fetched pricing SOP. Escalated to manager for rate confirmation. |
| 4 | "Can you do a discount for a week stay?" | pricing-negotiation | pricing-negotiation | YES | get_sop | Correctly fetched pricing SOP. Used SOP language "I've requested an additional discount from the manager." |
| 5 | "What does the apartment look like? How many bedrooms?" | property-info / sop-booking-inquiry | property-info, property-description | YES | get_sop | Answered with property details (2 bedrooms, pool, garden access). Good property knowledge retrieval. |
| 6 | "Is our booking confirmed? Can you check?" | sop-booking-confirmation | none (no get_sop call) | NO | none | Answered directly from reservation data without fetching booking-confirmation SOP. Response was accurate but no SOP guidance was consulted. |
| 7 | "Actually we might want to cancel, what's your cancellation policy?" | sop-booking-cancellation | sop-booking-cancellation | YES | get_sop | Correctly fetched cancellation SOP. Escalated as info_request. Told guest it varies by platform. |
| 8 | "Never mind, we'll keep the booking. Is this suitable for a long-term stay of 1 month?" | sop-long-term-rental | pricing-negotiation, property-info | PARTIAL | get_sop | Fetched pricing + property SOPs but missed **sop-long-term-rental** specifically. The pricing SOP itself says "For long-term stay pricing, also tag with sop-long-term-rental" but the model didn't do it. Response was good -- mentioned amenities and asked for dates. |
| 9 | "We want to add my mother to the booking, so 5 guests total" | sop-booking-modification | sop-visitor-policy, escalate | PARTIAL | get_sop | Used visitor-policy instead of booking-modification. Visitor policy is tangentially relevant (adding a family member), but the core request is a booking modification (guest count change). Escalated correctly and asked for passport. |
| 10 | "Can you confirm our final booking details?" | sop-booking-confirmation | property-info, pre-arrival-logistics | NO | get_sop | Fetched property-info + pre-arrival instead of booking-confirmation. Response was actually good -- confirmed dates, guest count, property name, and reminded about passports. |

---

## Scorecard

| Metric | Result |
|--------|--------|
| **SOP routing accuracy** | **6/10** (6 correct, 2 partial, 2 wrong) |
| **Response quality** | **9/10** (all responses were helpful, accurate, well-toned) |
| **Screening behavior** | **9/10** (correctly prioritized screening on Turn 1, asked nationality first) |
| **Escalation accuracy** | **10/10** (every escalation was appropriate with good task titles/notes) |
| **Tool usage** | **8/10** (create_document_checklist used correctly but marriage_cert missed) |
| **Overall** | **8/10** |

---

## Key Findings

### BUG: Marriage certificate not requested for Arab married couple (Turn 2)
- `create_document_checklist` was called with `marriage_certificate_needed: false`
- For an Arab married couple (Jordanian), the marriage certificate should be required
- The tool was correctly called with `passports_needed: 4`
- **Impact:** Could lead to incomplete document collection for eligible guests

### ISSUE: `sop-booking-confirmation` never triggered (Turns 6, 10)
- Two separate requests asking about booking confirmation status failed to trigger the `sop-booking-confirmation` SOP
- Turn 6: No SOP was fetched at all -- the model answered from reservation context alone
- Turn 10: Fetched `property-info` + `pre-arrival-logistics` instead
- The responses were accurate in both cases, but the SOP guidance wasn't consulted
- **Risk:** If the booking-confirmation SOP has specific instructions (e.g., what to include/exclude, what to ask for), they won't be followed

### ISSUE: `sop-long-term-rental` missed despite being referenced in pricing SOP (Turn 8)
- The pricing-negotiation SOP explicitly says "For long-term stay pricing, also tag with sop-long-term-rental"
- The model fetched `pricing-negotiation` + `property-info` but did not include `sop-long-term-rental`
- The model should have either: (a) included it in the initial categories, or (b) made a second tool call after reading the SOP instruction
- **Impact:** Long-term rental specific policies (minimum stay, monthly rate rules, lease terms) were not consulted

### ISSUE: `sop-booking-modification` missed for guest count change (Turn 9)
- Adding a guest to an existing booking is a booking modification
- The model routed to `sop-visitor-policy` + `escalate` instead
- While visitor policy is partially relevant (the mother is technically a new occupant), the primary action is modifying the reservation guest count
- **Impact:** If there are specific modification procedures (e.g., re-pricing, max occupancy limits, platform rules), they won't be followed

### POSITIVE: Excellent response quality throughout
- All 10 responses were natural, concise, and contextually appropriate
- The model maintained conversation continuity and remembered guest details
- Escalation tasks had clear, well-structured titles and notes
- The pricing SOP language ("I requested an additional discount from the manager") was correctly adopted

### POSITIVE: Strong screening-first discipline
- Turn 1 correctly asked for nationality and guest composition before answering anything
- Turn 2 correctly identified the family as eligible and escalated for confirmation
- Screening was completed before any property/pricing questions were answered

### NOTE: Hostaway delivery failures on test conversation
- All `message-delivery-failure` tasks are expected -- this is a test conversation without a real Hostaway reservation
- These do not indicate actual bugs

---

## Recommendations

1. **Fix marriage certificate logic** in `create_document_checklist` tool or prompt -- Arab married couples should always require marriage certificate
2. **Add `sop-booking-confirmation`** to the SOP definitions or improve prompt guidance so the model recognizes "confirm booking details" / "is my booking confirmed?" as a booking-confirmation SOP
3. **Teach multi-hop SOP lookups** -- when a fetched SOP says "also tag with X," the model should make a follow-up call for that SOP
4. **Distinguish booking-modification from visitor-policy** -- adding a guest to the booking is not the same as a visitor coming over; the model needs better category differentiation
5. **Consider always fetching an SOP** -- Turn 6 skipped get_sop entirely, which means the model self-answered without any SOP guidance. A lightweight "should I fetch SOP?" check might help.
