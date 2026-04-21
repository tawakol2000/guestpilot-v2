# Sprint 051 — Session A: BUILD artifact depth (Bundle B)

> Second UX sprint on the BUILD / Studio screen. Scope is Bundle B
> from [`ui-ux-brainstorm-build.md`](./ui-ux-brainstorm-build.md) §16
> plus the single sprint-050-A carry-over that pairs cleanly with it:
> `data-artifact-quote` backend emitter.
>
> Bundle A (sprint-050-A) made the agent's *process* visible — tool
> calls drillable, text origin legible, touched artifacts listed.
> Bundle B makes the agent's *subjects* openable — click any artifact
> and see what it actually says, click any cited claim and see where
> the agent got it from, view before/after when a diff is pending.
>
> This is primarily a frontend sprint with one small backend emitter
> gate. No schema changes. No tool shape changes beyond activating
> the already-additive `data-artifact-quote` type shipped
> renderer-only in sprint-050-A.
>
> Read sections in order: §0 context, §1 gates, §2 non-negotiables,
> §3 deferred, §4 gate sheet, §5 success criteria, §6 handoff.

---

## §0 Context

### Where we are

Sprint 050-A closed at `48f36e8` with three new surfaces: typographic
attribution (A1), tool-call drill-in drawer with sanitiser (A2), and
a session artifacts panel in the right rail (A3). Branch
`sprint-050-a` stays off `main` pending the owner-side manual smoke
test on a live backend — see sprint-050-A close-out caveat #1.

**If the 050-A smoke test hasn't run yet, do NOT start this sprint.**
051-A depends on the A3 artifacts panel as the click-target for the
new drawer. Shipping 051-A on top of an un-verified A3 compounds the
risk of a sanitiser miss leaking into the drawer's diff view too.

### Why this bundle second

The A3 deep-links to existing `/tuning/sops/:id` etc. pages are
placeholders the brief explicitly called out as Bundle B replacements.
The operator today can *see* what changed in a session but has to
leave Studio to read the artifact. That breaks the focus frame every
time. Inline citations (B3) aren't useful until the drawer exists
(they need a click target). Diff rendering (B2) isn't useful without
the drawer either — no surface to render inside. So the drawer shell
is the load-bearing primitive, and B2 / B3 / B4 all compose on top.

### Read list before touching code

1. **This file** (§1 through §6).
2. [`ui-ux-brainstorm-build.md`](./ui-ux-brainstorm-build.md) §6
   (artifact drawer), §3.7 (citations), §6.2 (diff rendering).
