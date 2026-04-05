# Quickstart: Coordinator Prompt Rework with Reasoning

## Test Scenarios

### Scenario 1: Simple direct answer — reasoning present, low effort

**Guest**: "What's the WiFi password?"

**Expected**:
- Reasoning effort: low
- Reasoning field: "WiFi credentials in reservation details, no tool needed."
- guest_message: Contains WiFi name and password
- No tool calls
- No escalation
- AI Logs show reasoning field populated
- Hostaway message does NOT contain reasoning

### Scenario 2: SOP-grounded request — reasoning explains tool choice

**Guest**: "Can someone come clean the apartment tomorrow morning?"

**Expected**:
- Reasoning effort: low
- AI calls get_sop with reasoning: "Guest requesting cleaning service, maps to sop-cleaning"
- Reasoning field: "Cleaning request within SOP hours. Need preferred time before confirming."
- guest_message: Asks for preferred time between 10am–5pm
- No escalation

### Scenario 3: Multi-intent with escalation — medium effort, structured note

**Guest**: "The AC isn't cooling at all and it's been like this for hours. Also can I stay one more night?"

**Expected**:
- Reasoning effort: medium (long message, distress signal)
- Reasoning field: identifies both intents, explains AC is urgent
- AI calls get_sop for maintenance + booking modification
- AI calls check_extend_availability
- Escalation with urgency "immediate" for AC
- Escalation note follows format:
  ```
  Guest: [name], [unit]
  Situation: AC has not been cooling for several hours
  Guest wants: Working AC immediately
  Context: [date/time], guest frustrated, [day of stay]
  Suggested action: Dispatch technician, offer fan as interim
  Urgency reason: Comfort failure, guest frustrated, review risk
  ```
- guest_message addresses both issues

### Scenario 4: Angry complaint — medium effort, emotion outranks refund

**Guest**: "THIS IS UNACCEPTABLE!!!! I WANT A REFUND RIGHT NOW!!!!"

**Expected**:
- Reasoning effort: medium (ALL CAPS + distress signals + "!!!!")
- Reasoning field: identifies strong emotion, notes refund request
- Escalation urgency: immediate (emotion outranks unauthorized action per ladder)
- Tone: empathetic, acknowledges frustration, no cheerfulness

### Scenario 5: Acknowledgment — low effort, empty message

**Guest**: "ok thanks 👍"

**Expected**:
- Reasoning effort: low
- Reasoning field: "Pure acknowledgment, no action needed."
- guest_message: "" (empty string)
- No escalation

### Scenario 6: Conversation repair

**Guest (first message)**: "When is check-in?"
**AI responds**: "Check-in is at 3:00 PM."
**Guest (second message)**: "No, I meant checkout, not check-in"

**Expected**:
- Reasoning field: "Guest corrected misunderstanding — asking about checkout, not check-in."
- guest_message: "Got it — checkout is at 11:00 AM." (brief correction, no reference to the mistake)

### Scenario 7: Safety — immediate, no tool calls

**Guest**: "There's smoke coming from the kitchen!"

**Expected**:
- Reasoning effort: medium (distress)
- Reasoning field: "Safety threat — smoke reported. Immediate escalation, no tools."
- Escalation urgency: immediate (safety is #1 on ladder)
- No tool calls before escalation
- guest_message: acknowledges urgency, says manager contacted immediately

### Scenario 8: Settings toggle — reasoning visibility in chat

**Setup**: Enable showAiReasoning in tenant settings

**Expected**:
- AI messages in inbox show reasoning alongside the message (collapsible or subtle)
- Disable toggle → reasoning hidden from chat but still in AI Logs

### Scenario 9: Tool reasoning in AI Logs

**Guest**: "Is there parking?"

**Expected**:
- AI calls get_sop with reasoning: "Guest asking about parking, property info question"
- If SOP doesn't cover parking, AI calls get_faq with reasoning: "SOP didn't cover parking, trying FAQ"
- Both reasoning fields visible in AI Logs tool call details

## Verification Checklist

- [ ] Reasoning field present in all coordinator AI responses (check AI Logs)
- [ ] Reasoning field NOT present in Hostaway-delivered messages
- [ ] Reasoning field present in SSE broadcast payload
- [ ] Settings toggle shows/hides reasoning in inbox chat UI
- [ ] Escalation notes follow structured format
- [ ] Escalation ladder priority order is correct (safety > emotion > unauthorized > SOP > FAQ > uncertain)
- [ ] Conversation repair works (brief acknowledgment, no reference to mistake)
- [ ] Tone matches situation (empathetic for complaints, efficient for operations)
- [ ] Arabic responses work when guest writes in Arabic
- [ ] Tool calls include reasoning in AI Logs
- [ ] Tool CALL/DO NOT CALL boundaries prevent misrouting
- [ ] Reasoning effort "low" for simple messages
- [ ] Reasoning effort "medium" for complex/distress messages
- [ ] Reasoning effort selector failure → defaults to "low"
- [ ] Content blocks unchanged (RESERVATION_DETAILS, etc.)
- [ ] SOP-first pattern preserved
