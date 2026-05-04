# Feature Specification: Studio Token Efficiency

**Feature Branch**: `047-studio-token-efficiency`
**Created**: 2026-05-04
**Status**: Draft
**Input**: User description: "Cut Studio token consumption 30-50% via tool-return verbosity, section drilldown, read-budget rules, and per-round Langfuse measurement"

## Clarifications

### Session 2026-05-04

- Q: Read-budget enforcement (prompt-only vs runtime hook, blocking vs warning)? → A: Prompt rule + PreToolUse hook that warns (logs span tag, increments observability counter) when read count exceeds budget, but does not block the call.
- Q: SOP section extraction heuristic for `mode:'index'` when SOPs lack formal structure? → A: Markdown headings (`##`/`###`) primary; when none found, return a single-section list with the SOP title as the section name. The agent must rely on the catalog (`studio_get_tenant_index`) title + description as the first filter before drilling into any SOP body — section extraction only matters AFTER the catalog has narrowed the candidate set.
- Q: Disabled SOPs visibility to the Studio agent? → A: Keep showing disabled SOPs in the catalog with the existing `disabled` status tag (preserves the "we deliberately opted out of this topic" signal that's useful during triage). Add a prompt rule in TUNE's `<edit_triage>` block: "Disabled SOPs are informational only. Do not call `studio_get_artifact` on a disabled SOP, do not propose edits to one, and do not propose re-enabling unless the operator explicitly asks."
- Q: Per-round Langfuse generation emit cadence (live vs batched)? → A: Live — each round's generation is emitted to Langfuse the moment that round's SDK assistant message arrives with usage, inside the `for await` loop. Each generation carries its own start/end timestamp matching the actual round window. Mid-turn process crashes preserve the partial trace. The Langfuse SDK's internal batching keeps network cost flat; we don't add a final summary generation (audit scripts sum across rounds).
- Q: How do the four decision-quality eval cases get verified per PR? → A: Codified as automated `node:test` integration tests at `backend/src/build-tune-agent/__tests__/decision-quality.test.ts`. Each test stubs the LLM call with a recorded canonical response and asserts on the agent's output structure (e.g. `category === 'NO_FIX'`, `consultedMemoryKeys` contains a specific preferences/* key, `witness_quote` is a non-empty string). Run in CI on every PR; hard-required to pass before merge. No live LLM calls in CI — tests run in <2s and cost $0. Real-model regressions are caught by post-deploy operator usage, not by these tests.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Per-round measurement so we can see the truth (Priority: P1)

The operator and engineering team need to see, for every Studio agent turn, exactly how many internal `messages.create` rounds fired, what each round's input/output token count was, what each round's cache_read vs fresh-input split was, and which tool calls happened in which round. Today the Anthropic console shows ~70K-input rounds hitting the 450K/min rate limit, but Langfuse only shows one rolled-up generation per Studio turn — and that one generation under-reports usage by ~4000× because it captures only the final SDK assistant message instead of every internal round. Without per-round visibility, no other lever in this spec can be measured for impact.

**Why this priority**: Measurement first. Every other story below claims a specific reduction; without P1 shipped we're optimizing blind and can't tell if any subsequent change actually helped.

**Independent Test**: After deploy, run `langfuse-cost-audit.ts --hours 1` against a freshly-completed Studio turn that the Anthropic console showed at ~70K input. The audit must report a sequence of N generations under one trace whose summed input matches the Anthropic console total within 5%. The Langfuse UI must render those N rounds as separate generation children of the parent `tuning-agent.query` span.

**Acceptance Scenarios**:

1. **Given** a 5-round Studio turn that the Anthropic console billed at 280K total input across rounds, **When** the audit script queries Langfuse for that trace, **Then** five generations appear with `roundIndex` 1 through 5 and summed input is 280K ± 14K.
2. **Given** the SDK transport is in use (default), **When** the agent fires a turn with 3 tool-use rounds, **Then** Langfuse shows three generations with monotonically increasing `roundIndex` and timestamps inside the parent span window.
3. **Given** the direct transport is in use (`BUILD_AGENT_DIRECT_TRANSPORT=true`), **When** the agent fires a turn with 4 rounds, **Then** the same per-round generation shape appears via the direct-transport bridge.
4. **Given** Langfuse is disabled (env vars missing), **When** the agent fires any turn, **Then** the agent runs to completion without errors (graceful no-op).

---

### User Story 2 - Default-concise tool returns (Priority: P1)

When the agent calls `studio_get_artifact` to peek at an SOP, FAQ, or system-prompt variant during edit triage, it should receive a head excerpt (~1-3K tokens) by default — not the full body (10-30K tokens). The agent only needs the full body when actually editing, which happens for a minority of turns. Today the `verbosity: 'concise' | 'detailed'` enum is declared in the schema but the handler ignores it, so every call returns full text.

**Why this priority**: Same priority as P1 measurement because this is the highest-leverage single fix — every TUNE turn that calls `get_artifact` saves 7-25K tokens per call, and most TUNE turns make 1-2 such calls during triage. Pairs with the measurement story to validate impact in the first 24h.

**Independent Test**: A TUNE turn that calls `studio_get_artifact(pointer)` with no verbosity parameter receives a return ≤1500 tokens regardless of the underlying artifact size. Calling again with `verbosity:'detailed'` returns the full body.

**Acceptance Scenarios**:

1. **Given** a system-prompt variant of 25,000 tokens, **When** the agent calls `studio_get_artifact(pointer)` with no verbosity parameter, **Then** the return is ≤1500 tokens and includes a head excerpt + section list + `fullCharLength` indicating the original size.
2. **Given** the same system-prompt variant, **When** the agent calls `studio_get_artifact(pointer, verbosity:'detailed')`, **Then** the return contains the full 25K-token body byte-for-byte.
3. **Given** an SOP body of 8,000 tokens, **When** the agent calls without verbosity, **Then** the return contains a 1200-character head excerpt and a `fullCharLength: 8000` marker.
4. **Given** a FAQ entry of 200 tokens, **When** the agent calls without verbosity, **Then** the return contains the full Q+A unchanged (no truncation needed for entries below the threshold).

---

### User Story 3 - Section-level drill-down on system prompts (Priority: P2)

When the agent decides a system-prompt edit is warranted (e.g., the screening rejection rules need rewording), it should be able to peek the section structure first (`mode:'index'` returns a section list with names + summaries + token counts), then fetch only the target section (`section:'<name>'` returns just that section's body). Today the only path is "fetch the whole 25K-token document", even when the agent only needs 500 tokens of it.

**Why this priority**: Compounds with P1 verbosity. P1 caps unintentional bloat; this story enables intentional precision when the agent does need to read content. Higher implementation cost than P1 (section extraction logic for SOPs which lack formal structure), so it's P2.

**Independent Test**: A TUNE turn that drills `studio_get_tenant_index → studio_get_artifact(mode:'index') → studio_get_artifact(section:'rejection_rules')` returns ≤2K tokens of tool output total for a system prompt the catalog says is 25K tokens.

**Hierarchy (clarified 2026-05-04)**: The catalog (`studio_get_tenant_index`) already carries each SOP/FAQ/system-prompt's **title + description** as metadata; that is the FIRST filter the agent uses to pick relevant artifacts. Section drill-down (`mode:'index'` / `section:'<name>'`) only applies once the agent has selected a specific artifact from the catalog. For SOPs without formal markdown structure, `mode:'index'` falls back to a single-section list with the SOP title (i.e., the agent re-uses the catalog metadata as the section name).

**Acceptance Scenarios**:

1. **Given** a system-prompt variant with 12 named sections, **When** the agent calls `studio_get_artifact(pointer, mode:'index')`, **Then** the return is ≤1500 tokens and lists each section's name, first-line summary, and token count.
2. **Given** the agent has already received the section list above, **When** it calls `studio_get_artifact(pointer, section:'rejection_rules')`, **Then** the return contains only that one section's body and the names of its previous and next neighbors.
3. **Given** the agent passes `section:'<unknown_name>'`, **When** the handler validates against the indexed section list, **Then** the return is an error naming the valid section names.
4. **Given** an SOP with no formal section structure (no `##`/`###` markdown headings), **When** the agent calls `studio_get_artifact(pointer, mode:'index')`, **Then** the return is a single-section list `[{name: <SOP title from catalog>, summary: <first 80 chars of body>, tokens, hashId}]` — no synthetic section invention. The agent should fall back to `verbosity:'concise'` for SOPs without structure, since drilling into a single fake section provides no additional precision.

---

### User Story 4 - Read-budget rules cap speculative reads (Priority: P2)

The agent currently fires 5-8 internal rounds per turn, often with 4-6 read-tool calls of which most return empty or trivial results (a real trace inspected via `langfuse-trace-detail.ts` showed 6 reads where 5 returned <100 chars). A prompt-level read budget — scoping=4, drafting=2, verifying=1 — caps speculative "let me check just in case" patterns and forces the agent to either respond or propose a transition once the budget is hit. Pairs with a "no speculative reads" rule under TUNE's edit-triage block: don't fetch artifact bodies until triage has produced a target.

**Why this priority**: Indirect savings. P1 and P3 reduce per-call bloat; this story reduces call count. The combination compounds.

**Independent Test**: Median reads-per-turn (counted via the audit script's per-trace span count) drops from ~3 in the baseline to ~2 within 24h post-deploy, without any regression in decision-quality eval cases.

**Acceptance Scenarios**:

1. **Given** a TUNE turn opens with a clearly wording-only edit (`<workflow>` rewording, no behavior change), **When** the agent triages, **Then** zero artifact bodies are fetched and the response is NO_FIX with witness_quote and reasonsNotToAct populated.
2. **Given** a BUILD turn in scoping state, **When** the agent has called 4 read tools, **Then** the next agent action is either a response to the operator or a `studio_propose_transition` call — not another read.
3. **Given** a turn in drafting state, **When** the agent has called 2 read tools, **Then** the next action is a write tool or a transition proposal.
4. **Given** the agent ignores the budget (model deviation), **When** the next read tool fires after the cap is exhausted, **Then** a PreToolUse warning hook logs a Langfuse span tag (`read_budget_exceeded: true`) and increments an observability counter — but the call is NOT blocked and the agent receives the normal tool response.

---

### User Story 5 - Slim default `studio_get_context` payload (Priority: P3)

`studio_get_context` returns a 7.8K-token payload by default, including conversation metadata, anchor message body, and several fields the agent rarely uses. Most turns only need anchor message text + last-edit summary. A `verbosity:'concise'` default that returns ≤2K tokens, with `verbosity:'detailed'` preserving the current shape, saves ~5K per turn that uses context.

**Why this priority**: Single-tool fix, smaller absolute savings than P1/P3 but cumulative across every turn since `get_context` is called on most turns.

**Independent Test**: After deploy, default `studio_get_context` returns ≤2K tokens. The trace inspector confirms the slim payload includes anchor + last edit + nothing else by default.

**Acceptance Scenarios**:

1. **Given** the agent calls `studio_get_context()` with no arguments, **When** the return lands, **Then** it is ≤2000 tokens and contains: anchor message text, last 3 inbox messages, last edit summary.
2. **Given** the agent calls `studio_get_context(verbosity:'detailed')`, **When** the return lands, **Then** it matches the current 7.8K-token shape byte-for-byte (back-compat).
3. **Given** a turn that doesn't need conversation context, **When** the agent skips the call, **Then** Region C contains the same anchor data via the new `<conversation_anchor>` block (see Story 7).

---

### User Story 6 - Per-state tool allow-list compaction (Priority: P3)

All 19 Studio tools are currently registered for every turn in every state. The PreToolUse hook blocks disallowed calls at runtime, but the descriptions still ship in the cached tools block. Registering only the tools allowed in the current state + outer mode shrinks the tools block from ~5K to ~2-3K cached tokens — pure win because the cache stays warm and per-turn token count drops.

**Why this priority**: Stable savings on every turn, but the win is on cached tokens (already cheap at $0.30/M). P3 because the absolute dollar impact is smaller than P1/P3.

**Independent Test**: A turn in scoping state has a cached tools block of ≤3K tokens. A turn in drafting has ≤4K. The PreToolUse hook still catches disallowed calls as a backstop, verified by intentionally-misregistered test case.

**Acceptance Scenarios**:

1. **Given** the agent enters a turn in scoping state in TUNE mode, **When** the system prompt is assembled, **Then** the tools block contains only read tools and `studio_propose_transition` — no `studio_create_*` or `studio_suggestion`.
2. **Given** the agent enters a turn in drafting state in TUNE mode, **When** the system prompt is assembled, **Then** the tools block contains read tools + `studio_suggestion` + `studio_propose_transition` — no `studio_test_pipeline`.
3. **Given** the agent enters a turn in verifying state, **When** the system prompt is assembled, **Then** the tools block contains read tools + `studio_test_pipeline` only — no write tools.
4. **Given** a state transition mid-conversation, **When** the next turn begins, **Then** the new state's allow-list applies cleanly with no cache-invalidation cascade beyond the tools block itself.

---

### User Story 7 - Move stable context into Region C (stretch, Priority: P3)

The agent currently calls `studio_get_context` on most turns to retrieve anchor message text + recent edits. That's an entire round-trip for data the runtime knows up front. Pre-rendering this as a `<conversation_anchor>` block in Region C eliminates one round per turn. Pairs with Story 5's slim payload — `get_context` stays available as the escape hatch for the heavy fields.

**Why this priority**: Highest impact among the stretch levers but riskiest (changes Region C size + adds a server-side data fetch). Ship after Stories 1-6 land and measurement confirms savings.

**Independent Test**: After deploy, ≤30% of turns call `studio_get_context` (down from ~95%). Region C grows by ≤2K tokens.

**Acceptance Scenarios**:

1. **Given** a TUNE turn with a populated anchor message, **When** the system prompt is assembled, **Then** Region C contains a `<conversation_anchor>` block with the anchor message text and last-edit summary.
2. **Given** the agent has the anchor data in Region C, **When** it processes the turn, **Then** it does not call `studio_get_context` for the anchor data (verified by trace observation count).
3. **Given** a turn with no anchor (greenfield BUILD onboarding), **When** the system prompt is assembled, **Then** the `<conversation_anchor>` block is omitted.

---

### Edge Cases

- **What happens when `verbosity:'concise'` truncates mid-section?** The truncation marker explicitly tells the agent to call again with `verbosity:'detailed'`. No ambiguity.
- **What happens when an SOP has no formal section structure and the agent calls `mode:'index'`?** Fallback returns a single-section list with the SOP title as the section name.
- **What happens when the agent calls `studio_get_artifact` on a disabled SOP despite the `<disabled_artifacts>` rule?** The handler still returns the SOP body (no runtime block — same soft-cap pattern as the read budget). The PreToolUse warning hook attaches a `disabled_artifact_fetched: true` Langfuse span tag so the deviation is observable. If post-deploy data shows the rule is routinely ignored, we revisit hardening in a follow-up feature.
- **What happens when the read budget is exceeded?** Soft cap — the prompt rule is advisory. The PreToolUse warning hook logs a Langfuse span tag (`read_budget_exceeded: true`) and increments an observability counter so we can see the deviation in the audit script, but the call still completes normally. No runtime error to the agent. If post-deploy data shows the rule is routinely ignored, we revisit hardening the hook to a hard block in a future feature.
- **What happens during a state transition mid-turn under the new allow-list?** State transitions are agent-proposed and host-confirmed across a turn boundary, so the next turn after a transition picks up the new allow-list. No mid-turn reshuffling.
- **What happens when an existing trace from before the deploy is re-queried?** Old traces show old shape (single rolled-up generation). New traces show per-round breakdown. No retroactive backfill.
- **What happens when the agent's process crashes mid-turn (after round 3 of 5)?** Rounds 1-3 are already in Langfuse via live emit. Rounds 4-5 never fire. The trace shows three child generations; the parent `tuning-agent.query` span ends with whatever close-mechanism the crash path provides. Audit scripts treat any trace with fewer rounds than the operator's `messages.create` count as evidence of a partial run.
- **What happens when the SDK and direct-transport paths report different round counts for the same logical turn?** Both should produce the same per-round breakdown by design. Discrepancy means a bug in one bridge — caught by the integration test that exercises both transports against the same fixture.
- **What happens when a deferred lever (compress old tool returns via PreCompact hook) breaks the agent's reasoning?** Won't ship in this feature; tracked as future work pending an SDK-hook spike.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST capture and report per-round token usage to Langfuse for every Studio agent turn, including `roundIndex`, fresh input tokens, output tokens, cache_read tokens, and cache_creation tokens. Each round's generation MUST be emitted live — at the moment that round's SDK assistant message arrives with usage, inside the `for await` loop — not batched at end-of-query. Each generation carries its own start/end timestamps matching the actual round window. No top-level rolled-up summary generation is emitted; audit scripts sum across per-round generations.
- **FR-002**: System MUST honor the `verbosity` parameter in `studio_get_artifact` such that `'concise'` (default) returns a head excerpt + section list and `'detailed'` returns the full body.
- **FR-003**: System MUST accept a `mode:'index'` parameter in `studio_get_artifact` that returns the artifact's section structure (names, summaries, token counts) without body text.
- **FR-004**: System MUST accept a `section:'<name>'` parameter in `studio_get_artifact` that returns only the named section's body, validating the name against the artifact's known sections and rejecting unknown names.
- **FR-005**: System MUST include a `<read_budget>` block in the cached system prompt naming the per-state read caps (scoping=4, drafting=2, verifying=1) AND MUST register a PreToolUse warning hook that, when a read tool fires after the per-state cap is exhausted, attaches a `read_budget_exceeded: true` tag to the active Langfuse span and increments an observability counter without blocking the call. The hook is observation-only — it never returns an error to the agent.
- **FR-006**: System MUST include a `<no_speculative_reads>` rule in TUNE mode's edit-triage block forbidding artifact body fetches before triage has produced a target.
- **FR-006a**: System MUST include a `<disabled_artifacts>` rule in TUNE mode's edit-triage block stating: "Disabled SOPs (catalog `status: 'disabled'`) are informational only. Do not fetch their bodies via `studio_get_artifact`, do not propose edits to them, and do not propose re-enabling them unless the operator explicitly asks." `studio_get_tenant_index` continues to surface disabled SOPs with their existing tag — they remain visible for triage context.
- **FR-007**: System MUST honor `verbosity` in `studio_get_context` such that the default returns ≤2000 tokens and `'detailed'` preserves the current 7.8K-token shape.
- **FR-008**: System MUST register only the tools allowed in the current state + outer mode at agent query time, while preserving the PreToolUse hook as a runtime backstop.
- **FR-009** (stretch): System MUST render anchor message text and last-edit summary as a `<conversation_anchor>` block in Region C when the conversation has an anchor message id.
- **FR-010**: System MUST not regress on four named decision-quality eval cases, codified as automated `node:test` integration tests at `backend/src/build-tune-agent/__tests__/decision-quality.test.ts`. The four cases are: (1) gender→family/friends edit → asserts `category === 'NO_FIX'` and `editType === 'FRAMING_TONE'`, (2) screening preferences memory recall → asserts `consultedMemoryKeys` contains the relevant `preferences/no-sop-for-screening` key when present in the memory snapshot, (3) witness_quote presence → asserts `witness_quote` is a non-empty string for every non-NO_FIX category, (4) three-field self_report → asserts the response on a critique-request message contains `weakest_inference`, `most_fragile_assumption`, and `preferred_alternative_classification` named fields. Each test stubs the LLM call with a recorded canonical response. CI runs them on every PR and they are hard-required to pass before merge. No live LLM calls in CI; tests run in <2s and cost $0.
- **FR-011**: System MUST degrade gracefully when Langfuse is disabled — observability code is no-op and agent runs unaffected.
- **FR-012**: System MUST emit per-round generations on both the SDK transport (default) and the direct transport (`BUILD_AGENT_DIRECT_TRANSPORT=true`) with byte-equivalent shape.

### Key Entities

- **Round**: One internal `messages.create` call inside an SDK query. Identified by `roundIndex` (1..N) under a parent `tuning-agent.query` span. Carries its own input/output/cache token counts.
- **Section index**: Metadata-only projection of an artifact: `[{name, summary, tokens, hashId}]`. Returned by `mode:'index'`. Section `hashId` is HMAC-signed to prevent the agent from forging section names.
- **Verbosity**: Enum `'concise' | 'detailed'`. Default for read tools is `'concise'`. Tool descriptions explicitly state when each is appropriate.
- **Read budget**: Per-state cap on read-tool calls before the agent must respond or transition. Prompt-level only, no runtime enforcement.
- **Allow-list**: The set of tools registered for a given state + outer mode combination. Smaller than the full 19-tool surface.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Median per-round input tokens drop from ~50K to ≤30K within 7 days of all stories landing.
- **SC-002**: P90 per-round input tokens drop from ~70K to ≤45K within 7 days.
- **SC-003**: Median rounds-per-turn drop from ~5 to ≤3, max from 8+ to ≤6.
- **SC-004**: Cache hit rate rises from 57.8% to ≥75%.
- **SC-005**: Median per-turn cost (Sonnet 4.6) drops from ~$0.08-0.10 to ≤$0.03.
- **SC-006**: Studio sessions no longer hit the 450K/min Anthropic rate limit during normal triage activity (defined as 0 rate-limit errors in 24h of representative usage).
- **SC-007**: Decision-quality eval suite (the 4 automated tests at `backend/src/build-tune-agent/__tests__/decision-quality.test.ts` per FR-010) passes at 100% in CI on every PR. A PR with any failing eval test cannot merge.
- **SC-008**: Reverting any single PR via `git revert` returns per-turn behavior to the previous PR's baseline within one deploy cycle, with no DB migration required.

## Implementation sequencing *(non-mandatory but recommended)*

PRs are sequenced so each is independently shippable and revertable, and so measurement (Story 1) lands first.

| PR | Story | Levers covered |
|---|---|---|
| 1 | Story 1 | Per-round Langfuse generation emit (SDK + direct transports) |
| 2 | Story 2 | `verbosity:'concise'` honored in `get_artifact` |
| 3 | Story 3 | `mode:'index'` + `section:'<name>'` on `get_artifact` |
| 4 | Story 4 | `<read_budget>` + `<no_speculative_reads>` prompt rules |
| 5 | Story 5 | Slim `get_context` default payload |
| 6 | Story 6 | Per-state tool allow-list compaction |
| 7 | Story 7 (stretch) | `<conversation_anchor>` Region C block |

After PR 5 we should be at the SC-001..SC-005 targets. PRs 6-7 are stretch.

## Open questions for `/speckit.plan`

1. **Section extraction heuristic for SOPs.** SOPs aren't formally section-divided like system prompts. The plan needs to pick a pragmatic heuristic (markdown headings, paragraph splits, or single-section fallback) for `mode:'index'` to surface SOP structure.
2. **Cache breakpoint behavior under per-state tool registration.** Anthropic supports 4 cache breakpoints; we use 3 system + 1 messages. Per-state tool changes invalidate the tools-block cache. The plan needs to confirm the per-state allow-list doesn't cascade cache invalidation beyond the tools block itself.
3. **PreCompact hook investigation (deferred lever — compress old tool_result blocks).** The riskiest stretch lever depends on whether the SDK exposes a usable PreCompact hook in v0.2.109. Spike before scoping a future feature.

## Related work (out of scope here)

- **Sonnet 4.6 vs GPT-5.4 model choice.** Independent research thread; the measurement infrastructure shipped in Story 1 is the prerequisite for that decision having real per-model cost numbers.
- **Reply-pipeline cache hit rate.** Audit reports the GPT-5.4-mini reply pipeline ("Omar") at 0% cache hit. Separate sprint; same techniques (cache markers, slim system prompt) but different transport.