3. [`sprint-050-session-a.md`](./sprint-050-session-a.md) §1.1 (A1
   typographic grammar — B2's diff view must extend the "pending
   italic grey" invariant to in-flight artifact changes) and §1.3
   (A3 session artifacts — B1 hooks into the click handler).
4. [`frontend/components/studio/session-artifacts.tsx`](../../frontend/components/studio/session-artifacts.tsx)
   — the A3 card; replace its deep-link anchor with a drawer-open
   callback.
5. [`frontend/components/studio/studio-chat.tsx`](../../frontend/components/studio/studio-chat.tsx)
   — MessageRow, text part branch; citations replace the existing
   flat `<p>` renderer for AI text that contains citation markers.
6. [`frontend/components/studio/raw-prompt-drawer.tsx`](../../frontend/components/studio/raw-prompt-drawer.tsx)
   and [`frontend/components/studio/trace-drawer.tsx`](../../frontend/components/studio/trace-drawer.tsx)
   — reference implementations for the drawer shell (animation,
   focus trap, Esc handling). Don't copy-paste; match patterns.
7. [`frontend/lib/build-api.ts`](../../frontend/lib/build-api.ts)
   — artifact read endpoints. Bundle B is viewer-only; confirm read
   endpoints exist for all five artifact types before scoping B1
   edits.
8. [`backend/src/build-tune-agent/data-parts.ts`](../../backend/src/build-tune-agent/data-parts.ts)
   — confirm the `data-artifact-quote` type is registered from
   050-A (renderer-only ship). B4 activates the emit side.
9. [`backend/src/build-tune-agent/tools/propose-suggestion.ts`](../../backend/src/build-tune-agent/tools/propose-suggestion.ts)
   — likely emitter host for `data-artifact-quote`; see B4 for the
   call.

### Non-goals (do not scope-creep)

- **No tiered permissions, no typed-confirm, no dry-run-before-write.**
  Bundle C. Out of scope.
- **No Try-it composer.** Bundle C.
- **No inline-edit from the drawer.** Drawer is viewer-only this
  sprint. Edit affordances deep-link to the existing tuning pages
  exactly as A3 did. "Compose at cursor" is explicitly deferred.
- **No write-ledger unification / suggested-fix rollback "reverted"
  state** (sprint-050-A caveat #3). That's a backend refactor with
  its own testing surface — handled in a standalone mop-up session
  or as Bundle C gate 1. Surface in NEXT.md at §6 handoff.
- **No diff for system_prompt or tool_definition.** B2 ships diffs
  for SOP and FAQ only — the two most common change targets. Other
  three artifact types render current-only in the drawer.
- **No session-list task board, no queued follow-ups, no posture
  banner.** Bundles D / E.

---

## §1 Gates

Four user-facing gates + one verification gate. Ordering is load-bearing:
B1 builds the shell, B2 and B3 compose inside it, B4 flips the backend
emitter so the A1 quote renderer wakes up.

### 1.1 Gate B1 — Unified artifact drawer shell

**Goal.** One slide-out drawer (480px wide, opens over the right rail,
does NOT cover the centre pane) that accepts
`{ artifact, artifactId }` and routes to an artifact-type-specific
read-only view. Replaces A3's deep-link anchors. Keyboard: Esc closes,
focus trapped while open, focus restored to the opener on close.

**Files.**

- *New file* `frontend/components/studio/artifact-drawer.tsx` — the
  shell + routing + focus trap. ~300 lines.
- *New directory* `frontend/components/studio/artifact-views/` —
  one file per artifact type:
  - `sop-view.tsx` — category, status scope, property scope, body
    (markdown-rendered), metadata (last edit, version, edit count),
    "Open in tuning" deep-link button.
  - `faq-view.tsx` — question, answer, category, scope,
    embeddings-status, deep-link.
  - `system-prompt-view.tsx` — section ID, current body,
    admin-only full-prompt toggle reuses
    `capabilities.rawPromptEditorEnabled`.
  - `tool-view.tsx` — name, description, JSON schema, webhook
    config (custom tools), admin-only runtime-flag.
  - `property-override-view.tsx` — property, overridden field,
    value, fallback.
- [`frontend/components/studio/session-artifacts.tsx`](../../frontend/components/studio/session-artifacts.tsx)
  — replace the anchor-based deep-link with a drawer-open callback.
  Keep deep-link as a secondary "Open in tuning" button inside the
  drawer, not the primary click target.
- [`frontend/components/studio/studio-surface.tsx`](../../frontend/components/studio/studio-surface.tsx)
  — own the drawer state (`artifactDrawerOpen`,
  `artifactDrawerTarget`) and the handlers that pass down to
  `session-artifacts.tsx` and (B3) `studio-chat.tsx`.
- [`frontend/lib/build-api.ts`](../../frontend/lib/build-api.ts)
  — add any missing read endpoints; ideally one generic
  `apiGetArtifact(artifact, id)` that routes to existing per-type
  endpoints so the drawer has one data seam.

**Implementation sketch.**

1. Shell: `artifact-drawer.tsx` renders a portal-level slide-out
   with a backdrop (semi-transparent, click-outside closes). Header:
   artifact-type icon + title + close X. Body: route by `artifact`
   prop to the appropriate view component. Footer: "Open in tuning"
   deep-link button + (B2) "View changes" toggle.
2. Data loading: each view calls `apiGetArtifact(artifact, id)`
   via SWR or a local `useEffect` + loading state. Show a lightweight
   skeleton while loading; show an inline danger banner on error
   (match the pattern already in `StudioSurface` load-state error).
3. Focus trap: Tab cycles within the drawer while open; Shift+Tab
   reverses; Escape closes and restores focus to the opener (stored
   as a ref on `StudioSurface`). The existing trace drawer already
   handles this — copy the pattern, don't re-invent.
4. Admin-only affordances inside views: gate on
   `capabilities.isAdmin` + whichever existing flag is most
   appropriate (`traceViewEnabled`, `rawPromptEditorEnabled`).
   Operator-tier default shows everything non-sensitive.
5. Sanitisation: the tool-view's webhook config can contain
   secrets — run it through
   [`frontend/lib/tool-call-sanitise.ts`](../../frontend/lib/tool-call-sanitise.ts)
   (shipped in sprint-050-A2) before render. Unit-test this path.

**Tests.**

- Component tests per artifact view (5 files — snapshot + loading
  state + error state).
- Integration test: clicking a row in `SessionArtifactsCard` opens
  the drawer with the right artifact + id; Esc closes; focus
  returned to the row.
- Sanitisation regression: tool-view webhook config with a fake
  `apiKey` field renders `[redacted]`.

**Effort.** 14–18 hours. The biggest gate in the sprint.

**Operator impact.** **Very high.** Converts A3 from "breadcrumb
to elsewhere" into "the surface you actually read the artifact on."

---

### 1.2 Gate B2 — Diff rendering inside drawer (SOPs + FAQs)

**Goal.** In the drawer, when the current session has touched the
artifact being viewed, show a "View changes" toggle. When on, the
body renders with red-strike / green-underline deltas against the
pre-session state. SOPs and FAQs only this sprint.

Critical invariant: **in-flight artifact content (pending plan not
yet approved) renders in A1's "pending italic grey with Unsaved
badge" grammar inside the drawer too.** No drawer-specific style
for pending state — same origin grammar everywhere.

**Files.**

- *New file* `frontend/components/studio/artifact-views/diff-body.tsx`
  — wraps a SOP or FAQ body with line-level diff rendering. Reuse a
  lightweight diff lib already in the tree if present (grep for
  `diff-match-patch` or `jsdiff`); otherwise add `diff` (small, no
  peer deps).
- `frontend/components/studio/artifact-views/sop-view.tsx` and
  `faq-view.tsx` — accept an optional `prevBody` prop; when present
  and the toggle is on, render via `diff-body.tsx`.
- [`frontend/lib/build-api.ts`](../../frontend/lib/build-api.ts) —
  add `apiGetArtifactVersion(artifact, id, at: ISO-string)` that
  returns the artifact as it existed at a given timestamp. Backend
  may already have per-version reads via `AiConfigVersion` for
  system_prompt; SOP/FAQ versions may need a `History` table scan
  or a `snapshotBefore` computed field on `BuildTransaction`.
  **Check the backend first — if the version-at-time lookup isn't
  cheap, scope B2 to "compare against the oldest version touched
  this session" (simpler query) and note in the handoff.**
- [`frontend/components/studio/artifact-drawer.tsx`](../../frontend/components/studio/artifact-drawer.tsx)
  — add the "View changes" toggle in the drawer footer; hide it
  entirely when the artifact isn't in the current session's
  artifact list.

**Implementation sketch.**

1. Drawer asks `StudioSurface` for the artifact's pre-session body
   via a new `getPrevBody(artifact, id)` selector that reads from
   the same `sessionArtifacts` state A3 owns. The selector returns
   `null` if the artifact wasn't touched this session (toggle hidden).
2. For pending state: if the artifact is in the session list with
   `action: 'created'` or `'modified'` but the plan hasn't been
   approved yet (state chip reads "pending · N sec ago" — extend
   A3 to emit this state if it doesn't already), render the proposed
   body wrapped in the A1 pending grammar (italic + inkMuted + an
   "Unsaved" badge above the body).
3. Diff rendering: line-level for SOPs (markdown paragraphs), token-
   level for FAQs (one Q + one A — tokens read better than lines on
   short text). Red-strike for removed, green-underline for added.
   Background tints should come from existing `STUDIO_COLORS`
   (`dangerBg` / `successBg` equivalents) — do not introduce a new
   palette.

**Tests.**

- Component tests for `diff-body.tsx` (add / remove / modify cases,
  empty-diff case, pending state).
- Snapshot test for SOP with active diff, FAQ with active diff.

**Effort.** 8–12 hours. Effort swings on whether version-at-time is
already cheap.

**Operator impact.** **High.** Closes the "did my change actually do
what I thought" loop without needing to run test_pipeline.

---

### 1.3 Gate B3 — Inline citations in chat text

**Goal.** Any AI-generated text span that references a concrete
artifact renders that reference as a clickable citation chip.
Click opens the artifact drawer (B1) scrolled to the quoted span.
Phase 1 accepts a narrow citation shape — if the cost to emit is
high, this gate stays small and grows with Bundle D onwards.

**Files.**

- [`frontend/components/studio/studio-chat.tsx`](../../frontend/components/studio/studio-chat.tsx)
  — extend the text-part branch in `MessageRow` to detect citation
  markers and render them as chips. A citation marker is a
  zero-width sentinel: `[[cite:sop:abc123#section-early-checkin]]`
  inserted by the agent. Parse, render, link.
- *New file* `frontend/components/studio/citation-chip.tsx` —
  the chip component. ~80 lines. Shows artifact-type icon + short
  label; hover shows full reference.
- [`backend/src/build-tune-agent/system-prompt.ts`](../../backend/src/build-tune-agent/system-prompt.ts)
  — teach the system prompt to use citations. Add a short section
  ("Citation grammar") with 2–3 examples. No other prompt-section
  changes.

**Implementation sketch.**

1. Choose the marker format deliberately — the brainstorm §3.7
   suggested `data-artifact-citation`-as-a-part. That's cleaner
   (structured) but requires the agent to emit citations as
   separate parts, which is awkward for inline text. Sentinel-
   in-text is uglier backend-side but renders cleanly on the
   frontend with a regex split. Going sentinel-in-text.
2. Parser: split text on
   `/\[\[cite:(sop|faq|system_prompt|tool|property_override):([^\]#]+)(?:#([^\]]+))?\]\]/g`,
   render the matches as `<CitationChip>` and the non-matches as
   plain text nodes (honouring the A1 origin grammar). Keep it
   simple — no nested citations, no markdown inside citations.
3. Click handler: chip calls `openArtifactDrawer(artifact, id,
   section)` where `section` is the optional `#...` fragment.
   B1's drawer can accept an optional `scrollToSection` prop
   (wire through to the body renderer — the SOP-view body
   is markdown; find a heading whose id matches and scroll).
4. Failure mode: if the marker points at an artifact id the
   current tenant doesn't have, the chip renders in muted grey
   with a "missing" tooltip — don't crash, don't 404 the whole
   turn.

**Tests.**

- Unit tests for the parser (5–7 cases: no markers, single marker,
  multiple in one paragraph, malformed marker, unicode around
  marker).
- Component test: click the chip, drawer opens with correct
  artifact + section.
- Prompt spec — add a backend test that the system prompt emit
  contains the citation grammar section (catches accidental
  removal).

**Effort.** 8–10 hours. Split the parser test-thoroughness from
the chip component — parser is load-bearing so it gets more cases.

**Operator impact.** **High** once the agent emits citations
reliably. Depends on B4 landing too — B4 is the backend sibling that
gives the agent a first-class "quote this" affordance in addition to
inline citations.

---

### 1.4 Gate B4 — `data-artifact-quote` backend emitter

**Goal.** Activate the `data-artifact-quote` data-part that shipped
renderer-only in sprint-050-A1. The agent can now emit block-level
quotes of existing artifact content with source attribution. Pairs
with B3: citations are for *claims* inline, quotes are for
*excerpts* the agent is discussing.

**Files.**

- [`backend/src/build-tune-agent/tools/propose-suggestion.ts`](../../backend/src/build-tune-agent/tools/propose-suggestion.ts)
  and [`backend/src/build-tune-agent/tools/emit-audit.ts`](../../backend/src/build-tune-agent/tools/emit-audit.ts)
  — natural hosts. When the tool response quotes from an existing
  SOP / FAQ / prompt section, emit a `data-artifact-quote` part
  alongside the tool output.
- *New tool (optional, small)*:
  `backend/src/build-tune-agent/tools/quote-artifact.ts` — an
  explicit affordance the agent can call to emit a quote block
  without going through propose-suggestion. Scope call: if the
  existing tools' natural emit sites cover 80% of real cases, skip
  this file. If not, 50–80 lines, one unit test.
- [`backend/src/build-tune-agent/system-prompt.ts`](../../backend/src/build-tune-agent/system-prompt.ts)
  — short section teaching the agent when to quote vs cite: quote
  when showing the operator what the current artifact *says* so they
  can compare to a proposed change; cite when making a factual
  claim with "this is where I got that."
- [`frontend/components/studio/studio-chat.tsx`](../../frontend/components/studio/studio-chat.tsx)
  — verify the A1 `StandalonePart` switch handles
  `data-artifact-quote`. It should already from 050-A1; confirm
  with a manual render test.

**Implementation sketch.**

1. Quote emission is fire-and-forget — if emit fails, the tool
   response still surfaces. The quote is a redundancy win, not a
   dependency.
2. Content safety: sanitise quoted bodies through the shared
   sanitiser before emit (same redaction rules as A2). If a quoted
   block would be entirely `[redacted]`, suppress the emit instead
   of emitting an empty quote.
3. Attribution: the emitted part must carry `{ artifact, artifactId,
   sourceLabel, body }` (matches the shape brainstorm §1.1 already
   spec'd). `sourceLabel` is human-readable ("SOP: early-checkin ·
   variant: CONFIRMED"); `artifactId` is the stable id the frontend
   can use to open the drawer.
4. Click-through: the quote's attribution chip (rendered by A1) is
   clickable and opens the drawer same as a B3 citation — add the
   opener wiring in `studio-chat.tsx` if not already present.

**Tests.**

- Backend unit tests for the sanitisation-on-emit path (3–4 cases).
- Emit-site tests: propose-suggestion and emit-audit both fire the
  part when appropriate; suppressed when the body is
  fully-redacted.
- Frontend: component test confirming quote parts are clickable and
  open the drawer.

**Effort.** 6–8 hours. Smaller than it sounds because the renderer
already exists; this gate is emit + prompt + click-through.

**Operator impact.** **Medium-high** — not immediately visible but
once B3 citations compound with it, the chat surface has a full
"the agent is talking about a concrete artifact and can prove it"
grammar.

---

### 1.5 Gate B5 — Verification

**Goal.** tsc clean both sides, full test suites green, end-to-end
manual pass on the new surfaces.

**Checks.**

1. `cd backend && npx tsc --noEmit` clean.
2. `cd frontend && npx tsc --noEmit` clean.
3. `cd backend && npm run test` — full green.
4. `cd frontend && npm test` — full green; expect +40 cases across
   ~8 new/modified files.
5. Manual: open a session in Studio, click a row in Session
   Artifacts — drawer opens with the right artifact. Esc closes.
   Tab cycles inside drawer.
6. Manual: trigger a build plan that modifies an SOP. Without
   approving it, open the drawer — "View changes" toggle shows the
   proposed body in A1 pending grammar. Approve the plan — toggle
   now shows committed diff against pre-session body.
7. Manual: start a new session and ask the agent to review an
   existing SOP. Confirm the agent emits at least one citation or
   quote. Click — drawer opens at the cited section.
8. Manual: admin-vs-operator tier on the tool-view webhook config —
   operator sees `[redacted]` on any secret fields; admin with
   full-output toggle off also sees `[redacted]` (the 050-A4
   sanitiser-asymmetry invariant must hold in the drawer too).
9. Read `PROGRESS.md`, append a "Sprint 051 — Session A" section
   with per-gate commits, tests, caveats, and (critically) whether
   the owner-side 050-A smoke test ran before this sprint started.

---

## §2 Non-negotiables

- **`ai.service.ts` untouched.** Guest messaging flow out of scope.
- **No schema changes.** Prisma untouched. No `prisma db push`.
- **Drawer is viewer-only.** No inline edit this sprint. "Open in
  tuning" deep-link button is the edit path — A3's existing
  affordance, just moved.
- **Admin-only surfaces stay admin-only** — full-prompt view,
  tool runtime flag, full-output toggle.
- **Sanitisation applies in the drawer too.** Webhook configs, raw
  prompts, anywhere a secret could live. Unit-tested.
- **A1 origin-grammar invariant extends to the drawer.** Pending
  artifact state in the drawer renders in italic grey + Unsaved
  badge, same as in the chat.
- **No write-ledger unification.** Sprint-050-A caveat #3 stays
  deferred; flag in NEXT.md for an explicit next-sprint choice.
- **Citation marker format is backend-facing.** If the format
  changes between this sprint and Bundle D, it's an API break —
  treat it that way and document.
- **Graceful degradation on missing data.** Drawer opens with a
  "missing artifact" banner for stale ids; citations render muted
  for unknown artifact references.

---

## §3 Deferred (explicitly not in this sprint)

- Inline edit from the drawer; "Compose at cursor" (§6.3).
- Diff for system_prompt, tool_definition, property_override.
- Version slider / per-version navigation in the drawer.
- Artifact drawer cross-linking (click a ref in one artifact
  jumps to another).
- Suggested-fix rollback → "reverted" state (sprint-050-A caveat #3).
  Tracks into Bundle C gate 1 or a standalone mini-session.
- Tiered permissions, typed-confirm, dry-run-before-write (Bundle C).
- Try-it composer (Bundle C).
- Session-list task board (Bundle D).
- Queued follow-ups during streaming (Bundle D).
- Posture banner / brownfield opportunities (Bundle E).
- A11y pass on origin-grammar and on the drawer focus trap
  (cross-cutting — separate a11y sprint).

If any of the above surfaces mid-sprint, note in `PROGRESS.md`
post-session — do not scope-expand.

---

## §4 Gate sheet

| Gate | Title | Files (primary) | Tests | Effort |
| ---- | ----- | --------------- | ----- | ------ |
| B1 | Artifact drawer shell | *new* `artifact-drawer.tsx` + 5 *new* views in `artifact-views/`, `session-artifacts.tsx`, `studio-surface.tsx`, `build-api.ts` | per-view component tests (5) + integration open/close + sanitisation regression | 14–18 h |
| B2 | Diff rendering (SOP + FAQ) | *new* `diff-body.tsx`, SOP/FAQ views, `build-api.ts` (version-at-time), `artifact-drawer.tsx` (toggle) | diff-body cases (5) + SOP / FAQ snapshot + pending-state grammar | 8–12 h |
| B3 | Inline citations | `studio-chat.tsx`, *new* `citation-chip.tsx`, `system-prompt.ts` | parser cases (5–7) + chip click + system-prompt regression | 8–10 h |
| B4 | `data-artifact-quote` emitter | `propose-suggestion.ts`, `emit-audit.ts`, optionally *new* `quote-artifact.ts`, `system-prompt.ts`, `studio-chat.tsx` (confirm only) | sanitisation on emit (3–4) + emit-site cases + frontend click-through | 6–8 h |
| B5 | Verification | tsc + suites both sides + manual walkthrough + `PROGRESS.md` | — | 2 h |

Total rough: 38–50 hours. This is bigger than 050-A by design — the
drawer shell is the expensive primitive. If time compresses, drop
B4 last (emitter can ship in a follow-up mini-session since the
renderer is already live) and ship B1/B2/B3 as the coherent depth
bundle.

---

## §5 Success criteria

- **SC-1.** Clicking a row in the Session Artifacts panel opens a
  drawer with the right artifact; drawer is viewer-only; Esc closes;
  focus returns to the opener.
- **SC-2.** All five artifact types render in their own view
  component with correct metadata; sanitisation blanks any secret
  field; admin-only toggles gated correctly.
- **SC-3.** For SOP and FAQ artifacts touched in the current session,
  a "View changes" toggle reveals line-/token-level diffs against
  the pre-session body. Pending artifact state renders in A1 italic
  grey + Unsaved badge.
- **SC-4.** AI-generated text containing citation markers renders
  citations as clickable chips; clicking opens the drawer scrolled
  to the right section. Unknown artifact refs render muted with
  "missing" tooltip — no crash.
- **SC-5.** The agent emits at least one `data-artifact-quote` part
  per representative quote-worthy turn (manual verification step).
  Fully-redacted quote bodies are suppressed rather than emitted.
- **SC-6.** `npx tsc --noEmit` clean on both sides; both test
  suites green; ~40 new cases land.
- **SC-7.** No regression on 050-A surfaces: tool-call drawer,
  session artifacts panel, typographic attribution invariants.
- **SC-8.** `PROGRESS.md` has a "Sprint 051 — Session A" block
  with commit SHAs, tests, caveats, and an explicit note on whether
  the 050-A smoke test ran before this sprint started.

---

## §6 Handoff

After B5 is green:

1. Commit each gate separately with the repo's imperative,
   scope-prefixed one-line style.
2. Append `PROGRESS.md` with the session block.
3. **Rewrite `NEXT.md`** — archive the current kickoff as
   `NEXT.sprint-051-session-a.archive.md`, then write a new
   `NEXT.md` that surfaces three candidates for sprint-052-A:
   - **Bundle C primary** — tiered permissions + Try-it composer
     + dry-run-before-write. Include sprint-050-A caveat #3
     (suggested-fix rollback → "reverted" state) as gate C1 since
     the write-ledger unification aligns with the permissions
     work.
   - **Correctness carry-over bundle** — the still-deferred
     sprint-049 items (P1-5, P1-2, P1-4, P1-6, F1, P1-3 DB-half)
     plus any 050-A or 051-A caveats that haven't been absorbed.
   - **B extension bundle** — diff for system_prompt and tool
     artifacts, version slider, inline-edit from the drawer.
     Call out as "only if operator pressure surfaces."
4. Branch `sprint-051-a` stays off `main` until the owner runs
   the combined 050-A + 051-A manual smoke test. The citation
   parser and the sanitisation-on-quote-emit paths are both
   load-bearing for that sign-off.

End of session A.
