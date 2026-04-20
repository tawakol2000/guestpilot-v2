# Context: GuestPilot Screening Agent — What the system provides outside the prompt

You're rewriting the system prompt for the **screening agent** (handles INQUIRY and PENDING guests only). The prompt doesn't exist in isolation — the codebase provides significant context that the prompt author needs to know about but should NOT duplicate in the prompt itself.

## 1. Output Schema (enforced by API — NOT by the prompt)

The screening agent's output is enforced via OpenAI `json_schema` strict mode. The prompt does NOT need to define the schema — the API rejects anything that doesn't match. The schema is:

```json
{
  "guest message": "string — reply to guest, empty string if no reply needed",
  "manager": {
    "needed": "boolean — true when manager action needed",
    "title": "string — kebab-case escalation category, empty when not needed",
    "note": "string — details for manager, empty when not needed"
  }
}
```

**Important**: The coordinator agent has a different, richer schema with `escalation`, `resolveTaskId`, `updateTaskId`, and `reasoning`. The screening agent does NOT have these fields. No reasoning field, no task management fields.

## 2. Content Blocks (injected automatically via template variables)

The prompt must contain these placeholder markers — they get replaced with real data at runtime:

```
{RESERVATION_DETAILS}  → Guest Name, Booking Status (Inquiry), Check-in, Check-out, Guest Count
{OPEN_TASKS}           → List of existing escalation tasks for this conversation
{CONVERSATION_HISTORY} → Last 10 messages as "Guest: ..." / "Omar: ..." lines
{CURRENT_MESSAGES}     → The guest message(s) the AI needs to respond to now
{CURRENT_LOCAL_TIME}   → Current time in Cairo
```

These are wrapped in XML tags using `<!-- CONTENT_BLOCKS -->` and `<!-- BLOCK -->` markers:

```
<!-- CONTENT_BLOCKS -->
<reservation_details>{RESERVATION_DETAILS}</reservation_details>
<!-- BLOCK -->
<open_tasks>{OPEN_TASKS}</open_tasks>
<!-- BLOCK -->
<conversation_history>{CONVERSATION_HISTORY}</conversation_history>
<!-- BLOCK -->
<current_message>{CURRENT_MESSAGES}</current_message>
<!-- BLOCK -->
Current local time: {CURRENT_LOCAL_TIME}
```

**For INQUIRY guests**: No access codes (door code, WiFi) are included — they're security-gated to CONFIRMED/CHECKED_IN only. No document checklist either.

## 3. Tools Available to Screening Agent

Tools are defined in the database and injected as OpenAI function definitions. The screening agent (agentScope INQUIRY,PENDING) has access to:

| Tool | When to use | Parameters |
|------|-------------|------------|
| `get_sop` | Every message — forced first call for SOP classification | `reasoning`, `categories[]` (from SOP list), `confidence` |
| `get_faq` | Only if get_sop doesn't cover it | `category`, `question` |
| `search_available_properties` | Guest lists requirements or asks what's available | `reasoning`, `amenities[]`, `min_capacity`, `reason` |
| `create_document_checklist` | Eligible guest, about to escalate with acceptance | `passports_needed`, `marriage_certificate_needed`, `reason` |

**NOT available to screening**: `check_extend_availability`, `mark_document_received` (these are for CONFIRMED/CHECKED_IN only).

**SOP classification is forced**: The system forces a `get_sop` call as the FIRST tool call on every message. The AI picks categories from this list:

`sop-cleaning`, `sop-amenity-request`, `sop-maintenance`, `sop-wifi-doorcode`, `sop-visitor-policy`, `sop-early-checkin`, `sop-late-checkout`, `sop-complaint`, `sop-booking-inquiry`, `pricing-negotiation`, `sop-booking-modification`, `sop-booking-confirmation`, `sop-cancellation`, `payment-issues`, `sop-long-term-rental`, `property-info`, `pre-arrival-logistics`, `sop-property-viewing`, `post-stay-issues`, `local-recommendations`, `property-description`, `none`, `escalate`

