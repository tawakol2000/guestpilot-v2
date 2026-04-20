# 036 — Perfect Mix: Best of Old + New AI Architecture

## Philosophy

The old system (main) was better because it let the model do ONE job: write a good guest message. The v4 system degraded that by asking the model to also classify actions, track SOP paths, self-report screening state, and navigate 11-path decision trees — all inside the output schema.

But v4 also solved real problems the old system had. The goal is to keep the v4 improvements that work through APPLICATION CODE (not model output) and discard the ones that added cognitive load to the model.

**Guiding principle**: Let the model write. Let the code think.

---

## The Deep Analysis

### Why the old system produced better responses

**1. Schema focus.**
Old coordinator: 4 fields. Old screening: 2 fields. The model's entire generation capacity went to `guest_message`. v4 added reasoning (80 words), action enum (5-7 values), sop_step, and two booleans — 7 fields total. With strict JSON schema, the model plans ALL fields simultaneously. More fields = less attention per field = worse guest_message quality.

**2. One critical rule vs. eight diluted rules.**
Old system used a single `<critical_rule>` XML tag at the top of each prompt. The model treated this as THE behavioral anchor. v4 replaced it with 8 "Non-negotiable rules" — when everything is non-negotiable, nothing is.

**3. Imperative workflow vs. decision tree.**
Old screening: 7 numbered steps — do 1, then 2, then 3. v4: 11 conditional paths (A-K) with "evaluate in order, stop at first match." LLMs are language models, not decision tree executors. They miss conditions, evaluate out of order, or match the wrong path.

**4. Server-side SOP filtering vs. model self-filtering.**
Old system served INQUIRY guests a 26-word cleaning SOP. v4 served them a 189-word multi-path document and expected the model to find the right path by checking `booking_status`. This is a 7x increase in content the model must process — and a SECURITY issue for WiFi/door codes, where the old system made credential leaks impossible by construction.

**5. XML tags vs. Markdown headers.**
Models weight XML tag boundaries (`<critical_rule>`, `<tools>`, `<rules>`) as strong structural signals — content inside gets elevated attention. Markdown headers (`## Rules`) are weaker signals treated more like regular text.

**6. "Always English" vs. multilingual.**
Old: one line. v4: a whole section about language detection, dialect matching (Egyptian vs Gulf), register calibration (formal → informal), keeping reasoning in English while responding in Arabic. This is a per-token cognitive tax on every generation.

### What v4 got right (that we must keep)

**1. Pre-computed context.** The model should NOT do date arithmetic. `is_within_2_days_of_checkin`, `has_back_to_back`, `existing_screening_escalation_exists` are computed by code and injected as facts. This eliminates a whole class of errors.

**2. Post-tool schema enforcement.** Old system enforced JSON schema during tool rounds, which blocked further tool calls. v4 lets the model call tools freely, then enforces schema in a final call. Better architecture — more reliable tool use.

**3. Pre-response sync.** v4 checks Hostaway for new messages and status changes before generating. If the manager already replied, it cancels the AI response. Prevents stale/conflicting responses.

**4. Conversation summary injection.** v4 loads conversation summaries for long threads. Helps the model maintain context beyond the 20-message history window.

**5. get_sop returns Markdown.** Old returned JSON `{ categories, content }`. v4 returns `## SOP: category\n\ncontent`. Markdown is more natural for the model to process.

**6. Auto-enrich for early checkin/late checkout.** When the SOP category matches and the date is within 2 days, v4 automatically calls `checkExtendAvailability` and appends the result to SOP content. Smart — saves a tool round.

**7. Duplicate screening prevention.** When `action=awaiting_manager` and an existing screening task exists, v4 skips `handleEscalation`. Prevents private note spam.

**8. Screening urgency derivation.** Old hardcoded all screening urgency to `info_request`. v4 derives: `eligible-*/violation-*/awaiting-manager-review` → `inquiry_decision`, everything else → `info_request`. Better task categorization.

**9. Dynamic reasoning effort.** `pickReasoningEffort` returns `'medium'` for distress signals, ALL CAPS, multiple open tasks, or long messages. `'low'` for everything else. Smart resource allocation.

**10. Fallback recovery.** v4 handles `reason` → `note` field name confusion, missing titles (→ `missing-title-${urgency}`), and concatenated JSON objects in `stripCodeFences`. Graceful degradation.

**11. get_faq inline tool.** v4 properly defines the FAQ retrieval tool with category enum and reasoning parameter. Old didn't have this.

**12. Validation functions.** Observe-only checks that catch action-field inconsistencies. Don't block responses, just log for analytics.

**13. buildPropertyInfo improvements.** v4 extracts structured property details (capacity, bedrooms, bathrooms, square meters, cleaning fee, check-in/out times) from customKnowledgeBase.

**14. Last 20 messages.** Old used 10. More context helps multi-turn consistency.

### The security issue v4 introduced

