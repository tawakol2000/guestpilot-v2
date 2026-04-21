# Sprint 056 — Session A — Compose-at-Cursor + Ask-the-Past + Cache + Polish

**Branch:** `feat/056-session-a` (stacks on `feat/055-session-a` → 054-A → 053-A → 052-A → 051-A → 050-A → main)
**Parent tip expected:** tip of `feat/055-session-a` after F5 close-out (`ae863fc` per the user's 055-A report — verify with `git rev-parse` at session start).
**Session type:** A — big frontend feature + small backend retrieval tool + infra cache tune + two polish items.
**Brainstorm §:** §11 (direct-manipulation drawer, continued) + §14 (historical-rationale retrieval) + §16 (infra hygiene) + 055-A post-ship gaps.
**Length discipline:** five gates, but three are small. Dispatch subagents aggressively.

---

## 0. Why this sprint exists

055-A made the drawer editable. But inline-edit only works when the operator already knows the fix. Half the time they just *see* something's off — tone, length, a missing clause — and want to describe it in words against the specific span they're looking at. That's what **compose-at-cursor** solves: highlight text in the drawer → mini scoped chat bubble pops up → agent edits only that span. Inline-edit is for "I know the words." Compose-at-cursor is for "make this shorter."

054-A started capturing rationale on every write. 055-A added operator-rationale on top. But the agent doesn't currently **read** any of it back. When the manager asks "why did we change the late check-in SOP last week?" the agent fabricates an answer from generic priors, not from the stored rationale. **Ask-the-past** fixes that with a small retrieval tool + prompt nudge.

Separately, the Claude Console is reporting zero cache hits on the `guest pilot` workspace. The system prompt already has documented cache-boundary markers (see `system-prompt.ts` — `__SHARED_MODE_BOUNDARY__`, `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__`). The existing comment assumes Anthropic's automatic prefix caching handles it, but the telemetry line that's been in `runtime.ts` for months will tell us if that's true. **Prompt caching** gate verifies, then either confirms we're already caching (and the console is lagging) or wires explicit `cache_control` blocks.

Two polish items ride along: row-click on the plan checklist (055-A left this as dead click surface — only hover `+` worked), and a rollback CTA on failed test rituals (so managers don't hunt through the ledger after a `0/3 passed`).

---

## 1. Non-negotiables

- **`ai.service.ts` stays untouched.** Guest-reply pipeline is on OpenAI and is not in scope.
- **Schema change:** none. `get_edit_history` queries the existing `BuildArtifactHistory` table. Compose-at-cursor uses component state + existing apply endpoint. Cache gate changes how the system prompt is passed, not what's stored.
- **Apply in the drawer is still the only write gate.** Compose-at-cursor produces a preview the manager then Applies — it does NOT write directly.
- **Sanitiser parity holds.** Agent-generated spans from compose-at-cursor go through the same sanitiser as any other body write.
- **Graceful degradation.** Missing cache capability → warn-log, don't fail the turn. `get_edit_history` with zero rows → returns empty array, agent responds in natural language ("I don't have a record of changes to this artifact").
- **Branch discipline.** Stack on `feat/055-session-a`. Do NOT rebase onto main.

---

## 2. Pre-flight gate

### 2.1 Branch-tip verification

```
git rev-parse feat/050-session-a feat/051-session-a feat/052-session-a feat/053-session-a feat/054-session-a feat/055-session-a
```

Write actual SHAs into `specs/045-build-mode/PROGRESS.md`. Expected `feat/055-session-a` tip from user's report: `ae863fc`.

### 2.2 Baseline test counts

```
cd frontend && npm test -- --run
cd backend && npm test
```

Expected from 055-A close-out: frontend 195/195. Record backend number at session start.

### 2.3 Cache telemetry baseline (F3 prerequisite)

BEFORE writing any code, run a real BUILD-mode turn against the staging tenant and inspect:

```
grep "\[TuningAgent\] usage" backend/logs/*.log | tail -5
```

(Or tail the dev server during a manual turn.) Record the `cache_read` and `cached_fraction` numbers on turn 1 and turn 2 of the same conversation. This is the baseline. If `cache_read=0` on turn 2, the automatic-caching assumption is wrong and F3 must wire explicit `cache_control`. If `cache_read>0` and `cached_fraction>0.5`, F3 is mostly a console/LangFuse investigation (why doesn't the dashboard show it?).

---

## 3. Gates

Five gates. Parallelizable as: **Stream A = F1** (frontend-heavy), **Stream B = F2 + F3** (backend only, both in `build-tune-agent/`), **Serial merge = F4 + F5** after A + B land.

### F1 — Compose-at-cursor in the drawer

**Scope:** text selection inside the drawer's preview or read view opens a small inline chat affordance scoped to the selected span. Agent's reply is merged back into the preview buffer; manager then Applies.

**Interaction:**
- Operator selects a text range inside the drawer body (read or preview mode, markdown or plain).
- A floating bubble anchored near the selection appears with a single-line input: "ask or tell the agent about this span".
- Submit → emits a scoped agent turn with context: `{ artifactId, artifactType, selection: { start, end, text }, surroundingBody }` and the operator instruction.
- Agent returns a proposed replacement span (NOT a full-body rewrite). Rendered as a before/after diff inside the bubble with Accept / Redo / Dismiss.
- Accept → merges the replacement into the drawer's preview buffer (same buffer 055-A F2 inline-edit writes to). Apply button still gates the actual write.
- Redo → same prompt box reappears, with the prior reply as context. Up to 3 redos.
- Dismiss or Esc → bubble closes, preview buffer unchanged.

**Scoping constraint:** the agent MUST NOT rewrite outside the selection span. Enforce via prompt ("replace only the highlighted text, return only the replacement") AND a post-response validator that rejects multi-paragraph expansions if the original selection was a single line. Fail closed — on validator reject, show "The agent returned more than the selection. Try a narrower ask." rather than silently applying a bigger change.

**Backend surface:** a new small endpoint `POST /api/build/compose-span` (non-streaming — the composition is short, streaming isn't worth the complexity). Request: `{ artifactId, artifactType, selection, instruction }`. Response: `{ replacement, rationale }`. This endpoint calls a restricted BUILD-agent query with a fresh system prompt variant that's span-scoped, not a full-artifact system prompt. Reuse the existing Claude Agent SDK plumbing but with `allowedTools: []` (the composer doesn't need tools — it only returns text).

**Frontend tests:**
- Selection event fires the bubble at the right anchor position.
- Submit posts the expected payload to `/api/build/compose-span`.
- Accept merges the replacement at the correct `{start, end}` into the buffer (not at cursor position — at the stored selection range, even if cursor moved).
- Redo preserves bubble state; Dismiss restores prior buffer; Esc closes.
- Validator-reject renders the "try a narrower ask" message.

**Backend tests:**
- `/api/build/compose-span` returns a replacement string bounded by the selection-size heuristic.
- Tenant-scoped: request for another tenant's `artifactId` returns 404.
- Rate-limited: >10/min per conversation → 429.

**Acceptance:** manager highlights "Check-in is at 4pm" inside a SOP, types "make it sound warmer", bubble returns "Check-in is any time after 4pm — we'll have a warm welcome ready for you", Accept → preview updates → Apply writes.

### F2 — Ask-the-past (`get_edit_history` tool)

**Scope:** new BUILD-agent tool `get_edit_history` that queries `BuildArtifactHistory` by artifact target. Prompt nudge in the BUILD system prompt tells the agent to call it on "why / when / who" questions about existing artifacts.

**Tool definition** (`backend/src/build-tune-agent/tools/get-edit-history.ts`):

```
get_edit_history({
  artifactType: 'sop' | 'faq' | 'system_prompt' | 'tool' | 'property_override',
  artifactId: string,
  limit?: number,  // default 10, max 50
}) →
  {
    rows: [
      {
        appliedAt: ISO,
        operation: 'CREATE' | 'UPDATE' | 'DELETE' | 'REVERT',
        rationale: string | null,
        operatorRationale: string | null,
        rationalePrefix: string | null,  // e.g. 'edited-by-operator'
        appliedByUserId: string | null,
      }
    ]
  }
```

Tenant-scoped via the existing `ToolContext`. Results ordered newest-first.

**Prompt nudge** in `system-prompt.ts` Region B (BUILD mode addendum):

> When the manager asks about the *history* of a specific artifact — why it was changed, when, or by whom — call `get_edit_history` BEFORE responding. Do not rely on conversation scrollback; scrollback is incomplete. If the tool returns zero rows, say so honestly.

**Out of scope:** cross-artifact "what changed this week" queries (different tool, later sprint). Free-text search over rationales (would need a different index).

**Backend tests:**
- Tool returns rows in DESC order by `appliedAt`.
- Tenant isolation: tool called under tenant A for artifact owned by tenant B → empty result (not 404, tool-level graceful).
- Limit respected; default=10 when absent.
- Rationale-prefix passes through unchanged.

**Acceptance:** "Why did we change the late-checkout SOP last month?" → agent calls `get_edit_history`, receives 3 rows, quotes the stored rationale from the matching row in its reply.

### F3 — Prompt caching verification + explicit `cache_control`

**Scope:** starts with verification (§2.3 baseline), then wires explicit `cache_control` if needed. The existing system-prompt boundary markers already exist — this gate makes them functional.

**Step 1 — verify (required, output goes in PROGRESS.md):**
- Run 2-turn BUILD conversation. Read the `[TuningAgent] usage` log.
- If turn 2 `cache_read > 0` AND `cached_fraction > 0.5`: caching is working. The Console is likely just lagging. Document this, spot-check LangFuse for `cache_read_input_tokens`, and consider the gate a no-op (commit is just the documentation). Skip step 2.
- If turn 2 `cache_read = 0`: the SDK is NOT attaching `cache_control` for us. Proceed to step 2.

**Step 2 — wire explicit cache_control (only if step 1 says so):**
- Change `runtime.ts` so `systemPrompt` is passed as an **array of content blocks** with `cache_control` breakpoints, not a flat string. Requires the Agent SDK to accept structured system prompts — if the SDK's `options.systemPrompt` is string-only, bypass the SDK convenience and call `@anthropic-ai/sdk` directly for this one turn.
- Split the assembled prompt at `__SHARED_MODE_BOUNDARY__` and `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__`:
  - Block 1: Region A (shared). `cache_control: { type: 'ephemeral' }`.
  - Block 2: Region B (mode addendum). `cache_control: { type: 'ephemeral' }`.
  - Block 3: Region C (dynamic suffix). NO cache_control.
- Also attach `cache_control` to the tool-definitions array's last tool (per Anthropic's docs — caches the whole tools block).

**Tests:**
- `prompt-cache-stability.test.ts` already exists — extend it to assert the three-block structure is emitted when cache_control path is active.
- Golden-file test: Region A is byte-identical across two different BUILD turns of the same tenant/mode (required for cache hits).
- Integration test: mock SDK call, assert `cache_control` is present on exactly the documented blocks.

**Instrumentation:**
- Add a one-line `data-cache-stats` SSE part emitted at turn end with `{ cacheReadTokens, cacheCreatedTokens, inputTokens, cachedFraction }`. Do NOT render it in the UI — it's for LangFuse tagging and for the close-out verification.
- LangFuse tag: `cache_hit_fraction` on the trace.

**Acceptance:** turn 2 of a fresh conversation logs `cached_fraction >= 0.70`, confirmed via the `[TuningAgent] usage` line AND LangFuse trace tags. The Console dashboard should start reflecting it within a few minutes (per the console's own "can take a few minutes" note).

### F4 — Plan-row click opens the drawer

**Scope:** in `plan-checklist.tsx`, row click (not just hover `+`) opens the artifact drawer for that plan item's target. For `✓ done` rows, opens in history-view; for `● current` / `○ pending`, opens in preview-if-available-else-empty state.

Resolve the artifact ID from the plan item:
- If `item.target.artifactId` is set, use it directly.
- Otherwise, look up the `BuildArtifactHistory` row matching `{type, name, transactionId}` and use the `artifactId` from there.
- If neither resolves (pending item with no write yet), show a toast: "This artifact hasn't been written yet — it'll open here when the agent writes it."

Don't conflict with the hover `+`: clicking the `+` stays composer-seed; clicking anywhere else on the row opens the drawer. Event.target check.

**Frontend tests:**
- Click on a `✓ done` row opens drawer in history-view for that artifact.
- Click on a `○ pending` row (no write yet) shows the toast.
- Click on the hover `+` still seeds composer, does NOT open drawer (event stopPropagation).

**Acceptance:** the plan checklist is now a navigation surface, not just a progress indicator.

### F5 — Test-failure inline rollback CTA

**Scope:** in `test-pipeline-result.tsx`, when `aggregateVerdict !== 'all_passed'` AND `sourceWriteHistoryId` is present, show a secondary "Roll back this write" button next to the per-variant rows. Clicking calls the existing revert endpoint (`POST /api/build/history/:id/revert` from 053-A D4 — verify path).

Prompt nudge in the BUILD system prompt Region B (BUILD only): when a test ritual returns `0/3 passed`, the agent's follow-up message should explicitly mention "if this isn't what you wanted, you can roll back from the card above" — giving the button a narrative anchor.

Confirmation dialog before revert (reuse `ConfirmRollbackDialog` from plan-checklist). Toast on success. If the history row has already been reverted, disable the button with a "Already rolled back" tooltip.

**Frontend tests:**
- Button only renders when `aggregateVerdict !== 'all_passed'` AND `sourceWriteHistoryId` is present.
- Click flow: confirm dialog → revert call → success toast → button disables.
- Graceful when revert endpoint errors: toast, button re-enables.

**Acceptance:** after a `0/3 passed` ritual, the rollback is one click away, not a ledger hunt.

---

## 4. Parallelization plan (REQUIRED — dispatch subagents)

Three work-streams. Dispatch the first two in a **single message** (two Task calls in parallel). Run F4 + F5 yourself serially after both return.

- **Stream A (frontend — F1 compose-at-cursor):** owns the new composer bubble component, drawer selection capture, `/api/build/compose-span` endpoint scaffolding (route + controller stub), and all F1 tests.
- **Stream B (backend — F2 + F3):** owns `get-edit-history.ts` tool, system-prompt Region B nudge for F2, cache verification + explicit `cache_control` wiring for F3, and all F2/F3 tests. Both live in `build-tune-agent/` — single stream prevents merge conflicts on `system-prompt.ts` and `runtime.ts`.
- **Serial (you) — F4 + F5:** two small UI merges on top of A + B. ~1 hour combined.

Dispatch pattern:

```
Task(subagent_type: "general-purpose",
     description: "Stream A: compose-at-cursor",
     prompt: [F1 scope + non-negotiables + tests + pre-flight SHAs, verbatim])

Task(subagent_type: "general-purpose",
     description: "Stream B: ask-the-past + prompt caching",
     prompt: [F2 + F3 scope + non-negotiables + tests + pre-flight SHAs, verbatim.
              Include the §2.3 cache telemetry baseline as step 1.])
```

Each subagent lands its gate(s) as a single commit on `feat/056-session-a`. If either fails, re-dispatch with the failure pasted in.

---

## 5. Close-out checklist

- [ ] Five gates shipped as commits on `feat/056-session-a`
- [ ] Frontend tests green; backend tests green; record deltas in PROGRESS.md
- [ ] F3 cache verification result recorded in PROGRESS.md (before/after `cached_fraction` numbers)
- [ ] Manual smoke: highlight a SOP line in the drawer, compose "make it warmer", Accept, Apply; then ask the agent "why did we change this SOP?" and confirm it cites the stored rationale; then click a plan row and confirm the drawer opens
- [ ] Check Claude Console cache dashboard 10-15 minutes after F3 deploy — confirm it now registers hits
- [ ] NEXT.md written for sprint-057 (candidate: session-wide diff summary, or verify-without-writing, or the deferred 049 P1 sweep)
- [ ] Archive this spec to `NEXT.sprint-056-session-a.archive.md` at close

---

## 6. Risks + mitigations

- **Compose-at-cursor selection anchoring drifts** on re-render (React commits can move DOM). Mitigation: store selection as `{start, end}` character offsets into the body text, NOT as DOM ranges. Re-derive DOM range from offsets each render.
- **Agent expands the replacement beyond the selection.** Mitigation: validator rejects multi-paragraph replacements for single-line selections; prompt says "return only the replacement text, no preamble".
- **`get_edit_history` pulls sensitive rationale** that shouldn't be surfaced to non-admin operators. Mitigation: existing BUILD-agent tenant scoping already limits this; no new admin posture needed since rationale is already surfaced in the ledger (054-A F2).
- **F3 step 2 requires bypassing the Agent SDK** if its `systemPrompt` option is string-only. Mitigation: if SDK doesn't support block-array systems, the smallest fix is a direct `@anthropic-ai/sdk` call gated behind the same model/tool config. Budget a half-day contingency.
- **Plan-row click conflicts with future row-inline-actions.** Mitigation: F4's event-target check is explicit; adding more per-row buttons later requires the same pattern.

---

## 7. Explicit out-of-scope

- Cross-artifact history search ("what changed this week across all SOPs").
- Rich-text composer bubble — keep it a plain single-line input.
- Model-routing for compose-at-cursor (e.g. Haiku for short spans). One model, same as main BUILD agent.
- Agent-consumed operator-rationale loop (reading `metadata.operatorRationale` to adjust future behavior). Still deferred.
- Session-wide diff summary. Candidate for sprint-057.
