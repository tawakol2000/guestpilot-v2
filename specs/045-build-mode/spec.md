# Sprint 045 — Build Mode (Ship 1 + Ship 2 bundled)

> Unified build+tune agent. BUILD mode is a **surface** problem, not an agent
> problem. One persona, two tool surfaces gated by UI context, a second
> cache-control breakpoint at the mode-addendum boundary, and an
> adversarial-test-by-default preview loop.
>
> This sprint is Ship 1 + Ship 2 from the research brief
> (`specs/045-build-mode/research-prompt.md` context) bundled together. Ship 1
> alone is invisible to users; we're shipping both so the first release has a
> visible `/build` page with the preview loop. Ship 3 (session resumption +
> DECISIONS.md handoff) comes in sprint 046.

---

## Mental model

Today we have a **tune-only** agent on `/tuning/*` that fires when a manager
corrects an AI reply. After this sprint, the same agent runs in two modes:

- **BUILD** — entered from `/build`. No triggering correction. The agent
  interviews the manager, fills a canonical hospitality template, creates
  SOPs / FAQs / tools / system prompt artifacts. First-time tenants or
  configured tenants both land here; the agent detects state at mount.
- **TUNE** — unchanged behaviour, same `/tuning/*` surface. Fires on
  correction, classifies into the 8-category taxonomy, proposes edits.

Both modes share the persona, principles, taxonomy, tool descriptions,
platform context, and shared critical rules. The things that differ are
compressed into small mode addenda. All tools stay loaded; `allowed_tools`
per-request gates what's callable.

---

## What we are NOT doing in this sprint

- **Session resumption** (`ONBOARDING_STATE.md`, `SessionStart` hook). Ship 3
  / sprint 046. BUILD in this sprint is a single-session flow; a refresh
  mid-interview restarts from the beginning (acceptable for v1 because the
  canonical template graduation is <60 min).
- **`DECISIONS.md` handoff** into TUNE dynamic suffix. Ship 3 / sprint 046.
  We do write DECISIONS.md at BUILD graduation in this sprint (it's cheap),
  but TUNE mode does not yet read it.
- **Extraction into an independent service.** See the architectural note
  below. Monorepo only.
- **Removing anything from the current tune-only flow.** All existing
  sprint-01-through-10 behaviour must continue to work identically.
- **Shipping BUILD mode to real tenants.** Behind
  `ENABLE_BUILD_MODE` env flag, default off in prod. Staging only until the
  preview loop's red-team pass rate is ≥0.85 on the internal golden set.

---

## Architectural notes (non-negotiable)

### 1. Cache architecture — three breakpoints

All within a single prompt. This preserves the current 0.999 hit rate on
TUNE sessions and gives BUILD its own cached prefix.

```
[tools array]                         ← breakpoint 1 (all 14 tools; shared)
[shared system]                       ← breakpoint 2 (~2,000 tokens; shared)
  <principles>      (mode-agnostic)
  <persona>         (mode-agnostic identity)
  <taxonomy>        (8 categories + NO_FIX)
  <tools>           (descriptions)
  <platform_context>
  <critical_rules>  (universal only)
[mode_addendum]                       ← breakpoint 3 (~400–800 tokens; per mode)
  TUNE variant OR BUILD variant — exactly one
[dynamic suffix]                      ← uncached
  <tenant_state>    (BUILD only; what's already configured)
  <memory_snapshot>
  <pending>         (TUNE: suggestions) | <interview_progress> (BUILD)
  <session_state>
  <terminal_recap>  (3 rules, mode-selected)
```

**Max 4 breakpoints is the Anthropic limit.** We're using 3. The 4th is
reserved for future segmentation (e.g., per-tenant hospitality template
overrides).

**TTL:** 5m ephemeral (current default). Do not switch to 1h in this sprint.

### 2. Tool surface — all 14 loaded, `allowed_tools` gates visibility

**Do NOT do conditional tool loading per mode.** Modifying the `tools` array
invalidates the entire cache — tools cache ✘, system cache ✘, messages cache
✘. Always load all 14 tools. Use the Claude Agent SDK's `allowed_tools`
per-request to constrain which are callable based on UI-set mode. Cache
survives.

**The tool inventory:**

Existing TUNE tools currently registered in
`backend/src/tuning-agent/tools/index.ts` (verified — 8 at time of
writing):
`get_context`, `search_corrections`, `fetch_evidence_bundle`,
`propose_suggestion`, `suggestion_action`, `memory`, `get_version_history`,
`rollback`. The `names.ts` file is a constants module (server + tool
names), not an agent-callable tool. If sprint 10's `search_replace` tool
has landed by the time this sprint starts, count it — verify in
`tools/index.ts` before planning.

Four new BUILD tools (this sprint):
`create_sop`, `create_faq`, `write_system_prompt`, `create_tool_definition`.

One new orchestration tool (this sprint, callable in both modes):
`plan_build_changes`.

One new eval tool (this sprint, callable in both modes):
`test_pipeline`. (Previously scoped as `preview_ai_response` with a
batch subsystem — re-scoped 2026-04-19; the batch subsystem is deferred
to sprint 047+, see MASTER_PLAN.md.)

That's 14 total in the cached `tools` array (or 15 if search_replace
has landed). Verify count before setting `allowed_tools` allow-lists.

**Per-request `allowed_tools` mapping:**

| Mode  | Allowed                                                       |
|-------|---------------------------------------------------------------|
| BUILD | get_context, memory, search_corrections, **create_sop, create_faq, write_system_prompt, create_tool_definition, plan_build_changes, test_pipeline**, get_version_history |
| TUNE  | all existing TUNE tools (8 or 9 per verified inventory), plus `plan_build_changes` and `test_pipeline` |

Cross-mode escalation (e.g. a TUNE session realises a whole SOP is missing
and wants to call `create_sop`) is denied by `allowed_tools` in that request.
The agent should then ask the user to switch to BUILD mode. Do NOT add a
PreToolUse cross-mode sanction gate in this sprint — that's a Ship 3 nicety.
Simple `allowed_tools` denial is enough for v1.

