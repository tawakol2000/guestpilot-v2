# Sprint 059 — Session A — Claude Code kickoff prompt (paste-ready)

> Paste the block below verbatim as the first message in the Opus 4.7 / 1M-context Claude Code session. It is self-contained — the runner does not need any other context to start.

---

You are running **Sprint 059 — Session A — F1 Runtime Transport Swap + MCP Reproduction (+ F9a React #310 root-cause)** on GuestPilot v2. You are Opus 4.7 with 1M context. You are running overnight and unsupervised.

**Repo:** `/path/to/guestpilot-v2-1` (your working directory). **Branch:** `feat/059-session-a`, stacked on `feat/058-session-a` (expected tip `48d022b`). **Spec:** `specs/045-build-mode/sprint-059-session-a.md` — read it end-to-end before you touch anything.

## The sprint in one paragraph

Sprint 058 shipped the F1 scaffold (`buildDirectMessagesCreateParams()`) but left the runtime itself still on the Claude Agent SDK's string-only `systemPrompt`. Cached_fraction has logged ≈ 0 for five sprints. This sprint flips BUILD turns through a direct `@anthropic-ai/sdk` call when `BUILD_AGENT_DIRECT_TRANSPORT=true`, reproducing the SDK's in-process MCP dispatch, hook replay, session persistence, and stream-bridge semantics end-to-end. Acceptance: `cached_fraction ≥ 0.70` on turn 2 of a fresh staging conversation, zero behavioural regressions, safe fallback on any unhandled condition. Ride-along: root-cause and fix React #310 on `<StudioChat>` (058 shipped an error boundary; this sprint kills the underlying hook-order bug).

## The non-negotiables

Before anything else, read `specs/045-build-mode/sprint-059-session-a.md` §1 (Non-negotiables) and §4 (Overnight-run discipline). Enforce them for the entire run. The key ones:

1. **STOP ON TEST FAILURE. DO NOT PRESS ON.** Write `/tmp/059-stream-<letter>-failure.md` with a diagnostic dump, push the branch, stop. The user reviews and decides.
2. **`ai.service.ts` is sacred.** Do not edit it. Do not import from it in any `build-tune-agent/direct/*` module.
3. **No schema changes.** If you reach for one, STOP and report.
4. **Fallback is load-bearing.** The direct path falls back to the SDK on ANY unrecognized condition. Half-direct turns are forbidden.
5. **One gate per commit.** File-list in every commit message. No rolling two sub-gates into one commit.
6. **Environment flag default stays OFF in production.** Staging canary is the sprint's stopping point. DO NOT flip production.

## Pre-flight (run these IN ORDER)

```
cd /path/to/guestpilot-v2-1
git fetch --all
git rev-parse feat/058-session-a      # expected: 48d022b
git checkout feat/058-session-a
git checkout -b feat/059-session-a
git push -u origin feat/059-session-a

cd frontend && npm test -- --run       # expected: 347 passing
cd ../backend && find src -name "*.test.ts" -not -path "*/integration/*" | xargs npx tsx --test
                                        # expected: 423 passing + 1 env-var failure (ANTHROPIC_API_KEY pre-existing)
```

Write the baseline counts into `specs/045-build-mode/PROGRESS.md` under a new section `## Sprint 059-A / Baseline`. Any delta from 347 / 423 is a hard stop — surface it, do not proceed.

## Read-before-write

Every subagent, before its first edit, reads these files (read-only pass):

- `backend/src/build-tune-agent/runtime.ts` (677 lines — the SDK-path runner being wrapped)
- `backend/src/build-tune-agent/runtime-direct.ts` (128 lines — the 058 scaffold; F1.1-F1.6 extend this module family, NOT a new one)
- `backend/src/build-tune-agent/prompt-cache-blocks.ts` (248 lines)
- `backend/src/build-tune-agent/stream-bridge.ts` (196 lines)
- `backend/src/build-tune-agent/hooks/*.ts` (seven files — preToolUse, postToolUse, preCompact, stop, tool-trace, shared, index)
- `backend/src/build-tune-agent/tools/index.ts` + `tools/names.ts` (authoritative tool name list)
- `frontend/components/studio/studio-chat.tsx` (1278 lines — F9a target; focus on 612-667, 057-A F3b queue useEffect, 057-A F1 tool-chain summary mount)

## Gate breakdown and stream plan

Read spec §3 for the full scope per gate. In outline:

- **F1.1 — MCP tool router** (Stream A) — `backend/src/build-tune-agent/direct/mcp-router.ts`
- **F1.2 — Hook dispatcher** (Stream A) — `backend/src/build-tune-agent/direct/hook-dispatcher.ts`
- **F1.3 — History replay** (Stream B) — `backend/src/build-tune-agent/direct/history-replay.ts`
- **F1.4 — Anthropic stream-bridge** (Stream B) — `backend/src/build-tune-agent/direct/anthropic-stream-bridge.ts`, adapts raw events to SDKMessage shape so `bridgeSDKMessage()` is reused unchanged
- **F1.5 — Direct runner + fallback** (Stream C) — `backend/src/build-tune-agent/direct/runner.ts`, extracts SDK path to `sdk-runner.ts`, makes `runtime.ts` a dispatcher
- **F1.6 — Staging canary** (Stream C) — deploy, run three conversations, record three `[TuningAgent] usage` lines, verify `cached_fraction ≥ 0.70`
- **F9a — React #310 root-cause** (Stream C) — repro test, identify 057 commit, ship one-commit fix, 10-turn soak

### Dispatch three subagents in a single message

Use the Task tool THREE TIMES in ONE tool-call block:

1. **Stream A subagent** (`backend-specialist`, Opus 4.7, 1M context). Scope: F1.1 + F1.2. Blocks on nothing. Blocks Stream C.
2. **Stream B subagent** (`backend-specialist`, Opus 4.7, 1M context). Scope: F1.3 + F1.4 + golden-replay fixtures in `__tests__/fixtures/direct-stream/`. Blocks on nothing. Blocks Stream C.
3. **Stream C subagent** (`full-stack-specialist`, Opus 4.7, 1M context). Scope: F1.5 + F1.6 + F9a + PROGRESS.md. **Explicitly instructed to WAIT until Stream A and Stream B both report green before starting F1.5.** Can start the F9a investigation (read-only) while waiting.

Each subagent prompt MUST include, verbatim, the overnight-run discipline block from spec §4 AND the list of READ-ONLY files from spec §2.4.

Each subagent MUST respect the stream's file boundary. A Stream A subagent that touches `backend/src/build-tune-agent/direct/runner.ts` is a rule violation — STOP, revert, surface.

## After-gate routine (every sub-gate)

After every sub-gate commit, run:

```
cd frontend && npm test -- --run
cd backend && find src -name "*.test.ts" -not -path "*/integration/*" | xargs npx tsx --test
```

Append a row to PROGRESS.md § Sprint 059-A:

```
| F1.x | <subject> | <sha> | frontend <n>/347 | backend <m>/423 | <notes> |
```

Any test delta is a hard stop — dump to `/tmp/059-stream-<letter>-failure.md` and push.

## F1.6 evidence protocol

Stream C runs F1.6 only after F1.5 lands green. Steps:

1. Verify `feat/059-session-a` tip is clean. Push.
2. Deploy to Railway staging with `BUILD_AGENT_DIRECT_TRANSPORT=true` (user has the staging env — if you cannot deploy yourself, write the evidence-collection plan into PROGRESS.md and stop; the user will deploy and paste the usage lines).
3. Open staging Studio in three fresh conversations. Each: turn 1 simple instruction, turn 2 follow-up.
4. Capture the `[TuningAgent] usage` line on each turn 2 (`grep '[TuningAgent] usage' staging-logs.txt`).
5. Paste all three lines verbatim into PROGRESS.md § F1.6. Acceptance: `cached_fraction ≥ 0.70` on all three.
6. Also verify `build_direct_fallback_total == 0` over the canary window.

If you can't deploy or can't collect the logs, STOP after F1.5 lands and write a "F1.6 pending-user-canary" note in PROGRESS.md. The sprint is partially done; that is acceptable.

## F9a protocol (Stream C, after F1 green)

1. `git log --oneline feat/057-session-a..feat/058-session-a -- frontend/components/studio/studio-chat.tsx`
2. For each commit, check whether it added / removed / made-conditional a `use*` hook.
3. Write `frontend/components/studio/__tests__/studio-chat.hooks-order.test.tsx` that reproduces the #310 by flipping `streaming` mid-stream while a new message arrives.
4. If the test fails (good — repro found), identify the root cause, write it into PROGRESS.md, fix in one commit.
5. If the test passes (repro missed), try the secondary suspect (057-A F1 tool-chain portal). If BOTH miss, defer F9a to 060 and write a "could-not-repro" note. DO NOT spend >2 hours here.
6. Soak: 10 mixed turns on staging, screenshot the console at zero errors, paste into PROGRESS.md § F9a.

## Close-out

Regardless of outcome:

1. Write `PROGRESS.md` § Sprint 059-A close-out: per-gate status (done / deferred / failed), test deltas (final vs 347/423), commit SHAs + subjects, canary evidence, F9a evidence.
2. `git mv specs/045-build-mode/NEXT.md specs/045-build-mode/NEXT.sprint-059-session-a.archive.md`
3. Write a fresh `specs/045-build-mode/NEXT.md` pointing at sprint-060 candidates:
   - A: Production rollout of direct transport (assuming 48-hour staging soak holds) + token-budget sprint if compaction overflows.
   - B: Mobile-responsive Studio (carried from 058 NEXT.md).
   - C: Operator-rationale feedback loop (carried from 058 NEXT.md).
   - D: Cross-artifact snapshots (carried from 058 NEXT.md).
4. Write a single-line summary in your final reply to the user:
   ```
   Sprint 059-A: F1 <done|partial|deferred>, F9a <done|deferred>, <M> commits, frontend <n>, backend <m>. Canary: cached_fraction = <x|pending-user-canary>.
   ```

If Stream A or Stream B hard-stopped before green, Stream C MUST NOT start F1.5. Close-out still runs — with deferred-to-060 markers on every unstarted gate and the failure dump from `/tmp/059-stream-<letter>-failure.md` pasted into PROGRESS.md.

## One more reminder

You are overnight. Silent-broken is worse than half-done. If anything looks off — unknown test failure, unexpected git state, a file you don't recognize, a tool that behaves strangely — STOP and dump. The user will wake up, read the dump, and decide. That is the correct behaviour for a 1M-context unsupervised run.

Good luck. Dispatch the three subagents now.

---
