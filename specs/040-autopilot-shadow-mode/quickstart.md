# Quickstart: Autopilot Shadow Mode

This is the happy-path walkthrough a tenant admin follows to use Shadow Mode for a tuning session.

## Prerequisites

- The tenant has at least one property synced from Hostaway.
- **At least one reservation is in `copilot` mode** — Shadow Mode only affects copilot reservations. Autopilot, manual, and AI-off reservations will not produce previews because Shadow Mode does not touch them.
- The admin has any authenticated user role for the tenant.

## 1. Turn Shadow Mode on

1. Open the web app → **Settings** → **Configure AI**.
2. Find the **Shadow Mode** toggle (new row near the bottom of the page, under the "Tuning" group).
3. Flip the toggle ON. Save is implicit — changes apply within ~60s as the tenant-config cache refreshes.

From this moment, AI replies generated for **copilot** reservations on that tenant are rendered as in-chat preview bubbles instead of the legacy suggestion-card UI. Autopilot reservations are unaffected (they continue to send replies directly to guests). Manual and AI-off reservations are also unaffected.

## 2. Watch a preview appear

1. Trigger a test guest message on a **copilot** reservation (easiest way: send yourself a message through your own test property configured in copilot mode).
2. Open the conversation in the **Inbox**.
3. After the normal debounce window (default 30s), the AI's reply appears as a **preview bubble** clearly marked **"Not sent to guest"**.
4. The bubble is visually distinct from sent messages (reduced opacity + yellow "preview" pill).

If the guest sends more messages before you interact with the preview, a new debounce cycle fires and a new preview is generated. The older preview stays visible in the chat but its Send/Edit buttons disappear and it is marked as superseded. Any in-progress edit on the older preview is discarded with a toast notification.

## 3. Send a preview unchanged

1. On the most recent preview bubble, click **Send**.
2. The preview transitions into a normal sent AI message within ~5s.
3. The guest receives the text verbatim.
4. No tuning analyzer runs (there was nothing to learn from an unedited send).

## 4. Edit a preview, then send

1. On the most recent preview bubble, click **Edit**.
2. Revise the text in the inline editor.
3. Click **Send**. The edited text is delivered to the guest.
4. In the background, the tuning analyzer runs. You can keep working — nothing blocks the Send response.

## 5. Review tuning suggestions

1. Open **Settings** → **Tuning** tab (new tab, peer to Configure AI / SOPs / FAQs / AI Logs).
2. The default view shows all **PENDING** suggestions, grouped by the preview that generated them.
3. Each suggestion card shows:
   - **Action type badge**: `EDIT_SYSTEM_PROMPT` / `EDIT_SOP_CONTENT` / `EDIT_SOP_ROUTING` / `EDIT_FAQ` / `CREATE_SOP` / `CREATE_FAQ`
   - **Root-cause rationale**: 1-2 sentences explaining why the analyzer thinks this change would have produced output closer to your edit.
   - **Target reference**: exactly which artifact is affected (e.g. "Coordinator system prompt", "SOP `sop-checkin` at status CONFIRMED for property 1234", "FAQ entry #abc123").
   - **Before/proposed diff** (for EDIT actions) or **proposed new-artifact fields** (for CREATE actions).
4. For each suggestion:
   - Click **Accept** to apply the change as-is. The suggestion status becomes ACCEPTED and the target artifact is updated immediately.
   - Click **Edit & Accept** to revise the proposed text first, then apply your revised version.
   - Click **Reject** to dismiss. Nothing is modified.
5. Accepted changes take effect on the very next AI generation — no restart needed.

If a single edit produced multiple suggestions (for example, an EDIT_SYSTEM_PROMPT plus a CREATE_FAQ), they appear together under the same source-preview group. You can accept some and reject others independently.

## 6. Turn Shadow Mode off

When you're done tuning:

1. Back to **Settings** → **Configure AI**.
2. Flip the Shadow Mode toggle OFF.
3. Within ~60s, new copilot AI replies revert to the legacy suggestion-card flow. Autopilot reservations are unchanged (they were never affected).

Historical previews remain visible in every conversation's chat history (inert, no action buttons). Accumulated tuning suggestions remain viewable in the Tuning tab, and you can still Accept / Reject them after the toggle is off.

## Verification checklist

- [ ] Shadow Mode toggle visible in Configure AI, defaults to OFF
- [ ] With toggle ON, a guest message on a **copilot** reservation produces a preview bubble (not routed to the legacy suggestion-card UI) within 5s of AI generation time
- [ ] Preview bubble carries the "Not sent to guest" label
- [ ] Older previews lose their Send/Edit buttons when a new preview is generated on the same conversation
- [ ] Per FR-006a/FR-006b: rapid-fire guest messages coalesce into a single preview cycle; if a preview is left unsent and a new guest message arrives, the next preview cycle addresses BOTH the original unanswered message(s) and the new one together
- [ ] An in-progress edit on an older preview is discarded with a toast when a new preview arrives
- [ ] Send (unedited) delivers the original text to the guest and transitions the preview to a normal message within 5s
- [ ] Send (edited) delivers the edited text and queues a tuning-analyzer run
- [ ] A tuning suggestion appears in the Tuning tab within 30s of an edited send (80% of meaningful edits)
- [ ] Accepting an EDIT_SYSTEM_PROMPT suggestion updates the referenced system prompt and the next generation reflects the change
- [ ] Accepting a CREATE_FAQ suggestion creates a new FAQ entry with `source='MANUAL'` and `status='ACTIVE'`, and `get_faq` tool calls find it on the next generation
- [ ] Rejecting a suggestion leaves all artifacts untouched
- [ ] Disabling Shadow Mode restores the **legacy copilot suggestion-card flow** on the next generated copilot reply (autopilot is unchanged in either toggle state)
- [ ] Historical previews and suggestions are still visible after Shadow Mode is disabled
- [ ] Escalations still fire normally under Shadow Mode (they are not diverted into the preview path)
- [ ] **Autopilot-mode** reservations are not affected by the Shadow Mode toggle — they continue to send replies directly to guests
- [ ] The FAQ auto-suggest pipeline does NOT re-analyze edited-and-sent previews (it continues to run only on direct Hostaway manager replies with open info_request tasks)
