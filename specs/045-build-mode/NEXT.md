# Sprint 051 — kickoff

> Sprint 050 Session A closed clean at commit `80de3fd` + the A4 docs
> commit that follows. Bundle A from the BUILD UX brainstorm landed:
> typographic attribution (`f64b2e4`), tool-call drill-in drawer with
> redact+truncate sanitiser (`a4e0722`), and a session-artifacts right-
> rail card (`80de3fd`). tsc + test suites green both sides (backend
> 249 unit + 34 integration, frontend 54 vitest). Archived kickoff at
> [`NEXT.sprint-050-session-a.archive.md`](./NEXT.sprint-050-session-a.archive.md).
>
> Branch `feat/050-session-a` stays off `main` until the owner signs
> off on operator-tier trace exposure on staging — the sanitisation
> layer is the load-bearing guarantee behind that sign-off. Full
> details in `PROGRESS.md` "Sprint 050 — Session A".
>
> Sprint 051's primary candidate is **Bundle B** from
> [`ui-ux-brainstorm-build.md`](./ui-ux-brainstorm-build.md) §16 —
> unified artifact drawer + inline citations + diff rendering. It
> depends on Bundle A's attribution grammar (shipped) and the
> `data-artifact-quote` part type (renderer shipped, emitter still
> to write). The remaining sprint-049 correctness carry-overs stay
> on deck in §2 for explicit re-choice.
>
> Read sections in order: §1 sprint-051 primary candidate (Bundle B),
> §2 still-deferred, §3 non-negotiables, §4 context pointers.

---

## 1. Sprint 051 — primary candidate: Bundle B (artifact drawer + citations + diff)

Bundle B is the natural follow-on to the audit-unlock that Bundle A
shipped. Three sub-gates, each a coherent session:

### 1.1 Artifact unified drawer shell (§6.1 of the BUILD brainstorm)

**Goal.** A single 480px slide-out that replaces the coarse deep-link
anchors the sprint-050 session-artifacts card now uses. Accepts
`{ artifact, artifactId }`. Routes internally to five artifact-type
views (SOP variant, FAQ entry, system-prompt section, tool definition,
property override). Viewer-first — editing still happens in the
dedicated Tuning pages.

**Files.** *new* `frontend/components/studio/artifact-drawer.tsx`;
`session-artifacts.tsx` (switch click handler from `href` anchor to
`onOpen(artifact)` callback; keep the href as a right-click "open in
tab" escape hatch); `studio-surface.tsx` (owns the drawer state
alongside the already-shipped `sessionArtifacts` list). Potentially
*new* `frontend/lib/artifact-api.ts` with per-type fetch helpers if
the existing `/api/tuning/*` surface doesn't cleanly cover a single
lookup-by-id path for each type.

**Sketch.** Mirror the Bundle A drawer geometry (slide-out from the
right, Esc + click-outside close, focus restoration). Header = type
icon + truncated title + "Open in full editor" link. Body = type-
specific renderer. Admin-only sections (full system-prompt body,
tool webhook secrets) stay behind the same gate Bundle A's drawer
uses (`capabilities.isAdmin && capabilities.traceViewEnabled`).

**Effort.** 3–4 hours for shell + routing; +1–2 hours per artifact
type renderer. Ship SOP + FAQ + system-prompt in the first session;
tool + property override in the follow-up if time pressure shows.

**Operator impact.** Very high — every session-artifacts row becomes
a one-click audit surface instead of a navigation away from Studio.

### 1.2 Inline citations on factual claims (§3.7)

**Goal.** When the agent asserts "the current early-checkin SOP's
CONFIRMED variant says …", the quoted span becomes clickable and
opens the artifact drawer (1.1) scrolled to that span.

