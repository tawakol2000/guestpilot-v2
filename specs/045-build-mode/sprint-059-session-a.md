# Sprint 059 — Session A — F1 Runtime Transport Swap + MCP Reproduction (+ F9a React #310 root-cause)

**Branch:** `feat/059-session-a` (stacks on `feat/058-session-a` → 057 → 056 → 055 → 054 → 053 → 052 → 051 → 050 → main)
**Parent tip expected:** `48d022b` (tip of `feat/058-session-a` after 058-A nine-gate close-out). Verify with `git rev-parse feat/058-session-a` at session start.
**Session type:** A — overnight run on **Opus 4.7 with 1M context**. Backend-heavy; one surgical frontend pass for F9a. No schema changes.
**Brainstorm §:** 058 NEXT.md candidate A, spec §6 MCP-risk carve-out, 058 deferred F9a root-cause.
**Length discipline:** **one primary gate (F1) broken into six contract-tested sub-gates, plus F9a ride-along as a seventh.** Seven sub-gates total. Three streams, dispatched in a single message. Do not serialize.

---

## 0. Why this sprint exists

Sprint 058 shipped the F1 scaffold — `buildDirectMessagesCreateParams()` is unit-tested, the block-array system + cache_control markers are correct, the env flag `BUILD_AGENT_DIRECT_TRANSPORT` exists. What did **not** ship is the runtime actually using it. Every BUILD turn still routes through the Claude Agent SDK's `query()` call, which accepts `systemPrompt` as a bare string (no cache_control breakpoints). The `[TuningAgent] usage` line has been logging `cached_fraction ≈ 0` for **five** sprints now (055 → 056 → 057 → 058 → today). Every turn re-reads ~14k system-prompt tokens at full price.

Sprint 058's spec §6 flagged the MCP-reproduction risk and explicitly deferred the transport swap: the Agent SDK today registers ~18 tools via `createSdkMcpServer()` and routes `mcp__tuning-agent__*` tool_use blocks to in-process handlers transparently, including `preToolUse` / `postToolUse` / `preCompact` / `stop` hook dispatch. A direct `messages.create` loop must re-implement that routing end-to-end. 058 said: *"one sprint MAY not be enough."* This is the sprint that proves it is — or ships what's shippable and reports cleanly what isn't.

On top of F1, we ride **F9a React #310 root-cause** as an isolated seventh gate. 058 shipped a StudioErrorBoundary around `<StudioChat>` so the crash no longer nukes the app, but the hook-order violation still fires intermittently on long mid-stream turns. The boundary is a tourniquet, not a fix. The sprint budget is small enough that a single focused stream can land the staging-repro + one-commit fix without derailing F1.

Four-sentence pass criteria:

1. **Numerical cache target.** `[TuningAgent] usage` line on turn 2 of a fresh conversation logs `cached_fraction ≥ 0.70`. Measured with `BUILD_AGENT_DIRECT_TRANSPORT=true` on a staging tenant, baseline Sonnet 4.6.
2. **Functional parity.** Every integration test that currently passes with `BUILD_AGENT_DIRECT_TRANSPORT` unset also passes with it set to `true`. Zero regression on tool-call behaviour, hook firing, session continuity, streaming shape.
3. **Safe rollout.** The direct path falls back to the SDK on ANY unrecognized tool name, any hook-dispatch error, or any stream-event shape the bridge doesn't recognize — so a partial landing cannot silently ship a broken turn. Fallback is logged at WARN level with the tool name and a single-line reason.
4. **F9a fixed.** Repro the React #310 on a staging long-turn, identify the offending hook-order change in `studio-chat.tsx`, ship a one-commit fix, verify boundary fires zero times over a 10-turn soak.

---

## 1. Non-negotiables

