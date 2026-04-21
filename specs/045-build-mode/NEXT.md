# Next — after sprint-054 Session A close-out

> Sprint 054-A closed at `b158f6f` on `feat/054-session-a`, stacked on
> `feat/053-session-a` (`e5d1051`) → `feat/052-session-a` (`7d49103`)
> → `feat/051-session-a` (`41b339c`) → `feat/050-session-a` (`d103c14`)
> → `main`. Studio is now self-narrating (rationale on every write) and
> self-verifying (three-variant test ritual on every write).
>
> 055-A has three realistic candidates. The owner picks one — each stands
> alone and any is a reasonable next step.
>
> Previous NEXT content archived at
> [NEXT.sprint-054-session-a.archive.md](NEXT.sprint-054-session-a.archive.md).

---

## Candidate 1 — Sprint-049 correctness carry-over sweep (PRIMARY)

**Why primary:** 050-A → 054-A has been feature-forward for five sprints.
Each close-out notes a 1–2 line "pre-existing flake" or "unrelated tsc
issue." Those add up. A paydown sprint clears the queue and gives the
test suite the integrity it needs before Bundle D opens.

### Items in scope

- **P1-2 — `tenant-config-bypass.test.ts` requires `OPENAI_API_KEY` at
  import time.** Restructure to lazy-import inside the test so the env
  workaround disappears.
- **P3 — Integration tests race on shared `ENABLE_*` env vars.** Each
  integration test toggles `ENABLE_BUILD_MODE` / `ENABLE_RAW_PROMPT_EDITOR`
  in a `try/finally`; parallel runs collide. `messages-copilot-fromdraft.integration.test.ts`
  is the one that surfaces intermittently; likely worth a per-test
  isolated env pattern (snapshot + restore) rather than a mutation loop.
- **P4/P5/P6** — whatever was surfaced in 050-A / 052-A NEXT.md but not
  landed. Re-scan the close-out caveats before starting.
- **F1** — one legacy tsc drift (documented somewhere in 051-A
  close-out, needs to be re-discovered).
- **053-A caveat #3** — the flaky backend integration test, still
  deferred.
- **054-A carry-over** — F4's stray `backend/scripts/seed-demo.ts` and
  `specs/045-build-mode/sprint-055-session-a.md` were swept into the
  F4 commit; both are pre-existing / unrelated. Either move them to
  their own commits or confirm they're expected artifacts of the
  workstream.

### Why this is defensible

- We just expanded the Studio surface substantially (rationale,
  verification, ledger linkage). Tightening before moving on is the
  right posture — it costs one sprint, pays for every following one.
- Paydown sprints have no scope creep risk. Each item is self-contained.
- Clears the "one pre-existing flake" line from every close-out.

### Non-goals

- No new artifact types.
- No new ritual steps on top of F3/F4.
- No new UI.

### Estimate

10–16 hours depending on how many of the Pn items still need investigation.
Small.

---

## Candidate 2 — Bundle D opener: session task board (ALTERNATE)

**Why this exists:** with rationale + verification in place, the next
natural extension is a **queue of follow-ups** — when the agent edits
an SOP, it can queue "and also update the FAQ that references this SOP"
as a pending task the manager can pick up in a later session. Turns
the studio from a one-shot editor into a persistent workspace.

### Gate shape (sketch)

| Gate | Title | Scope |
|------|-------|-------|
| D1 | `BuildTaskQueue` model + `queue_followup` tool | Agent can write a queued follow-up with a title, rationale, and suggested trigger. Light schema addition via `prisma db push`. |
| D2 | Session task board UI (right rail card) | Renders queued tasks, click-to-prompt re-engages the agent with the task as context. |
| D3 | Task completion linkage | When a queued task produces a write, link the task to the resulting history row's `metadata.completedFromTaskId`. |
| D4 | Verification + smoke |  |

### Why this is the alternate (not primary)

- It's new surface. Every sprint that adds surface also adds long-tail
  maintenance cost.
- The PRIMARY option is paydown, which is what the project needs more
  than another feature gate right now.
- A task queue is a real good idea; there's no reason to rush it while
  correctness debt is accumulating.

### Estimate

20–28 hours. Medium sprint. Skippable per-gate if time gets tight.

---

## Candidate 3 — Bundle C closing half: tiered permissions (TERTIARY, parked)

**Status:** explicitly descoped from 054-A per user direction. Parked
until a second persona (operator, not admin) needs this.

**What it would ship:** tiered permissions dial on the apply endpoint
+ the BUILD write tools' dry-run path (suggest-only / one-click-apply /
autopilot). Reuses `BuildCapabilities` — no new wire format.

**Why it's parked:** today every Apply path is admin-only. We have one
persona using the Studio. Adding tiered permissions before there's a
second persona is premature. The rails are ready (`ritual-state` and
the dry-run seam both already track manager-sanctioned state); the
dial itself is a 2-day addition whenever the second persona surfaces.

**Do not start this until:** an operator who is NOT an admin has asked
to use the Studio. Before that, it's speculative.

---

## Prerequisite carry-over (applies to all three candidates)

**050-A → 054-A staging walkthrough.** Still the merge gate for the
whole stack. The branch chain is five sprints deep now; any further
sprint-stack without a staging walkthrough adds integration-risk that
compounds. Recommend running the walkthrough *before* picking 055-A so
the next sprint can stack on `main` rather than a 6-deep chain.
