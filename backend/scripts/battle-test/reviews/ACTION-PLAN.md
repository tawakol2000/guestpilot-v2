# Battle Test Action Plan — GuestPilot AI

**Date:** 2026-03-30 | **Tested by:** 30 agents, ~926 messages, ~410 AI responses
**Overall Grade: B- (73/100)** | **Cost: ~$1.70 USD**

---

## The Bottom Line

The AI's SOP routing is solid (~89% accuracy), escalation logic is good (~92% correct), and screening compliance is perfect. But three deal-breakers make it unusable for real Arabic-speaking guests:

1. **Every Arabic message gets an English reply** — 100% failure rate
2. **14% of messages silently dropped** — no retry on rate limits
3. **WiFi/door codes never provided to checked-in guests** — the #1 guest request fails

---

## IMMEDIATE FIXES (Do This Week)

### 1. Add Language Matching to System Prompt
**Problem:** All 28 Arabic-speaking agents received 100% English responses.
**Fix:** Add this line to BOTH coordinator and screening system prompts:

```
## LANGUAGE
Always respond in the same language as the guest's most recent message. If the guest writes in Arabic, respond in Arabic. If they write in English, respond in English. Never switch languages unless the guest does.
```

**Effort:** 5 minutes (prompt edit)

### 2. Add Rate Limit Retry to AI Pipeline
**Problem:** When OpenAI returns 429 (rate limit), the pipeline fails silently. Guest gets no response. 65 messages were permanently lost.
**Fix:** In `ai.service.ts`, add exponential backoff retry (3 attempts: 1s, 2s, 4s). If all retries fail, insert a fallback message: "We received your message and will respond shortly." and create an escalation task.

**Effort:** 1-2 hours (code change)

### 3. Populate WiFi/Door Codes in Property Knowledge Base
**Problem:** No property has WiFi passwords or door codes in its `customKnowledgeBase`. The `sop-wifi-doorcode` SOP only covers troubleshooting, not credential delivery.
**Fix:**
- Add `wifiName`, `wifiPassword`, `doorCode` to each property's `customKnowledgeBase`
- Add a CHECKED_IN variant to `sop-wifi-doorcode`:
  ```
  Guest asks for WiFi or door code and is checked in:
  Share the WiFi name, WiFi password, and door code from the property info.
  If the codes are not in your info, escalate immediately.
  ```
- Add to system prompt: "Access codes (WiFi, door code) are ONLY for CHECKED_IN guests. Never share with INQUIRY, CONFIRMED, CHECKED_OUT, or CANCELLED guests."

**Effort:** 30 min (data entry + SOP edit)

### 4. Fix JSON Response Parser
**Problem:** The AI sometimes outputs `{...}{...}` (duplicated JSON) or empty `guest_message` fields. Guest receives nothing. Happened in 8 of 30 agents.
**Fix:** In the response parser, when `responseText` contains multiple JSON objects:
- Extract the last complete one with a non-empty `guest_message`
- If all have empty `guest_message`, use `""` (empty response per system prompt rules for acknowledgments)
- Log the malformed output for monitoring

**Effort:** 1 hour (code change)

---

## SHOULD FIX (Next Sprint)

### 5. Create `sop-extend-stay` SOP Category
**Problem:** Stay extension requests are misclassified to `pricing-negotiation` or `sop-booking-cancellation`. The `check_extend_availability` tool was NEVER called across all 30 agents — it's dead code.
**Fix:** Create a new enabled SOP:
- **Category:** `sop-extend-stay`
- **Tool description:** "Guest wants to extend their stay, add more nights, or stay longer. NOT for date changes (use sop-booking-modification)."
- **Content (CHECKED_IN variant):**
  ```
  Guest wants to extend their stay:
  1. Use the check_extend_availability tool to check if the dates are available.
  2. If available, share the dates and pricing with the guest.
  3. Escalate to manager with dates and pricing for confirmation.
  4. Never confirm an extension yourself.
  ```

### 6. Enable `sop-booking-modification`
**Problem:** Currently disabled. Unit changes, date changes, and guest count changes all fall through to complaint or generic escalation.
**Fix:** Enable it with content:
```
Guest wants to change dates, switch units, or modify guest count:
Never confirm modifications yourself. Escalate as info_request with:
- Current dates and requested changes
- Reason for change if provided
Within 48 hours of check-in: escalate as immediate instead.
```

### 7. Fix `create_document_checklist` Tool
**Problem:** Returns "No reservation linked" error in every INQUIRY conversation. The tool can't find the reservation from the conversation context.
**Fix:** In `document-checklist.service.ts`, resolve the reservation via `conversationId → conversation.reservationId` instead of the current lookup path.

### 8. Add Anti-Hallucination Guardrail to System Prompt
**Problem:** The AI fabricated availability ("the apartment isn't available" / "yes, the extra nights are available") 4 times without calling any tool.
**Fix:** Add to system prompt:
```
## NEVER FABRICATE
- Never claim you checked availability without using the check_extend_availability tool
- Never claim you checked pricing without using a pricing tool
- Never confirm dates, prices, or availability from memory — always use tools or escalate
```

