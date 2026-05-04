# Sprint 061 — Studio token efficiency

**Status:** spec.
**Branch:** `chore/061-studio-token-efficiency` off `chore/060-C-studio-mode-restructure` HEAD.
**Size:** large sprint, ~12-18 stacked commits, backend-heavy with ~3 prompt edits.
**Predecessor:** 060-C (mode restructure + state machine + initial cache_control wiring) shipped.
**Successor:** TBD; this sprint sets the measurement baseline that downstream model-choice work (see "Sonnet vs GPT-5.4" research thread) depends on.

## 1. Intent

Cut Studio per-turn token consumption by **30-50%** and per-turn API cost by **40-60%** without regressing decision quality. The two non-negotiable behaviors stay sharp:

- NO_FIX abstain calibration on wording-only edits.
- Long-context instruction following on the dense rule blocks (taxonomy, edit-triage, never-do, state machine).

Empirical motivation: Anthropic console showed individual `messages.create` rounds at **70,000-77,000 input tokens**, hitting the 450K/min rate limit on bursts. Cache hit rate is 57.8% — decent, but uncached portion (~57K/req) is the binding constraint, not cost. Internally one Studio user-turn fires 3-8 tool-use loop rounds, and **every round re-sends the full prior history**, so tool returns compound.

Worked example for a 5-round turn (matches a real trace inspected via `langfuse-trace-detail.ts`):

| Round | What's in the request | Cumulative input |
|---|---|---|
| 1 | system (12K cached) + tools (5K cached) + Region C (1K) + user msg | ~18K |
| 2 | + assistant-1 (~2K) + tool_result-1 (`get_context`, 8K) | ~28K |
| 3 | + assistant-2 (~1.5K) + tool_result-2 (`get_artifact`, 12K) | ~41K |
| 4 | + assistant-3 (~1K) + tool_result-3 (`get_evidence_section`, 15K) | ~57K |
| 5 | + assistant-4 (~1.5K) + tool_result-4 (smaller, 5K) | ~63-70K |

Total input across the turn: **~144K**. Total output: ~3-5K. Cost dominated by uncached inputs in rounds 4-5.

## 2. Why — empirical breakdown

Three sources, ranked by leverage:

### 2.1 Tool returns are dumped at full size

`studio_get_artifact` returns full bodies: 10-30K for system prompts, 5-15K for SOPs. The `verbosity: 'concise' | 'detailed'` enum exists in the schema (line 34 of `tools/get-artifact.ts`) but the **handler ignores it** — every call returns `detailed` regardless. Same shape applies to `studio_get_evidence_section` and `studio_get_context`.

System prompts have explicit section structure (`v.sections` is already returned alongside `v.text`) but no tool to fetch a single section. Agents that only need one section pay for the whole document.

### 2.2 Speculative reads

A real trace (`25c30eb8-1601-4c0e-93c4-b8a693c32ee3`, 102s, 15 observations) shows the agent firing 6 tool calls in one turn, of which **5 returned <100 chars** (errors, empty results, trivial returns). The "let me check just in case" pattern is unconstrained: no rule caps reads per state, no rule forbids speculative `get_artifact` before triage has produced an artifact target.

### 2.3 No round-by-round observability

Current `logAgentGeneration` runs **once per SDK query** with cumulative usage taken from the LAST assistant message. The Langfuse trace shows `input=17, output=64` for a turn the Anthropic console billed at ~70K input. We can't measure any lever's impact until per-round usage is captured.

### 2.4 Tools and Region C are healthy already

Measured via `scripts/measure-prompt.ts`:

- Region A: 5,914 tokens (cached) ✅
- Region B (TUNE addendum): 2,063 tokens (cached) ✅
- Region B (BUILD addendum): 3,814 tokens (cached) ✅
- Region C typical: 818 tokens (uncached, fine) ✅
- Tools block: ~3-5K (cached) ✅

These aren't the leak. The leak is rows 13b/13c/13d in the per-request table (full-body tool returns accumulating across rounds).

## 3. Scope

**In scope.**

