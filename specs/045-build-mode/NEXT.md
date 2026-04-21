# Next — after sprint-053 Session A close-out

> Sprint 053-A closed at `a40bfe8` on `feat/053-session-a`, stacked on
> `feat/052-session-a` (`7d49103`) → `feat/051-session-a` (`41b339c`)
> → `feat/050-session-a` (`d103c14`) → `main`. All four branches stay
> off `main` until the owner runs the combined 050-A + 051-A + 052-A +
> 053-A staging walkthrough.
>
> Bundle C's opening half (safety nets — dry-run, history, ledger,
> revert) is now live. Two complementary sprint shapes exist for 054-A.
> The owner picks; either is a reasonable next step.

---

## Candidate 1 — Bundle C closing half (primary)

Closes Bundle C by shipping the **posture change**: tiered permissions
+ Try-it composer + revert-UX polish. 053-A built the safety nets;
this candidate reclassifies who is allowed to use them.

### Gate sheet

| Gate | Title | Why |
|------|-------|-----|
| E1 | Tiered permissions dial — suggest-only / one-click-apply / autopilot | Today every Apply path is admin-only. Operators have been asking since 048 to be able to *propose* without an admin in the loop. Capability-tier gate on the apply endpoint + the agent write tools' dry-run path. Reuses `BuildCapabilities` — no new wire format. Estimated 8–12h. |
| E2 | Try-it composer in the drawer | Inline "compose a draft reply using this artifact" chip that calls `test_pipeline` with the artifact's current body bound. Read-only viewer-only — operator gets a preview of the AI's behaviour under the proposed content without committing. Same drawer-extension posture as D3's `pendingBody` prop. Estimated 10–14h. |
| E3 | In-drawer Preview Revert + Confirm Revert | 053-A D4 carry-over. Replace the current 2-step browser-confirm revert flow with a third drawer mode (apply / revert / read-only) that swaps the diff semantic and renders dedicated `Preview Revert` + `Confirm Revert` buttons. Estimated 4–6h. |
| E4 | Tool-call-ID column on history rows | 053-A D2 open question §8a. Adds a `toolCallId` column on `BuildArtifactHistory`, threads through from the BUILD agent context, surfaces in the rail row tooltip + the trace-drawer cross-link. Cheap to add now, expensive to backfill. Estimated 2–4h. |
| E5 | Verification + walkthrough | tsc + suites + manual five-step. Fold in the combined 050+051+052+053-A staging walkthrough as the merge gate. Estimated 3–4h. |

Total: **27–40 hours**. Medium sprint. E3 is the smallest gate;
schedule it first if the sprint runs hot and time pressure looks
real — gives a clean cut-point.

### Why this is the primary pick

- It closes Bundle C cleanly: managers got the safety net in 053-A;
  this gives them the posture change that makes the safety net
  *useful to non-admins*.
- E2 (Try-it composer) directly answers the operator question that
  surfaced in 048 user research: "can I see what this would do."
  053-A made the answer technically possible (the apply executor
  exists, the dry-run seam exists); E2 surfaces it.
- E3 closes the only sprint-053-A polish carry-over honestly noted
  as "downgraded vs spec target."
- E4 is cheap insurance against a column-add later. Backfilling a
  `toolCallId` onto rows that didn't capture it is impossible.

### Non-goals (protect the scope)

- No new artifact types. SOP/FAQ/system_prompt/tool/property_override
  remain the universe.
- No autopilot mode itself — the *dial* exists; the autopilot tier's
  "no-confirm" behavior is a separate sprint.
- No version slider, no inline-edit-from-drawer, no audit-quote emit.
  All unblocked by 053-A but not on this candidate's critical path.

---

## Candidate 2 — Sprint-049 correctness carry-over sweep (alternate)

Paydown sprint. Pure correctness work — no new surface, no schema
changes. Picks up the P1/P2/P3/P4/P5/P6 + F1 items the team has been
deferring across the last four sprints.

### Why this exists

The 050-A → 053-A arc was feature-forward. Each sprint's close-out
notes a 1–2 line "pre-existing flake" or "unrelated tsc issue." Those
add up — there are now ~7 pieces of correctness debt floating in the
PROGRESS.md ledger. A paydown sprint clears the queue and gives the
test suite the integrity it needs before Bundle D opens.

### Items in scope (sprint-049 references)

- **P1-2 — `tenant-config-bypass.test.ts` requires OPENAI_API_KEY at
  import time.** Restructure to lazy-import inside test so the env
  workaround disappears.
- **P3 — Integration tests race on shared `ENABLE_*` env vars.**
  Surfaced in 053-A: `messages-copilot-fromdraft.integration.test.ts`
  intermittently fails in parallel runs. Per-test isolated env
  dictionaries instead of `process.env` mutation.
- **P4 — Stale `prevBody: undefined as any` cast in test fixtures**
  (introduced 053-A integration tests). Re-type so prisma JSON nulls
  are first-class.
- **P5 — Pre-existing `tsc --noEmit` drift** flagged in 050-A close-
  out (3 files referenced; verify they're still drifting after
  053-A's controller refactor).
- **P6 — `AiConfigVersion` legacy callers** — now that 053-A retired
  the build-artifact-detail read, audit remaining callers to confirm
  none are doing the same prev-body lookup with the old shape.
- **F1 — Test count discrepancy in PROGRESS.md ledger.** Reconcile
  the 275 vs 309 vs 340 deltas across 050-A → 053-A close-outs.

### Estimated total

**14–20 hours.** Smaller than candidate 1; equally valuable as
infrastructure. Schedule this if the team feels the test suite drifting
or wants a "no surprises" sprint before Bundle D.

---

## How to choose

- **Pick Candidate 1** if the goal is "close Bundle C and let
  non-admins into Studio."
- **Pick Candidate 2** if the goal is "stabilize the foundation
  before the next feature sprint."

Both are reasonable. The owner's call.

---

## Unblocked-but-deferred (no sprint required to start; just needs UI/UX)

- **Artifact version slider** — `BuildArtifactHistory` table is the
  data source; needs a small slider component on the drawer.
- **Inline-edit-from-drawer** — preview/apply path exists; needs an
  editor input on the drawer's body region. (Note: pairs naturally
  with Candidate 1 E2's "compose a draft reply" UI.)
- **Audit-quote emit** — orthogonal, but benefits from the apply
  endpoint existing.
- **Grouped ledger rows + filter-by-type + CSV export** — 053-A spec
  §6 explicitly parked these as 054-A+ polish; not on candidate 1's
  primary path but cheap individual lifts.

---

## Open questions surfaced by 053-A (not resolved in-sprint)

These are noted at the bottom of `sprint-053-session-a.md` §8 and
should be answered as part of whichever sprint touches the affected
seam:

- **Tool-call-ID column on history rows.** (Folded into Candidate 1
  as gate E4.)
- **Sanitisation of property_override rows.** Today plain-text;
  schema is JSON, so future shape could include credentials. Cheap
  insurance vs domain readability. Not urgent.
- **Session-scoped vs tenant-scoped default for the ledger rail.**
  Currently session-scoped. Could go either way; flag if the user
  asks for tenant-wide history.
