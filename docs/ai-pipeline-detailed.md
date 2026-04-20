# GuestPilot AI Pipeline — Detailed Technical Reference

**Date**: 2026-04-06
**For**: Claude Code sessions working on the AI pipeline
**Branches**: 033-coordinator-prompt-rework → 034-sop-v4-rewrite → 035-screening-agent-v4

---

## Architecture Overview

```
Guest Message → Hostaway Webhook → Save + SSE broadcast
  → scheduleAiReply() → PendingAiReply (30s debounce)
  → Poll job → generateAndSendAiReply()
      1. Load tenant config (60s cache)
      2. Sync messages from Hostaway
      3. Determine agent: isInquiry → screening, else → coordinator
      4. Load system prompt (DB-stored or SEED default)
      5. Compute pre-computed context variables
      6. Resolve template variables → content blocks
      7. Assemble tools (filtered by agentScope)
      8. Select reasoning effort (low/medium)
      9. Call OpenAI Responses API
      10. Tool use loop (max 5 rounds)
      11. Parse response (coordinator or screening path)
      12. Post-parse validation
      13. Extract reasoning, action, sop_step → ragContext
      14. Handle escalation / task management
      15. Save message (guest_message only, no reasoning)
      16. SSE broadcast (includes reasoning)
      17. Send to Hostaway (guest_message only)
      18. Fire-and-forget: summary generation
```

---

## Schemas

### Coordinator Schema
**File**: `backend/src/services/ai.service.ts`, COORDINATOR_SCHEMA
**Fields** (in order):
1. `reasoning` (string, required) — chain-of-thought, under 80 words
2. `action` (enum: reply, ask, offer, escalate, none)
3. `sop_step` (string|null) — format: `{sop_name}:{path_id}`
4. `guest_message` (string) — empty for action=none
5. `escalation` (object|null) — required when action=escalate
   - `title` (string) — kebab-case, max 6 words
   - `note` (string) — structured format
   - `urgency` (enum: immediate, scheduled, info_request)
6. `resolveTaskId` (string|null)
7. `updateTaskId` (string|null)

### Screening Schema
**File**: `backend/src/services/ai.service.ts`, SCREENING_SCHEMA
**Fields** (in order):
1. `reasoning` (string, required)
2. `nationality_known` (boolean) — self-reported, language-agnostic
3. `composition_known` (boolean) — self-reported, language-agnostic
4. `action` (enum: reply, ask, screen_eligible, screen_violation, escalate_info_request, escalate_unclear, awaiting_manager)
5. `sop_step` (string|null)
6. `guest_message` (string) — empty only for awaiting_manager
7. `manager` (object, always present)
   - `needed` (boolean) — false for reply/ask, true for all others
   - `title` (string) — from fixed vocabulary of 17 titles
   - `note` (string) — in English, includes nationality/composition/recommendation

### Screening Urgency Derivation (code, not model)
```
title starts with "eligible-" → inquiry_decision
title starts with "violation-" → inquiry_decision
title === "awaiting-manager-review" → inquiry_decision
everything else → info_request
```

---

## System Prompts

### Coordinator (SEED_COORDINATOR_PROMPT)
**~3100 tokens**. Structure:
1. Identity + objective
2. Operating rules (bookended — appear at top AND bottom)
3. Grounding rules
4. Output contract (reasoning, action, sop_step, guest_message, escalation)
5. How to read SOPs (path structure, action enum meanings)
6. Tool routing table (SOP-first pattern)
7. Escalation decision ladder (9 levels, first-match)
8. Structured escalation note format
9. Task management rules
10. Tone/language (Egyptian Arabic default, formality matching)
11. Conversation repair section
12. Document handling
13. Hard constraints (positive directives)
14. 4 worked examples (WiFi, cleaning, AC+extension, acknowledgment)
15. Content blocks ({RESERVATION_DETAILS}, {PRE_COMPUTED_CONTEXT}, {OPEN_TASKS}, {CONVERSATION_HISTORY}, {CURRENT_MESSAGES}, {CURRENT_LOCAL_TIME})
16. Operating rules restated + reminder

### Screening (SEED_SCREENING_PROMPT)
**~3300 tokens**. Structure:
1. Identity + objective
2. Operating rules (bookended)
3. Output contract (reasoning, nationality_known, composition_known, action, sop_step, guest_message, manager)
4. Escalation title vocabulary (17 fixed titles)
5. Screening procedure — 18 named paths (A through R):
   - A: Existing screening on file
   - B: Document refusal
   - C: Nationality unknown
   - D: Composition unknown
   - E: Couple, marital status unclear
   - F: Ambiguous gender
   - G: Non-Arab party (eligible)
   - H: Arab family/siblings (eligible)
   - I: Arab married couple (eligible)
   - J: Arab female(s) (eligible)
   - K: Lebanese/Emirati exception (eligible)
   - L: Arab solo male (violation)
   - M: Arab all-male group (violation)
   - N: Arab unmarried couple (violation)
   - O: Arab mixed-gender non-family (violation)
   - P: Mixed-nationality unmarried couple (violation)
   - Q: Unclear (escalate)
   - R: Guest disputes policy
   - S: Unknown answer
