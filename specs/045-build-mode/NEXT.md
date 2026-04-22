# Sprint 060 — Session A kickoff (draft — pick a target, then write the spec)

> **Runner:** Opus 4.7 with 1M context, unsupervised overnight run.
> **Parent branch:** `feat/059-session-a` (tip once Stream C lands back). Sprint-059 close-out lives in `NEXT.sprint-059-session-a.archive.md` and `PROGRESS.md`.

---

## Sprint-059 outcome (for context)

**Six gates, all landed (F1.5 + F9a done; F1.6 pending-user-canary).**

- F1.1 — MCP tool router (Stream A)
- F1.2 — Hook dispatcher (Stream A)
- F1.3 — TuningMessage-replay history (Stream B)
- F1.4 — Anthropic raw-stream → SDKMessage bridge + golden fixtures (Stream B)
- F1.5 — Direct-path runner + SDK-extraction + `runtime.ts` dispatcher (Stream C)
- F1.6 — pending-user-canary protocol documented (Stream C)
- F9a — React #310 repro test added (Stream C); offline repro COULD NOT trigger the crash, deferred to sprint-060 with a staging-repro requirement

The runtime split is done: `runtime.ts` is a thin dispatcher over `sdk-runner.ts` (pure rename) and `direct/runner.ts` (wires F1.1–F1.4). Flag `BUILD_AGENT_DIRECT_TRANSPORT` gates direct path; today the direct wiring returns `fallback → SDK` because the tools-array export out of `tools/index.ts` is still pending. Every fallback path is unit-test-covered end-to-end.

---

## Candidates for sprint-060

Pick one. If no signal from the user by dispatch time, default to **A (production rollout of direct transport)** — it's the logical continuation of 059.

### A. Production rollout of direct transport (default)

**Why this one:** 059's F1.5 landed the runner + dispatcher + every fallback reason unit-tested. All that remains is (1) plumbing the tools array out of `tools/index.ts`, (2) converting the `DirectRunResult` back into a `RunTurnResult`-shaped payload in `wire-direct.ts`, (3) running the staging canary (spec §3 F1.6 + PROGRESS.md F1.6 section), and (4) flipping `BUILD_AGENT_DIRECT_TRANSPORT=true` in production after 48-hour staging soak holds.

**Scope:**
- Export `buildAllTuningTools(): SdkMcpToolDefinition<any>[]` from `tools/index.ts` (plumbs the array the MCP router needs).
- Wire the DirectRunInput constructor in `direct/wire-direct.ts`: build hooks via `buildTuningAgentHooks()`, dispatcher via `buildHookDispatcher()`, router via `buildMcpRouter()`, prompt assembly + tool-shape conversion to `DirectToolDefinition[]`.
- Persist SDK-session-id equivalent in the direct runner — today session state is lost across turns because TuningMessage replay is the whole history (see `history-replay.ts`). Decision: the direct path never resumes an SDK session, so `sdkSessionId` stays null for direct-path turns. Document this on `TuningConversation` via a new nullable column or a sentinel value.
- `build_direct_fallback_total{reason=<tag>}` metric wired into the real metrics sink (if one exists; otherwise structured JSON log for Langfuse ingestion).
- Rollback runbook: one-liner instructions to flip `BUILD_AGENT_DIRECT_TRANSPORT=false` + redeploy to fall back to SDK path.
- Canary-on-percentage gate: optional env `BUILD_AGENT_DIRECT_TRANSPORT_PCT=25` that turns direct on for 25% of tenants via deterministic hash — lets the first live tenants be shadow-switched without a hard cutover.

**Risk:** live tool-call dispatch through the router hits ~18 tools. The router's Zod validation + handler signatures may surface an edge case the mocked tests didn't catch. Budget 1 sprint; if the canary fails acceptance (`cached_fraction < 0.70` on turn 2) we roll back and investigate.

### B. Mobile-responsive Studio (carried from 058/059)

See 058's candidate B writeup. Still a valid target if the user prefers UI work.

### C. Operator-rationale feedback loop (carried from 058/059)

See 058's candidate C writeup.

### D. Cross-artifact version snapshots (carried from 058/059)

See 058's candidate E writeup.

### E. Token-budget compaction for long BUILD sessions

**Why:** `history-replay.ts` caps history at the last 50 turns and WARNs on truncation. If staging canary shows any conversation approaching the 200k context budget (i.e. >150k tokens on turn 20), the "last-50-turns" heuristic is too crude. A real compactor (summarise tool_use/tool_result pairs, drop repeated context blocks, rollup artifact diffs into a single baseline) would sidestep the 200k budget cap.

**Scope:** summariser service invoked when `approx_tokens > 120_000`. Uses gpt-5-nano to produce a one-paragraph rollup of turns 1-N, prepended as a single system-level summary block. TuningMessage rows stay untouched — this is a read-time transform.

**Risk:** summariser quality directly affects agent continuity. Extensive fixture-based regression suite needed.

### F. F9a React #310 staging repro (carried from 059)

Only viable if the crash surfaces on staging during the F1.6 canary (spec §6 R5 timebox). Requires live repro + targeted fix; offline unit tests could not reproduce.

---

## How to pick

