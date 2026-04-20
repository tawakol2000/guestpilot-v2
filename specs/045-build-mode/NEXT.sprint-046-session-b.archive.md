# Sprint 046 — Session B: Cards + SSE parts

> Session 2 of 4 for sprint 046. Implements Phase B of
> [`sprint-046-plan.md`](./sprint-046-plan.md) §8.
>
> Owner: Abdelrahman. Branch: `feat/046-studio-unification` (continue
> on the branch Session A opened; do NOT branch off again).

---

## 0. Starting state (handed off by Session A)

All six Session-A gates are green; see PROGRESS.md "Sprint 046 —
Session A" for the full table. Highlights relevant to Session B:

- `get_current_state` tool exists and is in BUILD + TUNE allow-lists.
  Every scope in the discriminated-union payload is testable
  server-side. The agent is **not yet** instructed to call scopes
  beyond `summary` — the prompt update lands in Session B once the
  cards exist to render the returned text.
- Forced first-turn call emits `data-state-snapshot` with the
  `summary` scope payload. The frontend (Session C) will render this
  into the right-rail state card.
- Response Contract (7 rules) is live in the shared prefix; Triage
  Rules are in both mode addenda.
- `BuildToolCallLog` table exists + is getting written to per-turn
  via `hooks/tool-trace.ts`. Findings from the post-turn output
  linter persist as synthetic `__lint__` rows (log-only).
- Branch is NOT pushed yet — Session A's exit commits land together
  with any cleanup Session B inherits.

Decisions locked in Session A that affect Session B:

- Category-pastel palette **retained** (SOP yellow, FAQ teal,
  system_prompt blue, tool purple) — they survive the Linear/Raycast
  restraint pass because they're artifact-type labels, not chrome.
- Hash-state `/studio` tab, not a top-level Next.js route (shell
  merge is Session C, but frontend card components built in Session
  B must not assume a route-level page — they live in
  `frontend/components/studio/*`).
- The advanced raw-prompt editor (§6.5 of the plan) defers until
  sprint 047 UI surfacing; no frontend path for it in this sprint.

---

## 1. Read-before-you-start

Mandatory, in order:

1. [`CLAUDE.md`](../../CLAUDE.md) — constitution + critical rules.
2. [`sprint-046-plan.md`](./sprint-046-plan.md) — §§5.4 + 6.1 + 6.2
   in particular. Plan §§5.4 lists the four new SSE parts; plan §6.1
   describes the six new card components.
3. [`sprint-046-session-a.md`](./sprint-046-session-a.md) — context on
   what already shipped (especially the Response Contract verbatim
   and the emitDataPart / turnFlags plumbing).
4. [`PROGRESS.md`](./PROGRESS.md) "Sprint 046 — Session A" — current
   gate state + deferrals you are about to pick up.

Then read the code you'll touch:

- `backend/src/build-tune-agent/stream-bridge.ts` — SDKMessage →
  UIMessageChunk mapping. Add four new data-part passthroughs
  (suggested_fix, question_choices, audit_report, advisory).
- `backend/src/build-tune-agent/tools/*.ts` — two new tools:
  `ask_manager` and `emit_audit` (thin wrappers around
  `emitDataPart`).
- `frontend/components/tuning/tokens.ts` — source of the existing
  TUNE palette. Session B creates `frontend/components/studio/tokens.ts`
  as the sprint-046 palette (main-app tokens verbatim per plan §3.3).
- `frontend/components/build/plan-checklist.tsx` — extend item
  schema for `target` + `previewDiff` (plan §5.3).

---

## 2. Scope — in this session

Each item is a gate. Order matters.

### 2.1 SSE part types + stream-bridge pass-through

- Extend `stream-bridge.ts` with pass-through handling for four new
  types: `data-suggested-fix`, `data-question-choices`,
  `data-audit-report`, `data-advisory`. Existing
  `data-state-snapshot` + `data-build-plan` + `data-test-pipeline-result`
  stay as-is.
- Unit test: every new type round-trips through the bridge unchanged.

### 2.2 `ask_manager` + `emit_audit` tools

