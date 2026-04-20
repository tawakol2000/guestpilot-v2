# Sprint 046 — Session A: Backend grounding + response contract

> Session 1 of 4 for sprint 046. Implements Phase A of
> [`sprint-046-plan.md`](./sprint-046-plan.md) §8.
>
> Owner: Abdelrahman. Branch: `feat/046-studio-unification` (new,
> branched off `feat/045-build-mode` — sprint 045 is NOT merged to
> main, so we build on top of it).

---

## 0. Read-before-you-start

These are mandatory reads, in order. Do not skim:

1. [`CLAUDE.md`](../../CLAUDE.md) — project constitution, tech stack,
   critical rules. §"Build & Run" for db/test commands. §"Critical
   Rules" are non-negotiable.
2. [`sprint-046-issues.md`](./sprint-046-issues.md) — the 23 raw
   issues this sprint must resolve. Issues #5, #6, #7, #9, #10, #12,
   #13, #22 are the ones Session A touches directly.
3. [`sprint-046-plan.md`](./sprint-046-plan.md) — the full refinement
   plan. You are executing §8 Phase A. You must read §§1, 4, 5, 8
   end-to-end. §10 is the coverage-check table — use it to sanity-
   check that your work addresses the intended issues.
4. [`PROGRESS.md`](./PROGRESS.md) §"Gate status" — sprint 045's final
   gate table. Gives you the starting code state.

Then read the code you'll touch:

- `backend/src/build-tune-agent/system-prompt.ts` — the three-region
  prompt assembly. You'll edit Region A and both mode addendums.
- `backend/src/build-tune-agent/runtime.ts` — the SDK turn loop. You'll
  inject a forced first-turn tool call here.
- `backend/src/build-tune-agent/tools/index.ts` + `get-context.ts` +
  `types.ts` — tool registration patterns.
- `backend/src/services/tenant-state.service.ts` — the current
  counts-only grounding you're replacing.
- `backend/prisma/schema.prisma` — where `BuildToolCallLog` lands.

---

## 1. Decisions locked for sprint 046 (defaulted, can be revisited)

From `sprint-046-plan.md` §12. Lock these in so downstream sessions
don't re-litigate:

1. `/studio` lives as a **hash-state tab** inside `inbox-v5.tsx`
   (`navTab === 'studio'`), not a top-level Next.js route.
2. The advanced raw-prompt editor (deferred to sprint 047 UI surfacing
   anyway) is **admin-only** when it ships.
3. Category pastels (SOP yellow, FAQ teal, system_prompt blue, tool
   purple) are **retained** — they are artifact-type labels, not
   chrome, and they survive the Linear/Raycast restraint pass.

Session A is 100% backend so only decision #1 is load-bearing here
(the forced-first-turn mechanic writes a `data-state-snapshot` that
the tab will render in session B/C).

---

## 2. Scope — in this session

Six concrete changes, each a commit. Order matters: later items
depend on earlier ones compiling.

### 2.1 New tool: `get_current_state`

- New file: `backend/src/build-tune-agent/tools/get-current-state.ts`.
- Input: `{ scope: 'summary' | 'system_prompt' | 'sops' | 'faqs' |
  'tools' | 'all' }`.
- Output payload: a discriminated union per scope (see plan §5.1).
  `summary` reuses the existing `TenantStateSummary`.
  `system_prompt` returns `{ text, sections: [{ id, title, range:
  [number, number] }] }` — derive sections from the existing
  `<section id="…">…</section>` or heading conventions already in
  the prompt template (whatever's there; inspect
  `config/default-prompts.*` and `services/ai-config.service` for
  structure). If no explicit structure exists today, emit a single
  section `{ id: 'body', title: 'Body', range: [0, text.length] }`
  — don't invent sectioning.
  `sops`, `faqs`, `tools` return the actual Prisma rows trimmed to
  the fields enumerated in plan §5.1.
  `all` is the union of all four non-summary scopes + summary.
- Register in `tools/index.ts`. Allow in **both** BUILD and TUNE
  mode allow-lists (`runtime.ts#resolveAllowedTools`).