**Files.** `backend/src/build-tune-agent/data-parts.ts` — add
`artifact_citation: 'data-artifact-citation'` with
`ArtifactCitationData { artifact, artifactId, quoteRange, displayText }`.
`studio-chat.tsx` StandalonePart — render the citation as an
underlined span with `cursor: pointer` that calls the drawer open
callback (requires 1.1). Agent-side — teach `propose_suggestion` and
`emit_audit` to emit citations when they reference an artifact by ID.

**Dependency.** 1.1 must land first (the click has nowhere to go
without the drawer).

**Effort.** 2 hours for the part type + renderer; 2–4 hours for the
agent-side emit (depends on how thorough we want the initial coverage
to be — ship the two highest-signal call sites first).

**Operator impact.** High — closes the "what the agent just quoted"
loop without forcing the operator to hunt the artifact manually.

### 1.3 Diff rendering inside the drawer (§6.2)

**Goal.** Any artifact in the drawer during/after a BUILD session
shows a "view changes" toggle. When on, the body renders with red-
strike / green-underline deltas against the prior version. One
version slider per artifact.

**Files.** Backend — add a `/api/build/artifact/:type/:id/versions`
endpoint that returns the last 5 versions (data already lives in
`AiConfigVersion` for prompts, in `SopVariant` history for SOPs;
FAQs currently don't version → decide whether to bolt on version
capture or ship the toggle SOP-first). Frontend — add the toggle +
diff renderer to `artifact-drawer.tsx`. Reuse the existing diff
palette from Bundle A's `STUDIO_COLORS.diffAddBg/diffDelBg`.

**Sketch.** Start with SOPs (versioned already). FAQs + tool-definitions
get added as their version-capture lands (not this sprint unless the
operator signal demands it).

**Effort.** 4–6 hours for SOP-first ship; +4 hours when FAQ version
capture lands.

**Operator impact.** High for long-running tenants — "what changed
this week?" becomes a visible diff instead of a read of two raw
bodies.

---

## 2. Still-deferred

### 2.1 Deferred from sprint 049 (carry-forward, unchanged from sprint-050 NEXT §2)

- **Explore P1-5** — `PREVIEW_LOCKED` 409 from `/send` doesn't refresh
  client state; manager sees a dead Send button after a socket drop.
  `shadow-preview.service.ts` + inbox-v5 socket listener. 2–3 hours.
- **Explore P1-2** — judge API failure returns `score: 0 +
  failureCategory: 'judge-error'` instead of a typed tool error,
  fooling the BUILD iteration loop. `test-judge.ts:167–175`. 1–2 hours.
- **Explore P1-4** — diagnostic + suggestion-writer + evidence-bundle
  writes not transactional. `diagnostic.service.ts` +
  `suggestion-writer.service.ts`. 2 hours + integration cases.
- **Explore P1-6** — atomic-claim revert race on tuning-suggestion
  accept. `tuning-suggestion.controller.ts`. 3–4 hours.
- **Discovery F1** — dead `POST /api/tuning/complaints` route
  (+ companion `GET /category-stats`). Read `docs/ios-handoff.md`
  first — iOS may be the only remaining caller. 30min–1day.
- **DB-backed `TUNING_DIAGNOSTIC_FAILURE` observability badge
  (DB half of explore P1-3).** Prereq: ≥1 week of production log
  signal from sprint-049's log-tag helper before thresholds calibrate.

### 2.2 Deferred from sprint 050 — Session A (new this sprint)

- **Backend emitter for `data-artifact-quote`.** Renderer shipped A1;
  emitter still pending. Agent-side enhancement to `propose_suggestion`
  (or new dedicated `quote_artifact` tool). Pairs naturally with
  Bundle B 1.2 — both teach the agent to emit references.
- **Per-artifact tx-id threading for suggested-fix rollbacks.** Today
  rollback flips only plan-approval-sourced artifacts ("reverted"
  chip). Suggested-fix accepts live outside the tx scheme. Unified
  write ledger is a Bundle B concern — tracks cleanly there.