- **`ai.service.ts` stays untouched.** Guest-reply pipeline is on OpenAI and out of scope forever in the 045-line.
- **BUILD agent tool surface stays stable.** F1 changes how the system prompt is transmitted and how tool_use blocks are routed, not what tools exist. Tool names, schemas, and handler contracts are frozen. No `write_system_prompt` / `create_sop` / `create_faq` / `plan_build_changes` / `test_pipeline` / `emit_audit` / `emit_session_summary` / `propose_suggestion` / `suggestion_action` / `search_replace` / `search_corrections` / `get_current_state` / `get_context` / `get_edit_history` / `ask_manager` / `fetch_evidence_bundle` / `create_tool_definition` / `build_transaction` / `version_history` / `memory.*` behaviour changes. If the direct path routes a tool_use differently than the SDK would have, that IS a regression.
- **No schema change.** F1 uses existing `TuningMessage` + `TuningConversation` rows for history replay. F9a is pure frontend.
- **Fallback is mandatory.** If the direct path encounters ANY condition it cannot handle (unknown tool, hook-dispatch exception, stream-event it can't bridge, session-replay error), it falls back to the SDK path for THAT ENTIRE TURN. One unknown condition = one full SDK turn. No partial-direct / partial-SDK hybrids inside a single turn.
- **Env flag default is still OFF in production.** Staging canary is `BUILD_AGENT_DIRECT_TRANSPORT=true`. Production flip is a separate, post-sprint decision after a 48-hour staging soak. The sprint ships the code + the canary; it does NOT flip production.
- **Cache-fix correctness check:** if `cached_fraction` is non-zero but the turn produces a different assistant output than the SDK path would have on the same input, that is worse than the zero-cache baseline. A golden-replay test is required.
- **F9a does NOT touch F1 files.** F9a is `frontend/components/studio/studio-chat.tsx` and its immediate deps only. Do not bleed into the backend.
- **Overnight-run discipline.** Every subagent is instructed **STOP ON TEST FAILURE. DO NOT PRESS ON.** Clean failure with a diagnostic dump > silent bleed through remaining gates. See §4.
- **Branch discipline.** Stack on `feat/058-session-a`. Do NOT rebase onto main.

---

## 2. Pre-flight gate

### 2.1 Branch-tip verification

```
git rev-parse feat/050-session-a feat/051-session-a feat/052-session-a feat/053-session-a feat/054-session-a feat/055-session-a feat/056-session-a feat/057-session-a feat/058-session-a
```

Write SHAs into `specs/045-build-mode/PROGRESS.md`. Verify `feat/058-session-a` tip = `48d022b`. If it differs, STOP and surface.

### 2.2 Baseline test counts

```
cd frontend && npm test -- --run
cd backend && find src -name "*.test.ts" -not -path "*/integration/*" | xargs npx tsx --test
```

Expected: **frontend 347 passing, backend 423 passing + 1 env-var failure** (ANTHROPIC_API_KEY smoke test — pre-existing, not caused by this sprint). Write the counts into `PROGRESS.md` § baseline. Any delta from 347 / 423 MUST be investigated before starting gate work.

### 2.3 Create branch

```
git checkout feat/058-session-a
git checkout -b feat/059-session-a
```

Push on first commit.

### 2.4 Read-before-write

Before the first Stream A commit lands, every subagent reads — with no edits — these files. They are the contract surface:

- `backend/src/build-tune-agent/runtime.ts` (677 lines) — the SDK-path runner this sprint is replacing.
- `backend/src/build-tune-agent/runtime-direct.ts` (128 lines) — the 058 scaffold. The F1 stream extends THIS file, NOT a new module, unless crossing 400 lines.
- `backend/src/build-tune-agent/prompt-cache-blocks.ts` (248 lines) — block-array builder + `isDirectTransportEnabled()`.
- `backend/src/build-tune-agent/stream-bridge.ts` (196 lines) — SDKMessage → UIMessageChunk adapter. F1.4 adds a peer adapter for raw Anthropic stream events.
- `backend/src/build-tune-agent/hooks/*.ts` (7 files) — `preToolUse`, `postToolUse`, `preCompact`, `stop`, `tool-trace`. The SDK wires these via the `hooks` option; the direct path must replay them at the same moments.
- `backend/src/build-tune-agent/tools/index.ts` + `names.ts` — the authoritative tool name list. F1.1's router is driven by this, NOT a hardcoded list.
- `frontend/components/studio/studio-chat.tsx` (1278 lines) — the F9a repro target. Pay attention to lines 612-667 (reasoning part handling), the useEffect deps in the queue hook added by 057-A F3b, and the tool-chain summary mount point added by 057-A F1.

No code writes in 2.4 — just ensure every subagent has read its immediate contract surface before touching anything.

---

## 3. Gate-by-gate scope

### F1 — Runtime transport swap (primary, six sub-gates)

**Goal:** flip BUILD turns through the direct `@anthropic-ai/sdk` path when `BUILD_AGENT_DIRECT_TRANSPORT=true`. The transport path must reproduce everything the Agent SDK does today that affects the outward behaviour of a turn: MCP tool dispatch, hook firing, session continuity, stream shape.

#### F1.1 — MCP tool router (Stream A)

New module `backend/src/build-tune-agent/direct/mcp-router.ts`.

Signature:

```ts
export interface McpRouter {
  has(toolName: string): boolean;
  dispatch(
    toolName: string,
    input: unknown,
    ctx: McpDispatchContext,
  ): Promise<McpToolResult>;
}

export function buildMcpRouter(
  tools: ReturnType<typeof import('../tools').buildAllTuningTools>,
): McpRouter;
```

Behaviour:

- `has(name)` returns `true` for every name in `buildAllTuningTools()`'s output. Namespace is `mcp__tuning-agent__*` in the wire format (Anthropic prepends the server namespace); the router accepts both the wire name and the bare name.
- `dispatch()` calls the matching tool handler with the same shape the SDK would have, awaits its return, and packages it into an Anthropic `tool_result` content block (text or structured).
- On unknown tool name: throw `McpUnknownToolError` with the wire name. The outer runner catches this and falls back to the SDK path for the rest of the turn (see F1.5).
- On handler throw: catch, wrap in an `is_error: true` `tool_result` block, do NOT throw up. Matches the SDK's error-as-tool-result semantics so the model can recover.

Tests (`__tests__/mcp-router.test.ts`):

- Known-tool dispatch returns expected shape.
- Unknown-tool dispatch throws `McpUnknownToolError`.
- Handler-throw becomes `is_error: true` tool_result.
- Wire name (`mcp__tuning-agent__create_faq`) and bare name (`create_faq`) both resolve.
- `has()` is consistent with `dispatch()` — if `has(x)` is true, `dispatch(x)` does not throw `McpUnknownToolError`.

#### F1.2 — Hook replay (Stream A)

New module `backend/src/build-tune-agent/direct/hook-dispatcher.ts`.

The SDK wires hooks via `query({ hooks: buildTuningAgentHooks(...) })`. The hooks object is a map from lifecycle event to handler:

- `preToolUse(toolName, input, ctx)` — fires before the router dispatches.
- `postToolUse(toolName, input, result, ctx)` — fires after the router returns.
- `preCompact(ctx)` — fires before the agent SDK compacts. The direct path does not compact (we manage history ourselves via F1.3), so this hook is only fired if explicitly triggered by a tool (none currently do).
- `stop(ctx)` — fires at turn end, before the final `result` SDKMessage.

Signature:

```ts
export interface HookDispatcher {
  preToolUse(toolName: string, input: unknown): Promise<HookOutcome>;
  postToolUse(toolName: string, input: unknown, result: McpToolResult): Promise<void>;
  stop(): Promise<void>;
}

export function buildHookDispatcher(
  hooks: ReturnType<typeof import('../hooks').buildTuningAgentHooks>,
  ctx: HookContext,
): HookDispatcher;
```

Behaviour:

- `preToolUse` may return `{ cancel: true, reason }` — the router MUST abort dispatch and return a synthetic `tool_result` with the reason text, marked `is_error: true`. This matches the SDK's hook-cancel semantics.
- `postToolUse` is fire-and-forget from the caller's perspective but AWAITED by the dispatcher (the caller must not proceed to the next model call until post-hooks resolve — the hooks write `ToolTrace` rows and the next turn reads them).
- `stop` fires exactly once per turn.
- Any hook throw is logged at WARN + converted to a direct-path fallback signal (F1.5). We do NOT swallow hook errors silently.

Tests (`__tests__/hook-dispatcher.test.ts`):

- `preToolUse` cancellation aborts dispatch and yields the expected synthetic tool_result.
- `postToolUse` is awaited (uses a fake that resolves after 50ms; dispatcher.postToolUse resolves no sooner).
- `stop` fires exactly once even if called twice (idempotent).
- Hook throw propagates as fallback signal, not uncaught rejection.

#### F1.3 — Session persistence via TuningMessage replay (Stream B)

Today, the Agent SDK persists sessions as `sdk-session-id.json` on the local FS (`runtime.ts:405` comment calls this unreliable on Railway). The direct path must NOT use FS-based session storage. Instead:

- On turn start, load all `TuningMessage` rows for `conversationId`, sorted by `createdAt` ASC.
- Map each row into an Anthropic `messages` array entry (`role`, `content`). Assistant rows may include tool_use blocks; user rows may include tool_result blocks.
- Apply the existing `compactHistoryIfNeeded()` helper (if it exists — if not, the direct path uses a simple "last 50 turns" window for now and logs when truncation fires).
- Append the new user turn, call the model, stream-bridge the response, and on `stop` hook, persist the new assistant message as a `TuningMessage` row.

New module `backend/src/build-tune-agent/direct/history-replay.ts`:

```ts
export async function loadConversationHistory(
  conversationId: string,
): Promise<AnthropicMessageHistory[]>;

export async function persistAssistantTurn(
  conversationId: string,
  assistantMessage: AnthropicAssistantMessage,
): Promise<void>;
```

Tests (`__tests__/history-replay.test.ts`):

- Empty conversation → empty history array.
- Conversation with 3 user + 3 assistant turns → 6-entry array, correct order.
- Assistant turn with tool_use block is preserved verbatim.
- User turn with tool_result block is preserved verbatim.
- `persistAssistantTurn` writes exactly one `TuningMessage` row.
- Concurrent `persistAssistantTurn` calls on the same conversationId do not interleave content (use an advisory row lock or a transaction).

Risk: the SDK's compaction strategy is probably cleverer than "last 50 turns." If we see token-budget overshoot in staging, this becomes a follow-up sprint. Log the context-token budget on every turn so we have the signal.

#### F1.4 — Stream-bridge parity (Stream B)

New module `backend/src/build-tune-agent/direct/anthropic-stream-bridge.ts`.

The existing `stream-bridge.ts` consumes SDKMessage events (aggregate shapes assembled by the SDK). The direct path receives raw Anthropic stream events: `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`.

Two options:

- (a) adapt raw events into SDKMessage aggregates and feed the existing `bridgeSDKMessage()` unchanged.
- (b) bridge raw events directly into UIMessageChunk.

Pick (a). Reason: `bridgeSDKMessage` already handles all the corner cases (sprint 09 fix 11 unique text ids, reasoning/text interleaving, tool_use de-dup via `seenToolIds`). Recreating that logic invites regressions. The adapter just needs to yield SDKMessage-shaped objects:

- On `message_start` → nothing (the assistant message isn't complete yet).
- On `content_block_start` + `content_block_delta` (type `text_delta`) → emit a `stream_event` SDKMessage with the raw event (existing bridge handles this).
- Same for `thinking_delta`.
- On `content_block_stop` for a `tool_use` block → synthesize an `assistant` SDKMessage containing the full tool_use (with aggregated `input`).
- On a `tool_result` being returned (from F1.1 dispatch, NOT from the model) → synthesize a `user` SDKMessage with the tool_result.
- On `message_stop` → synthesize a `result` SDKMessage with `subtype: 'success'` (or `error` if an exception propagated).

Tests (`__tests__/anthropic-stream-bridge.test.ts`):

- Raw text stream (no tool calls) produces the same UIMessageChunk sequence as an SDK run with equivalent content. Snapshot-compared.
- Raw stream with one tool_use + one tool_result produces the same chunk order as the SDK equivalent.
- Interleaved thinking + text produces the same UIMessageChunk sequence as the SDK equivalent.
- `message_delta` stop_reason is respected — `tool_use` → model continues (caller dispatches next tool), `end_turn` → bridge closes out.

A **snapshot** test diffs the direct-path chunk log against the SDK-path chunk log for three canned turns. This is the single most important F1 regression gate.

#### F1.5 — Direct-path runner + fallback (Stream C)

New module `backend/src/build-tune-agent/direct/runner.ts`. This is the replacement for the `runtime.ts` `runTuningAgentTurn()` entry point's inner loop when `isDirectTransportEnabled()` is true.

Outer shape:

```ts
export async function runDirectTurn(
  input: DirectRunInput,
  write: (chunk: UIMessageChunk) => void,
): Promise<DirectRunResult>;
```

Behaviour (pseudocode):

```
1. Build direct params via buildDirectMessagesCreateParams() (058 scaffold).
2. Load history via loadConversationHistory() (F1.3).
3. Start anthropic.messages.stream({ ...params, messages: [...history, userTurn] }).
4. For each raw stream event:
   a. Adapt to SDKMessage (F1.4).
   b. If SDKMessage is a tool_use assistant:
      - preToolUse hook (F1.2).
      - If cancelled: synthesize error tool_result, DO NOT dispatch.
      - Else: mcpRouter.dispatch() (F1.1). On McpUnknownToolError: abort, fall back to SDK.
      - postToolUse hook (F1.2).
      - Emit tool_result as user SDKMessage, feed next stream iteration.
   c. Else: bridge to UIMessageChunk and write().
5. On message_stop: stop hook (F1.2), persist assistant turn (F1.3), emit finish.
6. On ANY direct-path exception (unknown tool, stream shape, hook throw):
   - Log WARN with reason.
   - Call runSdkTurn() (existing SDK-path runner, extracted).
   - Return its result.
   - The fallback emits its own stream; the caller gets a single coherent stream.
   - Metric: increment `build_direct_fallback_total{reason=<tag>}`.
```

Fallback reasons (enumerated):

- `unknown_tool` — MCP router didn't recognize a tool name.
- `hook_error` — preToolUse / postToolUse / stop threw.
- `bridge_error` — raw stream event didn't map to a known SDKMessage shape.
- `history_error` — TuningMessage replay failed.
- `api_error` — Anthropic SDK threw (rate limit, 5xx, etc.).

Tests (`__tests__/direct-runner.test.ts`):

- Happy path: text-only turn streams correctly, persists one assistant row, fires stop hook once.
- Tool-call turn: dispatches the tool, emits tool_result, continues the stream.
- Unknown tool falls back to SDK, emits `build_direct_fallback_total{reason="unknown_tool"}` metric.
- Hook throw falls back with `reason="hook_error"`.
- API error falls back with `reason="api_error"`.
- Fallback does not double-emit chunks (direct path's partial chunks are discarded, SDK path starts fresh).

Wiring: `runtime.ts` `runTuningAgentTurn()` branches on `isDirectTransportEnabled()`. Extract the existing SDK path into `backend/src/build-tune-agent/sdk-runner.ts` (pure rename + default export), leave `runtime.ts` as the dispatcher. Both paths share the same outer ctx (`HookContext`, `TuningAgentCtx`, etc.).

#### F1.6 — Staging canary + numerical acceptance (Stream C, last)

Only runs after F1.1-F1.5 are all green.

1. Merge the full stack into `feat/059-session-a`.
2. Deploy to Railway staging with `BUILD_AGENT_DIRECT_TRANSPORT=true`.
3. Open Studio on staging, run 3 fresh conversations. Each:
   - Turn 1: send a simple instruction ("create a FAQ about parking").
   - Turn 2: send a follow-up ("make the same FAQ more detailed").
   - Record the `[TuningAgent] usage` line on turn 2.
4. Acceptance:
   - `cached_fraction ≥ 0.70` on turn 2 across all 3 conversations.
   - Zero `build_direct_fallback_total` increments.
   - Assistant output shape matches what turn 2 would have produced on the SDK path (spot-check — full golden replay is a follow-up).
5. Persist evidence in `PROGRESS.md` § F1.6: the three `[TuningAgent] usage` lines, verbatim.

Production rollout is NOT in this sprint. Spec explicitly ends at staging canary + evidence.

### F9a — React #310 root-cause (ride-along, Stream C)

**Goal:** identify which commit introduced the hook-order change, fix it, verify the error boundary fires zero times over a 10-turn soak on staging.

Steps:

1. `git log --oneline feat/057-session-a..feat/058-session-a -- frontend/components/studio/studio-chat.tsx` — list every commit that touched the chat component.
2. For each commit, identify whether it added, removed, or made-conditional a `useEffect`, `useMemo`, `useCallback`, `useState`, or `useRef` call.
3. Run `npm test -- studio-chat` — any test that reproduces the hooks order change will fail. If none do, write a new test: render `<StudioChat>` with an initial `streaming=false` state, then flip to `streaming=true` mid-stream while a new message arrives. Wrap in `@testing-library/react` `act()` and assert no console.error about hooks.
4. Most likely culprit (per 058 screenshot analysis): the 057-A F3b queue-while-busy `useEffect` is conditional on a ref value. Conditional hook calls = #310. Hoist it to the top level; guard its BODY rather than its call.
5. Secondary suspect: the 057-A F1 tool-chain summary mounts a portal. If that portal's parent unmounts mid-stream (e.g., because an effect sets `showToolChain = false` in a branch that also changes hooks), that's #310.
6. Ship the fix as ONE commit. Do NOT bundle with F1 commits — F9a is cherry-pickable.

Tests:

- Existing `studio-chat.test.tsx` coverage continues to pass.
- New test: `studio-chat.hooks-order.test.tsx` — mount → mid-stream message arrives → no console.error about hooks, no error boundary engagement.

Staging soak: 10 mixed turns (some short, some long; some tool-heavy, some text-only). Zero `[StudioErrorBoundary] caught` entries in the browser console. Screenshot the console at 0 errors for PROGRESS.md.

---

## 4. Overnight-run discipline (reproduced in every subagent prompt)

> **YOU ARE RUNNING OVERNIGHT AND UNSUPERVISED.** The only failure mode that matters more than incomplete work is silent-broken work. Read this block at the start of your session and again before every test run.
>
> 1. **STOP ON TEST FAILURE. DO NOT PRESS ON.** If `npm test` or the backend test suite reports a failure after a commit, STOP the stream immediately. Write a diagnostic dump to `/tmp/059-stream-<letter>-failure.md` containing: the failing test names, the full `npm test` output, the last 50 lines of your edit log, the git diff of your last commit. Push the branch. Do NOT attempt to "fix it and continue." The user will review the dump and decide.
> 2. **Clean failure > silent bleed.** A partial sprint with a crisp stop-point and diagnostic dump is always better than a full sprint with a silent regression buried at gate 4.
> 3. **File-list discipline.** At the top of every commit message, list every file touched by that commit. If your diff touches a file you did not list, that is a sprint-level rule violation — revert and restate.
> 4. **One gate per commit.** `F1.1 — MCP router`, `F1.2 — Hook dispatcher`, etc. Do NOT roll two sub-gates into one commit. Revert is cheaper when commits are atomic.
> 5. **`ai.service.ts` is sacred.** Do not edit it. Do not import from it from any new `build-tune-agent/direct/*` module. If you find yourself writing `from '../../services/ai.service'`, you are in the wrong file.
> 6. **Constitution §Development Workflow:** NO migrations. Only `prisma db push`. (No schema changes expected this sprint — if you find yourself reaching for one, STOP and report.)
> 7. **When in doubt, fall back to the SDK.** The direct path's fallback logic is load-bearing. It is better to ship a path that falls back on 50% of turns and logs why than a path that claims to handle everything and silently corrupts one.
> 8. **Every subagent reads the target file before editing.** `read_file` first, then `edit_file`. No blind writes.
> 9. **Baseline tests first, after each gate.** Run `cd frontend && npm test -- --run` and `cd backend && find src -name "*.test.ts" -not -path "*/integration/*" | xargs npx tsx --test` after EACH sub-gate commit. Record pass counts in PROGRESS.md. Any delta is a stop-condition.
> 10. **PROGRESS.md is authoritative.** Every sub-gate close gets a paragraph in `specs/045-build-mode/PROGRESS.md` under `## Sprint 059-A`. If it's not written there, it did not happen.

---

## 5. Stream breakdown

### Stream A — MCP router + Hook dispatcher (backend, F1.1 + F1.2)

**Subagent:** backend-specialist. Opus 4.7.

**Scope:**
- `backend/src/build-tune-agent/direct/mcp-router.ts` (new)
- `backend/src/build-tune-agent/direct/hook-dispatcher.ts` (new)
- `backend/src/build-tune-agent/__tests__/mcp-router.test.ts` (new)
- `backend/src/build-tune-agent/__tests__/hook-dispatcher.test.ts` (new)
- READ-ONLY: `backend/src/build-tune-agent/tools/index.ts`, `names.ts`, `hooks/*.ts`, `runtime.ts`

**Order:** F1.1 commit → baseline tests pass → F1.2 commit → baseline tests pass → close Stream A.

**Blocks on:** nothing (can start immediately).
**Blocks:** Stream C (F1.5 consumes F1.1 + F1.2).

### Stream B — History replay + Stream bridge (backend, F1.3 + F1.4)

**Subagent:** backend-specialist. Opus 4.7.

**Scope:**
- `backend/src/build-tune-agent/direct/history-replay.ts` (new)
- `backend/src/build-tune-agent/direct/anthropic-stream-bridge.ts` (new)
- `backend/src/build-tune-agent/__tests__/history-replay.test.ts` (new)
- `backend/src/build-tune-agent/__tests__/anthropic-stream-bridge.test.ts` (new)
- Golden-replay fixture directory: `backend/src/build-tune-agent/__tests__/fixtures/direct-stream/` (new) — three canned raw-stream captures + their expected UIMessageChunk output.
- READ-ONLY: `backend/src/build-tune-agent/stream-bridge.ts`, `runtime.ts`, `prisma/schema.prisma` (for TuningMessage shape).

**Order:** F1.3 commit → baseline tests pass → F1.4 commit (includes snapshot fixtures) → baseline tests pass → close Stream B.

**Blocks on:** nothing (can start immediately; parallel with Stream A).
**Blocks:** Stream C (F1.5 consumes F1.3 + F1.4).

### Stream C — Direct runner + canary + F9a (backend + frontend, F1.5 + F1.6 + F9a)

**Subagent:** full-stack-specialist. Opus 4.7. Starts AFTER Stream A + Stream B both report green.

**Scope:**
- `backend/src/build-tune-agent/direct/runner.ts` (new)
- `backend/src/build-tune-agent/sdk-runner.ts` (new — extracted from runtime.ts)
- `backend/src/build-tune-agent/runtime.ts` (edited — becomes a thin dispatcher on `isDirectTransportEnabled()`)
- `backend/src/build-tune-agent/__tests__/direct-runner.test.ts` (new)
- `backend/src/build-tune-agent/__tests__/runtime-dispatcher.test.ts` (new — ensures the env-flag branch hits the right runner)
- `frontend/components/studio/studio-chat.tsx` (edited for F9a)
- `frontend/components/studio/__tests__/studio-chat.hooks-order.test.tsx` (new for F9a)
- `specs/045-build-mode/PROGRESS.md` (edited — F1.6 evidence + F9a soak evidence)
- NO backend test file outside `__tests__/` touched.

**Order:**
1. F1.5 commit (runner + extraction + dispatcher edit + tests). Baseline tests pass.
2. F1.6 canary. Deploy to staging, collect three `[TuningAgent] usage` lines. Paste into PROGRESS.md. Commit.
3. F9a investigation commit (repro test + root-cause write-up in PROGRESS.md).
4. F9a fix commit (one-line/small edit in studio-chat.tsx).
5. F9a soak — 10 turns, screenshot console at 0 errors. Commit the screenshot into PROGRESS.md (base64 inline or link to artifact).

**Blocks on:** Stream A + Stream B both closed.
**Blocks:** close-out.

---

## 6. Known risks

- **R1 — SDK's compaction is smarter than our replay window.** If a conversation exceeds 50 turns with heavy tool use, the 200k context budget blows. Mitigation: log token count per turn; if we see >150k, add a compaction sprint to 060.
- **R2 — Hook ordering subtlety.** The SDK may fire `preToolUse` in a specific position relative to partial stream events; replaying at a slightly different moment could cause a ToolTrace row to be written with stale ctx. Mitigation: F1.2 tests include a clock-ordering assertion; if the direct path's hook fires at a materially different point than the SDK's, the snapshot test catches it via different ToolTrace row timestamps.
- **R3 — `stream-bridge.ts` Sprint 09 fix 11 state machine.** That bug cost two sprints to find and fix. F1.4 MUST NOT reimplement it — the adapter synthesizes SDKMessage and feeds `bridgeSDKMessage` unchanged. If someone on Stream B thinks "I can just emit UIMessageChunk directly, it's simpler," REJECT the approach in review.
- **R4 — Partial landing.** If F1.1 + F1.2 land but F1.3 or F1.4 hit an unknown obstacle, we have a half-baked direct path that falls back to SDK on every turn. That is NOT a regression (SDK path is unchanged), it's just a silent no-op. Ship it, flip the env flag off, report what's missing, defer to 060.
- **R5 — F9a is speculative.** We think it's the 057-A F3b queue useEffect. If the repro points somewhere else entirely (e.g., a Next.js 16 Strict Mode thing), Stream C defers F9a and closes with just F1. Do NOT spend more than 2 hours chasing F9a — this sprint's primary deliverable is F1.

---

## 7. Close-out protocol

At the end of the run (Stream C declared done or any stream hit a hard stop):

1. Write `PROGRESS.md` § Sprint 059-A close-out: gate-by-gate status (done / deferred / failed), test deltas (final counts vs baseline 347/423), commits (SHAs + subjects), the three canary `[TuningAgent] usage` lines, the F9a screenshot / soak evidence.
2. Archive `NEXT.md` → `NEXT.sprint-059-session-a.archive.md`.
3. Write a fresh `NEXT.md` pointing at sprint-060 candidates. Seed with: production rollout of direct transport (assuming staging soak holds), cross-artifact snapshots (058 candidate E), mobile-responsive Studio (058 candidate B), operator-rationale feedback loop (058 candidate C).
4. Single summary line in the final user message: `Sprint 059-A: F1 <status>, F9a <status>, <M> commits, frontend <n>, backend <m>.`

If Stream A or B hard-stops, Stream C must not start. The close-out STILL runs — with a deferred-to-060 marker on every unstarted gate.

---