Old system: `{ACCESS_CONNECTIVITY}` (WiFi passwords, door codes) was ONLY injected in CONFIRMED and CHECKED_IN SOP variants. INQUIRY guests got: "WiFi is available. Details provided after check-in."

v4: Collapsed all status variants into DEFAULT content. `{ACCESS_CONNECTIVITY}` is now in the wifi-doorcode SOP that ALL statuses receive. The model is expected to follow a `**When**: Status INQUIRY` guard in the SOP text. But this moves a safety-critical gate from deterministic code to probabilistic model behavior.

**This must be reversed.** Status-specific variants are a security requirement, not a preference.

---

## The Perfect Mix

### Schema: Old simplicity + reasoning visibility

**Coordinator (5 fields):**
```
guest_message  →  The actual response (model's primary focus)
escalation     →  null or { title, note, urgency }
resolveTaskId  →  Task resolution
updateTaskId   →  Task update  
reasoning      →  One sentence summary (LAST field — model writes message first)
```

**Screening (3 fields):**
```
guest_message  →  The actual response (renamed from 'guest message')
manager        →  { needed, title, note }
reasoning      →  One sentence summary (LAST field)
```

**Why reasoning LAST:** With structured JSON, field order matters. By putting reasoning last, the model generates guest_message first (full attention), then summarizes what it did. This is the opposite of v4's approach (reasoning first = chain-of-thought). But structured JSON ≠ free text — the model plans holistically, so "first" doesn't help the way it does in free text. What DOES help is having the highest-attention field be the one that matters most.

**Derived by code (not in schema):**
- `action`: `escalation != null` → "escalate". `guest_message == ""` → "none". `manager.needed` → "screen_eligible"/"screen_violation" (from title prefix). Else → "reply" or "ask" (from escalation signals).
- `sop_step`: From the get_sop tool call arguments (which categories were requested).
- `nationality_known / composition_known`: Not tracked. The `<critical_rule>` handles this naturally. The model asks when it doesn't know — no self-report needed.

### Prompts: Old structure + surgical v4 additions

**Coordinator changes from old:**
1. Add `<language>` — ONE line: "Match the guest's language. Default English. Escalation notes always English."
2. Add escalation note format inside `<escalation>` (4 fields: Guest, Situation, Guest wants, Suggested action)
3. Add `<pre_computed_context>` content block
4. Add reasoning instruction — ONE line at end of `<rules>`: "Fill the reasoning field last — one sentence on what you decided."
5. Add 4th reminder line: "Match guest's language. Notes in English."
6. Add 3rd example showing escalation with 4-field note format
7. Everything else stays EXACTLY as old

**Screening changes from old:**
1. Add `<language>` — same one line
2. Make Lebanese/Emirati exception prominent (old had it, v4 made it clearer)
3. Add "search_available_properties → ONLY after screening is complete. Never before nationality is known." to `<tools>`
4. Add workflow step: "0. Check open tasks and pre_computed_context — if screening escalation exists, do not re-screen."
5. Add `<pre_computed_context>` content block
6. Add reasoning instruction — same one line
7. Add 4th reminder line: "search_available_properties ONLY after screening complete."
8. Rename schema field in prompt/examples: `'guest message'` → `guest_message`
9. Everything else stays EXACTLY as old

### SOPs: Old format + old variants + targeted improvements

**Keep from old:**
- ALL status-specific variants (security requirement)
- Short prose format (20-40 words per variant, not 150-200)
- All business rules ($20 cleaning fee, O1 Mall, working hours, dirty-on-arrival exception)
- Template variable isolation (`{ACCESS_CONNECTIVITY}` ONLY in CONFIRMED/CHECKED_IN)

**Add from v4:**
- WiFi troubleshooting DEFAULT content (old was empty — this is a real gap)
- Maintenance safety triage language ("AC/water/electricity → immediate, cosmetic → scheduled")
- The early-checkin/late-checkout auto-enrich is in CODE, not SOP text (keep the code, not the SOP paths)

**Don't touch:**
- SEED_TOOL_DESCRIPTIONS (identical between old and new)
- SOP categories list (identical)

### Pipeline code: v4 infrastructure on old prompts