### 3. Persona — mode-agnostic, collapsed

Current persona references "correcting their AI" and "trainer". Rewrite so
identity describes what the user is doing *across all modes*, not what the
agent is doing this turn. Mode posture goes in the mode addendum.

Target text:

> You assist a property manager operating a short-term-rental AI reply
> system. You help them build, refine, and correct it with care and
> honesty. Direct, candid, willing to push back. Never open with flattery.
> When you disagree, say so with evidence.

Mode addenda then say things like "In BUILD mode, your current task is to
interview the manager and draft configuration artifacts." Posture, not
identity.

### 4. Principles — surgical moves

Move OUT of shared `<principles>` into **TUNE addendum**:

- **"NO_FIX is the default"** (current principle #3). In TUNE it's correct —
  it prevents fabrication. In BUILD it reads as "don't act," which is wrong.
- **"Edit format depends on artifact size"** (current principle #11). This
  is a TUNE-specific *rule*, not a principle. Move the whole block.

Move OUT of shared `<principles>` into **BUILD addendum**:

- Nothing. BUILD addendum gets new principles specific to interview posture.
  See §6.

Keep in shared `<principles>`:

- Evidence before inference (1)
- Truthfulness over validation (2, rename from "anti-sycophancy" — the root
  principle is truthfulness; anti-sycophancy is its instantiation)
- Refuse directly without lecturing (4)
- Human-in-the-loop for writes, forever (5)
- No oscillation (6)
- Memory is a hint, not ground truth (7)
- Memory is durable (8)
- Cooldown is real (9)
- Scope discipline (10)

Net: shared principles drop from 11 to 9. TUNE addendum gains 2 specific
rules. BUILD addendum gains the new principles in §6.

### 5. Critical rules — split

Move OUT of shared `<critical_rules>` into **TUNE addendum**:

- "proposedText/newText must never be a fragment..." — TUNE-only; BUILD
  has its own fragment-risk which is different.

Keep in shared `<critical_rules>`:

- "Never apply or rollback without explicit manager sanction in their last
  message."
- (Reworded) "When uncertain about category or approach, ask before acting."

Add to **BUILD addendum** critical rules:

- "Never write a system prompt longer than 1,500 tokens in one turn without
  user confirmation."
- "Every defaulted slot in the canonical template must be flagged with the
  `<!-- DEFAULT: change me -->` marker. Do not silently fill."
- "Before any `create_*` tool call that writes more than one artifact, call
  `plan_build_changes` first."

### 6. BUILD mode addendum — new content

Add as a new XML-tagged section, cached at breakpoint 3 when in BUILD mode:

```
<build_mode>
You are in BUILD mode. Your job is to interview the manager, elicit the
tacit policies they use day-to-day, and draft configuration artifacts that
encode those policies.

Interview posture:
1. Elicit through specific past incidents, not abstract policies. "Tell me
   about the last guest who asked for X — what did you say?" beats "What's
   your X policy?"
2. After each incident, probe for cues, not rules. "What made you decide
   yes/no? Was it the guest's history? The property? The day of week?"
3. After 2+ incidents converge on a pattern, summarise back as structured
   policy and ask for confirmation before writing an artifact.
4. Avoid these interviewer errors: (a) leading questions that assume a
   policy, (b) yes/no questions that collapse nuance, (c) asking two things
   in one turn, (d) restating the manager's answer as a formal policy
   without confirming.

When the manager can't articulate a policy:
1. Offer 2-3 concrete options ("most properties handle this one of three
   ways...") — recognition over recall.
2. If they still can't commit, propose a sensible default, explicitly label
   it "Default — please review", and mark the slot with
   `<!-- DEFAULT: change me -->` in the artifact you generate.
3. Show a hypothetical guest message + draft reply under the proposed
   policy. Ask "would you send this?" Managers who can't articulate can
   almost always evaluate.

Graduation:
- Load-bearing slots (must be covered): property_identity, checkin_time,
  checkout_time, escalation_contact, payment_policy, brand_voice.
- Non-load-bearing slots (defaults OK): cleaning_policy, amenities_list,
  local_recommendations, emergency_contact.
- Advance to graduation when coverage ≥ 0.7 AND all 6 load-bearing slots
  have non-default answers OR the manager explicitly clicks "build now."
- "Build now" is always available. If taken early, fill remaining slots
  with canonical defaults, flag each with `<!-- DEFAULT: change me -->`.

Anti-sycophancy in BUILD (different from TUNE):
- When the manager proposes a policy that conflicts with common sense or
  their other stated policies, name the conflict explicitly. Don't quietly
  integrate.
- When the manager is vague, ask one specific question. Do not guess and
  proceed.
- Never open with "Great question!" or "Excellent point!" Brief acknowledgement,
  move to substance.
- When proposing a default, label it "Default — please review," not as a
  considered recommendation.
- If a preview test fails, lead with the failure, not the mitigation.

Orchestration:
- When a single manager turn implies multiple artifacts ("we don't do
  weekend late checkouts AND the cleaning fee is non-refundable"), call
  `plan_build_changes` with the full list before any `create_*` call.
- Every `create_*` call within an approved plan shares the plan's
  transaction_id. On error, the next user turn should summarise partial
  progress and offer retry or skip.
- After a meaningful set of `create_*` calls (or on user request), run
  `test_pipeline` with a representative guest message so the manager
  can see how the pipeline responds. One message, one graded reply.
  Batch testing against a golden set or adversarial messages is
  deferred (see MASTER_PLAN.md).
</build_mode>
```

### 7. TUNE mode addendum — moved content

Add as a new XML-tagged section, cached at breakpoint 3 when in TUNE mode:

```
<tune_mode>
You are in TUNE mode. A manager has edited, rejected, or complained about
an AI-generated reply. Your job is to classify the correction into one of
the 8 taxonomy categories and propose a durable artifact fix.

NO_FIX is the default. Every non-NO_FIX classification must clear a
sufficiency check: the evidence must entail a concrete, testable edit to a
specific artifact. If the correction is cosmetic, a style preference, or
ambiguous, return NO_FIX and explain what evidence would change the
classification.

Edit format depends on artifact size:
- For artifacts OVER ~2,000 tokens: use search/replace. Set
  editFormat='search_replace' on propose_suggestion and provide the exact
  passage to find (oldText, 3+ lines of context for uniqueness) and the
  replacement (newText). The apply path does a literal string replacement
  against the current artifact text — read it first via
  fetch_evidence_bundle, copy the target passage verbatim including all
  whitespace, tags, and punctuation. If oldText is not unique, widen the
  context until it is.
- For artifacts UNDER ~2,000 tokens: use full replacement. Set
  editFormat='full_replacement' (or omit; default) and provide the COMPLETE
  revised text as proposedText. Every untouched section, header, XML tag,
  variable placeholder, and rule must be preserved verbatim — the apply
  path overwrites the artifact field wholesale with exactly what you
  provide.
- NEVER use placeholders like "// ... existing code ...", "# rest unchanged",
  or "[remaining content]". This is a critical failure that destroys the
  rest of the artifact at apply time.

This applies to SYSTEM_PROMPT, SOP_CONTENT, PROPERTY_OVERRIDE, FAQ answers,
SOP_ROUTING toolDescription, and TOOL_CONFIG description.

Hold firm on NO_FIX. When you classify something as NO_FIX and the manager
pushes back without new evidence, hold your position. Do not flip to a
different category to be agreeable.

When a TUNE correction reveals an entire artifact is missing (not just
edits needed), advise the manager to switch to BUILD mode. Your
`create_*` tools are NOT available in this mode — `allowed_tools` will
deny the call and you should surface the need to switch rather than
fabricate a workaround.
</tune_mode>
```

### 8. Terminal recap — in dynamic suffix, mode-selected

At the very end of the dynamic suffix, before `</session_state>` closes (or
immediately after), add 3 rules. This exploits U-shaped attention.

```
<terminal_recap>
1. Before any tool call that mutates state, briefly state what you're
   about to do and why.
2. [TUNE variant] NO_FIX is correct when evidence is absent. Do not
   fabricate a correction rationale.
   [BUILD variant] Propose a sensible default if the manager can't
   articulate a policy. Flag it with <!-- DEFAULT: change me --> for later
   review.
3. If you are unsure which mode you are in, ask before acting.
</terminal_recap>
```

The terminal recap is part of the uncached dynamic suffix — it costs no
extra cache invalidation.

### 9. Tenant-state detection — new `<tenant_state>` dynamic block (BUILD only)

At BUILD mount (`/build` page load), the backend reads the tenant's current
configuration and injects a summary into the BUILD dynamic suffix:

```
<tenant_state>
Tenant configuration summary:
- System prompt: [EMPTY | DEFAULT | CUSTOMISED — Nn edits since D]
- SOPs: Nn defined (N defaulted from canonical template)
- FAQs: Nn defined (N global, N property-scoped)
- Custom tools: Nn defined
- Properties: Nn imported from Hostaway
- Last BUILD session: [never | Ndays ago]

Opening posture: [GREENFIELD | BROWNFIELD]
  GREENFIELD — no prior configuration. Offer two paths: "start from the
    generic hospitality template" or "start from scratch."
  BROWNFIELD — existing configuration present. Open with "What do you want
    to build or change?" Do NOT re-interview topics already covered unless
    the manager asks.
</tenant_state>
```

This is the paper's §2 UI-context signal extended from mode to starting
condition. Detection logic lives in
`backend/src/build-tune-agent/tenant-state.service.ts` (new).

### 10. Canonical hospitality template — `GENERIC_HOSPITALITY_SEED.md`

A new, generic hospitality system prompt shipped with the product. NOT
forked from the current v28 `SEED_COORDINATOR_PROMPT` (which is tuned to
Abdelrahman's specific operation). Written from scratch with ~20 slots.

**Location:** `backend/src/build-tune-agent/templates/generic-hospitality-seed.md`
— committed to the repo, read at runtime by the agent when the manager
chooses "start from the generic template" at BUILD mount (GREENFIELD path).

**Slot inventory (20):**

Load-bearing (6, interview must fill):
1. `{PROPERTY_IDENTITY}` — brand name, short description, tone anchors.
2. `{CHECKIN_TIME}` — default check-in hour + early-check-in policy.
3. `{CHECKOUT_TIME}` — default check-out hour + late-checkout policy.
4. `{ESCALATION_CONTACT}` — name/role + channel (WhatsApp, phone, email) +
   business hours.
5. `{PAYMENT_POLICY}` — refund terms, deposit handling, damage charges.
6. `{BRAND_VOICE}` — tone adjectives (warm/professional/casual), forbidden
   phrases, language preferences.

Non-load-bearing (14, defaults OK):
7. `{CLEANING_POLICY}` — mid-stay cleaning, extra-cleaning fees.
8. `{AMENITIES_LIST}` — wifi, parking, kitchen, laundry, etc.
9. `{LOCAL_RECOMMENDATIONS}` — curated nearby suggestions.
10. `{EMERGENCY_CONTACT}` — after-hours routing.
11. `{NOISE_POLICY}` — quiet hours, party policy.
12. `{PET_POLICY}` — pets allowed, fees, restrictions.
13. `{SMOKING_POLICY}` — indoor, outdoor, vape.
14. `{MAX_OCCUPANCY}` — per-property default.
15. `{ID_VERIFICATION}` — what the screening flow requires.
16. `{LONG_STAY_DISCOUNT}` — thresholds, discount tiers.
17. `{CANCELLATION_POLICY}` — flexible / moderate / strict.
18. `{CHANNEL_COVERAGE}` — which OTAs the AI handles (Airbnb,
    Booking, WhatsApp, Direct).
19. `{TIMEZONE}` — for scheduled messages, local time references.
20. `{AI_AUTONOMY}` — coordinator-only vs coordinator+autopilot.

Every slot has an inline guidance comment (`<!-- guidance: ... -->`) and
every default-filled slot is additionally marked
`<!-- DEFAULT: change me -->`.

**Acceptance:** the template, when fully filled with non-default values,
produces a coordinator system prompt between 1,500–2,500 tokens. If it
produces more, tighten the template before shipping.

### 11. Tool-description engineering — 4 new BUILD tools + 2 orchestration tools

Every new tool follows this template in its description:

```
[NAME]: [1-sentence what-it-does]
WHEN TO USE: [concrete trigger conditions, including mode if relevant]
WHEN NOT TO USE: [concrete negative conditions, including the adjacent
                  tool that should be used instead]
PARAMETERS: [each param with meaning and effect]
RETURNS: [shape and what it means]
```

Full tool-description specs:

#### `create_sop`

```
create_sop: Create a new Standard Operating Procedure artifact.
WHEN TO USE: In BUILD mode, when the manager describes a policy or
  procedure that doesn't yet exist and you have enough detail to write a
  draft (two or more converging incidents OR an explicit policy statement
  the manager has confirmed). Also callable in TUNE mode in the rare case
  a MISSING_CAPABILITY correction reveals an entire SOP is absent — but
  only with user confirmation to switch to BUILD mode. In TUNE mode
  allowed_tools will deny this call; surface the need to switch.
WHEN NOT TO USE: Do NOT use to modify an existing SOP — use
  search_replace or propose_suggestion instead. Do NOT use as a guess
  after a single vague incident — probe for cues first.
PARAMETERS:
  sopCategory (string, 3-8 words, kebab-case canonical name — must not
               collide with an existing sopCategory for this tenant)
  status (enum DEFAULT | INQUIRY | PENDING | CONFIRMED | CHECKED_IN |
          CHECKED_OUT) — the reservation status this SOP applies to.
          Prefer DEFAULT if the policy is status-agnostic.
  propertyId (string, optional) — if set, creates a SopPropertyOverride
              for this property. If null, creates a global SopVariant.
  title (string, 3-8 words, human-readable)
  body (string, ≤800 tokens, use the canonical hospitality template
        structure)
  triggers (array of strings, guest-message patterns that invoke this
            SOP at classification time)
  transactionId (string, optional) — if part of a plan_build_changes
                 plan, pass the plan's id.
RETURNS: { sopId, variantId, version, previewUrl }
```

#### `create_faq`

```
create_faq: Create a new FAQ entry in the tenant's knowledge base.
WHEN TO USE: In BUILD mode, when the manager surfaces a factual piece of
  information guests ask about (wifi password shape, parking arrangement,
  check-in instructions, amenity specifics). Also callable in TUNE mode
  via allowed_tools for FAQ-gap corrections. In TUNE mode this competes
  with propose_suggestion(category='FAQ') — prefer propose_suggestion if
  the FAQ already exists and needs editing; use create_faq only for net
  new entries.
WHEN NOT TO USE: Do NOT use for policy statements (use create_sop). Do
  NOT use for information that belongs in the system prompt (use
  write_system_prompt or propose_suggestion).
PARAMETERS:
  category (string, FAQ taxonomy from config/faq-categories.ts)
  question (string, the canonical form of the guest's question)
  answer (string, ≤400 tokens)
  propertyId (string, optional) — null for global, set for property-scoped
  triggers (array of strings, optional)
  transactionId (string, optional)
RETURNS: { faqEntryId, version, previewUrl }
```

#### `write_system_prompt`

```
write_system_prompt: Write or replace the tenant's coordinator or
  screening system prompt.
WHEN TO USE: In BUILD mode, after the canonical hospitality template has
  been filled to at least coverage ≥ 0.7 and all 6 load-bearing slots have
  non-default values. The manager explicitly sanctions the write.
WHEN NOT TO USE: Do NOT use to make small edits to an existing system
  prompt — use propose_suggestion(category='SYSTEM_PROMPT') or
  search_replace instead. Do NOT use mid-interview while slots are still
  unfilled — the template will produce a fragment-quality prompt.
PARAMETERS:
  variant (enum 'coordinator' | 'screening')
  text (string, ≤2,500 tokens, COMPLETE prompt — no fragments)
  sourceTemplateVersion (string, hash of the GENERIC_HOSPITALITY_SEED.md
                         used at render time)
  slotValues (object, key→value map of the slots that produced this
              prompt; used for re-render and audit)
  transactionId (string, optional)
RETURNS: { configVersionId, previewUrl }
```

#### `create_tool_definition`

```
create_tool_definition: Create a new custom webhook-backed tool for the
  main AI to call.
WHEN TO USE: In BUILD mode, when the manager describes an action the AI
  should be able to take that isn't in the system tool suite
  (get_sop, get_faq, search_available_properties, create_document_checklist,
  check_extend_availability, mark_document_received) — e.g. "the AI should
  be able to check the cleaning schedule." Also callable in TUNE mode in
  rare MISSING_CAPABILITY → artifact-fix cases, though typically a
  CapabilityRequest is the right output there.
WHEN NOT TO USE: Do NOT use to modify an existing tool definition — use
  propose_suggestion(category='TOOL_CONFIG') or search_replace. Do NOT
  use without concrete webhook details — name, URL, auth, parameter
  schema all required.
PARAMETERS:
  name (string, snake_case, unique per tenant)
  description (string, 3-4 sentences minimum per Anthropic guidance)
  parameters (JSON schema)
  webhookUrl (string, https)
  webhookAuth (object, { type: 'bearer'|'basic'|'none', secretName })
  availableStatuses (array of reservation statuses)
  transactionId (string, optional)
RETURNS: { toolDefinitionId, version, previewUrl }
```

#### `plan_build_changes`

```
plan_build_changes: Surface a reviewable plan of multiple artifact writes
  before executing any of them. Returns a plan_id (transactionId) that
  subsequent create_* calls reference.
WHEN TO USE: BEFORE any sequence of 2+ create_* calls within a single
  user turn OR when a single manager statement implies multiple
  artifacts. Also appropriate in TUNE mode for multi-artifact corrections
  that touch SOPs + FAQs + system prompt together.
WHEN NOT TO USE: Do NOT use for single-artifact operations. Do NOT use
  after create_* calls have already been made — call plan first or not
  at all.
PARAMETERS:
  items (array of { type: 'sop'|'faq'|'system_prompt'|'tool_definition',
                    name: string,
                    rationale: string })
  rationale (string, ≤500 chars, overall plan rationale)
RETURNS: {
  transactionId (string),
  plannedAt (iso),
  approvalRequired (bool) — true if >1 item; frontend renders approval UI,
  uiHint: "Show this plan to the manager and wait for approval before
           executing any create_* calls that reference this transactionId."
}
```

#### `test_pipeline`

> Rewritten 2026-04-19 (session 3). Replaces the deferred batch-preview
> tool that previously sat here (`preview_ai_response`). See
> `MASTER_PLAN.md` → Sprint 047+ for the batch-preview deferral entry
> and `PROGRESS.md` → session-3 pivot for the rationale.

```
test_pipeline: Run one test message through the tenant's pipeline and
  get back both the reply and an LLM-graded score. Use after any
  create_* or write_system_prompt call to confirm the change behaves
  as intended.
WHEN TO USE: After a create_sop / create_faq / create_tool_definition /
  write_system_prompt call (or a plan transaction completing) to verify
  the freshly-written artifact is reflected in pipeline output. Also on
  manager request ("what would the AI say if a guest asked X?"). In
  TUNE mode, after an apply on a non-trivial artifact to confirm the
  correction landed.
WHEN NOT TO USE: Do NOT use to test the same change twice in one turn
  — results will be identical (the tool enforces a hasRunThisTurn
  guard). Do NOT use to stress-test with dozens of messages — batch
  scenario testing is deferred to a future tool. Do NOT use
  mid-interview with no artifacts yet.
PARAMETERS:
  testMessage (string, 1-1000 chars) — the guest message to run through
    the pipeline
  testContext (optional { reservationStatus?: 'INQUIRY'|'PENDING'|
    'CONFIRMED'|'CHECKED_IN'|'CHECKED_OUT'|'CANCELLED',
    channel?: 'AIRBNB'|'BOOKING'|'DIRECT'|'WHATSAPP'|'OTHER' }) —
    per-call overrides for the synthetic reservation context the
    pipeline runs against. Defaults to CONFIRMED + DIRECT.
RETURNS: {
  reply (string) — the AI's generated reply text,
  judgeScore (number, 0..1) — Sonnet-4.6 grader score,
  judgeRationale (string) — one-paragraph explanation of the score,
  judgeFailureCategory (string, optional) — short tag when score <0.7
    (e.g. "missing-sop-reference", "policy-violation", "channel-tone"),
  judgePromptVersion (string) — version stamp of the grading prompt used,
  latencyMs (number) — pipeline call wall-clock,
  replyModel (string) — the pipeline model that produced the reply
}
```

The judge is Sonnet 4.6, deliberately cross-family to the GPT pipeline
generator. This keeps the "judge ≠ generator" principle intact (no
self-enhancement bias per Zheng et al.) without requiring Opus. The
grading prompt is version-stamped in source so later edits don't
silently re-score old runs.

A PostToolUse emission of `data-test-pipeline-result` surfaces the
whole return shape in the frontend preview panel when it lands (Gate 6).

### 12. Transaction-ID extension to `rollback`

Extend the existing `rollback` tool with an optional `transactionId`
parameter. When present, revert ALL artifacts written under that
transaction, in reverse dependency order (tool_definitions → system_prompt
→ faq → sop). When absent, current per-artifact rollback behaviour
unchanged.

Schema:

```ts
rollback({
  artifactType?: SYSTEM_PROMPT | TOOL_DEFINITION | SOP_VARIANT | FAQ_ENTRY,
  versionId?: string,
  transactionId?: string,
})
```

Exactly one of `(artifactType, versionId)` pair OR `transactionId` must be
present. Mixed is an error.

PreToolUse hook stays the same — rollback requires an explicit rollback
sanction regardless of transaction mode.

### 13. PreToolUse hook updates

Minimum-invasive changes only:

- `allowed_tools` gating is done by the SDK config per-request, not by the
  hook. Hook does not need to know about modes.
- The existing compliance check on `suggestion_action` (apply/edit_then_apply)
  and `rollback` is unchanged.
- NEW: cooldown/oscillation checks skip entirely for the new BUILD tools
  (`create_sop`, `create_faq`, `write_system_prompt`, `create_tool_definition`)
  in this sprint. Cooldown semantics for net-new artifacts are different
  from edits-to-existing and need a separate design pass. We will add
  BUILD-mode cooldown in sprint 046 once we have real usage data.
- NEW: `plan_build_changes` and `test_pipeline` are both unguarded —
  they don't mutate artifacts directly.

### 14. PostToolUse hook updates

- Log all new tools to Langfuse with the shared transactionId (if present).
- Capture preference pairs for edit_then_apply paths as today; no change.
- For `test_pipeline` results, emit a `data-test-pipeline-result` SSE
  event so the frontend can render the reply + judge score inline.
  Low-score results (judgeScore < 0.7) should be visually distinct.

---

## Backend file plan

### New files

```
backend/src/build-tune-agent/                  # renamed from tuning-agent/
backend/src/build-tune-agent/templates/generic-hospitality-seed.md
backend/src/build-tune-agent/tenant-state.service.ts
backend/src/build-tune-agent/tools/create-sop.ts
backend/src/build-tune-agent/tools/create-faq.ts
backend/src/build-tune-agent/tools/write-system-prompt.ts
backend/src/build-tune-agent/tools/create-tool-definition.ts
backend/src/build-tune-agent/tools/plan-build-changes.ts
backend/src/build-tune-agent/tools/test-pipeline.ts       # single-message test tool (sprint 045, session 3)
backend/src/build-tune-agent/preview/test-judge.ts        # Sonnet 4.6 grader (sprint 045, session 3)
backend/src/build-tune-agent/preview/test-pipeline-runner.ts  # dry pipeline invocation helper
# ↓ Deferred to sprint 047+ (batch-preview subsystem; see MASTER_PLAN.md):
# backend/src/build-tune-agent/preview/golden-set.ts
# backend/src/build-tune-agent/preview/adversarial.ts
# backend/src/build-tune-agent/preview/judge-rubric.ts
# backend/src/build-tune-agent/preview/judge-opus.ts
backend/src/controllers/build-controller.ts             # /api/build/* endpoints
backend/src/routes/build.ts
```

### Modified files

```
backend/src/build-tune-agent/system-prompt.ts           # add BUILD/TUNE addenda, tenant_state, terminal_recap, persona rewrite, principles surgery
backend/src/build-tune-agent/runtime.ts                 # accept `mode: 'BUILD'|'TUNE'` RunTurnInput, pass allowed_tools
backend/src/build-tune-agent/config.ts                  # ENABLE_BUILD_MODE flag
backend/src/build-tune-agent/tools/index.ts             # register the 6 new tools
backend/src/build-tune-agent/tools/names.ts             # add 6 new tool names
backend/src/build-tune-agent/tools/rollback.ts          # transactionId support
backend/src/build-tune-agent/hooks/pre-tool-use.ts      # skip cooldown for BUILD create_* (documented)
backend/src/build-tune-agent/hooks/post-tool-use.ts     # transactionId logging
backend/prisma/schema.prisma                            # see §15
```

### Rename

`backend/src/tuning-agent/` → `backend/src/build-tune-agent/` (directory
only; re-export shim left behind at `backend/src/tuning-agent/index.ts` for
one sprint to avoid breaking imports).

### 15. Prisma schema changes

One new table + two column additions.

```prisma
model BuildTransaction {
  id           String   @id @default(cuid())
  tenantId    String
  tenant      Tenant   @relation(fields: [tenantId], references: [id])
  conversationId String?
  plannedItems Json     // Array<{ type, name, rationale }>
  status       String   // PLANNED | EXECUTING | COMPLETED | PARTIAL | ROLLED_BACK
  rationale    String?
  createdAt    DateTime @default(now())
  completedAt  DateTime?
  @@index([tenantId, createdAt])
}

model SopVariant {
  // existing fields...
  buildTransactionId String?   // new — links to BuildTransaction
}

model FaqEntry {
  // existing fields...
  buildTransactionId String?   // new
}

model ToolDefinition {
  // existing fields...
  buildTransactionId String?   // new
}

model AiConfigVersion {
  // existing fields...
  buildTransactionId String?   // new — on writes from write_system_prompt
}
```

Apply with `npx prisma db push` per constitution §Development Workflow.

---

## Frontend file plan

### New files

```
frontend/app/build/page.tsx                             # main /build page
frontend/app/build/layout.tsx
frontend/components/build/                              # new component folder
frontend/components/build/chat-surface.tsx              # center chat column (reuse tuning chat patterns)
frontend/components/build/activity-bar.tsx              # left 56px bar
frontend/components/build/left-rail.tsx                 # 288px dynamic left rail (history, suggestions, progress widget)
frontend/components/build/preview-panel.tsx             # 440px right panel (system prompt preview, plan, preview-result)
frontend/components/build/plan-checklist.tsx            # UI for plan_build_changes result
frontend/components/build/preview-result.tsx            # UI for test_pipeline single-message result
frontend/components/build/tenant-state-banner.tsx       # GREENFIELD / BROWNFIELD opening banner
frontend/components/build/tokens.ts                     # re-export of tuning tokens.ts (same palette)
frontend/lib/build-api.ts                               # client for /api/build/*
```

### Design constraints

- Use `frontend/components/tuning/tokens.ts` palette verbatim. Same purple
  accent (#6C5CE7), same category pastels. Do NOT import the main app's
  blue theme. The /build surface is the /tuning surface evolved — same
  look, different entry.
- Layout from the locked-in mockup at `specs/045-build-mode/ui-mockup.html`.
  Three-pane: 56px activity bar, 288px left rail, flex chat, 440px preview
  panel. Mobile: preview collapses behind a drawer.
- Reuse `frontend/components/tuning/chat-surface.tsx` components where
  possible — message bubbles, thinking indicator, tool-call cards, SSE
  stream handling. If something needs a BUILD-specific variant, copy
  rather than abstract.

### Tenant-state detection on mount

`/build` page load path:
1. Client hits `GET /api/build/tenant-state` → returns TenantStateSummary.
2. Page renders `<TenantStateBanner />` with GREENFIELD or BROWNFIELD copy.
3. Empty message list. Input focused. Placeholder text conditional on
   tenant state: GREENFIELD "Tell me about your properties..." / BROWNFIELD
   "What do you want to build or change?"
4. On first user message, opens a new `TuningConversation` row with
   `mode: 'BUILD'`, drives the runtime via POST `/api/build/turn`.

---

## Empirical validation tasks (scheduled BEFORE architectural commits)

These are the 3 open questions the research brief flagged. Execute
**at the start of the sprint**, not as acceptance criteria. If any fails,
the architecture above has to adjust.

### V1. `allowed_tools` cache-preservation check

**Goal:** confirm empirically that setting `allowed_tools` per-request does
NOT invalidate the `tools` array cache on Sonnet 4.6 via the Claude Agent
SDK.

**Procedure:**
1. Start a tuning session with the current 10 tools and an `allowed_tools`
   subset of 5 of them.
2. Fire 3 turns. Record Langfuse cache_read_input_tokens and
   cache_creation_input_tokens.
3. On turn 2+ of same session, cache_read should be ≥95% of expected
   prefix tokens (the current baseline). cache_creation should be ~0.
4. Change `allowed_tools` to a different subset of 5 (same underlying tools
   array). Fire a 4th turn.
5. cache_read on turn 4 should STILL be high. cache_creation should still
   be ~0. If not — cache invalidated — we need a different strategy.

**Fallback if V1 fails:** put BUILD and TUNE on separate prompt invocations
with separate cached prefixes (two cache hashes, one per mode). Cost: 2x
cache writes on cold start. Still cheaper than conditional tool loading,
which invalidates on every mode switch.

### V2. Terminal recap vs `<system-reminder>` in user message

**Goal:** decide where the 3 terminal rules live.

**Procedure:**
1. Implement both variants as a feature flag (`RECAP_LOCATION=dynamic_suffix`
   vs `RECAP_LOCATION=user_message_system_reminder`).
2. Run 20 synthetic BUILD sessions (10 GREENFIELD, 10 BROWNFIELD) and
   20 synthetic TUNE sessions against each variant.
3. Grade on: (a) tool-call preamble compliance (rule 1 adherence), (b)
   NO_FIX rate on cosmetic corrections (rule 2 adherence, TUNE only), (c)
   mode-confusion rate (rule 3 adherence).
4. Pick the winner. If within 5% — pick the dynamic_suffix variant (it's
   already the default architecture and doesn't require framework changes
   to inject into user messages mid-stream).

**Do this in parallel with V1 — they're independent.**

### V3. Defaults-as-markers round-trip

**Goal:** confirm `<!-- DEFAULT: change me -->` markers survive the full
template rendering path and land in the persisted artifact where TUNE
mode's future read path (sprint 046) can see them.

**Procedure:**
1. Render `GENERIC_HOSPITALITY_SEED.md` with 5 of 20 slots filled by
   defaults (other 15 by fake interview data).
2. Run it through `write_system_prompt`. Inspect the persisted
   `TenantAiConfig.systemPromptCoordinator` field.
3. The 5 `<!-- DEFAULT: change me -->` markers must all be present and
   byte-identical. No HTML-entity encoding, no whitespace collapse, no
   stripping by the template renderer.
4. Also verify the markers don't leak into the MAIN AI's view — they
   should be stripped at the point `templateVariableService` injects the
   prompt into the main pipeline, or they should be in comment form that
   the main AI is instructed to ignore.

**Fallback if V3 fails:** switch default markers from HTML-comment form to
an XML-tag form (`<default slot="foo">...</default>`) that the template
renderer explicitly recognises and preserves. More invasive but more
robust.

---

## Acceptance criteria

### Ship 1 architecture

- [ ] V1, V2, V3 all resolved (pass or fallback applied) before any other
      code commits.
- [ ] Directory renamed to `backend/src/build-tune-agent/`. Re-export shim
      at old path.
- [ ] System prompt assembly produces 3 cache breakpoints via
      `cache_control: { type: 'ephemeral' }` in the request body. Langfuse
      shows distinct cache_read patterns for BUILD vs TUNE.
- [ ] All tools always loaded in `tools` array (14 or 15 per verified
      inventory). `allowed_tools` per request gates visibility. Langfuse
      cache_read on the tools block stays ≥95% of baseline across mode
      switches.
- [ ] Persona rewritten mode-agnostic. No identity language in mode
      addenda.
- [ ] NO_FIX-as-default moved to TUNE addendum. Edit-format rule moved
      to TUNE addendum. Shared principles down from 11 to 9.
- [ ] BUILD addendum present with interview posture, graduation criteria,
      defaults-as-markers rule, anti-sycophancy specifics.
- [ ] Terminal recap present in dynamic suffix, mode-selected.
- [ ] Existing 10 TUNE tools behave identically on /tuning surface. No
      behaviour regression on sprint-01-through-10 tests.
- [ ] Cache hit rate on pure-TUNE sessions (no BUILD coexistence) stays
      ≥0.998. Verified in Langfuse over a 48h window.

### Ship 2 visible feature

- [ ] 4 new BUILD tools implemented per tool-description specs in §11.
      Each has unit tests covering happy path + 2 error cases.
- [ ] `plan_build_changes` tool implemented, `BuildTransaction` table
      created, `buildTransactionId` foreign keys added to SopVariant,
      FaqEntry, ToolDefinition, AiConfigVersion.
- [ ] `rollback` extended with `transactionId` mode. Existing rollback
      paths unchanged. Integration test: plan 3 artifacts, create all 3,
      rollback by transactionId, all 3 revert in reverse dependency order.
- [ ] `test_pipeline` tool implemented — single-message verification
      with a Sonnet-4.6 judge (cross-family to the GPT pipeline
      generator; never same-family grading). Includes a hasRunThisTurn
      guard and tenant-config cache bypass. (Batch preview subsystem —
      golden set + adversarial + rubric + LLM judging — is deferred to
      sprint 047+ per MASTER_PLAN.md.)
- [ ] `GENERIC_HOSPITALITY_SEED.md` written with all 20 slots, guidance
      comments, default markers. A fully-filled render produces
      1,500–2,500 tokens.
- [ ] `/build` page renders three-pane layout from mockup, tuning tokens
      palette. Tenant-state detection fires on mount. GREENFIELD and
      BROWNFIELD opening copy render correctly.
- [ ] End-to-end test: GREENFIELD tenant → opens /build → interview fills
      all 6 load-bearing slots via incident-based probes → `plan_build_changes`
      surfaces approvable plan → approved → 3 SOPs + 2 FAQs + 1
      write_system_prompt complete under one transactionId →
      `test_pipeline` run on at least one representative guest message →
      reply references the tenant's new artifacts and the Sonnet-4.6
      judge returns a score ≥0.7 with a non-empty rationale.
- [ ] `ENABLE_BUILD_MODE` env flag gates the /build route on the backend.
      Default off in prod config.
- [ ] BUILD addendum rules are live — verify in Langfuse traces that
      interview sessions actually use the incident-probe posture (sample
      10 manually).
- [ ] Cache hit rate on mixed sessions (TUNE + BUILD in same tenant) stays
      ≥0.995 over a 48h window.

### Red-team / preview quality

Deferred to sprint 047+ (see MASTER_PLAN.md). Sprint 045 ships the
single-message `test_pipeline` tool as the manager's verification
primitive; the batch golden-set + adversarial + rubric infrastructure
is added when there's commercial demand for multi-scenario testing.

### Non-regression

- [ ] All existing tuning-agent tests pass.
- [ ] All existing AI-pipeline tests pass.
- [ ] No migration required on existing tenants' data — `buildTransactionId`
      is nullable, old rows remain null.

---

## Out of scope — explicit deferrals

| Item                                        | Deferred to   |
|---------------------------------------------|---------------|
| `ONBOARDING_STATE.md` session resumption    | Sprint 046    |
| `DECISIONS.md` read-path into TUNE suffix   | Sprint 046    |
| Cross-mode PreToolUse sanction gate         | Sprint 046    |
| Extraction into independent service         | TBD (post-046) |
| BUILD-mode cooldown / oscillation semantics | Sprint 046    |
| Mobile-optimised /build layout              | Sprint 046    |
| Multi-language interview support            | Sprint 047+   |
| Fine-tuning / DPO from preference pairs     | TBD, SMB scale insufficient today |

---

## Risks and mitigations

**R1. Cache regression on TUNE sessions.** Adding breakpoint 3 per-mode
could surprise the API's caching heuristic. Mitigation: V1 empirical test
+ Langfuse monitoring for 48h before enabling BUILD for any real tenant.

**R2. BUILD interview runs too long.** Graduation target is <60 min.
Managers drop off at 30+ min without visible progress. Mitigation: left
rail shows interview progress widget per slot (locked-in mockup has this);
"build now" button always visible; default-fill early-exit path.

**R3. Adversarial suite over-flags.** 100 adversarial messages with 15%
false-positive rate = 15 confusing "failures" per BUILD graduation.
Mitigation: confidence-gated disclosure — only show failures above
threshold, cap surfaced failures at 5, plain-language summaries not raw
transcripts.

**R4. `create_*` tools fabricate slop.** Sonnet 4.6 + 14 loaded tools +
interview context might generate low-quality SOPs. Mitigation:
`test_pipeline` is the done-oracle — the manager runs a representative
guest message after each meaningful `create_*` and confirms the judge
score is ≥0.7 with a rationale that references the freshly-written
artifact. If not, the interview rounds continue. (Batch golden-set
validation is deferred to sprint 047+; until then, the single-message
loop is the quality gate.)

**R5. Template renderer strips default markers.** V3 catches this early.
If it fails, fall back to XML-tag default markers and re-test.

---

## Success metrics (post-launch, not sprint acceptance)

Per the research brief §26, the 6 that matter. Instrument Langfuse + a
new `BuildSession` analytics view before sprint close so we can report
on them from day 1.

1. **Time to first-guest-reply** (interview start → first production AI
   reply sent). Target: <60 min median.
2. **Completion rate** (start → graduation). Target: >70%.
3. **D7 retention** (≥1 AI reply/day for 7 consecutive days post-graduation).
   Target: >60%.
4. **First-100-replies quality** vs pre-BUILD manual baseline and
   defaults-only config. Target: beat defaults-only on ≥80%, match manager
   manual on ≥70% (LLM-judge).
5. **Graduation-time distribution.** Investigate any tail beyond p90.
6. **Default-override rate in first 30 days.** Target: <40%.

These are sprint 046 deliverables (instrumentation); reporting begins once
real tenants use /build in prod (post-gating).

---

## Decision log captured for future reference

Decisions made explicitly and NOT revisited in this sprint:

1. Unified persona, two mode addenda (NOT two prompts + router).
2. All 16 tools always loaded (NOT conditional loading).
3. `allowed_tools` per-request gates visibility (NOT separate prompt invocations).
4. Distinct `create_*` tools (NOT unified `upsert_artifact(type, content)`).
5. Judge ≠ generator — Opus 4.6 or deterministic rubric, never Sonnet grading itself.
6. Template-with-slots (NOT final big generation or incremental accumulation).
7. Defaults-as-markers (NOT silent defaults or forced full-interview).
8. Monorepo module boundary (NOT independent service).
9. Keep SOPs/FAQs/system prompt vocabulary exposed (NOT abstracted to "policies/answers").
10. Branch `feat/045-build-mode` off `feat/044-doc-handoff-whatsapp`. Main↔044 divergence is a separate problem.

Revisit at sprint 046 planning:

- Cross-mode PreToolUse gate vs `allowed_tools` denial alone.
- `ONBOARDING_STATE.md` vs in-DB session state.
- Independent service extraction (only if traffic or team size forces it).

---

## Appendix — reference reads for the executor

- `specs/045-build-mode/research-prompt.md` — the research prompt used to
  generate the brief (for provenance).
- `/sessions/charming-festive-babbage/mnt/uploads/BUILD + TUNE- architecture brief for a unified serviced-apartments agent.md` —
  the brief this spec derives from. All §-references in this spec point here.
- `specs/045-build-mode/ui-mockup.html` — locked-in three-pane layout.
- `backend/src/tuning-agent/system-prompt.ts` — current sprint-10 ordering.
- `backend/src/tuning-agent/tools/propose-suggestion.ts` — tool pattern to mirror.
- `backend/src/tuning-agent/hooks/pre-tool-use.ts` — compliance gate pattern.
- `specs/041-conversational-tuning/tuning-research-recommendations.md` —
  prior research master reference; item DEFERRED → this sprint is where
  some of those deferrals unblock.
