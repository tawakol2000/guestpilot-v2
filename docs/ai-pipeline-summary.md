# GuestPilot AI Pipeline — Summary of v4 Changes

**Date**: 2026-04-06
**Branches**: 033-coordinator-prompt-rework → 034-sop-v4-rewrite → 035-screening-agent-v4

## What Changed (Plain English)

### 1. The AI now thinks before it speaks
Every response includes a hidden `reasoning` field — the AI writes out its thinking (what's the guest asking, what context do I have, which procedure applies) BEFORE generating the guest message. This is never shown to the guest. You can see it in AI Logs, and there's a toggle in Settings to show it in the inbox chat.

### 2. Every response is categorized with an action type
Instead of inferring what the AI did from the presence/absence of escalation fields, every response now declares its action explicitly: `reply`, `ask`, `offer`, `escalate`, `none` (coordinator) or `reply`, `ask`, `screen_eligible`, `screen_violation`, `escalate_info_request`, `escalate_unclear`, `awaiting_manager` (screening).

### 3. Every response traces back to a specific procedure step
The `sop_step` field tells you exactly which path the AI followed — e.g., `cleaning_checked_in:path_a_awaiting_time` or `screening:path_i_eligible_arab_couple`. This makes debugging trivial: look at the sop_step, check if it's the right path for the situation.

### 4. SOPs are rewritten as structured decision trees
All 22 SOPs moved from prose paragraphs to structured Markdown with named paths, trigger conditions, and action sequences. Each SOP only shows the AI what's relevant to the current booking status. No more "NEVER" blocks — replaced with positive instructions ("Always X" instead of "Never Y").

### 5. The AI gets pre-computed facts instead of computing them
Business hours, days until check-in, back-to-back booking detection, stay length — all computed by code and injected as facts. The AI doesn't have to figure out "is it between 10am and 5pm in Cairo?" from a timestamp. For screening, it also gets `existing_screening_escalation_exists` and `document_checklist_already_created` so it doesn't re-screen or duplicate checklists.

### 6. Screening now works in Arabic
Removed the "Always English" rule. The screening agent mirrors the guest's language — Arabic, English, Arabizi, or code-switched. Egyptian Arabic is the default dialect. The AI self-reports whether it has gathered nationality and party composition info (in any language) via boolean fields, replacing fragile English keyword detection.

### 7. Smarter reasoning effort allocation
Simple messages (greetings, WiFi questions) use minimal reasoning effort. Complex messages (angry complaints, multi-intent, long messages, conversations with multiple open issues) get more reasoning budget. This saves cost on the 90% of messages that are simple.

### 8. Escalation notes follow a consistent structure
Every escalation now follows: Guest (name, unit) → Situation → Guest wants → Context → Suggested action → Urgency reason. Managers get the same format every time.

### 9. Tool calls explain themselves
Every tool call (get_sop, get_faq, search_properties, extend_stay, mark_document, create_checklist) includes a `reasoning` field explaining why the AI chose that tool and those parameters. Visible in AI Logs.

### 10. Validation catches inconsistent AI outputs
Post-parse validation checks that action matches escalation state (e.g., action="escalate" requires escalation object, action="none" requires empty message). Both coordinator and screening have their own validation rules. Mismatches are logged and flagged.

## What to Expect

### Better
- AI thinks before responding → fewer "autopilot" errors (like the property search failure)
- Clear decision paths → AI follows the SOP tree instead of improvising
- Full traceability → every response links to a specific procedure step
- Arabic screening → guests aren't forced into English at first contact
- Consistent escalation notes → managers can act faster
- Tool reasoning visible → you can see WHY the AI called search_available_properties instead of answering from the SOP
- Cost optimization → simple messages cost less

### Potentially Worse (Monitor These)
- Schema change → first few responses may have the AI adjusting to new fields
- Arabic dialect → GPT-5.4 Mini may drift to Gulf Arabic or overly formal MSA (prompt specifies Egyptian Arabic but watch for drift)
- Longer prompts → ~3300 tokens each, within safe range but more than before
- New SOP format → existing tenants with DB-saved SOPs keep old format until they reset to defaults