Cherry-pick from v4:
1. `computeContextVariables()` + `renderPreComputedContext()` — pre-computed context
2. `pickReasoningEffort()` — dynamic reasoning effort  
3. `PRE_COMPUTED_CONTEXT` in variableDataMap + template-variable registration
4. Post-tool schema enforcement (don't enforce during tool rounds)
5. get_sop returns Markdown instead of JSON
6. Auto-enrich for early checkin/late checkout in get_sop handler
7. Pre-response Hostaway sync
8. Conversation summary injection as first content block
9. Duplicate screening prevention (skip handleEscalation when awaiting_manager + existing task)
10. Screening urgency derivation (title prefix → inquiry_decision vs info_request)
11. Manager note/title fallbacks (reason→note, missing-title sentinel)
12. stripCodeFences improvements (concatenated JSON handling)
13. buildPropertyInfo improvements (structured property details)
14. get_faq inline tool definition + handler
15. Validation functions (observe-only, don't block)
16. Screening info gate warning (log contradictions)
17. Last 20 messages history window
18. SSE reasoning broadcast
19. Max output tokens minimum 2560

### Frontend: Reasoning visibility

Cherry-pick from v4:
1. `showAiReasoning` toggle in Configure AI
2. Reasoning display in inbox (collapsible, muted)
3. `PRE_COMPUTED_CONTEXT` in BLOCK_VARIABLES
4. Sandbox: meta forwarding for task tracking + reasoning display

### Database
1. Add `showAiReasoning Boolean @default(false)` to TenantAiConfig

---

## What this achieves vs. each system

| Dimension | Old (main) | v4 | Perfect Mix |
|-----------|-----------|-----|-------------|
| Schema fields (coordinator) | 4 | 7 | 5 |
| Schema fields (screening) | 2 | 7 | 3 |
| SOP content per status call | 20-40 words | 150-200 words | 20-40 words |
| Credential leak protection | Deterministic (code) | Probabilistic (model) | Deterministic (code) |
| Pre-computed context | No | Yes | Yes |
| Reasoning visibility | No | Yes | Yes |
| Multilingual | No | Full section | One line |
| Screening workflow | 7 steps | 11 paths | 7 steps (+1 pre-check) |
| Critical rule pattern | One `<critical_rule>` | 8 "Non-negotiable rules" | One `<critical_rule>` |
| Tool enforcement | XML `<tools>` section | Markdown bullets | XML `<tools>` section |
| Escalation notes | Free-form | 6-field template | 4-field template |
| Date arithmetic | Model does it | Pre-computed | Pre-computed |
| Duplicate screening | Not handled | Code prevents | Code prevents |
| Post-tool schema | Enforced (blocks tools) | Deferred (better) | Deferred (better) |
| get_faq tool | Missing | Inline | Inline |
| Pre-response sync | No | Yes | Yes |
| Summary injection | No | Yes | Yes |
| History window | 10 messages | 20 messages | 20 messages |
| Max output tokens | 2048 min | 3072 min | 2560 min |

---

## Implementation Plan

### Phase 1: Backend core (ai.service.ts)
Starting from main branch code:
1. Update COORDINATOR_SCHEMA — add `reasoning` as 5th (last) field
2. Update SCREENING_SCHEMA — rename `guest message` → `guest_message`, add `reasoning` as 3rd (last) field
3. Update SEED_COORDINATOR_PROMPT — add language line, escalation note format, pre_computed_context block, reasoning instruction, escalation example, 4th reminder
4. Update SEED_SCREENING_PROMPT — add language line, prominent Lebanese/Emirati exception, search restriction, pre-check step, pre_computed_context block, reasoning instruction, 4th reminder, rename field in examples
5. Port `computeContextVariables()`, `renderPreComputedContext()`, `pickReasoningEffort()` from v4
6. Port PRE_COMPUTED_CONTEXT into variableDataMap
7. Port post-tool schema enforcement (don't enforce during tool rounds)
8. Port get_sop Markdown return format + auto-enrich
9. Port get_faq inline tool definition + handler
10. Port pre-response Hostaway sync
11. Port conversation summary injection
12. Port duplicate screening prevention
13. Port screening urgency derivation
14. Port manager note/title fallbacks
15. Port stripCodeFences improvements
16. Port buildPropertyInfo improvements
17. Port validation functions (observe-only)
18. Port screening info gate warning
19. Update response parsing — extract reasoning, derive action in code
20. Broadcast reasoning via SSE
21. Change history window to last 20
22. Set effectiveMaxTokens minimum to 2560

### Phase 2: Template variables
23. Register PRE_COMPUTED_CONTEXT in template-variable.service.ts

### Phase 3: SOP improvements (minimal)
24. Add WiFi troubleshooting DEFAULT content (old was empty)
25. Improve maintenance SOP with safety triage language
26. Keep ALL existing status variants unchanged

### Phase 4: Database
27. Add showAiReasoning to TenantAiConfig schema
28. Run prisma db push

### Phase 5: Frontend
29. Add reasoning toggle to Configure AI
30. Add reasoning display to inbox
31. Add PRE_COMPUTED_CONTEXT to BLOCK_VARIABLES
32. Update sandbox for reasoning + meta forwarding

### Phase 6: Sandbox parity
33. Port task tracking from v4
34. Port PRE_COMPUTED_CONTEXT
35. Update response parsing
36. Port pickReasoningEffort

### Phase 7: Deploy + re-seed
37. Delete existing v4 SOPs from DB (they have multi-path format)
38. Deploy — auto-seeds with old prose format + improvements
39. Restore both prompts to defaults in Configure AI
40. Test in sandbox
41. Monitor AI logs
