Run AI response audit — evaluate how well Omar responds to guests, escalation accuracy, SOP adherence, and security compliance.

## Instructions

1. Read `AI_RESPONSE_AUDIT.md` from the repo root to get the "Last run" timestamp.

2. Connect to the production database:
   ```
   cd backend && node -e "require('dotenv').config(); ..."
   ```
   The `.env` file must have `DATABASE_URL` set.

3. Query `AiApiLog` for all entries since the last run timestamp (or last 24 hours if first run):
   - Order by createdAt ASC
   - Include ALL fields: createdAt, agentName, conversationId, model, costUsd, durationMs, inputTokens, outputTokens, responseText, userContent, systemPrompt (first 100 chars only for agent detection), ragContext
   - We NEED the full userContent to see what SOPs were injected and what reservation details Claude saw

4. For each log entry, extract and evaluate:

   **Extract from userContent:**
   - Guest message (text after "### CURRENT GUEST MESSAGE(S) ###")
   - Reservation details (from "### RESERVATION DETAILS" section: guest name, booking status, check-in, check-out, guest count)
   - Whether access codes (door code, WiFi) are present in the prompt
   - SOP chunks injected (from "### RELEVANT PROCEDURES & KNOWLEDGE" section — include FULL content)
   - Escalation signals (from "### SYSTEM SIGNALS" section if present)
   - Open tasks (from "### OPEN TASKS" section if present)

   **Extract from responseText:**
   - Parse the JSON response
   - Get guest_message (or "guest message" for screening)
   - Get escalation object (title, note, urgency) or manager object (needed, title, note)
   - Get resolveTaskId / updateTaskId if present

   **Evaluate:**
   - Response quality: concise? answers the question? no filler? valid JSON?
   - SOP adherence: followed the injected SOP? picked right conditional branch?
   - Escalation accuracy: over-escalation? under-escalation? wrong urgency?
   - Security: codes shared to wrong status guest?
   - Screening rules (if screeningAI): nationality asked? correct decision? no criteria leaked?
   - Persona: no AI/manager/system mentions?

5. Display per-message breakdown using the format in AI_RESPONSE_AUDIT.md.
   - Include FULL SOP content that was injected (this is the point — see what Claude received)
   - Score each message 1-5
   - Flag anomalies with emoji markers

6. After all messages, show summary stats:
   - Total by agent type
   - Response quality rate
   - Escalation accuracy (over/under/wrong urgency counts)
   - Security violations (CRITICAL — list every one)
   - Screening quality (if any screeningAI messages)
   - Persona consistency
   - Overall average score
   - Top issues to fix (ranked by frequency)

7. Update `AI_RESPONSE_AUDIT.md` "Last run" timestamp to now.

8. If CRITICAL issues found (security violations, screening leaks), highlight them prominently at the top before the per-message breakdown.