6. Tool usage (SOP-first, get_faq second, search_available_properties, create_document_checklist)
7. Tone/language (Egyptian Arabic default)
8. Conversation repair
9. 4 worked examples (eligible couple, missing info, Path K Lebanese, awaiting manager)
10. Content blocks (same as coordinator + PRE_COMPUTED_CONTEXT)
11. Operating rules restated + reminder

---

## Tools

| Tool | Parameters | reasoning? | agentScope | Handler |
|------|-----------|-----------|-----------|---------|
| get_sop | reasoning, categories[], confidence | Yes | All statuses | Fetches SOP content, auto-enriches for early check-in/late checkout |
| get_faq | reasoning, category | Yes | All (inline, not scope-filtered) | Fetches FAQ entries, merges property+global |
| search_available_properties | reasoning, amenities[], min_capacity, reason | Yes | INQUIRY, PENDING | Nano scoring against all tenant properties |
| check_extend_availability | reasoning, new_checkout, new_checkin, reason | Yes | CONFIRMED, CHECKED_IN | Hostaway calendar check + pricing |
| create_document_checklist | reasoning, passports_needed, marriage_certificate_needed, reason | Yes | INQUIRY, PENDING | Creates document checklist for eligible guest |
| mark_document_received | reasoning, document_type, notes | Yes | CONFIRMED, CHECKED_IN | Marks passport/cert received |

**Tool assembly**: Loaded from DB (getToolDefinitions, 5min cache) → filtered by enabled + agentScope → exclude get_sop/get_faq (inline) → conditionally include mark_document_received (only if checklist pending) → add dynamic get_sop + inline get_faq.

**Tool use loop**: Max 5 rounds. Each round: execute tool calls → feed results back to model → model decides next action.

---

## SOP Library (v4)

**Format**: Structured Markdown with XML tags (`<sop>`, `<description>`, `<inputs>`, `<paths>`, `<rules>`)

**22 categories**, 8 with status-specific variants:
- sop-cleaning, sop-amenity-request, sop-wifi-doorcode, sop-visitor-policy (INQUIRY/CONFIRMED/CHECKED_IN)
- sop-early-checkin, sop-late-checkout (INQUIRY/CONFIRMED/CHECKED_IN)
- sop-booking-modification, pre-arrival-logistics (INQUIRY/CONFIRMED/CHECKED_IN)

**Cascade**: Property override (exact status) → Property override (DEFAULT) → Variant (exact status) → Variant (DEFAULT) → empty

**Template variables in SOPs**: {PROPERTY_DESCRIPTION}, {AVAILABLE_AMENITIES}, {ON_REQUEST_AMENITIES}, {ACCESS_CONNECTIVITY} — resolved at fetch time via variableDataMap.

---

## Pre-Computed Context Variables

Computed in `computeContextVariables()` before every AI call. Injected as `{PRE_COMPUTED_CONTEXT}` content block.

| Variable | Type | Description |
|----------|------|-------------|
| is_business_hours | boolean | 10am-5pm Cairo time |
| day_of_week | string | Monday, Tuesday, etc. |
| days_until_checkin | number | Days from today (999 if no dates) |
| is_within_2_days_of_checkin | boolean | Check-in ≤ 2 days away |
| days_until_checkout | number | Days from today |
| is_within_2_days_of_checkout | boolean | Checkout ≤ 2 days away |
| stay_length_nights | number | Total nights |
| is_long_term_stay | boolean | > 21 nights |
| has_back_to_back_checkin | boolean | Checkout on arrival day |
| has_back_to_back_checkout | boolean | Check-in on departure day |
| booking_status | string | INQUIRY, PENDING, CONFIRMED, CHECKED_IN |

**Screening-only** (added when isInquiry):
| existing_screening_escalation_exists | boolean | Open task with eligible-*/violation-*/awaiting-manager-review |
| existing_screening_title | string|null | The existing screening task title |
| document_checklist_already_created | boolean | Whether create_document_checklist was already called |

---

## Template Variables

**Registered in** `template-variable.service.ts` TEMPLATE_VARIABLES array.

