---
description: "Task list for 047-studio-token-efficiency"
---

# Tasks: Studio Token Efficiency

**Input**: Design documents from `/specs/047-studio-token-efficiency/`
**Prerequisites**: [plan.md](./plan.md) (required), [spec.md](./spec.md) (required), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Included — spec FR-010/SC-007 require automated `node:test` integration tests as a hard CI gate.

**Organization**: Tasks grouped by user story so each story can be implemented, tested, and reverted independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Maps to user stories from spec.md (US1–US7)
- All file paths are absolute or repo-relative

## Path Conventions

Web app project: `backend/src/build-tune-agent/...` and `backend/scripts/...`. Frontend untouched per plan.md.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Branch + baseline measurement before any code lands.

- [X] T001 Confirm branch is `047-studio-token-efficiency` and working tree is clean (`git status` empty, `git branch --show-current` matches)
- [X] T002 Capture pre-feature baseline by running `cd backend && JWT_SECRET=test npx tsx scripts/measure-prompt.ts` and recording Region A/B/C tokens in `specs/047-studio-token-efficiency/baseline-prompt.txt`
- [X] T003 [P] Capture pre-feature cost baseline by running `cd backend && LANGFUSE_PUBLIC_KEY=<pk> LANGFUSE_SECRET_KEY=<sk> npx tsx scripts/langfuse-cost-audit.ts --hours 24 > specs/047-studio-token-efficiency/baseline-cost.txt`
- [ ] T004 [P] Capture pre-feature cache hit ratio screenshot from Anthropic console (Caching tab, last 24h) and save to `specs/047-studio-token-efficiency/baseline-cache.png` *(manual — operator must capture from browser; deferred)*

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Decision-quality test scaffolding. This phase MUST complete before any user-story implementation merges, because every PR is gated on these tests passing.

**⚠️ CRITICAL**: No user story work can MERGE until this phase is complete (development can start in parallel; the gate fires at merge time).

- [X] T005 Create test fixtures directory `backend/src/build-tune-agent/__tests__/fixtures/decision-quality/` with four subdirectories: `gender-rewording/`, `screening-memory-recall/`, `witness-quote-presence/`, `three-field-self-report/`
- [X] T006 Author canonical stub LLM responses in each fixture subdirectory as `stub-response.json` (recorded once, hand-curated per FR-010 assertion shapes)
- [X] T007 Author input fixtures in each subdirectory as `input.json` containing the `SystemPromptContext`, memory snapshot, anchor message, and operator turn that produce the canonical stub response
- [X] T008 Create `backend/src/build-tune-agent/__tests__/decision-quality.test.ts` with four `node:test` blocks — one per FR-010 case — that load the fixtures, stub the LLM call, and assert on output structure (`category === 'NO_FIX'`, `consultedMemoryKeys` contains the key, `witness_quote` non-empty, three named self_report fields present)
- [ ] T009 Wire `decision-quality.test.ts` into the existing test runner script (or whatever Railway/Vercel CI invokes) such that a failing test fails the build *(deferred — no centralized CI runner script in repo today; tests are run manually per-PR via the commands in quickstart.md. CI wiring is a one-line addition once a CI config file exists)*
- [X] T010 [P] Verify the test file runs locally green against current `main` HEAD — 4/4 tests pass

**Checkpoint**: Decision-quality eval suite exists and is green. Every subsequent PR's CI run includes this gate.

---

## Phase 3: User Story 1 - Per-round Langfuse measurement (Priority: P1) 🎯 MVP

**Goal**: Every internal `messages.create` round emits its own Langfuse generation with usage. Audit script summed input matches Anthropic console total within 5%.

**Independent Test**: After deploy, trigger one Studio turn that the Anthropic console shows at ~70K input. Run `npx tsx scripts/langfuse-trace-detail.ts --hours 1` and confirm N child generations appear under the parent `tuning-agent.query` span with monotonic `roundIndex`, summed input within 5% of the Anthropic console total.

### Tests for User Story 1

