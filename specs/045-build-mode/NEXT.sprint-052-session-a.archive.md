# Sprint 052 — kickoff

> Sprint 051 Session A closed clean at commit `4c049e8`. Bundle B from
> the BUILD UX brainstorm landed: unified artifact drawer + 5 type
> views (`ffa6d50`), diff-body + prev-body coverage (`adb1a1d`), inline
> citations (`f667d8b`), and the data-artifact-quote backend emitter
> (`4c049e8`). A pre-flight sanitiser tighten-up (`d103c14`) landed on
> `feat/050-session-a` before branching. tsc + test suites green both
> sides: backend 268 unit + 34 integration, frontend 90 vitest across
> 17 files. Archived kickoff at
> [`NEXT.sprint-051-session-a.archive.md`](./NEXT.sprint-051-session-a.archive.md).
>
> Branch `feat/051-session-a` stays off `main` — stacked on
> `feat/050-session-a`, which is itself pending the combined owner-
> side smoke walkthrough (sprint-050-A §1.4 steps 5–7 + the
> sprint-051-A manual walk per the brief §1.5). Pre-flight was
> owner-overridden this sprint (see `PROGRESS.md` "Sprint 051 —
> Session A"); the live walkthrough is still the load-bearing check
> before anything merges to `main`.
>
> Three candidates for sprint-052-A, ranked by operator impact:
>
>   1. **Bundle C primary** (tiered permissions + Try-it composer +
>      dry-run-before-write) — with sprint-050-A caveat #3 absorbed as
>      gate C1. Natural follow-on now that depth (Bundle B) has
>      shipped.
>   2. **Correctness carry-over** — the still-deferred sprint-049
>      P1s plus any 050-A / 051-A caveats that haven't been absorbed.
>   3. **B-extension** — diff for system_prompt + tool_definition,
>      version slider, inline-edit-from-the-drawer. Gated on explicit
>      operator pressure; easy to start from `feat/051-session-a`.
>
> Read sections in order: §1 candidate C (primary), §2 candidate B
> (correctness carry-over), §3 candidate B-ext (only if pressured),
> §4 still-deferred, §5 non-negotiables, §6 context pointers.

---

## 1. Sprint 052 — primary candidate: Bundle C (permissions + Try-it + dry-run)

Bundle C is the write-safety layer the brainstorm explicitly pairs with
Bundle B's depth. With the drawer and citations in place operators can
already *see* what the agent is about to do; Bundle C decides *who can
sanction it* and gives the agent a safe place to experiment. Three
gates, starting with the prerequisite mop-up.

### 1.1 Gate C1 — Write-ledger unification + suggested-fix "reverted" state

**Why first.** Sprint-050-A caveat #3 was explicitly flagged at the
close of Bundle A ("per-artifact tx-id threading for suggested-fix
rollbacks") and carried through sprint-051-A without being touched.
The permissions work in C2 needs a single write surface to gate; any
"reverted" affordance on a suggested-fix accept needs a ledger to
flip. Cheaper to unify now than to back-fill once C2 is threaded.

**Goal.** One `WriteLedgerEntry` (or equivalent shape on
`BuildTransaction`) records every artifact write regardless of
source: plan approval, suggested-fix accept, direct tune-page edit.
Rollback reads this ledger and flips the session-artifact row to
`reverted` for any write in scope, not just plan-approval-sourced
ones. A4's row state chip already handles `reverted`; the gap is
purely in the write path.

**Files.** *new* `backend/src/build-tune-agent/write-ledger.ts` (or
extend `BuildTransaction` via additive Prisma change — push, not
migrate, per constitution); `suggestion-action.ts`; rollback path in
`version-history.ts`; frontend unchanged except possibly surfacing a
ledger-id on the A3 row for debugging.

**Effort.** 6–8 hours. Schema change is additive so no migration
ceremony. Tests = new write-ledger unit + integration on the
suggested-fix accept+rollback loop.

### 1.2 Gate C2 — Tiered permissions + typed-confirm for destructive writes

**Goal.** Distinguish "operator" from "admin" at the write path, not
just the read path. Operator-tier sanction is sufficient for FAQ
edits, SOP tone tweaks, non-destructive tool param changes. Admin
sanction required for: system_prompt edits, tool webhook-url changes,
property-override creates, and anything marked `sensitive` by the
agent's plan item.

**Sketch.** Add a `requiresAdminSanction: boolean` field on
`BuildPlanItem` + `SuggestedFixData`. The agent emits it based on
artifact type (system_prompt / tool webhook changes always true) +
explicit sensitivity signals. Frontend renders a typed-confirm on
admin-gated items ("type CONFIRM to approve"). Backend double-checks
on the write path.

**Effort.** 8–12 hours. Test surface is wide (every write seam).

### 1.3 Gate C3 — Dry-run-before-write + Try-it composer

**Goal.** A scratchpad surface where the operator can author a
proposed artifact change (FAQ answer, SOP body section) and hit
"Try it" — runs through `test_pipeline` + the drawer's diff view
without writing anything. Pairs with C2: the same typed-confirm
pattern applies to an explicit "commit this draft" action.

**Effort.** 10–12 hours. Largest gate of the bundle.

**Bundle total.** 24–32 hours. Biggest yet — split into two sessions
if time compresses; C1+C2 form a coherent "safety" ship, C3 follows.

---

## 2. Sprint 052 — correctness carry-over candidate

Unchanged from sprint-051-A NEXT §2.1 + §2.2 — the P1 docket has
stayed deferred through three sprint cycles. If operator pressure on
these lands between now and kickoff, swap this to §1:

- **Explore P1-5** — `PREVIEW_LOCKED` 409 from `/send` doesn't refresh
  client state; manager sees a dead Send button after a socket drop.
  2–3 hours.
- **Explore P1-2** — judge API failure returns `score: 0 +
  failureCategory: 'judge-error'` instead of a typed tool error,
  fooling the BUILD iteration loop. 1–2 hours.
- **Explore P1-4** — diagnostic + suggestion-writer + evidence-bundle
  writes not transactional. 2 hours + integration cases.
- **Explore P1-6** — atomic-claim revert race on tuning-suggestion
  accept. 3–4 hours.
- **Discovery F1** — dead `POST /api/tuning/complaints` route
  (+ companion `GET /category-stats`). 30min–1day depending on iOS
  caller audit.
- **DB-backed `TUNING_DIAGNOSTIC_FAILURE` observability badge
  (DB half of explore P1-3).** Prereq: ≥1 week of production log
  signal from sprint-049's log-tag helper before thresholds calibrate.

Plus the un-absorbed 050-A / 051-A items that didn't make Bundle C:

- **A11y pass on A1 origin-grammar + artifact-drawer focus trap.**
  Cross-cutting — separate a11y sprint eventually, but a one-session
  pass over `data-origin`, chip `aria-label`, and focus-trap +
  `role="quote"` on the `data-artifact-quote` pre is cheap.

---

## 3. Sprint 052 — B-extension candidate (only if operator pressure surfaces)

Start from `feat/051-session-a` so the drawer work is already in
hand. Three gates, each small:

### 3.1 Gate Bx-1 — Diff rendering for system_prompt

The `SystemPromptView` already takes `showDiff` via the shell; the
gap is a backend `AiConfigVersion`-sourced prevBody for the
`prevSince` query. Add a branch to
`getBuildArtifactPrevBody('system_prompt', …)` that returns the
oldest `AiConfigVersion` body within the window for the requested
variant. 2–3 hours.

### 3.2 Gate Bx-2 — Diff rendering for tool_definition

Similar shape to Bx-1 but reading from a tool-history source that
doesn't exist yet — either add a `ToolDefinitionHistory` table
(additive, push-not-migrate) or start the diff against the oldest
`updatedAt`-earliest tool row in the plan. 4–6 hours (depends on
history decision).

### 3.3 Gate Bx-3 — Per-version navigation inside the drawer

Version slider or prev/next buttons in the drawer footer. 4–6 hours.

**Bundle total.** 10–15 hours. Only ship if the operator explicitly
asks — Bundle C unblocks more value per hour.

---

## 4. Still-deferred (carry forward, explicit re-choice required)

### 4.1 New in sprint-051-A

- **emit_audit quote emit.** Deferred deliberately (B4 handoff) —
  audit row notes aren't verbatim excerpts, so the natural quote
  grammar doesn't fit. If Bundle D brings an audit drilldown
  surface, this becomes a 1-hour wire-up.
- **Citation parser for additional artifact types beyond the five
  drawer types.** If a future artifact lands, extend
  `CitationArtifactType` + the backend grammar block together —
  the marker format is an API seam.

### 4.2 Carried from sprint-050-A (now mostly absorbed by Bundle B)

- ~~Backend emitter for `data-artifact-quote`~~ — ✅ shipped B4.
- ~~Per-artifact tx-id threading for suggested-fix rollbacks~~ —
  surfaces as Bundle C gate C1 above.
- **Manual live-walkthrough of Bundle A + B on staging.** Blocker on
  merging either branch to `main`. Owner override on sprint-051-A's
  pre-flight means the combined walkthrough is now the single live
  check for both sprints' sanitiser-leak risk + operator-vs-admin
  gating.

### 4.3 Carried from sprint-049 and earlier

Unchanged from sprint-051-A §2.3 — Discovery D1 webhook drop-through,
R1 persist-time truncation, dashboards merge, R2 enforcement
observability, oscillation advisory, per-user admin distinctions,
raw-prompt editor edit path, RejectionMemory retention sweep,
free-text rationale on reject card, Path A ⇔ Path B parity audit,
Explore P2s (×10).

---

## 5. Non-negotiables carried forward

- `ai.service.ts` untouched. Guest messaging flow out of scope.
- Prisma changes via `prisma db push`, not migrations.
- Admin-only surfaces stay admin-only — triple-gated (env flag +
  `tenant.isAdmin` + server-side route gate). The artifact-drawer
  reuses `capabilities.isAdmin && capabilities.traceViewEnabled`
  for the tool webhook full-output toggle, and
  `capabilities.isAdmin && capabilities.rawPromptEditorEnabled` for
  the system-prompt body view. Bundle C's typed-confirm must keep
  the same gate surface.
- Sanitisation is load-bearing. The 050-A redact-by-key regex +
  051-A length-heuristic fallback form the one path into
  operator-tier payload rendering. No code-side shortcut that
  bypasses `sanitiseToolPayload`. Quote bodies on the backend go
  through `sanitiseQuoteBody`.
- The `[[cite:...]]` marker format is a versioned contract between
  the backend prompt grammar and the frontend parser. Changing it
  is a breaking change — document and coordinate.
- Graceful degradation on every new API surface (CLAUDE.md rule #2).
  The artifact-drawer's "missing artifact" banner + the citation
  parser's pass-through-on-unknown-type are the current instances.

---

## 6. Context pointers

- [`sprint-051-session-a.md`](./sprint-051-session-a.md) — sprint-051
  Session A brief (Bundle B gates B1–B5, all closed).
- [`sprint-050-session-a.md`](./sprint-050-session-a.md) — sprint-050
  Session A brief (Bundle A gates A1–A4).
- [`ui-ux-brainstorm-build.md`](./ui-ux-brainstorm-build.md) — BUILD
  UX deep-dive; Bundle C's gate anchors live in §7 (permissions) +
  §8 (Try-it composer) + §5 (dry-run semantics).
- [`PROGRESS.md`](./PROGRESS.md) — "Sprint 051 — Session A"
  subsection is the close-out log, including the pre-flight override
  note, per-gate commit SHAs, and the decisions-worth-next-attention
  list that seeded this kickoff.
- [`NEXT.sprint-051-session-a.archive.md`](./NEXT.sprint-051-session-a.archive.md)
  — archived sprint-051 kickoff brief.
- [`NEXT.sprint-050-session-a.archive.md`](./NEXT.sprint-050-session-a.archive.md)
  — archived sprint-050 kickoff brief (the six correctness
  candidates from sprint-049's explore report). Re-surface from §2
  if Bundle C is deferred.
- [`sprint-049-explore-report.md`](./sprint-049-explore-report.md) —
  16-finding explore pass; carry-forward P1s come from §2.

End of kickoff.
