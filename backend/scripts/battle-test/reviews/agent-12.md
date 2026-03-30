# Agent 12 Review — [TEST] Tarek Nabil

**Persona:** CONFIRMED guest, couple, DIRECT channel, Apartment 104
**Stay:** 2026-03-29 to 2026-04-08 | Guests: 2
**Turns completed:** 13 (including follow-up nudge + 2 timeouts)
**Phases covered:** CONFIRMED (turns 1-4) + CHECKED_IN (turns 5-13)

---

## Summary

The AI pipeline handled most scenarios correctly. SOP routing was accurate, escalation urgency was appropriate, and the no-parties rule was enforced properly. Two significant issues were found: response timeouts on longer/complex messages and failure to match guest language when Arabic was used.

---

## Turn-by-Turn Log

| # | Guest Message (summary) | AI Response (summary) | SOP Hit | Escalation | Verdict |
|---|---|---|---|---|---|
| 1 | Confirm booking for arrival today | Confirmed, gave self check-in + gate instructions | pre-arrival-logistics | None | PASS |
| 2 | Ask about passports (2) + marriage cert | Will check with manager | pre-arrival-logistics, visitor-policy | info_request | PASS |
| 3 | Send 3 images (passports + cert) | Checking now, will come back | (tool used, no SOP match needed) | Updated existing task | PASS |
| 4 | Ask for address/directions from Cairo Airport | Will check exact address + route; gave gate instructions | pre-arrival-logistics, property-info | info_request | PASS |
| 5 | WiFi password? (CHECKED_IN now) | Will check WiFi details | sop-wifi-doorcode | info_request | PASS |
| 6 | When does cleaning come? | Extra cleaning available 10am-5pm, offered to schedule | sop-cleaning | None | PASS |
| 7 | Fridge not working, bought groceries | Apologized, informed manager, someone will look into it | sop-maintenance | **immediate** | PASS |
| 8 | Iron + ironing board for dinner event | Let me check on that | sop-amenity-request | info_request | PASS |
| 9 | Party complaint: 4 friends, neighbors complained, "no-parties rule?" | **TIMEOUT** -- no response within 120s | -- | -- | **FAIL** |
| 10 | Follow-up nudge: "Did you see my message?" | Enforced no-parties rule, family-only property, escalated | sop-complaint, sop-visitor-policy | **immediate** | PASS |
| 11 | BBQ area in compound? (Arabic) | No BBQ in amenities, offered to check with manager | property-info | info_request | PASS -- but see language issue |
| 12 | Security blocking food delivery from Talabat | **TIMEOUT** -- no response within 120s | -- | -- | **FAIL** |

---

## Issues Found

### BUG-1: AI response timeout on first attempt of complex/multi-topic messages (CRITICAL)
- **Turns 9 and 12** both timed out (120s+) on first attempt
- Turn 9 (party complaint with noise + no-parties rule dispute + minimization) required a follow-up nudge to get a response
- Turn 12 (compound security blocking food delivery + urgency + emotional tone) also timed out
- Both messages were longer/more complex with multiple topics and emotional language
- The system did eventually create a task on turn 9 timeout (`sop-tool-escalation`, immediate urgency), so partial processing occurred
- **Impact:** Guest waits 2+ minutes with no response on urgent issues

### BUG-2: Language mismatch -- Arabic message gets English response (MEDIUM)
- **Turn 11:** Guest wrote entirely in Egyptian Arabic ("فهمت يا عمر، معلش. سؤال تاني - في منطقة BBQ في الكمبوند؟ عايزين نعمل شوي بكرا")
- Omar responded in English: "I don't see a BBQ area listed among the available amenities..."
- The system prompt likely instructs to match guest language, but the AI defaulted to English
- **Impact:** Breaks the natural conversational flow; guest may feel less comfortable

### NOTE-1: WiFi password not in knowledge base
- Turn 5: Omar couldn't provide WiFi password and had to escalate
- This is correct behavior if the knowledge base truly doesn't have it, but worth verifying the KB has access codes for CHECKED_IN guests

---

## What Worked Well

1. **SOP routing accuracy:** Every turn hit the correct SOP category (pre-arrival-logistics, sop-cleaning, sop-maintenance, sop-amenity-request, sop-complaint, sop-visitor-policy, property-info)
2. **Escalation urgency calibration:** Maintenance (fridge) and complaint (party) correctly got `immediate`; informational requests correctly got `info_request`
3. **No-parties rule enforcement (Turn 10):** Omar correctly identified this was a policy violation, mentioned it's a family-only property, warned the guest, and escalated. Did not offer to accommodate the gathering.
4. **Image handling (Turn 3):** System accepted 3 image attachments and correctly updated the existing task rather than creating a duplicate
5. **Task management:** Properly created, updated, and resolved tasks throughout the conversation
6. **Amenity SOP adherence (Turn 8):** Iron/ironing board not in ON REQUEST amenities, so Omar correctly said "let me check" and escalated, following the SOP exactly

---

## Lifecycle Coverage

- **CONFIRMED phase:** 4 turns -- booking confirmation, documents, directions. All passed.
- **CHECKED_IN phase:** 9 turns -- WiFi, cleaning, maintenance, amenity request, party complaint, BBQ, food delivery. 2 timeouts.
- **Not tested (due to early stop):** Payment dispute, extend stay, cancel extension, late checkout, lost key, goodbye, Arabic-heavy conversation

---

## Recommendations

1. Investigate timeout root cause -- likely related to debounce/processing pipeline stalling on messages with multiple escalation signals or high complexity
2. Add language detection to match guest language in responses (or verify system prompt instructions are clear on this)
3. Ensure WiFi/access code information is populated in the knowledge base for checked-in guests