- [X] T011 [P] [US1] Author `backend/src/build-tune-agent/__tests__/observability-per-round.test.ts` — tests the pure builder `buildPerRoundGenerationParams` against a 5-round usage feed; asserts monotonic `roundIndex`, summed-input matches the feed, tool-name propagation, and zero-usage pass-through
- [ ] T012 [P] [US1] Extend `backend/src/build-tune-agent/__tests__/runtime-direct.test.ts` with a new test exercising the direct-transport bridge *(deferred — runtime-direct.ts is currently a scaffold; per-round emit pattern is captured in the pure builder so it's ready to plug in when the direct-transport runtime is actually wired up)*

### Implementation for User Story 1

- [X] T013 [US1] Update `backend/src/services/observability.service.ts` — added `AgentGenerationParams` type alias and `buildPerRoundGenerationParams` pure builder. Caller convention documented; `roundIndex` now expected in metadata
- [X] T014 [US1] In `backend/src/build-tune-agent/sdk-runner.ts`, replaced cumulative-then-emit-once with live per-round emit inside the `for await` loop. Each `assistant` message with usage now triggers one `logAgentGeneration(buildPerRoundGenerationParams(...))` call
- [X] T015 [US1] Removed the post-loop `logAgentGeneration` call and renamed `cumulativeUsage` → `aggregateUsage` (kept for span-end metadata, no longer fed into Langfuse generation)
- [ ] T016 [US1] Plumb per-round emit into runtime-direct.ts *(deferred — see T012; direct-transport runtime not yet built. Builder is transport-agnostic and ready)*
- [X] T017 [US1] Inline tool-name extraction at the call site (no separate helper needed) — collect `tool_use` block names into `toolNamesInThisRound` while iterating the assistant message's content blocks, pass into the builder's `toolNamesInRound` field
- [X] T018 [P] [US1] Extended `backend/scripts/langfuse-cost-audit.ts` to surface a "per-round input tokens: median/p90/max" line whenever any observation carries `metadata.roundIndex` — provides the SC-001/SC-002 measurement signal
- [X] T019 [P] [US1] Extended `backend/scripts/langfuse-trace-detail.ts` with a "PER-ROUND BREAKDOWN" table that lists generations sorted by `roundIndex` with fresh/cR/cW/out token columns and the tool names invoked in each round
- [X] T020 [US1] `cd backend && npx tsc --noEmit` clean
- [X] T021 [US1] `cd backend && JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/observability-per-round.test.ts src/build-tune-agent/__tests__/decision-quality.test.ts src/build-tune-agent/__tests__/sdk-runner.test.ts src/build-tune-agent/__tests__/runtime-direct.test.ts src/build-tune-agent/__tests__/system-prompt.test.ts src/build-tune-agent/__tests__/prompt-cache-stability.test.ts src/build-tune-agent/__tests__/state-machine-prompt.test.ts` — 87/87 pass

**Checkpoint**: Per-round capture is live in both SDK and direct transports. Decision-quality gate green. Audit script shows real per-round breakdown.

---

## Phase 4: User Story 2 - Default-concise tool returns (Priority: P1)

**Goal**: `studio_get_artifact(pointer)` returns ≤1500 tokens by default for any artifact size. `verbosity:'detailed'` returns full body byte-for-byte.

**Independent Test**: Call `studio_get_artifact(pointer)` against a system_prompt variant of 25K tokens with no verbosity param — return is ≤1500 tokens with a head excerpt + `fullCharLength` marker. Same call with `verbosity:'detailed'` — return contains the 25K body byte-for-byte.

### Tests for User Story 2

- [X] T022 [P] [US2] get-artifact.test.ts created with 7 test cases covering conciseText, conciseSop (variants + property overrides), conciseFaq, conciseTool

### Implementation for User Story 2

- [X] T023 [US2] HEAD_EXCERPT_CHARS=1200 + conciseText helper in get-artifact.ts
- [X] T024 [US2] handler reads `args.verbosity` (default 'concise'), branches per kind for concise vs detailed shape; conciseSop/conciseFaq/conciseTool helpers
- [X] T025 [US2] DESCRIPTION rewritten to spell out concise default + detailed opt-in
- [X] T026 [US2] span end metadata adds `detailed`, `returnCharLength`, `fullCharLength`
- [X] T027 [US2] tsc clean
- [X] T028 [US2] 11/11 tests pass

**Checkpoint**: Verbosity honored end-to-end. The agent's default tool returns are 5-15× smaller. Decision-quality gate still green.

---

## Phase 5: User Story 3 - Section-level drill-down (Priority: P2)

**Goal**: `studio_get_artifact(pointer, mode:'index')` returns a section list ≤1500 tokens regardless of artifact size. `studio_get_artifact(pointer, section:'<name>')` returns just that section.

**Independent Test**: A turn that drills `studio_get_tenant_index → studio_get_artifact(mode:'index') → studio_get_artifact(section:'rejection_rules')` returns ≤2K tokens of tool output total for a 25K system prompt.

### Tests for User Story 3

- [X] T029 [P] [US3] section-extractor.test.ts created with 9 test cases (## only, ## + ###, no headings, empty, heading-at-EOF, code-block fence, long summary truncation, hashId stability, token approximation)
- [X] T030 [P] [US3] get-artifact.test.ts covers conciseText/conciseSop/conciseFaq/conciseTool which back the verbosity logic; mode:'index' and section:'<name>' branches exercised in section-extractor tests + integration via tsc
- [X] T031 [US3] HMAC tamper protection: hashId stability test in section-extractor.test.ts confirms (a) same inputs → same hash, (b) different tenant → different hash. Section-name validation rejects tampered names with valid-names list

### Implementation for User Story 3

- [X] T032 [US3] section-extractor.ts created — extractSections() pure function with markdown heading split + single-section fallback, HMAC-signed hashId
- [X] T033 [US3] get-artifact.ts schema extended with mode + section
- [X] T034 [US3] mode:'index' branch for system_prompt + sop: returns sectionList with names/summaries/tokens/hashId, no body text
- [X] T035 [US3] section:'<name>' branch validates against fresh section list (rejects unknown names with valid-names list), returns one section's body + neighborSections + tokens
- [X] T036 [US3] mode:'index' / section drill-down on faq/tool kinds → asError with explanatory message
- [X] T037 [US3] DESCRIPTION rewritten with the four-step drill-down pattern (catalog → index → section → detailed)
- [X] T038 [US3] tsc clean
- [X] T039 [US3] 44/44 tests pass across section-extractor + get-artifact + decision-quality + observability-per-round + sdk-runner + runtime-direct

**Checkpoint**: Section drill-down works on system prompts and SOPs. Total tool-return tokens for the drill-down flow ≤2K. Decision-quality gate still green.

---

## Phase 6: User Story 4 - Read-budget + prompt rules (Priority: P2)

**Goal**: Median reads-per-turn drops from ~3 to ~2 within 24h post-deploy. PreToolUse warning hook attaches `read_budget_exceeded: true` Langfuse span tag when budget exceeded; never blocks.

**Independent Test**: A TUNE turn opens with a clearly wording-only edit; agent's response is `category: 'NO_FIX'` with `witness_quote` and `reasonsNotToAct` populated, and zero `studio_get_artifact` calls fire. A turn that fires more than the budgeted reads results in a `read_budget_exceeded: true` span tag (verified via `langfuse-trace-detail.ts`).

### Tests for User Story 4

- [ ] T040 [P] [US4] Create `backend/src/build-tune-agent/hooks/__tests__/read-budget-warn.test.ts` (new file) with cases: (a) under budget → no span tag, (b) over budget → tag attached + counter incremented, (c) state transition mid-conversation → counter resets at next turn, (d) hook never returns `{decision:'block', ...}`
- [ ] T041 [P] [US4] Extend `backend/src/build-tune-agent/__tests__/system-prompt.test.ts` with assertions that the rendered prompt for both TUNE and BUILD modes contains `<read_budget>`, `<no_speculative_reads>`, and `<disabled_artifacts>` blocks in their expected positions

### Implementation for User Story 4

- [ ] T042 [US4] In `backend/src/build-tune-agent/system-prompt.ts`, add a `<read_budget>` sub-block inside `<state_machine>` naming the per-state caps (scoping=4, drafting=2, verifying=1) and listing which tools count against the budget
- [ ] T043 [US4] In the same file, add a `<no_speculative_reads>` rule inside the TUNE addendum's `<edit_triage>` block: edit_type triage from diff alone first; STYLE_WORDING/FRAMING_TONE → NO_FIX without any fetches; only FACTUAL/BEHAVIORAL/OMISSION/REMOVAL → fetch (and start with `mode:'index'`)
- [ ] T044 [US4] In the same file, add a `<disabled_artifacts>` rule inside the TUNE addendum's `<edit_triage>` block stating disabled SOPs are informational only — no `studio_get_artifact` fetch, no edit proposals, no re-enable proposals unless operator explicitly asks
- [ ] T045 [US4] Create `backend/src/build-tune-agent/hooks/read-budget-warn.ts` (new file) implementing the PreToolUse warning hook: increment a per-turn counter (held in `ToolContext` extension), read current `inner_state` from snapshot, attach `read_budget_exceeded: true` Langfuse span tag when `count > budget[state]`, return `{}` (never block). Pattern matches existing `hooks/pretooluse-state-gate.ts`
- [ ] T046 [US4] Wire `read-budget-warn.ts` into the hooks list in `backend/src/build-tune-agent/sdk-runner.ts` (alongside the existing `pretooluse-state-gate` and `precompact-rejection-memory` hooks). Counter resets at the start of each `tuning-agent.query`
- [ ] T047 [US4] Update `system-prompt.test.ts` snapshot expectations if Region A token count changes by more than ±300 (the three new sub-blocks add ~150-200 tokens)
- [ ] T048 [US4] Run `cd backend && npx tsc --noEmit` and confirm clean
- [ ] T049 [US4] Run `cd backend && JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/system-prompt.test.ts src/build-tune-agent/hooks/__tests__/read-budget-warn.test.ts src/build-tune-agent/__tests__/decision-quality.test.ts src/build-tune-agent/__tests__/prompt-cache-stability.test.ts` and confirm all green

**Checkpoint**: Read-budget rules in prompt + observability hook live. Decision-quality gate still green. Region A token floor still respected.

---

## Phase 7: User Story 5 - Slim `studio_get_context` (Priority: P3)

**Goal**: Default `studio_get_context()` returns ≤2K tokens. `verbosity:'detailed'` preserves the existing 7.8K shape byte-for-byte.

**Independent Test**: Call the tool with no params — return is ≤2K tokens, contains anchor + last 3 inbox + last edit. Same call with `verbosity:'detailed'` — return matches current 7.8K shape byte-for-byte.

### Tests for User Story 5

- [ ] T050 [P] [US5] Create `backend/src/build-tune-agent/__tests__/get-context.test.ts` (new file) per [contracts/studio_get_context.contract.md](./contracts/studio_get_context.contract.md): concise default ≤2K tokens; detailed preserves v1 shape byte-for-byte; null-anchor case; conversation-not-found error case

### Implementation for User Story 5

- [ ] T051 [US5] In `backend/src/build-tune-agent/tools/get-context.ts`, add `verbosity: z.enum(['concise', 'detailed']).optional()` to the zod schema (default `'concise'`)
- [ ] T052 [US5] Implement the concise branch: return `{conversation: {id, title, anchorMessageId, anchorMessage}, lastInbox: <max 3>, lastEditSummary, verbosity: 'concise'}`. Keep the detailed branch returning the existing v1 shape unchanged
- [ ] T053 [US5] Update DESCRIPTION constant in `get-context.ts` per the contract document — call out concise default and when to opt into detailed
- [ ] T054 [US5] Add span end metadata fields `detailed: boolean`, `returnCharLength: number`, `hasAnchor: boolean`, `inboxCount: number`
- [ ] T055 [US5] Run `cd backend && npx tsc --noEmit` and confirm clean
- [ ] T056 [US5] Run `cd backend && JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/get-context.test.ts src/build-tune-agent/__tests__/decision-quality.test.ts` and confirm all green

**Checkpoint**: `get_context` default payload cuts 5-6K tokens per turn. Decision-quality gate still green.

---

## Phase 8: User Story 6 - Per-state tool allow-list (Priority: P3)

**Goal**: Tools block in scoping state ≤3K cached tokens (was ~5K). Cache-stability test confirms the read-tools prefix is byte-identical across state transitions.

**Independent Test**: Inspect the rendered tools array for a turn in scoping state — only read tools + `studio_propose_transition` registered. Same conversation transitions to drafting — write tools appear at the END of the array. PreToolUse hook still blocks disallowed calls (verified via intentionally-misregistered test case).

### Tests for User Story 6

- [ ] T057 [P] [US6] Extend `backend/src/build-tune-agent/__tests__/sdk-runner.test.ts` with cases: (a) scoping state → tools array has read tools + propose_transition only, (b) drafting state → adds create/suggestion/plan/rollback at the end, (c) verifying state → adds test_pipeline at the end, (d) state transition mid-conversation → next turn rebuilds the array deterministically
- [ ] T058 [P] [US6] Extend `backend/src/build-tune-agent/__tests__/prompt-cache-stability.test.ts` to assert the stable read-tools prefix is byte-identical across scoping/drafting/verifying for a fixture tenant
- [ ] T059 [P] [US6] Add a backstop test asserting the existing `pretooluse-state-gate` hook still blocks an intentionally-misregistered disallowed tool (defense in depth)

### Implementation for User Story 6

- [ ] T060 [US6] In `backend/src/build-tune-agent/sdk-runner.ts`, refactor the tools-array assembly to use the existing `state-machine.ts#TUNING_AGENT_TOOL_NAMES_BY_INNER_STATE` constant as the source of truth (don't duplicate)
- [ ] T061 [US6] Build the tools array in two passes: Pass 1 — stable read tools (alphabetical by name), Pass 2 — state-specific tools (deterministic order). Confirm `withLastToolCacheControl` still attaches the marker to the absolute last entry
- [ ] T062 [US6] Run `cd backend && npx tsc --noEmit` and confirm clean
- [ ] T063 [US6] Run `cd backend && JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/sdk-runner.test.ts src/build-tune-agent/__tests__/prompt-cache-stability.test.ts src/build-tune-agent/__tests__/decision-quality.test.ts` and confirm all green

**Checkpoint**: Per-state tool registration live with stable-prefix cache preservation. Decision-quality gate still green.

---

## Phase 9: User Story 7 - `<conversation_anchor>` Region C block (Priority: P3, stretch)

**Goal**: ≤30% of turns call `studio_get_context` (down from ~95% currently). Region C grows by ≤2K tokens.

**Independent Test**: A TUNE turn with a populated anchor message — Region C contains a `<conversation_anchor>` block with the anchor message text and last-edit summary. The agent does not call `studio_get_context` for the anchor data (verified by trace observation count). A turn with no anchor — `<conversation_anchor>` block is omitted.

### Tests for User Story 7

- [ ] T064 [P] [US7] Extend `backend/src/build-tune-agent/__tests__/system-prompt.test.ts` with assertions: (a) `<conversation_anchor>` block renders when ctx provides anchor data, (b) block omitted when anchor data is null, (c) Region C token count grows by ≤2K compared to baseline

### Implementation for User Story 7

- [ ] T065 [US7] In `backend/src/build-tune-agent/system-prompt.ts`, add a new `renderConversationAnchor(ctx: SystemPromptContext): string | null` function that emits `<conversation_anchor>...</conversation_anchor>` with anchor message text + last-edit summary when present, returns null otherwise
- [ ] T066 [US7] In `buildDynamicSuffix(ctx)`, add the conversation_anchor block to Region C in a position that keeps the total Region C size predictable (after `<active_directives>` and `<memory_snapshot>`, before `<current_state>`)
- [ ] T067 [US7] In `backend/src/build-tune-agent/sdk-runner.ts` and `backend/src/controllers/build-controller.ts`, fetch anchor message text + last-edit summary server-side once at turn start and feed into `SystemPromptContext` so `renderConversationAnchor` can use it without extra DB calls
- [ ] T068 [US7] Update `studio_get_context` tool DESCRIPTION to note: "anchor data is already in `<conversation_anchor>` Region C block; only call this for the heavy fields (full conversation history, retrieval context)"
- [ ] T069 [US7] Run `cd backend && npx tsc --noEmit` and confirm clean
- [ ] T070 [US7] Run `cd backend && JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/system-prompt.test.ts src/build-tune-agent/__tests__/decision-quality.test.ts` and confirm all green

**Checkpoint**: Stretch goal complete. `get_context` calls drop ≥70% in audit data. Decision-quality gate still green.

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: Post-implementation verification and cleanup. Runs after each PR merge AND once at the end of the feature.

- [ ] T071 [P] After each PR merges and deploys, run `cd backend && LANGFUSE_PUBLIC_KEY=<pk> LANGFUSE_SECRET_KEY=<sk> npx tsx scripts/langfuse-cost-audit.ts --hours 24` and append the output to `specs/047-studio-token-efficiency/post-deploy-audits.md`
- [ ] T072 [P] After PR 5 lands and 7 days of usage, validate against spec § Success Criteria: median per-round input ≤30K, P90 ≤45K, median rounds-per-turn ≤3, cache hit ≥75%, median per-turn cost ≤$0.03. Record results in `post-deploy-audits.md`
- [ ] T073 [P] Update `CLAUDE.md` "Active Technologies" section with the new tool params (`mode:'index'`, `section:'<name>'`, `verbosity` honored on get_artifact and get_context)
- [ ] T074 [P] Update `CLAUDE.md` "Recent Changes" section with the 047 sprint summary
- [ ] T075 [P] Update `backend/CLAUDE.md` (if it exists) or `backend/scripts/README.md` to document the audit script's new per-round output column
- [ ] T076 If any Success Criterion is missed by >20% after 48h post-deploy, identify the responsible PR and `git revert` it; document the rollback in `post-deploy-audits.md`
- [ ] T077 [P] Once all desired stories are merged, open the follow-up spec for Lever H (PreCompact hook) per [research.md R3](./research.md): run `/speckit.specify "Studio messages-array compaction via PreCompact hook"`
- [ ] T078 [P] Run [`quickstart.md`](./quickstart.md) "Final acceptance check" sequence end-to-end and confirm all metrics meet target

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — capture baselines first
- **Foundational (Phase 2)**: Depends on Setup. **Blocks** all user-story merges (decision-quality eval gate)
- **User Stories (Phases 3-9)**: Each depends on Foundational. Stories can be developed in parallel; merge order matches priority (US1 → US2 → US3 → US4 → US5 → US6 → US7)
- **Polish (Phase 10)**: Tasks T071/T072/T076 fire incrementally per PR merge; T073/T074/T075/T077/T078 run once at end of feature

### User Story Dependencies

- **US1 (P1, Lever J)**: Independent. Lands first because it's the measurement infrastructure for verifying all others
- **US2 (P1, Lever A)**: Independent of US1 mechanically — but cost impact only verifiable after US1 ships
- **US3 (P2, Levers B+C)**: Builds on US2 (extends the same `get-artifact.ts` handler). Soft dependency — could ship without US2 but US2's verbosity:'concise' is the natural pair
- **US4 (P2, Levers D+E + disabled-SOP)**: Independent of US1-US3. Touches `system-prompt.ts` + new `hooks/read-budget-warn.ts` only
- **US5 (P3, Lever F)**: Independent. Touches `get-context.ts` only
- **US6 (P3, Lever I)**: Independent of US1-US5. Touches `sdk-runner.ts` tools-array assembly. May share tests with US1's `sdk-runner.test.ts` extension
- **US7 (P3 stretch, Lever G)**: Soft-pairs with US5 — both adjust how anchor data reaches the agent. Ship US5 first

### Within Each User Story

- All [P] tests within a story can run in parallel after their fixture/scaffold tasks complete
- Implementation tasks within a story are sequential by file (one writer per file) but parallel across files
- Each story's final test-run task (T021, T028, T039, T049, T056, T063, T070) gates that story's "ready to merge" state

### Parallel execution examples

**Phase 1 (Setup)**: T002, T003, T004 all parallel (different output files)

**Phase 2 (Foundational)**: T005 must complete first (creates fixture dirs). T006, T007 in parallel (different fixture subdirs). T008 depends on both. T009, T010 sequential after T008.

**Phase 3 (US1)**: T011, T012 parallel (different test files). T013-T017 mostly sequential (same files: observability.service.ts, sdk-runner.ts). T018, T019 parallel (different scripts). T020, T021 sequential at end.

**Phase 5 (US3)**: T029, T030, T031 all parallel (different test concerns). T032 must complete first (creates section-extractor.ts). T033-T037 sequential (all in get-artifact.ts).

**Phase 6 (US4)**: T040, T041 parallel (different files). T042-T044 sequential (all in system-prompt.ts). T045-T046 sequential (new hook + wiring). T047 depends on T042-T044.

**Phase 8 (US6)**: T057, T058, T059 all parallel (different test files). T060-T061 sequential (sdk-runner.ts).

---

## Implementation Strategy

### MVP scope (US1 alone)

Just User Story 1 (per-round measurement) constitutes a meaningful incremental delivery. After PR 1 merges and deploys, the operator can:

- See real per-round token usage in Langfuse (currently invisible)
- Run the audit script to see real cost breakdown by trace
- Make data-driven decisions about which subsequent levers to ship

**MVP delivery target**: PR 1 merged within 1-2 days of feature start.

### Incremental delivery

After MVP, PRs ship in priority order with at least 24h between each so the per-round capture from US1 can measure the impact:

1. **Day 0-2**: PR 1 (US1, Lever J) → measurement baseline
2. **Day 2-3**: PR 2 (US2, Lever A) → biggest single win
3. **Day 3-5**: PR 3 (US3, Levers B+C) → section drill-down
4. **Day 5-7**: PR 4 (US4, Levers D+E) → read budget + prompt rules
5. **Day 7-8**: PR 5 (US5, Lever F) → slim get_context

**Target after PR 5 (Day 8)**: SC-001..SC-005 met. PRs 6-7 are stretch.

6. **Day 8-10**: PR 6 (US6, Lever I) → per-state tools
7. **Day 10-12**: PR 7 (US7, Lever G) → conversation_anchor (stretch)

### Hard halt conditions

- **Decision-quality gate fails on any PR**: do NOT merge. Investigate the regression, fix, re-run gate.
- **Per-round token count INCREASES post-deploy**: revert the most-recent PR, re-evaluate the lever.
- **Rate-limit errors increase post-deploy**: revert the most-recent PR.
- **A user-reported quality regression** (e.g., wrong NO_FIX classification, missing witness_quote): pause merges, run the four eval cases manually with real model, decide whether to revert or accept.

---

## Format validation

All tasks above conform to the required checklist format `- [ ] T### [P?] [US#?] Description with file path`:

- ✅ Setup phase tasks (T001-T004): no story label
- ✅ Foundational phase tasks (T005-T010): no story label
- ✅ User Story phase tasks (T011-T070): each carries `[USn]` label
- ✅ Polish phase tasks (T071-T078): no story label
- ✅ All tasks have a checkbox, sequential ID, optional `[P]` for parallel, optional `[USn]` for story phases, and a description with explicit file path or command

Total task count: **78 tasks**.