- Unit tests at `backend/src/build-tune-agent/tools/__tests__/
  get-current-state.test.ts`. Minimum 5 cases:
  1. `summary` returns counts payload, no artifact text.
  2. `system_prompt` returns full text + sections array.
  3. `sops` returns all SOPs for tenant, including status variants
     + property overrides.
  4. `faqs` returns global + property-scoped entries.
  5. `all` is a strict superset of the others (no field loss).

Acceptance: `npm test -- get-current-state` green.

### 2.2 Forced first-turn call

- Edit `runtime.ts`. At the start of `runTurn` (or equivalent), if
  this is turn 1 of the conversation (check `conversation.turnCount
  === 0` or equivalent — use whatever signal the existing code
  exposes; if none, add a `BuildConversation.turnCount` column +
  prisma push), prepend a synthetic assistant message that forces a
  tool call to `get_current_state({ scope: 'summary' })` before the
  manager's message is processed.
- Emit a `data-state-snapshot` SSE part with the summary payload so
  the frontend (session C) can render the right-rail snapshot
  without an extra round-trip.
- Do NOT force the call on turn 2+ — the agent decides from that
  point forward.
- Unit test in `runtime.test.ts`: a fresh conversation's first turn
  calls `get_current_state` before any user-defined tool call.

Acceptance: `npm test -- runtime` green. Manual smoke: start a new
BUILD conversation in staging, confirm the tool call appears as the
first tool invocation in Langfuse.

### 2.3 Response Contract in shared prefix

- Edit `backend/src/build-tune-agent/system-prompt.ts`. Insert the
  Response Contract block from plan §4.1 into the shared prefix
  (Region A), positioned immediately after the existing "Principles
  of good editing" section and before the boundary marker
  `SHARED_MODE_BOUNDARY_MARKER`.
- Copy the block verbatim from plan §4.1 — 7 numbered rules. Don't
  paraphrase. Don't add rules the plan doesn't list.
- Re-run the existing `prompt-cache-stability.test.ts`. The Region A
  byte count will change; update the baseline in
  `PROGRESS.md` §"Cache metrics" and in the test's baseline
  constants. Confirm the token estimate stays within 500 tokens of
  the old baseline (2,856 → should land under ~3,356). If it
  exceeds that, pull the examples out of the contract into a
  non-cached surface instead of inflating the prefix.

Acceptance: `prompt-cache-stability.test.ts` passes with new
baseline; byte-identical renders per mode; shared prefix unchanged
across modes.

### 2.4 Triage Rules in mode addendums

