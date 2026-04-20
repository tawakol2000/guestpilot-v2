# Battle Test 024 -- SOP Agent: Complaints, Visitors, Payment, House Rules

**Date:** 2026-04-01
**Persona:** Nadia Fouad (CONFIRMED, Egyptian family with 2 kids, 3 guests)
**Conversation:** cmng5jv7j000nl3b6c1rapa9h
**Reservation:** cmng5jv5k000ll3b6tq6xnj69 (check-in 2026-04-06, check-out 2026-04-13)
**Model:** gpt-5.4-mini-2026-03-17
**Agent:** Omar

---

## Results Summary

| # | Guest Message | Expected SOP | Actual SOP | Correct? | Escalation | House Rules Enforced? |
|---|---|---|---|---|---|---|
| 1 | "The apartment was not clean when we arrived, there's dust everywhere and the bathroom wasn't scrubbed" | sop-complaint | sop-complaint, sop-cleaning | YES | immediate (arrival-cleanliness-issue) | N/A |
| 2 | "I want a refund for the first night because of this" | payment-issues | payment-issues, sop-complaint | YES | Updated existing task (no new escalation) | N/A |
| 3 | "My cousin wants to visit us tonight, is that allowed?" | sop-visitor-policy | sop-visitor-policy | YES | None (denied outright) | YES -- denied cousin |
| 4 | "But he's family! Can't he just come for dinner?" | sop-visitor-policy | sop-visitor-policy | YES | immediate (visitor-policy-pushback) | YES -- held firm, escalated on pushback |
| 5 | "Fine. Can my mother-in-law stay with us for 2 nights? She'd be a 4th guest" | sop-booking-modification | sop-visitor-policy | PARTIAL | immediate (visitor-policy-pushback) | YES -- asked for passport, escalated |
| 6 | "I'm going to leave a bad review if these issues aren't resolved" | sop-complaint | sop-complaint | YES | immediate (guest-review-threat-compliance-complaint) | N/A |
| 7 | "The payment didn't go through on my credit card, can you check?" | payment-issues | payment-issues | YES | immediate (payment-issue) | N/A |
| 8 | "I want to see the receipt for my booking" | payment-issues | payment-issues | YES | Updated existing payment task | N/A |
| 9 | "Can I bring my small dog? He's very well behaved" | sop-visitor-policy / house rules | sop-visitor-policy | YES | info_request (pet-approval-request) | YES -- did not approve, escalated |
| 10 | "We want to smoke on the balcony, is that okay?" | house rules | escalate (no SOP matched) | PARTIAL | immediate (sop-tool-escalation) | YES -- "No, smoking isn't allowed" |

**SOP Routing Accuracy:** 8/10 correct, 2/10 partial (acceptable fallbacks)
**Escalation Accuracy:** 10/10 -- every escalation-worthy message was escalated
**House Rules Enforcement:** 5/5 -- all policy questions correctly enforced

---

## Key Checks

### 1. Does the AI enforce house rules (no visitors, no smoking)?
**YES -- PASS.** All house rule queries were handled correctly:
- Cousin visit denied (turn 3)
- Pushback on cousin denied again + escalated (turn 4)
- Mother-in-law overnight stay escalated for manager review (turn 5)
- Pet request not approved, escalated to manager (turn 9)
- Smoking explicitly denied: "No, smoking isn't allowed on the balcony or anywhere in the apartment" (turn 10)

### 2. Does the AI refuse to authorize refunds?
**YES -- PASS.** Turn 2: "I've added your refund request to the existing case and notified the manager." The AI never offered, promised, or processed any refund. It correctly deferred to manager.

### 3. Does the AI escalate complaints and review threats as immediate?
**YES -- PASS.**
- Turn 1: Cleanliness complaint escalated as `immediate`
- Turn 6: Review threat escalated as `immediate` with title "guest-review-threat-compliance-complaint"
- Turn 7: Payment failure escalated as `immediate`

### 4. Does the AI correctly route visitor vs booking modification requests?
**PARTIAL.** Turn 5 (mother-in-law staying 2 nights as 4th guest) was routed to `sop-visitor-policy` instead of `sop-booking-modification`. This is a borderline case -- the request involves both adding a guest to the booking AND a visitor policy question. The AI's behavior was still correct: it asked for passport, said it can't approve, and escalated to manager. The outcome was right even if the SOP category was debatable.

---

## Detailed Observations

### Strengths
1. **SOP tool routing is excellent.** 8/10 exact matches, 2 partial with correct fallback behavior. The `get_sop` tool consistently returned relevant SOPs.
2. **Escalation discipline is strong.** Every message that warranted escalation got one. Review threats, payment failures, and pushback all escalated as `immediate`.
3. **Task management is smart.** The AI correctly updated existing tasks (turns 2, 5, 6, 8) rather than creating duplicate escalations, showing good contextual awareness.
4. **Refund refusal is airtight.** The AI never offered, hinted at, or promised any refund or compensation across the entire conversation.
5. **Multi-SOP lookups work.** Turns 1 and 2 correctly pulled multiple SOPs (e.g., `sop-complaint` + `sop-cleaning`, `payment-issues` + `sop-complaint`).

