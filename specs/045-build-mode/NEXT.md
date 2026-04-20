# Sprint 047 — Kickoff scope

> Sprint 046 closed 2026-04-21 on `feat/046-studio-unification`. This
> file is the sprint-047 starting scope, pre-session-A. Read
> [`PROGRESS.md`](./PROGRESS.md) "Sprint 046 — closed" before planning
> the sprint-047 session split.
>
> Owner: Abdelrahman. Base branch: `feat/047-…` off whichever branch
> is in production at kickoff (sprint 046 is branch-deployed, not
> merged to main — confirm with user before branching).

---

## 0. Post-sprint-046 landing state

All twelve sprint-046 gates are either ✅ landed or ⏭️ deferred here.
See [`PROGRESS.md`](./PROGRESS.md) "Sprint 046 — Session D" for the
full gate table + cache baselines + decisions.

Deployed surface: unified Studio tab (`/?tab=studio`), grounding-aware
agent (`get_current_state` + forced first-turn call + Response
Contract), enforcement linter (R1/R2 drop-not-log), session-scoped
rejection memory, 48h cooldown retired to advisory, legacy back-compat
shims deleted.

---

## 1. Sprint-047 shopping list

Carry-over from sprint 046 NEXT.md §3 + §9 plus Session D's explicit
deferrals. Each entry should open a spec or at least a one-paragraph
brief before work starts — sprint 046 taught us that gate sheets
without briefs drift into scope creep.

### 1.1 Deferred from sprint 046 Session D

- **D9 — `BuildToolCallLog` admin-only trace view.** Plan §4.5.
  Read-only drawer inside Studio's right-rail gear menu; gated by a
  new `ENABLE_BUILD_TRACE_VIEW` env flag (keep separate from
  `ENABLE_BUILD_MODE` so tenant admins can't accidentally see raw
  tool calls). Backend: `GET /api/build/traces?limit=&cursor=&tool=`.
  Tests: controller integration test + unit test for role-gate.
- **30-day retention sweep on `BuildToolCallLog`.** Cron or BullMQ
  job that prunes rows older than 30d. Deferred in sprint 046 Session
  A alongside the table creation.
- **R1 persist-time text truncation** — only if Langfuse shows
  prose-heavy turns surviving the advisory without self-correction.
  Sprint-046 Session D decision: the advisory alone is probably
  enough. Re-evaluate with a week of data.

### 1.2 Inherited from sprint 046 NEXT.md §3 (out of scope for D)

- **Cross-session rejection memory.** Sprint 046 shipped session-scoped
  only. Cross-session needs a Prisma model (not an `AgentMemory` key)
  so a preference survives container restarts + is independently
  queryable. Design exercise: what's the cardinality unit? (tenant?
  tenant+artifact? tenant+artifact+sectionOrSlot?)
- **Dashboards merge** into main Analytics tab (sprint 045 plan §9).
  Currently a standalone main-app tab inherited from sprint 045. Merge
  only if operator feedback shows the overlap is high.
- **Raw-prompt editor drawer** (plan §6.5). Admin-only; the power
  users who liked `/tuning/agent` lose their tool until this ships.
  Lives as a right-rail drawer in Studio, not a full page.
- **Deletion of the three redirect stubs** (`/build`, `/tuning`,
  `/tuning/agent`). Courtesy period expired at sprint 046 close.
  Simple `rm` + a Linear/Vercel monitoring check that no deep link
  hits them.

### 1.3 From Session D's "Decisions made" — potential follow-ups

- **R2 enforcement observability.** Session D chose emit-time
  first-wins so the client never sees the duplicate. Add a Langfuse
  dashboard for the R2 drop rate before a week passes.
- **Category-pastel palette re-evaluation.** Plan §3.3 decision #3
  retained the pastels on artifact-type pills. If the Linear-restraint
  push continues in sprint 047, revisit (low priority; cheap to flip).

### 1.4 Not from sprint 046 — surfaced by the deploy

Reserved for whatever the first real-tenant staging smoke after sprint
046 surfaces. Flag if:

- Studio tab fails to mount behind auth (Session C never wet-tested
  this; Session D honoured the same constraint).
- State-snapshot card fails to populate on agent turn 1 (forced
  first-turn grounding is Session A's key contract).
- `data-advisory` cards render with wrong copy — the Session D R1/R2
  wording is the first time a manager sees it in anger.

---

## 2. Open questions (resolve at kickoff, before any session A)

1. Does sprint 046 merge to `main` before sprint 047 branches, or does
   047 branch off 046 the same way 046 branched off 045? The chain has
   built up — sprint-045 is unmerged, sprint-046 branch-deploys,
   sprint-047 will hang off that if not merged. Merging would reset
   the base. Owner's call.
2. Is the Studio tab's staging smoke (first auth-gated click-through)
   a prerequisite for sprint 047 kickoff, or can sprint 047 A land in
   parallel? Recommend: block on the smoke so the first sprint-047
   session doesn't compound on a broken mount.
3. Does cross-session rejection memory (deferred from sprint 046) own
   a full session or fit inside a larger session's slack? Depends on
   the Prisma model design decision.

---

## 3. Non-negotiables (carried forward)

Same as sprint 046 plus sprint-046 hard-learned:

- Never break the main guest messaging flow. `ai.service.ts`
  untouched unless explicitly in scope.
- Prisma changes apply via `prisma db push`, not migrations.
- `BuildToolCallLog` insertion failures remain fire-and-forget.
- No violet anywhere in Studio chrome. Category pastels retained
  on artifact-type pills only.
- Cooldown is finally retired. If abuse shows up, rate-limit on
  the controller; do not re-add the hook block.
- Output-linter R3 stays log-only until we have a week of trace
  data to calibrate against (sprint 046 Session D decision).
- If a gate can't land cleanly, defer to the next sprint rather
  than ship a half-finished cleanup. Cleanup sessions that sprawl
  are worse than explicit deferrals (sprint 046 D9 illustrated
  the cost of honouring this).

---

## 4. Reference reads for sprint 047 planning

1. [`CLAUDE.md`](../../CLAUDE.md)
2. [`MASTER_PLAN.md`](./MASTER_PLAN.md) — especially the
   "Sprint 046 — shipped" appendix.
3. [`PROGRESS.md`](./PROGRESS.md) — sprint 046's four session
   sections + the "Sprint 046 — closed" wrap.
4. [`NEXT.sprint-046-session-d.archive.md`](./NEXT.sprint-046-session-d.archive.md)
   — the Session D brief for context on what the final
   cleanup sprint was scoped to do + what it deferred.
5. [`sprint-046-plan.md`](./sprint-046-plan.md) — full sprint-046
   refinement plan. §9 "Explicit deferrals" is the authoritative
   starting list for sprint 047; cross-reference against §1.1 + §1.2
   above before adding new scope.

End of sprint-047 kickoff scope.