| Variable | Essential | agentScope | propertyBound |
|----------|-----------|-----------|--------------|
| CONVERSATION_HISTORY | true | both | no |
| RESERVATION_DETAILS | true | both | no |
| PRE_COMPUTED_CONTEXT | true | both | no |
| ACCESS_CONNECTIVITY | false | both | yes |
| PROPERTY_DESCRIPTION | false | both | yes |
| AVAILABLE_AMENITIES | false | both | yes |
| ON_REQUEST_AMENITIES | false | both | yes |
| OPEN_TASKS | false | both | no |
| CURRENT_MESSAGES | true | both | no |
| CURRENT_LOCAL_TIME | false | both | no |
| DOCUMENT_CHECKLIST | false | coordinator | yes |

**Resolution**: `resolveVariables()` splits the prompt at `<!-- CONTENT_BLOCKS -->`, replaces {VARIABLE} in each block, builds content blocks array. Essential variables auto-appended if missing.

---

## Validation

### Coordinator (validateCoordinatorResponse)
- action=escalate → requires non-null escalation
- action≠escalate → requires null escalation
- action=none → requires empty guest_message
- action=reply/ask/offer → requires non-empty guest_message

### Screening (validateScreeningResponse)
- action=reply/ask → requires manager.needed=false
- action≠reply/ask → requires manager.needed=true
- action=awaiting_manager → requires empty guest_message
- action≠awaiting_manager → requires non-empty guest_message
- action=screen_eligible → requires title starting with "eligible-"
- action=screen_violation → requires title starting with "violation-"

### Screening Info Gate
- If action=screen_eligible/screen_violation AND nationality_known=false or composition_known=false → log warning (self-contradiction)

---

## Reasoning Effort Selector

**Function**: `pickReasoningEffort(message, openTaskCount)` → "low" | "medium"

**Triggers for "medium"**:
- Distress keywords: angry, furious, terrible, refund, complain, review, lawyer, غاضب, مش معقول, بشتكي, etc.
- ALL CAPS message > 20 characters
- 2+ open tasks
- Message length > 300 characters
- Default: "low"

**Wired into**: main pipeline + sandbox. Used when tenant config has reasoningCoordinator="auto".

---

## Data Flow: What goes where

| Data | Stored in DB | In SSE Broadcast | Sent to Hostaway | In AI Logs |
|------|-------------|-----------------|-----------------|-----------|
| guest_message | Message.content | Yes | Yes | AiApiLog.responseText |
| reasoning | No | Yes | No | AiApiLog.responseText + ragContext |
| action | No | No | No | ragContext.action |
| sop_step | No | No | No | ragContext.sopStep |
| nationality_known | No | No | No | ragContext.nationalityKnown |
| composition_known | No | No | No | ragContext.compositionKnown |
| reasoningEffort | No | No | No | ragContext.reasoningEffort |
| validationErrors | No | No | No | ragContext.validationErrors |

---

## Settings

| Setting | Field | Default | Effect |
|---------|-------|---------|--------|
| Show AI Reasoning | showAiReasoning (TenantAiConfig) | false | When on, reasoning displayed in inbox chat as collapsible muted element |
| Reasoning Level (Coordinator) | reasoningCoordinator | "auto" | auto=dynamic selector, or fixed none/low/medium/high |
| Reasoning Level (Screening) | reasoningScreening | "none" | Fixed level for screening agent |

---

## File Reference

| File | What it does |
|------|-------------|
| `ai.service.ts` | Core pipeline: schemas, prompts, createMessage, tool handlers, parsing, validation, reasoning effort |
| `sop.service.ts` | SOP content library, seeding, cascade resolution, tool definition building |
| `tool-definition.service.ts` | System tool definitions (search, extend, mark_document, create_checklist) |
| `template-variable.service.ts` | Template variable registry, resolveVariables |
| `property-search.service.ts` | Nano semantic scoring for property search |
| `extend-stay.service.ts` | Hostaway calendar/pricing for stay modifications |
| `faq.service.ts` | FAQ retrieval, property+global merging |
| `document-checklist.service.ts` | Document checklist CRUD |
| `tenant-config.service.ts` | Per-tenant AI config (cached 60s) |
| `escalation-enrichment.service.ts` | Keyword-based escalation signal detection |
| `summary.service.ts` | Conversation summarization (gpt-5-nano, fire-and-forget) |
| `image-caption.service.ts` | Image captioning for conversation history (gpt-5-nano) |
| `sandbox.ts` | Sandbox endpoint mirroring production behavior |
| `inbox-v5.tsx` | Frontend: reasoning display, settings toggle state |
| `configure-ai-v5.tsx` | Frontend: showAiReasoning toggle |
