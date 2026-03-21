# User Acceptance Test Checklist: System Audit & Cleanup

**Purpose**: Manual testing checklist for you (Abdelrahman) to verify after deployment
**Created**: 2026-03-21
**Feature**: [spec.md](../spec.md)

## Security — Can I access another tenant's data? (Should be NO)

- [ ] CHK001 - Open a conversation in the inbox. Copy the conversation ID from the URL/details panel. Log out. Log in with a different account (if you have one). Try to access that conversation. Should get 404 or empty, not the conversation.
- [ ] CHK002 - Same test with a Task — try to mark someone else's task as completed. Should fail.

## SSE — Does the dashboard stay on my tab?

- [ ] CHK003 - Go to the **Classifier** tab. Leave it open for 2 minutes. Come back. You should still be on the Classifier tab — NOT randomly switched to AI Logs or SOPs.
- [ ] CHK004 - Go to the **Sandbox** tab. Start a conversation. Leave it for 1 minute. Come back. Your chat history should still be visible, tab should not have changed.

## Sandbox — Do the tools work?

- [ ] CHK005 - Open **Sandbox**. Select a property. Set status to **INQUIRY**. Send: "do you have a pool?" — The AI should search for properties with pools and show results. Look for a purple "Tool" badge on the response.
- [ ] CHK006 - Reset chat. Set status to **CONFIRMED**. Send: "can I stay 2 more nights?" — The AI should check availability and give you a price. Look for the tool badge.
- [ ] CHK007 - In CONFIRMED mode, send "what's the WiFi password?" — The AI should answer with the WiFi details (NOT call a tool).

## Analytics — Does the math make sense?

- [ ] CHK008 - Open **Analytics**. Check the "AI Resolution Rate" stat. It should be a percentage between 0% and 100% — NOT 600% or any number over 100%.

## Dashboard Stability — Does everything still work?

- [ ] CHK009 - Click through ALL tabs (Overview, Inbox, Analytics, Tasks, Settings, Configure AI, Classifier, AI Logs, Pipeline, SOPs, Examples, Tools, Sandbox, OPUS). Every tab should load with data. None should be blank or show errors.
- [ ] CHK010 - In the **Inbox**, click a conversation. The message thread should load. The right panel should show Stay, AI Mode, Booking, Guest details.
- [ ] CHK011 - In the **Classifier**, try the Live Test. Type "I need extra towels" and test it. You should see KNN neighbors and LR scores.

## Tools Tab — Is my data there?

- [ ] CHK012 - Open the **Tools** tab. You should see "Property Search" listed as an available tool with "Enabled" badge. The Recent Invocations table should show your previous pool searches.

## Health Check (optional — for nerds)

- [ ] CHK013 - Open a new browser tab. Go to: `https://guestpilot-v2-production.up.railway.app/health` — You should see `{"status":"ok"}` (or similar). If you get a 404, the health check wasn't deployed yet.

## Notes

- 13 items — all manual, no terminal needed
- CHK003-CHK004 are the most important for daily usage (SSE bug was very disruptive)
- CHK005-CHK006 test the new AI tools you built today
- If anything fails, screenshot it and send to Claude