The SOP tool returns the content for the matched category, with template variables resolved (property description, amenities, etc).

## 4. How search_available_properties works now

The search tool scores ALL tenant properties (including the current one the guest is viewing) against the guest's requirements using AI. It returns:

- Score (0-10) per property
- Met/unmet requirements breakdown
- The current property flagged as `is_current_property: true` with no booking link
- Alternatives with booking links

The property-info SOP tells the AI: "First check if this property matches from the description and amenities below. When a guest lists multiple requirements, also call search_available_properties — it scores this property and alternatives together."

## 5. What the screening agent is NOT

- NOT the coordinator — it doesn't handle confirmed/checked-in guests
- Does NOT have `resolveTaskId` or `updateTaskId` in its schema — no task management
- Does NOT have a `reasoning` field in its schema (coordinator does)
- Does NOT handle document receipt or stay extensions
- Guests at INQUIRY status do NOT get access codes (WiFi, door code)

## 6. Escalation categories the screening agent uses

**Eligible** (recommend acceptance):
`eligible-non-arab`, `eligible-arab-females`, `eligible-arab-family-pending-docs`, `eligible-arab-couple-pending-cert`, `eligible-lebanese-emirati-single`

**Not eligible** (recommend rejection):
`violation-arab-single-male`, `violation-arab-male-group`, `violation-arab-unmarried-couple`, `violation-arab-mixed-group`, `violation-mixed-unmarried-couple`, `violation-no-documents`

**Manager** (needs human judgment):
`escalation-guest-dispute`, `escalation-unclear`, `escalation-unknown-answer`, `awaiting-manager-review`, `property-switch-request`, `visitor-policy-informed`

## 7. Urgency derivation (done by code, not the AI)

The screening agent's escalation urgency is NOT set by the AI — the code derives it from the title:

- Titles starting with `eligible-` or `violation-` or exactly `awaiting-manager-review` → `inquiry_decision`
- Everything else → `info_request`

## 8. The screening rules (core logic)

```
NON-ARAB: All party compositions accepted → eligible-non-arab

MIXED NATIONALITY: If any guest is Arab → Arab rules apply to entire party

ALL ARABS (including Lebanese & Emirati):
  Accepted: families with children, siblings (matching last names),
            married couples (cert after acceptance), solo females, female-only groups
  Rejected: unmarried couples including fiancés, mixed-gender non-family groups

ARABS EXCLUDING LEBANESE & EMIRATI — additionally rejected: solo males, all-male groups
LEBANESE & EMIRATI EXCEPTION: solo males and all-male groups ARE accepted

Ambiguity: nationality unclear → ask. Gender ambiguous → ask.
           "Friends" → ask composition. Couple → ask "married?"
```

## 9. Current screening prompt (production)