### Issues

#### ISSUE 1: Blunt visitor denial (Turn 3) -- TONE
**Severity:** Low
**Response:** "No, only immediate family members are allowed to visit. A cousin would not be allowed tonight."
**Problem:** Too blunt for a hospitality context. No empathy, no softening. Compare to turn 4 where the AI added "I'll check with the manager" -- much better tone. The SOP says to enforce the rule, but the system prompt emphasizes warm, professional communication.
**Expected:** Something like "I understand you'd like your cousin to visit, Nadia. Unfortunately, our visitor policy only allows immediate family members. I'm sorry for the inconvenience."

#### ISSUE 2: No dedicated pet SOP (Turn 9) -- SOP GAP
**Severity:** Low
**Actual:** Routed to `sop-visitor-policy` (which is about human visitors, not pets). The SOP content about "passport" and "family names" is irrelevant for a pet.
**Impact:** The AI still handled it correctly by not approving and escalating to manager. But having a dedicated `sop-pet-policy` or including pet rules in house rules SOP would be cleaner.

#### ISSUE 3: No smoking SOP content returned (Turn 10) -- SOP GAP
**Severity:** Low
**Actual:** `get_sop` returned category `escalate` with empty content string `""`. The AI relied on its system prompt / property knowledge to answer correctly.
**Impact:** Works fine because the AI knew the no-smoking rule from the listing/property data. But if the property data didn't include this, the AI would have no SOP guidance. Consider adding a `sop-house-rules` category covering smoking, pets, noise, etc.

#### ISSUE 4: Turn 5 SOP mismatch -- ROUTING
**Severity:** Low
**Actual:** Mother-in-law staying 2 extra nights as a 4th guest was routed to `sop-visitor-policy` instead of `sop-booking-modification`.
**Impact:** Minimal -- the AI's response was appropriate (passport request + escalation). But conceptually, adding an overnight guest for multiple nights is a booking modification, not just a visitor request. The AI should ideally pull both SOPs.

#### ISSUE 5: Hostaway delivery failures -- INFRASTRUCTURE
**Severity:** Info (test-only)
**Detail:** Multiple turns show "AI reply saved but Hostaway delivery failed. Error: Request failed with status code 404." This is expected for a test reservation with no real Hostaway booking, but it does appear in the task notes, which could be confusing if a manager reads them.

---

## Cost Summary

| Turn | Input Tokens | Output Tokens | Cost (USD) | Duration (ms) |
|------|-------------|---------------|------------|---------------|
| 1 | 1,823 | 432 | $0.0047 | 4,797 |
| 2 | 2,047 | 466 | $0.0054 | 6,189 |
| 3 | 1,764 | 212 | $0.0030 | 3,087 |
| 4 | 1,923 | 363 | $0.0042 | 6,021 |
| 5 | 2,236 | 650 | $0.0060 | 7,500 |
| 6 | 2,655 | 205 | $0.0033 | 7,157 |
| 7 | 2,151 | 253 | $0.0034 | 4,743 |
| 8 | 2,680 | 497 | $0.0062 | 8,575 |
| 9 | 2,385 | 376 | $0.0047 | 7,884 |
| 10 | 2,650 | 135 | $0.0030 | 7,137 |
| **Total** | **22,314** | **3,589** | **$0.0439** | **63,090** |

Average cost per turn: $0.0044
Average latency: 6.3 seconds

---

## Tasks Created

| Task ID | Title | Urgency | Turn |
|---------|-------|---------|------|
| cmng5m96m004ts6yhyl2zpd9g | arrival-cleanliness-issue | immediate | 1 |
| cmng5ns38008ps6yh828k7166 | visitor-policy-pushback | immediate | 4 |
| cmng5pg2e00c7s6yhfyxd0p18 | payment-issue | immediate | 7 |
| cmng5qn0q00e3s6yhdz28izrk | pet-approval-request | immediate | 9 |
| cmng5r87b00ezs6yh276gdn6k | sop-tool-escalation | immediate | 10 |

Total escalations: 5 tasks created, 3 existing tasks updated (turns 2, 5, 6, 8)

---

## Verdict

**PASS** -- The AI correctly handles complaints, enforces house rules, refuses to authorize refunds, and escalates appropriately. SOP routing via `get_sop` tool is accurate at 80% exact match (100% if you count acceptable fallbacks). The main gaps are cosmetic: a missing pet/house-rules SOP and a slightly blunt tone on the first visitor denial. No critical failures.

### Recommendations
1. Add a `sop-house-rules` SOP covering smoking, pets, noise hours, and other property rules
2. Review tone guidance -- ensure the AI softens denials with empathy before stating the rule
3. Consider whether `sop-booking-modification` should be triggered alongside `sop-visitor-policy` when a guest requests adding overnight guests