- Same file. Append the Triage Rules block from plan §4.3 to BOTH
  the BUILD_ADDENDUM and TUNE_ADDENDUM, scoped to each mode's
  relevant tools (`get_current_state` is shared, but BUILD's
  `plan_build_changes` vs TUNE's `suggestion_action` differ).
- TUNE's triage: find a single highest-leverage suggestion rather
  than enumerating the queue. BUILD's triage: single-top-fix for
  audit-style prompts, single-question-at-a-time for interview-
  style prompts.
- Re-run `prompt-cache-stability.test.ts` again. Mode addendum byte
  counts change; update baselines. BUILD addendum stays under
  ~1,300 tokens; TUNE addendum under ~1,000.

Acceptance: tests pass, baselines updated in PROGRESS.md.

### 2.5 `BuildToolCallLog` model + insertion hook

- Prisma schema addition:

  ```prisma
  model BuildToolCallLog {
    id             String   @id @default(cuid())
    tenantId       String
    conversationId String
    turn           Int
    tool           String
    paramsHash     String   // sha1 of normalised input
    durationMs     Int
    success        Boolean
    errorMessage   String?
    createdAt      DateTime @default(now())

    @@index([tenantId, createdAt])
    @@index([conversationId, turn])
  }
  ```

- `npx prisma db push` to apply. No migration file per CLAUDE.md
  constitution.
- New service: `backend/src/services/build-tool-call-log.service.ts`
  with a single `logToolCall(input)` function. Fire-and-forget
  (`.catch(() => {})`), never blocks the turn.
- Wire it into `runtime.ts` where tools are dispatched. Log
  before/after each tool call with duration.
- 30-day retention is handled later (sprint 047 task); for now just
  write rows.

Acceptance: after running the new integration test in 2.6, the row
count in `BuildToolCallLog` equals the number of tool calls in the
turn.

### 2.6 Output linter (log-only)

- New file: `backend/src/build-tune-agent/output-linter.ts`.
- Three rules, each returning `{ severity, message, detail? }`:
  - R1: if turn emitted 0 structured data-parts AND final text > 120
    words → `severity: 'warn'`.
  - R2: if turn emitted >1 `data-suggested-fix` → `severity: 'warn'`
    with the count (session D enforces via drop).
  - R3: if any text part contains >2 lines matching `^\s*[-*]\s` or
    `^\s*\d+\.\s` → `severity: 'warn'` with line samples.
- Invocation: in `runtime.ts` at end-of-turn, run the linter, persist
  findings into `BuildToolCallLog` as a synthetic "lint" tool entry
  (tool=`'__lint__'`, params=`{ rules: ['R1', ...] }`). Never block
  the turn, never visible to the user yet.
- Unit tests for the linter: 6 cases (each rule pass + each rule
  fail).

Acceptance: `npm test -- output-linter` green.

---

## 3. Out of scope — explicitly deferred to later sessions

Do not touch these in session A, even if tempting:

- Frontend. Zero frontend changes this session. All changes ship dark.
- `get_current_state` scopes beyond `summary` being actually CALLED
  by the agent on its own — the plumbing must work but the prompt
  doesn't instruct the agent to pull `system_prompt`/`sops`/etc. on
  its own yet. That goes in session B when the audit/suggested-fix
  cards exist.
- 48h cooldown removal — session D.
- Session-scoped rejection memory — session D.
- The new `ask_manager` / `emit_audit` tools — session B (they need
  the SSE part types which ship in session B).
- Deleting the `tuning-agent/index.ts` shim — session D.
- Updating the back-compat shim imports.

If you find yourself editing `frontend/`, stop. Revert. You're out
of scope.

---

## 4. Sequencing + gate sheet

Tick off as each lands. Don't move the next gate until the prior is
green (`tsc --noEmit` + `npm test` + manual smoke).

| Gate | Item                                    | Status |
|------|-----------------------------------------|--------|
| A1   | `get_current_state` tool + 5 unit tests | ☐      |
| A2   | Forced first-turn call in runtime       | ☐      |
| A3   | Response Contract in shared prefix      | ☐      |
| A4   | Triage Rules in both mode addendums     | ☐      |
| A5   | `BuildToolCallLog` model + service      | ☐      |
| A6   | Output linter (log-only) + unit tests   | ☐      |
| A7   | Full `build-tune-agent` test suite green + `tsc --noEmit` clean | ☐ |
| A8   | PROGRESS.md updated + NEXT.md for Session B written | ☐ |

---

## 5. Success criteria (this session)

Session A is done when all of these are true:

- S-1. A fresh BUILD conversation's first turn calls
  `get_current_state({scope: 'summary'})` before any user-intent
  tool call. Verified in a Langfuse trace or an integration test.
- S-2. The shared system prompt Region A contains all 7 Response
  Contract rules verbatim; `prompt-cache-stability.test.ts`
  baseline updated.
- S-3. Both mode addendums contain the Triage Rules block; mode
  addendum token counts stay within budget.
- S-4. `BuildToolCallLog` rows are written for every tool call in
  an E2E smoke run. One row per call, success + duration recorded.
- S-5. Output linter runs post-turn on every request, writes
  synthetic `__lint__` entries to `BuildToolCallLog` when rules
  fire. Never user-visible in this session.
- S-6. `tsc --noEmit` clean. `npm test` green across
  `build-tune-agent/*` + new services. No skipped tests added.
- S-7. `PROGRESS.md` gained a new "Sprint 046 — gate status"
  subsection with A1–A8 ticked; cache baselines updated.
- S-8. `NEXT.md` rewritten for Session B (the existing sprint-045
  close NEXT.md is archived to `NEXT.sprint-045-close.archive.md`).

---

## 6. Non-negotiables (from CLAUDE.md + sprint 045 hard-learned)

- Never break the main guest messaging flow. The AI pipeline in
  `ai.service.ts` must not regress. If any change to system-prompt
  assembly or tool registration could affect the main pipeline,
  confirm `ai.service` calls a different prompt path and add a
  regression test.
- Never expose access codes to INQUIRY-status guests. Not at risk
  this session (backend-agent only), but keep in mind if you touch
  any code path that renders a guest-facing message.
- Never commit secrets. Prisma changes apply via `prisma db push`,
  not migrations, per CLAUDE.md constitution.
- Graceful degradation: if `BuildToolCallLog` insertion fails, the
  turn must still succeed. Fire-and-forget with catch.
- `AgentMemory` / prisma: additive only. No column renames, no
  column drops this session.
- Do not push without tests green locally. Railway auto-deploys
  `feat/046-studio-unification` — a bad push is a bad deploy.

---

## 7. Exit handoff

At session end, do all three:

### 7.1 Commit + push

Single commit per gate is fine; squash is not required. Branch:
`feat/046-studio-unification`. Push with `--set-upstream origin
feat/046-studio-unification` on first push.

### 7.2 Archive the current NEXT.md

Move `specs/045-build-mode/NEXT.md` →
`specs/045-build-mode/NEXT.sprint-045-close.archive.md`. That file
is sprint 045's post-close handoff and isn't relevant to sprint 046
execution anymore.

### 7.3 Update PROGRESS.md and write NEXT.md

PROGRESS.md — append a new section:

```markdown
## Sprint 046 — Session A (Phase A: backend grounding + response contract)

Completed: YYYY-MM-DD.

| Gate | Item | Status | Notes |
|------|------|--------|-------|
| A1   | ...  | ✅     | ...   |
| ...  | ...  | ...    | ...   |

### Cache baselines (post-Session A)

| Slice | Chars | Est. tokens | Delta vs sprint-045 close |
|-------|-------|-------------|----------------------------|
| Region A (shared prefix) | ... | ... | ... |
| TUNE cacheable | ... | ... | ... |
| BUILD cacheable | ... | ... | ... |

### Decisions made this session

- (short bullet per non-obvious decision)

### Deferred to next session

- (any scope that slipped)
```

NEXT.md — rewrite completely for Session B. Section skeleton:

```markdown
# Sprint 046 — Session B: Cards + SSE parts

## Starting state (handed off by Session A)

- [what's landed on the branch, verbatim from PROGRESS.md gate
  table]
- [any decisions that affect session B]

## Read-before-you-start

- sprint-046-plan.md §§5.4, 6.1
- sprint-046-session-a.md (this file) — for context on what already
  shipped

## Scope

(mirror of plan §8 Phase B items, each as a gate)

## Out of scope

(explicit deferrals to session C/D)

## Gate sheet

| Gate | Item | Status |
| B1   | ...  | ☐      |
| ...  | ...  | ...    |

## Exit handoff

(same three-step pattern: commit/push, archive this NEXT, write
NEXT for session C)
```

Do NOT update `MASTER_PLAN.md` or `sprint-046-plan.md` except to fix
factual errors. The plan is the spec; the session docs are the
execution log.

---

## 8. Help channels

- If a test infrastructure assumption breaks (Prisma seed shape,
  env-var defaults, `ai.service.ts` dependency), stop and surface
  it in PROGRESS.md "Decisions made this session" → "Blocked /
  surfaced". Don't paper over it with a skipped test.
- If `prompt-cache-stability.test.ts` baselines drift more than
  ~500 tokens off prior values, stop and re-evaluate the
  Response Contract verbatim — it might need to move out of the
  prefix and into a dynamic-suffix include.
- If the SDK session-resume recovery path breaks because of a new
  tool registration, revert the `allow`-list change and log the
  finding. The runtime fallback behaviour is non-negotiable.

End of session brief.
