# Sprint 047 — Session C: scope and handoff

> Third session of sprint 047. Scope: the carry-overs from Sessions A
> and B plus the design exercise that's been punted since sprint 046
> §4.4 (cross-session rejection memory). Also soaks up whatever the
> end-of-stack merge's staging wet-test surfaces, which may reshape
> scope on arrival.
>
> Owner: Abdelrahman. Base branch: `feat/047-session-c` off
> `feat/047-session-b` (HEAD `fd63b36` at Session B close).
> End-of-stack merge-to-main strategy (`merge -X theirs` on the full
> 045→046→047-A→047-B→047-C chain) remains unchanged — Session C
> branches from 047-B directly, no intermediate merges.

---

## 0. Read-before-you-start

Mandatory, in order:

1. [`CLAUDE.md`](../../CLAUDE.md) — project constitution.
2. [`PROGRESS.md`](./PROGRESS.md) "Sprint 047 — Session B" — what B
   landed, the admin-role model gap, and the end-of-stack-merge
   decision.
3. [`sprint-046-plan.md`](./sprint-046-plan.md) §4.4 — the cross-
   session rejection-memory spec. This session implements it.
4. [`sprint-046-plan.md`](./sprint-046-plan.md) §6.5 — the raw-prompt
   editor drawer spec. This session ships it (admin-only).
5. [`validation/sprint-047-session-a-staging-smoke.md`](./validation/sprint-047-session-a-staging-smoke.md)
   — still open. If the end-of-stack wet-test surfaces any of the
   four failure modes, fix them here on `feat/047-session-c` before
   moving on to the new scope below.

---

## 0.1 Pre-flight — end-of-stack merge-to-main wet-test

Before cutting `feat/047-session-c`, confirm with Abdelrahman:

- **Have the 045→046→047-A→047-B commits been `merge -X theirs`'d to
  main yet?** If yes, branch `feat/047-session-c` off main. If no,
  branch off `feat/047-session-b` directly (HEAD `fd63b36`) and
  expect a later end-of-stack merge.
- **Has the staging wet-test been run?** If yes and it passed, mark
  `validation/sprint-047-session-a-staging-smoke.md` with `Status: ✅
  PASSED on YYYY-MM-DD` and the deploy sha. If it failed, the
  failing check(s) become Session C's first unit of work (see §1.5).
  If it hasn't been run, proceed on the same footing Session B used
  — noting the outstanding gate in PROGRESS.md.

---

## 1. Scope — Session C

Four items plus a contingency slot. Order by leverage and risk.

### 1.1 Cross-session rejection memory

Plan §4.4 deferral. Session-scoped memory (`session/{conv}/rejected/
{hash}`) ships today; this session designs + implements the durable
equivalent so a fix the manager hated last week stops getting
re-proposed in a fresh conversation.

**Design questions to resolve at kickoff, not during build:**

- **Cardinality unit.** Per-tenant vs per-(tenant, artifact) vs
  per-(tenant, artifact, sectionOrSlot). Finer-grained = a single
  bad rejection doesn't poison future suggestions; coarser = easier
  to reason about. Recommend per-(tenant, artifact, fixHash) —
  mirrors the session-scoped shape exactly, just lifted to durable
  storage.
- **TTL.** Session-scoped is forever within a conversation;
  cross-session needs a decay story. 30d matches `BuildToolCallLog`
  retention (B4). 90d gives more signal. "Never decay" risks stale
  rejections blocking genuinely-improved fixes. Recommend 90d with
  a single column so the retention sweep can be added later.
- **Prisma model shape.** Dedicated `RejectionMemory` table vs
  reusing `AgentMemory` with a durable-key prefix. Dedicated table
  is recommended — clean FK cascade on `Tenant` delete, own indexed
  columns for the lookup path, own retention sweep.