- `backend/src/build-tune-agent/tools/get-artifact.ts` — honor `verbosity:'concise'`, add `mode:'index'`, add `section:'<name>'`. Update DESCRIPTION.
- `backend/src/build-tune-agent/tools/get-context.ts` — slim default payload; conditionally include heavy fields only when caller asks.
- `backend/src/build-tune-agent/tools/get-evidence-section.ts` — already section-scoped; honor `verbosity:'concise'` for the long sections (`reasoning_trace`, `tool_call`).
- `backend/src/build-tune-agent/system-prompt.ts` — new `<read_budget>` block in `<state_machine>`; "no speculative reads" rule under `<edit_triage>`.
- `backend/src/build-tune-agent/sdk-runner.ts` — per-state tool allow-list compaction (already partially gated; promote to registration-level), per-round `logAgentGeneration` emit inside the `for await` loop instead of cumulative-after-loop.
- `backend/src/build-tune-agent/runtime-direct.ts` — direct-transport bridge logs per-round usage from `messages.create` response (parallel path to SDK fix).
- `backend/src/services/observability.service.ts` — `logAgentGeneration` extended with `roundIndex` metadata so the audit script can group per-turn.
- `backend/scripts/langfuse-cost-audit.ts` — group by trace + round, surface per-round breakdown.
- `backend/scripts/langfuse-trace-detail.ts` — already shipped; expand to show per-round usage now that it exists.
- `backend/src/build-tune-agent/__tests__/get-artifact.test.ts` (new) — unit tests for verbosity / mode:'index' / section:'<name>'.
- `backend/src/build-tune-agent/__tests__/system-prompt.test.ts` — assertions for `<read_budget>` block and "no speculative reads" rule.
- `backend/src/build-tune-agent/__tests__/sdk-runner.test.ts` (extend) — per-round generation emission, per-state allow-list filtering.

**Explicitly out of scope.**

- Switching primary model away from Sonnet 4.6. Tracked in a separate research thread. Cost work here is what informs that decision.
- New write tools. No new write surfaces; existing `studio_create_*` and `studio_suggestion` cover the writes.
- DB schema changes. None needed.
- Frontend rendering. Tool returns are still JSON; rendering layers ignore unknown fields.
- Reply-pipeline cache hit rate (separate finding from the audit: "Omar" is at 0% cache, GPT-5.4-mini side, separate sprint).
- Long-context summarization of conversation history. Lever H below; deferred unless A-G don't hit the target.
- Backwards compat for Region A/B prompt changes that invalidate cache once. Acceptable one-time cache miss; users will see one slower turn after deploy.

## 4. Levers — full list with cost / risk / wiring

Ten levers, ranked by expected impact-per-effort. Letters match the table I gave the user in chat.

### Lever A — Honor `verbosity:'concise'` in `studio_get_artifact`

**Impact:** ~5-15K tokens saved per `get_artifact` call when concise. Most artifact reads in TUNE are triage peeks, not full edits — concise should be the default for those.

**Wiring:**
- `tools/get-artifact.ts`: read `args.verbosity`. When `'concise'` (default) and the body exceeds `HEAD_EXCERPT_CHARS` (1200), return `{...meta, text: head_excerpt + '\n\n…[truncated — call again with verbosity:"detailed"]', fullCharLength}`. When `'detailed'`, full body. SOPs and FAQs follow the same shape.
- DESCRIPTION updated to specify when to use each.
- Span end metadata records `detailed: boolean` for observability.

**Risk:** Low. Default-concise might break a code path that assumed full-body return — audit `propose_suggestion` and `write_system_prompt` callers (none should call `get_artifact` directly; they get text via different paths).

**Acceptance:** A turn that calls `get_artifact` 2x for triage shows the concise-mode return shape in the trace; full body fetched only after `verbosity:'detailed'` is explicitly passed.

**Rollback:** Single tool file; revert is one commit.

---

### Lever B — Add `mode:'index'` to `studio_get_artifact`

**Impact:** ~10-25K tokens saved when the agent only needs to know "what sections does the screening prompt have?" before deciding which section to edit.

**Wiring:**
- `tools/get-artifact.ts`: add `mode: z.enum(['full', 'index']).optional()` (default `'full'` for back-compat — agent prompt teaches it to pass `'index'` first).
- For `mode:'index'`: return `{kind, body_pointer, sectionList: [{name, summary, tokens, hashId}], fullCharLength, version}`. No body text.
- Section summaries auto-derived from each section's first sentence + heading. Pre-computed once per artifact, cached in memory for the duration of the conversation.
- Section `hashId` is HMAC-signed so the agent can pass it back via `section:'<name>'` without forging.

**Risk:** Medium. New code path, needs unit tests on the section-extractor for system prompts (which are already structured) and SOPs (which may have informal markdown headings).

**Acceptance:** `studio_get_artifact(pointer, mode:'index')` returns ≤1500 tokens for any artifact regardless of body size. Section names match what's actually in the artifact.

**Rollback:** Same one tool file.

---

### Lever C — Add `section:'<name>'` to `studio_get_artifact`

**Impact:** Pairs with B — once the agent knows section names, fetching one section instead of whole artifact saves ~80-95% of body tokens for system prompts.