- `ask_manager({ question, options, recommended_default?, allowCustomInput? })`
  — emits `data-question-choices`. No DB write. Mode: both.
- `emit_audit({ rows, topFindingId })` — emits `data-audit-report`.
  No DB write. Mode: both.
- Register in `tools/index.ts` + both allow-lists in `runtime.ts`.
- Unit tests: 4 cases each (happy path, validation, emit path, edge).

### 2.3 Extended `plan-build-changes` item schema

- Add `target?: { artifactId?, sectionId?, slotKey?, lineRange? }`
  and `previewDiff?: { before, after }` to the item shape per plan
  §5.3.
- Update the 4-case `plan-build-changes.test.ts` fixture.

### 2.4 New React card components

All under `frontend/components/studio/`:

- `tokens.ts` (main-app palette per plan §3.3).
- `suggested-fix.tsx` — diff viewer + target chip + accept/reject.
- `question-choices.tsx` — 2–5 choice buttons + recommended-default.
- `audit-report.tsx` — compact status rows + "Fix" CTA on top finding.
- `state-snapshot.tsx` — right-rail card wired to the Session-A
  forced-first-turn `data-state-snapshot` payload.
- `reasoning-line.tsx` — one-line muted "Thought for Xs" collapse.

### 2.5 Prompt update — instruct the agent to pull richer scopes

Once the cards exist, the agent can be trusted to call
`get_current_state({scope:'system_prompt'|'sops'|...})` based on
intent. Update the shared prefix `<tools>` doc entry for
`get_current_state` to list the richer scopes and when to use each.
Re-run the cache-stability test + update baselines in PROGRESS.md.

### 2.6 Output-linter enforcement dial — still log-only

Session B keeps the linter in log-only mode. Session D flips the
drop-not-log switch after a week of trace calibration. No behaviour
change here, but verify the linter continues to fire after the new
tools land (single `__lint__` row per offending turn).

---

## 3. Out of scope

- Shell merge (`/studio` tab inside `inbox-v5.tsx`) → Session C.
- Old-route 302 redirects (`/build`, `/tuning`, `/tuning/agent`) →
  Session C.
- 48h cooldown removal + `data-advisory` recent-edit toast →
  Session D.
- Session-scoped rejection memory + cross-session deferral → Session
  D / sprint 047.
- Deleting `tuning-agent/index.ts` back-compat shim → Session D.
- Any frontend changes outside `frontend/components/studio/`.

---

## 4. Gate sheet

Tick off as each lands.

| Gate | Item | Status |
|------|------|--------|
| B1   | Four new SSE part types + stream-bridge pass-through | ☐ |
| B2   | `ask_manager` + `emit_audit` tools + allow-list wiring | ☐ |
| B3   | Extended `plan-build-changes` item schema | ☐ |
| B4   | `studio/tokens.ts` + five new card components | ☐ |
| B5   | `get_current_state` prompt update + cache baselines refresh | ☐ |
| B6   | Full suite green + `tsc --noEmit` clean + cards rendered in staging smoke | ☐ |
| B7   | PROGRESS.md updated + NEXT.md for Session C | ☐ |

---

## 5. Non-negotiables

- Never break the main guest messaging flow.
- Prisma changes apply via `prisma db push`, not migrations (CLAUDE.md).
- `BuildToolCallLog` insertion failures remain fire-and-forget; don't
  tighten the contract just because the admin view needs the data.
- Frontend cards must not import from `frontend/components/tuning/*`
  for chrome (palette or layout) — use the new `studio/tokens.ts`.
- Artifact-type category pastels are the one exception (plan §3.3
  decision #3).

---

## 6. Exit handoff

At session end, do all three:

### 6.1 Commit + push

Single commit per gate is fine. Push to
`feat/046-studio-unification` (the branch Session A opened).

### 6.2 Archive this NEXT.md

Move this file to `NEXT.sprint-046-session-a.archive.md`. Write a
fresh `NEXT.md` for Session C (shell merge — plan §8 Phase C).

### 6.3 Update PROGRESS.md

Append a "Sprint 046 — Session B" section mirroring Session A's
shape: gate table, cache baselines (if changed), decisions,
deferrals, blockers.

End of Session B brief.