### 9. Validate SOP Category Names
**Problem:** The AI sends `"escalate"` as a `get_sop` category 35 times across 16 agents. It always returns empty content.
**Fix:** In `sop.service.ts`, add validation in the `get_sop` tool handler:
```
If categories include "escalate" or "none", filter them out.
If no valid categories remain, return guidance:
"No SOP matches this request. Escalate to the manager with full details."
```

### 10. Fix Cleaning SOP — Ensure Post-Confirmation Escalation
**Problem:** After guest confirms cleaning time, the AI says "Done — housekeeping will come at 11 AM" but never creates an escalation task. Manager never gets notified. Housekeeping never shows up. Happened in agents 07, 13, 15.
**Fix:** Strengthen the cleaning SOP:
```
CRITICAL: After the guest confirms a time AND the $20 fee, you MUST escalate as "scheduled"
with the confirmed time in the note. Do NOT tell the guest "done" without escalating.
```

### 11. Merge `property-info` and `property-description`
**Problem:** `property-info` only returns amenities. `property-description` has bedroom count, pool access, floor level, security details. When guests ask "how many bedrooms?", the AI gets amenities and gives wrong answers.
**Fix:** Either merge into one SOP category, or add instruction: "When answering property questions, ALWAYS fetch both `property-info` AND `property-description` categories."

### 12. Add Access Code Security Rules to System Prompt
**Problem:** Access code security currently works by accident (codes aren't in the knowledge base). If codes are added (fix #3), we need explicit security rules.
**Fix:** Add to system prompt:
```
## ACCESS CODE SECURITY
- INQUIRY/PENDING: Never share WiFi, door codes, or building access information
- CONFIRMED: Never share WiFi or door codes until guest checks in
- CHECKED_IN: Share WiFi and door codes from property info
- CHECKED_OUT/CANCELLED: Never share access codes. Say "Access codes are only available during active stays."
```

---

## NICE TO HAVE (Backlog)

### New SOPs to Create

| SOP | Description | Priority |
|-----|-------------|----------|
| `local-recommendations` | Nearby pharmacy, supermarket, restaurant, mosque, ATM, hospital, coffee shop, salon. Always escalate for specific names/directions. | Medium |
| `sop-house-rules` | No smoking indoors, quiet hours (10PM-8AM), no parties, no pets, family-only visitors. Reference this instead of guessing. | Medium |
| `sop-checkout-process` | Checkout time (11AM), return keys to reception, trash in bags, leave apartment as found, damage deposit return timeline. | Low |
| `sop-safety-emergency` | Gas smell → evacuate + no flames + call emergency. Fire → evacuate. Stranger → lock door + call security. Medical → nearest hospital. | Low |
| `sop-document-submission` | Guest sends passport/marriage cert → use mark_document_received tool → confirm receipt → update checklist. | Medium |

### SOP Description Improvements

| Current SOP | Improvement Needed |
|-------------|-------------------|
| `sop-cleaning` | Add "$20 per session" to the description. Add "cleanliness complaint on arrival = waive fee" explicitly. |
| `sop-visitor-policy` | Define "immediate family" — parents, children, siblings, spouse. Clarify in-laws status. |
| `sop-early-checkin` | Add "suggest O1 Mall for luggage storage while waiting" from SOP content to actual AI behavior. |
| `sop-wifi-doorcode` | Split into: credential delivery (CHECKED_IN) vs troubleshooting (all statuses). |
| `pricing-negotiation` | Add "never quote specific prices — always escalate" more prominently. |

### System Prompt Additions

| Addition | Reason |
|----------|--------|
| Response variety instruction | 5 agents had guest call out repetitive "I'll check with the manager" phrasing |
| Noise complaint neutrality | AI should not side with complaining neighbor against the guest |
| Task hygiene rules | Don't update unrelated tasks — create new ones for different issues |
| Working hours awareness | "After 5 PM, all maintenance/cleaning → arrange for tomorrow morning" needs reinforcement |

### Infrastructure Fixes

| Fix | Impact |
|-----|--------|
| Fix `updateTaskId` clearing title/note fields | 3 agents had blank tasks after updates |
| Fix escalation signal false positives for Arabic | "smoke" (smoking policy) triggers `safety_emergency` |
| Clear escalation signals per-turn | Signals accumulate from conversation history, inflating false positives |
| Add `mark_document_received` invocation guidance | Tool exists but AI never knows when to call it |

---

## Summary Scorecard

| Category | Score | Notes |
|----------|-------|-------|
| SOP Classification | 89% | Strong — most categories route correctly |
| Escalation Accuracy | 92% | Good — urgency levels almost always right |
| Screening Compliance | 100% | Perfect — all nationality rules, document requirements correct |
| Access Code Security | 98% | Near-perfect — 1 implied leak to CHECKED_OUT |
| Language Matching | 0% | Catastrophic — needs immediate fix |
| Tool Utilization | 30% | Poor — 3 of 5 tools never called in production |
| Response Quality | 75% | Good when it responds, but JSON leaks and empty messages hurt |
| Rate Limit Resilience | 0% | No retry mechanism exists |

**The AI knows the right answer 89% of the time but can't deliver it in the right language, and silently fails 14% of the time.**

---

*Generated 2026-03-30 from 30 battle test agents, ~926 messages, ~410 AI turns*
