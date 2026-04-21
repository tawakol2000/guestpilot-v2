# Sprint 047 — Session B: observability, cleanup, cross-session memory

> Second session of sprint 047. Scope: finish the carry-over work that
> closes the 046+047-A surface for good — admin-only trace view +
> retention sweep, delete the expired redirect stubs, stand up a small
> frontend test harness so future Studio-card regressions land with
> coverage, and design the cross-session rejection-memory Prisma model.
>
> Owner: Abdelrahman. Base branch: `feat/047-session-b` off
> `feat/047-session-a`. Only flip this chain to main after a successful
> staging wet-test per §0 below.

---

## 0. Read-before-you-start

Mandatory reads, in order:

1. [`CLAUDE.md`](../../CLAUDE.md) — project constitution.
2. [`PROGRESS.md`](./PROGRESS.md) "Sprint 047 — Session A" — what
   Session A landed, what it deferred, and what it flagged
   (especially the staging-smoke blocker).
3. [`sprint-046-plan.md`](./sprint-046-plan.md) §§4.4, 4.5, 5.5, 9 —
   original spec for the BuildToolCallLog trace view + cross-session
   memory design.
4. [`NEXT.sprint-047-kickoff.archive.md`](./NEXT.sprint-047-kickoff.archive.md)
   §1.1 + §1.2 — the sprint-047 backlog shopping list this session draws
   from.

---

## 0.1 Pre-flight — staging wet-test

Session A's §"Blocked / surfaced" flagged that the first post-deploy
Studio click-through has not been exercised with a real tenant JWT. The
047-A surface MUST be smoke-tested on staging before Session B adds
more scope on top:

1. Deploy `feat/047-session-a` to Railway staging (it's branch-deployed
   today — no merge required).
2. Sign in with a real tenant JWT. Click through to the Studio tab.
3. On a fresh conversation, ask for an audit. Click Accept on any
   suggested-fix card the agent emits. Verify:
    - The artifact is actually modified (diff visible in `/sops` or
      wherever the target lives).
    - A fresh `TuningSuggestion` row with `status: 'ACCEPTED'` +
      `appliedAt: now()` exists in the DB.
    - A second accept on the same artifact surfaces the `recent-edit`
      advisory.
4. On a non-top-finding row of a `data-audit-report` card, click View.
   Verify the agent responds with the target artifact's current state.

If any of those four acceptance checks fail, Session B pauses to debug.
Don't layer new scope on a broken base.

---

## 1. Scope — Session B

Four items. Each is a commit. Order roughly by leverage; the
cross-session memory design is the one that most benefits from running
in parallel on staging-smoke data.

### 1.1 D9 — `BuildToolCallLog` admin trace view

Inherited from sprint 046 NEXT §1.1. Read-only drawer inside Studio's
right-rail gear menu; gated by a new `ENABLE_BUILD_TRACE_VIEW` env flag
(keep separate from `ENABLE_BUILD_MODE` so tenant admins can't
accidentally see raw tool calls).

Backend:
- `GET /api/build/traces?limit=&cursor=&tool=` returning the last
  `limit` `BuildToolCallLog` rows. Tenant-scoped, role-gated to admin.
- Cron or BullMQ sweep job that prunes rows older than 30d.
  Fire-and-forget insertion means occasional duplicates can slip in —
  the sweep is the source of truth for retention bounds.

Frontend:
- `frontend/components/studio/traces-drawer.tsx` — compact rows with
  tool name, duration, success/error chip, tenant-local timestamp.
- Drawer mounted in the right-rail gear menu, admin-only flag.

Tests:
- Controller-level integration for the new route + role gate.
- Unit test for the retention sweep.

### 1.2 Delete the three redirect stubs

Inherited from sprint 046 NEXT §1.2. Courtesy period already expired
at sprint 046 close + sprint 047 Session A close.

- `rm frontend/app/build/page.tsx`
- `rm frontend/app/tuning/page.tsx`
- `rm frontend/app/tuning/agent/page.tsx`
- Verify with `gh` or Vercel's analytics that nothing has hit those
  routes in the last 7 days; if so, flag + investigate before deleting.
- Also delete `frontend/app/build/layout.tsx` if it's now dead.

Zero-risk cleanup on paper; verify with traffic data before pulling
the trigger.

### 1.3 Cross-session rejection memory design

Inherited from sprint 046 Plan §4.4 deferral. Session-scoped memory
(`session/{conv}/rejected/{hash}`) ships today; this session designs
the durable equivalent.

