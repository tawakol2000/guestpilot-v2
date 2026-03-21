# AI Response Audit

**Last run**: 2026-03-21T12:15:00Z (53 messages audited, score: 3.83/5)
**Command**: Tell Claude "run response audit"

## What it does

Pulls ALL AI responses since the last run and evaluates how well Omar (guestCoordinator) and the screening agent performed. Focuses on response quality, escalation accuracy, tone, and SOP adherence — NOT classification accuracy (that's `/diagnostics`).

## Data pulled per message

| Field | Source |
|-------|--------|
| Timestamp | AiApiLog.createdAt |
| Agent | AiApiLog.agentName (guestCoordinator vs screeningAI) |
| Guest message | Extracted from userContent |
| Conversation history | Extracted from userContent (summary or recent messages) |
| Reservation details | Extracted from userContent (guest name, status, check-in/out, guest count) |
| Access codes included? | Whether door code / WiFi was in the prompt |
| SOP chunks injected | Full content of each SOP chunk sent to Claude |
| Escalation signals | ragContext.escalationSignals |
| AI response | Full responseText |
| Escalation created? | Parsed from response JSON (title, note, urgency) |
| Task resolved? | resolveTaskId / updateTaskId in response |
| Model | AiApiLog.model |
| Tokens in/out | AiApiLog.inputTokens, outputTokens |
| Cost | AiApiLog.costUsd |

## Evaluation criteria per message

### 1. Response Quality
- Did the AI answer the guest's actual question?
- Is the response concise (1-2 sentences)?
- Is it in the correct language (English)?
- No filler phrases ("I hope that helps!", "Feel free to reach out!")?
- No hallucinated information (facts not in the prompt)?
- Valid JSON format?

### 2. SOP Adherence
- Did the AI follow the injected SOP instructions?
- For conditional SOPs (e.g., early check-in "within 2 days" vs ">2 days"): did it pick the RIGHT branch based on reservation dates?
- Did it use property-specific data from the prompt (not generic hospitality knowledge)?
- Did it respect the "NEVER use general hotel knowledge" instruction?

### 3. Escalation Accuracy
- **Over-escalation**: Did the AI escalate when no escalation was needed? (e.g., simple greeting → escalation)
- **Under-escalation**: Did the AI NOT escalate when it should have? (e.g., complaint, safety issue, refund request)
- **Wrong urgency**: immediate vs scheduled vs info_request — was the urgency level correct?
- **Missing escalation signals**: Were keyword signals (refund_request, complaint, etc.) present but AI didn't escalate?

### 4. Access Code Security
- Were door codes / WiFi in the prompt? (check reservation status)
- If status is INQUIRY/PENDING: codes should NOT be in prompt
- If status is CONFIRMED/CHECKED_IN: codes should be available
- Did the AI share codes when it shouldn't have?

### 5. Screening Agent Quality (screeningAI only)
- Did it ask for nationality when not provided?
- Did it apply the correct screening rules (Arab vs non-Arab vs Lebanese/Emirati)?
- Did it ask for documents AFTER acceptance, not before?
- Did it escalate to manager when booking decision needed?
- Did it mention screening criteria or government regulations? (should NEVER)

### 6. Persona Consistency
- Does the AI respond as "Omar"?
- No mention of AI, manager, internal systems?
- No mention of screening criteria to guests?
- Appropriate tone (warm but professional)?

## Output format

```
=== AI RESPONSE AUDIT: [start] → [end] ===
Messages analyzed: N (guestCoordinator: X, screeningAI: Y)

--- MSG 1/N [3:02 AM] conv:cmmy6il5... agent:Omar (guestCoordinator) ---
Guest: "I have a booking issue"
Status: CONFIRMED | Check-in: 2027-01-03 | Guests: 2
Access codes in prompt: YES (door: 105***#, wifi: BR***)
SOPs injected:
  [sop-booking-confirmation] Guest confirms booking details, asks about...
  [payment-issues] Guest has payment problem, billing question...
Escalation signals: (none)

AI Response: "I'm here to help. What's the booking issue you're experiencing?"
Escalation: none

EVALUATION:
  Response quality: ✅ Concise, asks clarifying question
  SOP adherence: ✅ Followed booking confirmation SOP
  Escalation: ✅ Correct — no escalation needed yet (gathering info)
  Security: ✅ Codes in prompt but not shared (guest didn't ask)
  Persona: ✅ Professional, no AI mention
  SCORE: 5/5

--- MSG 2/N [3:15 AM] conv:cmmy8abc... agent:Omar (screeningAI) ---
Guest: "Hi, I want to book for me and my friends"
Status: INQUIRY | Check-in: 2027-02-10 | Guests: 1
Access codes in prompt: NO (inquiry status)
SOPs injected: (none — screening mode)

AI Response: "Thanks for reaching out. Could you share your nationality and who you'll be traveling with?"
Escalation: none

EVALUATION:
  Response quality: ✅ Concise, asks required screening questions
  Screening rules: ✅ Asked nationality (required before any decision)
  Escalation: ✅ Correct — need more info before escalating
  Security: ✅ No codes shared
  Persona: ✅ Natural, no screening criteria mentioned
  SCORE: 5/5
```

## Summary stats

```
=== SUMMARY ===
Total messages: N
By agent: guestCoordinator: X | screeningAI: Y

Response Quality:
  Correct responses: N/N (XX%)
  Filler phrases detected: N
  Hallucinations detected: N
  Invalid JSON: N

Escalation Accuracy:
  Correct escalations: N/N
  Over-escalations: N (list)
  Under-escalations: N (list)
  Wrong urgency: N (list)

Access Code Security:
  Codes correctly withheld (inquiry): N/N
  Codes correctly shared (confirmed): N/N
  ⚠️ VIOLATIONS: N (list with conv IDs)

Screening Quality (screeningAI only):
  Correct screening decisions: N/N
  Nationality asked when needed: N/N
  Documents requested too early: N

Persona Consistency:
  AI/manager/system mentions: N
  Screening criteria leaked: N

OVERALL SCORE: X/5 average
```

## Flags

- 🔴 SECURITY: Door code shared to non-confirmed guest
- 🔴 HALLUCINATION: AI stated facts not in the prompt
- 🔴 SCREENING LEAK: AI mentioned screening criteria or regulations
- 🟡 OVER-ESCALATION: Unnecessary escalation created
- 🟡 UNDER-ESCALATION: Should have escalated but didn't
- 🟡 WRONG URGENCY: Escalation urgency level incorrect
- 🟡 FILLER: Contains filler phrases
- 🟡 WRONG BRANCH: SOP conditional logic applied incorrectly
- 🟢 PERFECT: Response is ideal