**Wiring:**
- `tools/get-artifact.ts`: add `section: z.string().optional()`.
- When set, validate against the artifact's section list (rejects unknown names to prevent agent hallucinating them).
- Returns `{kind, sectionName, text: <just that section>, neighborSections: [<prev>, <next>]}` so the agent has hooks to pull adjacent context if needed without re-fetching the whole thing.
- For SOPs without explicit sections, falls back to fuzzy match on heading; if no match, returns the concise excerpt and an explanatory note.

**Risk:** Medium. Section name matching needs to be tight enough that the agent can't accidentally bypass `mode:'index'` by guessing names. Mitigated by validating against the indexed section list.

**Acceptance:** A TUNE turn that drills `tenant_index → mode:'index' → section:'rejection_rules'` returns ≤2K tokens for a 25K system prompt.

**Rollback:** Same tool file. Fallback path returns concise excerpt, so agent never gets a hard failure even if section list disagrees.

---

### Lever D — Tool-budget rule per state

**Impact:** Reduces speculative reads. The trace-inspected turn fired 6 reads when 2 would have sufficed; a budget rule says "max 4 reads in scoping, 2 in drafting, 1 in verifying" before the agent has to either respond or propose a transition.

**Wiring:**
- `system-prompt.ts`, inside `<state_machine>`, new `<read_budget>` sub-block:

  ```
  <read_budget>
  Reads per turn cap by state:
    scoping  — up to 4 read tools before responding or transitioning
    drafting — up to 2 read tools (you should already know what to write)
    verifying — 1 (studio_test_pipeline only)
  Reads include studio_get_*, studio_search_corrections, studio_get_correction.
  studio_get_tenant_index counts as 1 even though it's the catalog. After
  hitting the cap, respond or call studio_propose_transition.
  </read_budget>
  ```

- No runtime enforcement (prompt-level only). Soft cap; lets the agent break in genuinely hard cases without a hard error.

**Risk:** Low. Worst case the rule is ignored and we're back where we started; no regression.

**Acceptance:** Median reads-per-turn drops from ~3 to ~2 in the next 24h after deploy. Measured via the audit script's per-trace span count.

**Rollback:** Single prompt edit. Region A/B re-cache on first turn after revert.

---

### Lever E — "No speculative reads" rule

**Impact:** Pairs with D and B — bans the pattern where the agent fetches `get_artifact` "just to see what's there" before triage has produced a target.

**Wiring:**
- `system-prompt.ts`, inside `<edit_triage>` sub-block of TUNE addendum:

  ```
  <no_speculative_reads>
  Before calling studio_get_artifact, complete edit triage:
    1. Classify the edit_type from the diff alone (six types in <edit_triage>).
    2. If edit_type is STYLE_WORDING or FRAMING_TONE, the category is
       NO_FIX. Do not fetch any artifact body — there is nothing to edit.
    3. Only when edit_type is FACTUAL/BEHAVIORAL/OMISSION/REMOVAL do
       you fetch — and even then start with mode:'index' to find the
       target section before pulling its body.
  Witness quote and reasonsNotToAct must be filled before any fetch.
  </no_speculative_reads>
  ```

- Tightens what the agent does in the FIRST 1-2 rounds of a TUNE turn — the rounds where speculative reads pile up.

**Risk:** Low to medium. There's a risk the agent classifies wrong and proposes NO_FIX without realizing an SOP edit was warranted. Mitigated by the schema-default and witness_quote precondition we already have. Honest false-NO_FIX is preferable to confident wrong-classify (the original failure mode that motivated 060-C).

**Acceptance:** First-round read count drops from ~2-3 to ~0-1 in TUNE turns where edit_type is wording-class.

**Rollback:** Single prompt edit.

---

### Lever F — Trim `studio_get_context` payload