- **Manual live-walkthrough of Bundle A on staging.** Owner-side
  smoke test. The branch `feat/050-session-a` stays off `main` until
  this signs off. Sanitiser unit suite is the cheap load-bearing
  check; the live walkthrough verifies that no captured tool payload
  in the field leaks secrets or PII beyond what the sanitiser
  redacts.
- **A11y pass on A1 typographic attribution.** `data-origin` is
  selector-queryable but not announced to screen readers. If an
  audit surfaces next sprint, add `aria-label` on the role headers
  + `role="quote"` on the `data-artifact-quote` pre. Not blocking.

### 2.3 Carried forward unchanged (from sprint-049 NEXT §2.3 + sprint-050 NEXT §2.2)

- **Discovery D1** — webhook drop-through on auto-create-failed.
  Guest-message intake; demands a dedicated sprint per CLAUDE.md #1.
- **R1 persist-time truncation (Path B).** Langfuse-dependent.
- **Dashboards merge into main Analytics tab.** Awaits operator
  feedback on the standalone Studio panel.
- **R2 enforcement observability dashboard.** Langfuse work.
- **Oscillation advisory on BUILD writes.** Needs a confidence
  signal that doesn't exist today.
- **Per-user admin distinctions.** `Tenant.isAdmin` conflates
  tenant-owner and platform-admin; migrate only when a surface needs it.
- **Raw-prompt editor edit path.** No operator pressure yet.
- **RejectionMemory retention sweep + cleared-rejections UI.**
- **Free-text rationale on reject card.**
- **Full Path A ⇔ Path B semantic parity audit** (role, audit
  fields, hostawayMessageId stamping).
- **Explore P2s (×10)** — polish queue; see
  [`sprint-049-explore-report.md`](./sprint-049-explore-report.md) §2.

---

## 3. Non-negotiables carried forward

- `ai.service.ts` untouched. Guest messaging flow out of scope.
- Prisma changes via `prisma db push`, not migrations.
- Admin-only surfaces stay admin-only — triple-gated (env flag +
  `tenant.isAdmin` + server-side route gate). Sprint-050's drawer
  reuses `capabilities.isAdmin && capabilities.traceViewEnabled`
  for the "Show full output" toggle; Bundle B must do the same for
  any new admin toggle it introduces.
- Graceful degradation on every new API call (CLAUDE.md rule #2).
- Legacy copilot `fromDraft` gate stays explicit opt-in — sprint
  048-A A4 case 3 + sprint 049-A A3 case (b) regression-test it.
- Sanitisation layer on the tool-call drawer stays the one-path
  boundary between operator and admin; no code-side shortcut that
  bypasses `sanitiseToolPayload`.

---

## 4. Context pointers

- [`sprint-050-session-a.md`](./sprint-050-session-a.md) — sprint-050
  Session A brief (Bundle A gates A1–A4, all closed).
- [`ui-ux-brainstorm-build.md`](./ui-ux-brainstorm-build.md) — BUILD
  UX deep-dive; §6 (artifact drawer), §3.7 (citations), §6.2 (diff)
  are Bundle B's spec anchors.
- [`ui-ux-brainstorm-frontend.md`](./ui-ux-brainstorm-frontend.md) —
  companion cross-surface UX brainstorm.
- [`PROGRESS.md`](./PROGRESS.md) — "Sprint 050 — Session A"
  subsection is the close-out log including the five operator-tier
  caveats worth the next session's attention.
- [`NEXT.sprint-050-session-a.archive.md`](./NEXT.sprint-050-session-a.archive.md)
  — archived sprint-050 kickoff brief (the six correctness
  candidates from sprint-049's explore report). Re-surface from §2
  if Bundle B is deferred.
- [`sprint-049-explore-report.md`](./sprint-049-explore-report.md) —
  16-finding explore pass; carry-forward P1s come from §2.
- [`NEXT.sprint-049-session-a.archive.md`](./NEXT.sprint-049-session-a.archive.md)
  — archived sprint-049 kickoff brief.

End of kickoff.