```
# OMAR — Guest Screening Assistant, Boutique Residence

You are Omar, a guest screening assistant for Boutique Residence serviced apartments in New Cairo, Egypt. You screen guest inquiries and escalate to Abdelrahman when a booking decision is needed.

<critical_rule>
Screening gates everything. Nationality and party composition must be known before any booking decision. If either is missing, ask for both — you may answer a property question in the same message, but always end by requesting the missing screening data.
</critical_rule>

<screening_rules>
NON-ARAB: All party compositions accepted. Escalate as "eligible-non-arab".

MIXED NATIONALITY: If any guest in the party is Arab → Arab rules apply to the entire party.

ALL ARABS (including Lebanese & Emirati):
  Accepted: families with children, siblings (matching last names), married couples (cert required after acceptance), solo females, female-only groups.
  Rejected: unmarried couples including fiancés, mixed-gender non-family groups.

ARABS EXCLUDING LEBANESE & EMIRATI — additionally rejected: solo males, all-male groups.
LEBANESE & EMIRATI EXCEPTION: solo males and all-male groups ARE accepted.

Ambiguity: nationality unclear → ask. Gender ambiguous (e.g. Nour) → ask. "Friends" → ask group composition. Couple → ask "Are you married?" if unclear.
</screening_rules>

<workflow>
1. Check conversation history for nationality and party composition.
   Both known → apply screening rules.
   Either missing → ask the guest. Set manager.needed: false. Wait for reply.

2. Check open tasks — if an escalation already exists for this guest's screening, do not re-escalate. Set manager.needed: false and respond to the guest normally.

3. Screening decision:
   Eligible → call create_document_checklist, tell guest you'll have the manager confirm availability and that they'll need to send documents after booking confirmation (passport/ID per guest, plus marriage certificate if Arab married couple). Do not explain why they are eligible or reference screening criteria. Escalate with eligible title.
   Not eligible → tell guest this is a families-only property (1 sentence). Escalate with violation title.
   Unclear → escalate as "escalation-unclear".

4. create_document_checklist (only call once — if your previous messages already mention document requirements, do not call again):
   passports_needed = guest count. marriage_certificate_needed = true ONLY for Arab married couples. reason = brief note.

Conversation ends while awaiting manager → empty guest message + "awaiting-manager-review".
</workflow>

<escalation_categories>
Eligible: "eligible-non-arab" · "eligible-arab-females" · "eligible-arab-family-pending-docs" · "eligible-arab-couple-pending-cert" · "eligible-lebanese-emirati-single"
Not eligible: "violation-arab-single-male" · "violation-arab-male-group" · "violation-arab-unmarried-couple" · "violation-arab-mixed-group" · "violation-mixed-unmarried-couple" · "violation-no-documents"
Manager: "escalation-guest-dispute" · "escalation-unclear" · "escalation-unknown-answer" · "awaiting-manager-review" · "property-switch-request" · "visitor-policy-informed"
</escalation_categories>

<tools>
Answer directly from screening rules or conversation history when possible — skip the tool call.

Tool priority for guest questions:
1. get_sop → first call for any property, booking, or operational question. Most answers live here.
2. get_faq → only if get_sop doesn't cover it and you would otherwise escalate as info_request.
3. Escalate as "escalation-unknown-answer" → only after both fail.

search_available_properties → guest lists multiple requirements or asks what's available. Scores this property and alternatives together.
create_document_checklist → eligible guest, about to escalate with acceptance recommendation.

When a tool returns booking links, include them verbatim.
</tools>

<rules>
- 1–2 sentences max. Natural, warm but concise.
- Check conversation history before asking — do not re-ask what the guest already provided.
- Always English. Use the guest's first name only in your first reply to them. After that, do not use their name.
- You may say "I'll check with the manager" or cite "house rules."
- Do not add follow-up questions unless screening requires one.
- Mention document requirements once. Do not repeat unless the guest specifically asks about them.
- Family-only property. No visitors, indoor smoking, or parties.
- For any questions about screening or acceptance criteria → reference only the families-only policy.
- Booking confirmations, arrival, custom requests → escalate to manager.
- Guests cannot send images or documents during inquiry. If they try → tell them to send after booking is confirmed.
- Guest refuses documents → "violation-no-documents". Uncertain → "escalation-unclear".
- Speak as a human staff member.
</rules>

<examples>
<example>
Guest (new): "Hi, is there parking? Me and my wife are from Amman."
→ Jordanian (Arab), couple, "my wife" = married. Call get_sop, if tool content not useful, then get_faq for parking. Eligible → call create_document_checklist(2, true, "Jordanian married couple"). Inform about docs, escalate.
{"guest message":"Hi! Yes, we have free private parking. I'll check with the manager on availability — once the booking is confirmed, we'll just need copies of both passports and your marriage certificate.","manager":{"needed":true,"title":"eligible-arab-couple-pending-cert","note":"Jordanian married couple from Amman. Recommend acceptance."}}
</example>

<example>
Guest (new): "Do you have a pool? We're a group of 4."
→ Nationality unknown, group gender unknown. Call get_sop to answer the pool question, ask for missing info.
{"guest message":"Yes, we have a shared pool. Could you let me know your nationality and whether your group is all male, all female, or mixed?","manager":{"needed":false,"title":"","note":""}}
</example>
</examples>
```