Open design questions to resolve at kickoff, not during build:

- **Cardinality unit.** Per-tenant, per-(tenant, artifact), or
  per-(tenant, artifact, sectionOrSlot)? The finer-grained, the less
  a single bad rejection poisons future suggestions; the coarser, the
  easier to reason about.
- **TTL.** Session-scoped is forever; cross-session needs a decay
  story. 30d matching BuildToolCallLog? 90d? Never?
- **Prisma model shape.** A dedicated `RejectionMemory` table vs
  reusing `AgentMemory` with a durable-key prefix. Dedicated table
  lets the FK cascade on Tenant delete cleanly.
- **Agent surfacing.** The session-scoped version instructs the agent
  to consult memory before emitting — does the cross-session version
  need a separate instruction, or does the same one generalise?

Deliverable: a one-page design doc
(`specs/045-build-mode/cross-session-rejection-memory.md`) + a Prisma
model sketch. Implementation lands in Session C.

### 1.4 Frontend component-test harness + S5 coverage

Deferred from Session A. Stand up the minimum viable harness so Studio
card changes can land with coverage going forward.

- Add `vitest` + `@testing-library/react` + `jsdom` to `frontend/`
  dev deps.
- `frontend/package.json` → add `"test": "vitest run"` script.
- `frontend/vitest.config.ts` + `frontend/test/setup.ts` bootstrapping
  jsdom + testing-library.
- `frontend/components/studio/__tests__/audit-report-view-row.test.tsx`
  — three rows (one top, two non-top), click a non-top View button,
  assert the `onSendText` mock receives the expected string. Covers
  the Session A S5 wiring.

This unblocks future Studio-card work — QuestionChoicesCard,
SuggestedFixCard, etc. — shipping with unit coverage.

---

## 2. Out of scope — explicitly deferred

- **R1 persist-time truncation (Path B).** Still conditional on
  Langfuse showing long-prose turns surviving Path A without
  self-correction. Revisit after a week of production data from the
  046+047-A deploy.
- **Dashboards merge into main Analytics tab** (sprint 045 Plan §9).
  Still a standalone main-app tab; merge only if operator feedback
  shows the overlap is high.
- **Raw-prompt editor drawer** (Plan §6.5). Admin-only; power users
  who liked `/tuning/agent` still lose their tool until this ships.
- **Oscillation advisory on BUILD writes.** Requires a confidence
  signal on BUILD creator tools, which doesn't exist today. Wait
  for a real signal need.
- **Category-pastel palette re-evaluation.** Low priority; cheap to
  flip if the Linear-restraint push resurfaces.

---

## 3. Non-negotiables (carried forward)

- Never break the main guest messaging flow. `ai.service.ts`
  untouched unless explicitly in scope.
- Prisma changes apply via `prisma db push`, not migrations.
- `BuildToolCallLog` insertion failures remain fire-and-forget; the
  retention sweep (§1.1) must ALSO tolerate skew without crashing.
- No violet anywhere in Studio chrome.
- Cooldown is retired and stays retired. If abuse shows up, rate-limit
  on the controller.
- Output-linter R3 stays log-only until there's a week of trace data
  to calibrate against.
- If a gate can't land cleanly, defer to the next session rather than
  ship a half-finished cleanup.

---

## 4. Sequencing + gate sheet

| Gate | Item                                                     | Status |
|------|----------------------------------------------------------|--------|
| B1   | Staging wet-test of 047-A surface (per §0.1)             | ☐      |
| B2   | `BuildToolCallLog` admin trace view + route + drawer      | ☐      |
| B3   | 30-day retention sweep job                                | ☐      |
| B4   | Delete 3 redirect stubs (after traffic check)             | ☐      |
| B5   | Cross-session rejection-memory design doc + Prisma sketch | ☐      |
| B6   | Frontend vitest harness + S5 coverage test                | ☐      |
| B7   | Full backend + frontend suites green; `tsc` clean         | ☐      |
| B8   | PROGRESS.md updated + NEXT.md rewritten for Session C     | ☐      |

Don't start B2 until B1 is green on staging.

---

## 5. Exit handoff

Same as Session A §7:
- Commit per gate, push with `--set-upstream` on first push.
- Archive current NEXT.md → `NEXT.sprint-047-session-b.archive.md`.
- Append to PROGRESS.md + rewrite NEXT.md for Session C.

End of sprint-047 Session B brief.