Default is **A**. The user should say otherwise if they want B/C/D/E/F.

---

## Pre-flight for whichever target lands

- Branch `feat/060-session-a` off `feat/059-session-a` (final tip after Stream C merge).
- Run baseline tests: `cd frontend && npm test -- --run` (expect 349 — was 347; +2 from 059 F9a repro test) + `cd backend && find src -name "*.test.ts" -not -path "*/integration/*" | xargs npx tsx --test` (expect 472 passing + 1 env-var failure — was 463; +9 from 059 F1.5).
- If the frontend's `studio-error-boundary.test.tsx` still fails consistently, that's a pre-existing worktree-specific flake Stream C observed (Stream B also saw it; did NOT reproduce on orchestrator's primary worktree per 059 kickoff). Treat as a known-unreliable test; fix independently.
- Write the spec into `specs/045-build-mode/sprint-060-session-a.md` before dispatching anything. Overnight discipline holds.

---

## Deferred bugs from 2026-04-22 studio-agent bug-hunt pass

Two scan agents swept the Studio backend + frontend + adjacent services after the `get_context` chat-history-truncation fix. Five bugs were fixed this pass (2× HIGH, 3× MEDIUM). The items below were triaged **defer** — all LOW severity, cosmetic or edge-case, and safe to sit until they intersect other work.

### LOW — studio-chat: test-pipeline / state-snapshot parts forward twice during streaming
- **File:** `frontend/components/studio/studio-chat.tsx:237-254`.
- **Symptom:** `forwardedIds` set keys on `p.id ?? ${m.id}:${t}`. During SSE streaming a part may first arrive without `p.id` (fallback key used) then gain an id later (real key used). Both land in the Set → the upstream `onStateSnapshot` / `onTestResult` callbacks fire twice for the same payload. `handleTestResult` prepends every call, but `.slice(0, 3)` caps the right-rail rows so the duplicate is cosmetic and self-healing as the window rolls.
- **Fix sketch:** dedupe by `${m.id}:${t}:${p.index ?? ''}` or gate forwarding until `p.id` is populated / the part is terminal.

### LOW — studio-surface: auto-naming skipped when first queued message is flushed
- **File:** `frontend/components/studio/studio-chat.tsx:387-397` vs `studio-surface.tsx:328-346`.
- **Symptom:** When an operator queues their first-ever message and it's too short to auto-title, then queues a longer follow-up, the flush path sends via `sendMessage` but does NOT re-invoke `onUserMessageSent`. The surface's fallback-name logic never gets the longer text and the session keeps the generic title.
- **Fix sketch:** call `onUserMessageSent?.(first)` inside the flush effect too.

### LOW — template-variable: duplicate `{VAR}` in a content block can leak raw token
- **File:** `backend/src/services/template-variable.service.ts:227-245`.
- **Symptom:** `blockText.replace(`{${varName}}`, value)` replaces ONE occurrence. If a content block references `{OPEN_TASKS}` twice, the second stays literal. Edge case; almost never happens in practice.
- **Fix sketch:** `blockText = blockText.split(`{${varName}}`).join(value)` — replaces all.

### LOW — tenant-state: JSON-encoded slot value with `<!-- DEFAULT: change me -->` inside is treated as defaulted
- **File:** `backend/src/services/tenant-state.service.ts:207-213`.
- **Symptom:** Non-string slot values go through `JSON.stringify()` before the `includes(DEFAULT_MARKER)` check. A manager who stores escaped docs containing the sentinel string gets their slot silently marked defaulted and interview-graduation blocked.
- **Fix sketch:** only test for `DEFAULT_MARKER` when `typeof raw === 'string'`; treat any other non-empty JSON as filled.

### LOW — emit_session_summary: verify turnFlags parity on direct-transport path
- **File:** `backend/src/build-tune-agent/tools/emit-session-summary.ts:82-123`.
- **Symptom:** The "once per turn" invariant depends on `c.turnFlags` being freshly allocated per turn. SDK path does this; the direct transport path (today inactive via wire-direct.ts fallback) needs a verifier test before it goes live so the invariant doesn't become "once per process."
- **Fix sketch:** add a direct-runner test that asserts a second `emit_session_summary` in the same process but different turn succeeds.

### LOW — studio-chat queue-flush: add deterministic test of the silent-error wedge fix
- **File:** `frontend/components/studio/__tests__/` (new test).
- **Symptom:** The 2026-04-22 fix adds a 5s safety timeout + Promise.catch on `sendMessage`. Verified manually but no unit test. A Vercel AI SDK transport mock would pin the behaviour.
- **Fix sketch:** vitest harness that mocks `useChat.sendMessage` to throw synchronously, and one that returns an unresolving promise — assert the ref releases within 5.1s.

### LOW — all fixes this pass would benefit from `tsc --noEmit` in the after-gate routine
- **Context:** 059-A's `anthropic-stream-bridge.test.ts` shipped with two TS type errors that passed `tsx --test` (transpile-only) but failed Railway's `tsc` step. The 2026-04-22 fixes ran `tsc --noEmit` as part of the checklist. The sprint-060 kickoff should codify `tsc --noEmit` as a required after-gate step, not just a local habit.