- **Agent surfacing.** The session-scoped version nudges the agent
  to consult memory before emitting. Cross-session needs the same
  shape, but the agent should be told *why* a fix was previously
  rejected (if a rationale was captured). If no rationale, say so
  plainly and treat as a weaker signal.

**Deliverable:** Prisma model + write path from
`build-tune-agent/memory/service.ts` + read path injected into the
propose-suggestion precheck + integration tests + one-page design
doc at `specs/045-build-mode/cross-session-rejection-memory.md`.

### 1.2 Raw-prompt editor drawer (admin-only)

Plan §6.5. Power users who used `/tuning/agent` before it redirected
still lose their tool until this ships. Admin-only is deliberate —
this is a escape hatch, not a feature for tenant operators.

Scope:
- New drawer inside Studio's right rail (same gear-menu pattern as
  B3's trace drawer; mount gated on
  `capabilities.traceViewEnabled + capabilities.isAdmin`, possibly
  behind a distinct `ENABLE_RAW_PROMPT_EDITOR` env flag if product
  wants finer control).
- Fetch the assembled system prompt for the current conversation
  (reuse the build-tune-agent's `buildSystemPrompt` composer).
- Present the three regions (shared / dynamic / session-scoped)
  read-only by default, with an "Edit region" button per region.
  Manual edits save as a `TenantAiConfig` override.
- Save-path integration: flag the override as `origin: 'raw-editor'`
  so audit trails can distinguish operator hand-tuning from
  agent-driven writes.

### 1.3 Pre-existing `tsc` drift cleanup

Six files outside 047-B's touch radius emit `tsc` errors on the
session base: `sandbox-chat-v5`, `tools-v5`, `calendar-v5`,
`configure-ai-v5`, `inbox-v5`, `listings-v5`. Catalogued in Session B
PROGRESS. Clean-up is a housekeeping item:

- Grep each file for the types it references and correct the
  union/optional chain errors. Some (`Stats | undefined`) are genuine
  `strictNullChecks` gaps; others (`sopReasoning` on the AI meta
  type) are schema-drift artifacts from old shapes.
- Per-file commits so a regression can be reverted surgically.
- Goal: `tsc --noEmit` clean on `frontend/` so future sessions
  can include tsc in their gate without noise.

Out of scope if time-boxed: bigger refactors the errors might hint
at. Fix the types, don't rewrite the components.

### 1.4 Stub-deletion traffic verification

B5's decision log flagged this as deferred. Before Session C closes:
- Pull Vercel analytics (or Railway route logs) for the 7 days
  following the B5 deploy.
- If any of `/build`, `/tuning`, `/tuning/agent` drew >5 hits/day,
  restore a pinned Studio deep link (not the old redirect) so the
  click still goes somewhere useful and we can filter the traffic
  in later analytics.
- If all three are quiet, drop a line in PROGRESS.md marking the
  decision as fully settled and close the loop.

### 1.5 Contingency: Session A staging smoke fallout

If the end-of-stack merge's wet-test surfaces any of the four C-1/
C-2/C-4/C-5 failures from
`validation/sprint-047-session-a-staging-smoke.md`, Session C's
first commit is the fix. The affected gate work (1.1–1.4) defers
until the base is healthy.

---

## 2. Out of scope — explicitly deferred

- **R1 persist-time truncation (Path B).** Still conditional on
  Langfuse prose-heavy-turn data from production.
- **Dashboards merge into main Analytics tab.** Plan §9; depends on
  operator feedback on the standalone panel.
- **R2 enforcement observability dashboard.** Langfuse work, outside
  the code-session pattern.
- **Oscillation advisory on BUILD writes.** Requires a confidence
  signal on BUILD creator tools that doesn't exist today.
- **Per-user admin distinctions.** The `Tenant.isAdmin` model from
  B2 conflates tenant-owner and platform-admin. If product needs a
  finer split (e.g., individual operators on a shared tenant),
  migrate to a User model in a dedicated sprint.

---

## 3. Non-negotiables

- `ai.service.ts` untouched. Main guest pipeline is not in scope.
- Prisma changes via `prisma db push`, not migrations.
- Trace view and raw-prompt editor stay admin-only. No weakening
  for convenience.
- Do not push without tests green locally. Railway + Vercel
  auto-deploy — a bad push is a bad deploy.
- Cross-session rejection memory must degrade gracefully: if the
  DB lookup fails, the agent proposes the fix rather than
  hard-silencing suggestions. Missing memory ≠ no-suggestion.

---

## 4. Sequencing + gate sheet

| Gate | Item                                                         | Status |
|------|--------------------------------------------------------------|--------|
| C1   | Cross-session rejection memory: Prisma model + write/read    | ☐      |
| C2   | Cross-session rejection memory: design doc + integration tests | ☐   |
| C3   | Raw-prompt editor drawer (admin-only)                        | ☐      |
| C4   | Pre-existing `tsc` drift cleanup (6 files)                   | ☐      |
| C5   | Stub-deletion traffic verification + loop closure            | ☐      |
| C6   | Backend + frontend suites green; `tsc --noEmit` clean         | ☐      |
| C7   | PROGRESS.md updated + NEXT.md rewritten for Session D/close  | ☐      |

Order: C1 → C2 → C3 → C4 → C5 → C6 → C7. C1+C2 can be parallelised
inside the session but land as separate commits. If §1.5
contingency triggers, prepend it as C0.

---

## 5. Success criteria

- **SC-1.** A fix rejected in conversation A is detectably suppressed
  (or surfaced with a prior-rejection advisory) when proposed again
  in conversation B, same tenant, within the TTL.
- **SC-2.** The cross-session design doc exists at
  `specs/045-build-mode/cross-session-rejection-memory.md` with
  decisions on cardinality / TTL / shape recorded.
- **SC-3.** Admin raw-prompt editor drawer mounts behind the same
  capabilities gate as the trace drawer; round-trips an edit to a
  `TenantAiConfig` override with `origin: 'raw-editor'`.
- **SC-4.** `tsc --noEmit` clean on frontend, no pre-existing errors
  left.
- **SC-5.** Traffic-verification loop on the deleted stubs is
  closed — either zero-hits confirmed or a pinned-link restore
  deployed.
- **SC-6.** All backend + frontend test suites green locally.
- **SC-7.** PROGRESS.md gains a Session C subsection with gates +
  decisions + deferrals.
- **SC-8.** NEXT.md rewritten for whatever comes next — likely
  sprint-047 close + a brief sprint-048 kickoff.

---

## 6. Exit handoff

Three steps, same pattern as Sessions A and B:

### 6.1 Commit + push

Per-gate commits. Branch `feat/047-session-c`. Push with
`--set-upstream` on first push.

### 6.2 Archive the current NEXT.md

Move `specs/045-build-mode/NEXT.md` →
`specs/045-build-mode/NEXT.sprint-047-session-c.archive.md`.

### 6.3 Update PROGRESS.md and write NEXT.md for whatever follows

If sprint-047 closes with Session C, NEXT.md becomes the sprint-048
kickoff. Otherwise it's a Session D scope sheet. Either way, the
end-of-stack merge-to-main is the remaining non-code action — flag
in the handoff so it doesn't drift.

---

## 7. Help channels

- If the cross-session rejection memory design surfaces a
  cardinality question that can't be resolved at kickoff (e.g.,
  operator feedback contradicts §1.1's recommendation), stop and
  surface in PROGRESS.md "Decisions made → Blocked". The wrong
  cardinality unit is expensive to migrate later.
- If the raw-prompt editor drawer turns out to need deep changes to
  the `buildSystemPrompt` composer (not just a read-through), land
  only the read-through path this session and file the edit-path as
  a Session D scope item.
- If the end-of-stack merge surfaces test failures that predate
  Session B, don't silently fix — log, then decide whether to roll
  into §1.3 or escalate.

End of session brief.