**Impact:** ~3-5K tokens saved per turn that uses context (most turns do — it's called early).

**Wiring:**
- `tools/get-context.ts`: remove or summarize verbose fields. Keep the load-bearing core: anchor message text + last 3 inbox messages + last edit summary. Drop full conversation history (the SDK has session resume), drop large embedded objects, drop `retrievalContext` field (always null in current calls per the trace metadata).
- Add `verbosity:'concise'|'detailed'` like `get_artifact`. Concise = default 1.5K; detailed = current 7.8K shape.
- Span metadata records what was included so we can compare before/after.

**Risk:** Medium. Some agent flows might depend on a specific field that the slim default no longer includes. Mitigation: detailed mode preserves current shape; agents that need it can opt in.

**Acceptance:** Default `get_context` return drops from 7.8K to ≤2K tokens.

**Rollback:** Tool file revert. No persisted state.

---

### Lever G — Move stable `get_context` content into Region C

**Impact:** Eliminates one round-trip per turn (the agent always calls `get_context` first; we can pre-render it).

**Wiring:**
- `system-prompt.ts`: new `<conversation_anchor>` block in Region C, populated by `buildDynamicSuffix` from `ctx.anchorMessageId`-derived data.
- The runtime fetches anchor message + last edit summary server-side once at turn start and feeds it to the prompt context. Same data the tool returns; just delivered via the prompt instead of via a tool round.
- `studio_get_context` stays available for fields not in the prompt (full conversation history, retrieval context — only when requested).

**Risk:** Medium-high. Region C grows by ~2K (assuming Lever F shipped first). Plus one new server-side data fetch per turn. If the agent insists on calling `get_context` anyway, we duplicate. Mitigation: tool description explicitly says "data already in `<conversation_anchor>` if you need it; only call this for the heavy fields."

**Acceptance:** `get_context` is called in <30% of turns post-deploy (down from ~95%). Region C grows by ≤2K.

**Rollback:** Two-file change (system-prompt.ts + runtime context-builder); revert removes the block.

---

### Lever H — Compress old tool returns in messages array (deferred)

**Impact:** Highest theoretical impact (~30-50K saved per late-round request), but riskiest.

**Wiring:**
- The Claude Agent SDK manages the messages array via session resume. We can't directly mutate it from outside.
- Two paths to ship:
  1. **PreCompact hook** — the SDK exposes a PreCompact event that lets us rewrite history before it's sent. Replace tool_result blocks older than N rounds with `[tool_result:abc123 — re-fetch via tool]` stubs. Agent re-fetches on demand (rare).
  2. **Direct-transport bridge** — when `BUILD_AGENT_DIRECT_TRANSPORT=true` we have full control over the messages array and can apply the same logic before each `messages.create`.
- Path 1 is preferred (works in both transports); needs investigation of the SDK's PreCompact contract.

**Risk:** High. Wrong stubs break the agent's reasoning ("what was that SOP I just read?"). Re-fetches add round-trips. Caching invalidation if stub bytes differ from original.

**Acceptance:** Defer until A-G measured. Re-evaluate if per-round token count is still >40K average.

**Rollback:** Disable hook; old behavior returns immediately.

---

### Lever I — Per-state tool allow-list compaction

**Impact:** Tools block drops from ~5K cached to ~2-3K cached when the agent is in a state that doesn't need write tools. Even though it's cached, smaller tools blocks mean faster cache writes on cold turns and slightly better attention.

**Wiring:**
- `sdk-runner.ts`: when starting a query, filter the registered tools list by current state + outer mode. Keep all read tools always; add write tools only in drafting; add `studio_test_pipeline` only in verifying.
- The PreToolUse hook stays — runtime-level safety net even if registration is wrong.
- The agent only sees the allowed tool descriptions in the cached tools block.

**Risk:** Medium. State transitions mid-turn would mean the agent doesn't see a tool it needs. Mitigation: state transitions are agent-proposed and host-confirmed (one turn boundary), so the next turn after a transition will have the new allow-list — no mid-turn reshuffling.

**Acceptance:** Tools block in scoping turns drops to ≤3K cached. State-transition test cases cover the boundary case.

**Rollback:** Single function in sdk-runner.ts; revert restores all 19 tools always.

---

### Lever J — Per-round Langfuse generation emit (measurement)

**Impact:** Doesn't reduce cost. Required to **measure** every other lever.

**Wiring:**
- `sdk-runner.ts`, inside `for await (const message of q)`: when an `assistant` message arrives with usage, fire `logAgentGeneration` immediately with `roundIndex: cumulativeUsage.rounds + 1`. Don't accumulate-then-emit-once at end.
- `runtime-direct.ts`: when calling `messages.create` directly, log a generation per response.
- `observability.service.ts#logAgentGeneration`: extend to accept `roundIndex` and `parentSpanId` metadata so the audit script can reconstruct the turn shape.
- `langfuse-cost-audit.ts`: group observations by `traceId` then sort by `roundIndex` to show per-round breakdown.
- `langfuse-trace-detail.ts`: render rounds as a stacked tree under the parent `tuning-agent.query` span.

**Risk:** Low. Changes only observability code. Worst case Langfuse over-counts (multiple generations for one round) — caught by the audit-script test.

**Acceptance:** A 5-round turn shows 5 generations in Langfuse, summed input across them matches Anthropic console total within 5%.

**Rollback:** Two-file revert. No production behavior change.

---

## 5. Sequencing

Each PR is independently shippable and reverts cleanly.

| PR | Levers | Goal | Estimated savings |
|---|---|---|---|
| 1 | **J** (per-round capture) | We can see the truth | Measurement only |
| 2 | **A** (verbosity) | Default-concise reads | -10-30% per-call |
| 3 | **B + C** (mode:'index' + section:'<name>') | Section drill-down | -50-80% on system prompt fetches |
| 4 | **D + E** (read budget + no speculative reads) | Cap rounds | -30-50% rounds per turn |
| 5 | **F** (trim get_context) | Smaller context payload | -3-5K per turn |
| 6 | **G** (move context into Region C) | Eliminate one round | -1 round per turn |
| 7 | **I** (per-state tool allow-list) | Cleaner tools block | -2-3K cached per turn |
| 8 | **H** (compress old tool returns) | Stretch — only if 1-7 don't hit target | -30-50K late-round |

After PR 5 we should be at the goal. PRs 6-8 are stretch.

## 6. Acceptance criteria

Measured 24h after each PR via `langfuse-cost-audit.ts`:

- **Per-round input tokens:** median ≤30K (currently ~50K), p90 ≤45K (currently ~70K)
- **Rounds per turn:** median ≤3 (currently ~5), max ≤6 (currently 8+)
- **Cache hit rate:** ≥75% (currently 57.8%)
- **Per-turn cost (Sonnet 4.6):** median ≤$0.03 (currently ~$0.08-0.10)
- **Decision quality:** no regression on the four eval tests (gender→family/friends NO_FIX, screening preferences memory, witness_quote presence, three-field self_report). Run before each PR merge.

If any PR misses its targets after 48h of production data, roll back and re-evaluate.

## 7. Rollback story

Each lever is one-PR-revert. Specifically:

- A, B, C: single tool file (`get-artifact.ts`)
- D, E: prompt-only edits to `system-prompt.ts`
- F: single tool file (`get-context.ts`)
- G: prompt + runtime context-builder; two-file revert
- H: hook deactivation (env flag)
- I: single function in `sdk-runner.ts`
- J: observability code only — no prod behavior

No DB migrations. No persisted state. Revert is a `git revert <pr>` on each.

## 8. Tests

Per-lever:

- **A:** `get-artifact.test.ts` — assert concise default truncates at 1200 chars; detailed returns full; SOPs/FAQs/system_prompts each path covered.
- **B:** assert `mode:'index'` returns `sectionList`, no body text, ≤1500 tokens for a 30K system prompt.
- **C:** assert `section:'<name>'` returns just that section; rejects unknown names; SOP fallback works.
- **D, E:** `system-prompt.test.ts` — `<read_budget>` block presence, `<no_speculative_reads>` rule presence, scoping/drafting/verifying caps named correctly.
- **F:** `get-context.test.ts` — concise default ≤2K tokens; detailed matches current shape byte-for-byte.
- **G:** `system-prompt.test.ts` — `<conversation_anchor>` block renders when ctx provides anchor data; doesn't render when null.
- **I:** `sdk-runner.test.ts` — tool list filtered correctly per state+mode combo; PreToolUse hook still catches violations as a backstop.
- **J:** mock SDK message stream with 5 assistant messages; assert 5 generations emitted with monotonic `roundIndex`.

Existing prompt-cache stability + state-machine tests must continue to pass after every PR.

## 9. Open questions for the implementer

1. **Section extraction for SOPs.** SOPs aren't formally section-divided like system prompts. Lever B's `sectionList` for SOPs needs a pragmatic heuristic — markdown headings, paragraph splits, or a single-section fallback. Pick the simplest that works for the common case.
2. **`get_context` deprecation path for Lever G.** If Region C carries the anchor data, do we deprecate `get_context` entirely or keep it as the "give me the heavy fields" escape hatch? Recommend keeping it but making concise the default.
3. **Cache breakpoint on per-state tools (Lever I).** Anthropic supports 4 cache breakpoints; we use 3 + 1 (messages). Per-state tool registration changes the tools-block bytes, which invalidates cache on the cache_control marker. Mitigation: keep the per-state tools list at the END of the tools block so the cache prefix (read tools, stable across states) stays warm.
4. **PreCompact hook investigation (Lever H).** Need a small spike to confirm the SDK exposes the hook in v0.2.109 and that we can rewrite tool_result blocks safely. Spike before committing to PR 8.

## 10. Out of band — model-choice research

The "Sonnet 4.6 vs GPT-5.4" research thread is independent. This sprint's measurement infrastructure (Lever J + the audit scripts) is the prerequisite for that research having real per-model cost numbers. Don't block this sprint on the research; ship the levers and let the data inform the model decision.
