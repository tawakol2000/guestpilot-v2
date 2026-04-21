# Sprint 052 — Session A: B-extension mop-up (close the B bundle)

> Finishes the Bundle B debt that surfaced in sprint-051-A's close-out.
> Four items the 051-A brief explicitly deferred or shipped as
> best-effort, collected here as a single coherent "finish the viewer"
> sprint. After this lands, the B bundle is actually complete and 053-A
> can pick up Bundle C without half-shipped debt underneath it.
>
> Scope source: sprint-051-A close-out caveats + its own NEXT.md §3
> B-extension candidate list. Specifically: (a) markdown rendering for
> SOP/FAQ/system_prompt bodies in the artifact drawer, (b) promoting
> scrollToSection from best-effort to actually-works against the new
> heading anchors, (c) activating the `prevBody` path on
> `SystemPromptView` (the prop already exists), (d) adding diff
> rendering to `ToolView` for the JSON schema.
>
> This is a frontend-only sprint. No backend changes. No schema
> changes. No new tools. No prompt changes.
>
> Read sections in order: §0 context, §1 gates, §2 non-negotiables,
> §3 deferred, §4 gate sheet, §5 success criteria, §6 handoff.

---

## §0 Context

### Where we are

Sprint 051-A closed at `b322663` on `feat/051-session-a`, stacked on
`feat/050-session-a`. Both off `main` pending the combined 050-A +
051-A staging walkthrough. Tests +60 (target +40). B1 drawer shell,
B2 diff, B3 citations, B4 quote emitter all shipped.

Two real half-ships surfaced:

1. **Markdown isn't rendered.** `PreBody` in `sop-view.tsx` is a
   `<pre>` with monospace + `whitespace-pre-wrap`. SOP bodies look
   like code blocks to the operator. Same shape in `faq-view.tsx`
   and `system-prompt-view.tsx`. Comment on sop-view.tsx line 6–7
   explicitly calls this out: "Markdown-style body renders as a
   pre-wrapped block (no parser yet — keeps the diff diff; markdown
   can layer on later without changing the …)".
2. **`scrollToSection` is best-effort.** The B3 citation chip passes
   a section fragment to `openArtifactDrawer`, but the drawer has no
   heading anchors to scroll to because markdown isn't rendering.
   A citation with `#section-early-checkin` opens the drawer and
   lands at the top. Half-shipped feature.

Two more items the 051-A brief deferred on purpose:

3. **`SystemPromptView` diff.** Per 051-A close-out: "SystemPromptView
   already accepts `showDiff` but no `prevBody` path wired yet." The
   prop is there, the wiring isn't.
4. **`ToolView` diff.** Tool schemas (JSON) weren't in B2 scope.
   JSON-diff is a different renderer than line/token text diff, so
   it needs its own component.

### Why these four together

They compose into "the viewer story is actually finished." Markdown
rendering unlocks `scrollToSection`, which promotes B3 citations from
half-shipped to complete. System_prompt diff and tool diff close the
matrix on "every artifact in the drawer shows before/after when the
session has touched it." Splitting them into two sprints would spread
the same file-edit surface across both and duplicate the test setup.

### Read list before touching code

1. **This file** (§1 through §6).
2. [`sprint-051-session-a.md`](./sprint-051-session-a.md) §1.2 (B2
   diff implementation) and §1.3 (B3 citations + scrollToSection).
3. [`frontend/components/studio/artifact-views/sop-view.tsx`](../../frontend/components/studio/artifact-views/sop-view.tsx)
   — `PreBody` is the load-bearing component being replaced.
4. [`frontend/components/studio/artifact-views/faq-view.tsx`](../../frontend/components/studio/artifact-views/faq-view.tsx)
5. [`frontend/components/studio/artifact-views/system-prompt-view.tsx`](../../frontend/components/studio/artifact-views/system-prompt-view.tsx)
   — check how `showDiff` is currently accepted and what the diff
   render path looks like today. The prop hook-up is a small seam.
6. [`frontend/components/studio/artifact-views/tool-view.tsx`](../../frontend/components/studio/artifact-views/tool-view.tsx)
   — how the JSON schema renders today; where the diff insertion
   goes.
7. [`frontend/components/studio/artifact-views/diff-body.tsx`](../../frontend/components/studio/artifact-views/diff-body.tsx)
   — sibling component; the markdown renderer needs to compose with
   it (diff-view keeps raw text; rendered-view uses markdown).
8. [`frontend/components/studio/citation-chip.tsx`](../../frontend/components/studio/citation-chip.tsx)
   and [`frontend/components/studio/artifact-drawer.tsx`](../../frontend/components/studio/artifact-drawer.tsx)
   — how `scrollToSection` is currently wired. Find the
   "best-effort" site and the comment that flags it.

### Non-goals (do not scope-creep)

- **No inline-edit from the drawer.** Still viewer-only.
- **No version slider / per-version navigation.** Still out of
  scope.
- **No audit quote emit.** 051-A close-out deferred this for good
  reason — audit rows are agent summaries, not verbatim.
- **No Bundle C work.** Tiered permissions, Try-it composer,
  dry-run-before-write all wait for 053-A.
- **No suggested-fix rollback "reverted" state** (sprint-050-A
  caveat #3). Still a backend refactor, still deferred.
- **No correctness carry-overs.** Keep the surface focused.
- **No cross-artifact linking** (click a ref in one artifact jumps
  to another) — that's a future-brainstorm candidate, not this
  sprint.

---

## §1 Gates

Four user-facing gates + one verification. Ordering is load-bearing:
C1 establishes the markdown + heading-anchor primitive that C2 and
C3 both reuse.

### 1.1 Gate C1 — Markdown rendering + heading anchors

**Goal.** Replace the `PreBody` monospace block with a markdown-
rendered body in `SopView`, `FaqView`, and `SystemPromptView`. Every
`##`/`###` heading gets a slug-id so `scrollToSection` can anchor
against it. Diff mode (when "View changes" is on) continues to
render raw text through `diff-body.tsx` — markdown only applies when
the diff toggle is off.

**Files.**

- *New file* `frontend/components/studio/artifact-views/markdown-body.tsx`
  — ~80–120 lines. One component shared by all three views.
  Accepts `{ body: string, isPending: boolean, scrollToSectionSlug?:
  string | null }`. Renders via `react-markdown` with
  `remark-gfm` (GitHub-flavoured — tables, task lists, strikethrough)
  and a slug plugin for heading ids.
- [`frontend/components/studio/artifact-views/sop-view.tsx`](../../frontend/components/studio/artifact-views/sop-view.tsx)
  — replace the `<PreBody>` call with `<MarkdownBody>` in the
  non-diff branch. Keep `PreBody` exported for FAQ answer block
  reuse (short-text FAQ answers may look cleaner as pre-wrapped
  text than as markdown — keep per-view choice).
- [`frontend/components/studio/artifact-views/faq-view.tsx`](../../frontend/components/studio/artifact-views/faq-view.tsx)
  — use `MarkdownBody` for the answer; keep the question as plain
  text (questions are one-liners).
- [`frontend/components/studio/artifact-views/system-prompt-view.tsx`](../../frontend/components/studio/artifact-views/system-prompt-view.tsx)
  — system-prompt sections are markdown-flavoured; use `MarkdownBody`.
- [`frontend/components/studio/artifact-drawer.tsx`](../../frontend/components/studio/artifact-drawer.tsx)
  — accepts an optional `scrollToSection` prop (already wired in from
  051-A B3). Plumb it down into the artifact view, which passes it
  to `MarkdownBody`.
- [`frontend/components/studio/artifact-views/markdown-body.tsx`](../../frontend/components/studio/artifact-views/markdown-body.tsx)
  — on mount/update, if `scrollToSectionSlug` is set, find the
  matching heading element and `scrollIntoView({ behavior: 'smooth',
  block: 'start' })`. Fallback when not found: no scroll, no
  console noise — citations with stale section fragments should
  degrade gracefully.
- *package.json* — add `react-markdown` and `remark-gfm`. Both
  small, no peer-dep conflicts. If `rehype-slug` isn't wanted as a
  third dep, use the `rehype-slug` alternative or a tiny inline
  slugger (10 lines — lowercase, replace non-alphanumeric with `-`,
  collapse dashes). Pick the inline slugger if the dep budget is
  tight.

**Implementation sketch.**

1. Slug rule — keep it simple and documented: headings → `text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')`. Backend citation emission needs to use the same slug
   rule. Add the rule to a shared helper
   `frontend/lib/slug.ts` + *backend* `backend/src/build-tune-agent/lib/slug.ts`
   if the agent generates fragments server-side. **Important:**
   confirm whether citation section fragments are agent-generated
   or frontend-generated today. If agent-generated via the
   system-prompt's `<citation_grammar>` block (shipped in 051-A
   B3), the slug rule must be taught in-prompt too.
2. Styling: shadcn/ui's `prose` Tailwind classes are the canonical
   pattern. Use `prose prose-sm` with `--tw-prose-*` custom
   properties mapped to `STUDIO_COLORS`. No new palette tokens.
   Pending state: wrap in a `data-origin="pending"` div and scope
   the italic + Unsaved-badge styling via CSS selector. The A1
   origin-grammar invariant must hold — don't reinvent.
3. Diff interaction: `MarkdownBody` only renders when the diff
   toggle is OFF. When ON, the existing `diff-body.tsx` path
   continues to render raw text. This is a deliberate choice for
   this sprint — markdown-AST diff is a big lift, and operator
   value is fine without it ("view changes" is a debug affordance,
   "read the artifact" is the primary path).
4. `scrollToSection`: `useEffect` on `[scrollToSectionSlug]`.
   Query `#${CSS.escape(slug)}` inside the body ref. If found,
   scroll. If not, no-op. Timing: scroll after one rAF so the
   markdown has painted.

**Tests.**

- *New* `markdown-body.test.tsx` — 6–8 cases: basic markdown render
  (headings, lists, bold), slug id assignment, scrollToSection
  hits and misses, pending grammar applied, GFM features
  (task list at minimum), empty body.
- *New* `slug.test.ts` — 4–5 cases: alphanumeric, unicode,
  consecutive non-alphanumeric collapse, leading/trailing
  dashes stripped, empty string.
- Update `sop-view.test.tsx`, `faq-view.test.tsx`,
  `system-prompt-view.test.tsx` snapshot expectations for the new
  markdown output.

**Effort.** 8–12 hours. Bulk is the prose styling + slug rule
alignment. `react-markdown` is small and well-trodden.

**Operator impact.** **Very high.** The viewer becomes actually-
readable instead of monospace-code-block-y, and B3 citations go
from half-shipped to actually-works in the same commit.

---

### 1.2 Gate C2 — SystemPromptView diff activation

**Goal.** `SystemPromptView` already accepts `showDiff` from 051-A
B2 scope — the `prevBody` path just isn't wired. Wire it.

**Files.**

- [`frontend/components/studio/artifact-views/system-prompt-view.tsx`](../../frontend/components/studio/artifact-views/system-prompt-view.tsx)
  — add the same `prevBody` prop the SOP/FAQ views accept. When
  present and `showDiff` is on, render through `diff-body.tsx`
  (line-level — system prompts read better as paragraph-diff than
  token-diff).
- [`frontend/components/studio/artifact-drawer.tsx`](../../frontend/components/studio/artifact-drawer.tsx)
  — update the system-prompt route branch to also query for
  `prevBody` via the session-artifact pre-body selector the SOP
  view uses.
- [`frontend/components/studio/session-artifacts.tsx`](../../frontend/components/studio/session-artifacts.tsx)
  — confirm the pre-body selector handles `artifact: 'system_prompt'`.
  If not, extend. The session artifacts panel already tracks
  system_prompt writes from plan approvals.
- [`frontend/lib/build-api.ts`](../../frontend/lib/build-api.ts)
  — confirm `apiGetArtifactVersion` (or equivalent) supports
  system_prompt lookups via `AiConfigVersion`. Likely already yes
  from 051-A B2 but verify.

**Implementation sketch.**

1. Small seam — bulk of the plumbing exists. The new work is
   passing the `prevBody` through one more layer and teaching the
   selector to return the right shape for system-prompt.
2. `prevBody` for system-prompt is the *section body*, not the
   whole prompt. The diff should be scoped to the section the user
   edited. Confirm the session-artifacts record for system-prompt
   writes stores a `sectionId` — if not, extend.
3. Diff renders through `diff-body.tsx` with
   `granularity: 'line'`. Same grammar as SOP diff.

**Tests.**

- Update `system-prompt-view.test.tsx` — add 3 cases: no
  `prevBody` (hides toggle), with `prevBody` + diff off (renders
  markdown), with `prevBody` + diff on (renders line-diff).
- Integration: session-artifacts-drawer test exercises the
  system-prompt click path through a plan that modified a prompt
  section.

**Effort.** 3–5 hours. Mostly wiring.

**Operator impact.** Medium. Closes the artifact-type matrix on
"modified in this session → diff available."

---

### 1.3 Gate C3 — ToolView diff (JSON schema)

**Goal.** `ToolView` shows the tool's JSON schema and metadata.
When the session has touched the tool (via `create_tool_definition`
or `write_tool_definition` — check the registered tools for the
exact write path), show a "View changes" toggle that renders a
JSON-aware diff: added keys green, removed keys red, changed values
inline red-strike/green-underline on the value side.

**Files.**

- *New file* `frontend/components/studio/artifact-views/json-diff-body.tsx`
  — ~120–180 lines. Accepts `{ current: unknown, prev: unknown,
  isPending: boolean }`. Renders a tree-walk of the JSON structure
  with per-key add/remove/change annotations. Lightweight — don't
  pull in a heavyweight JSON-diff library; a small depth-first
  compare function is enough.
- [`frontend/components/studio/artifact-views/tool-view.tsx`](../../frontend/components/studio/artifact-views/tool-view.tsx)
  — add the `prevSchema` prop (and `prevConfig` for webhook
  configs — sanitised, always). Wire the toggle same shape as
  SOP/FAQ views.
- [`frontend/components/studio/artifact-drawer.tsx`](../../frontend/components/studio/artifact-drawer.tsx)
  — tool route branch queries for `prevSchema`.

**Implementation sketch.**

1. JSON-diff algorithm: recurse in parallel over both objects.
   Per key:
   - In both, values equal → render value unchanged.
   - In both, values differ → render as modified (old strike,
     new underline).
   - In prev only → render in red-strike.
   - In current only → render in green-underline.
   - Nested objects/arrays recurse.
2. Sanitisation: `prevConfig` may contain a secret that got
   removed — still need to redact it in the diff so we don't
   leak on the "removed" side. Run both `prev` and `current`
   through `tool-call-sanitise.ts` before diffing. The sanitiser
   returns redacted copies; diff works on redacted values.
3. Admin-tier behaviour: same as the existing `ToolView`
   admin-only full-output toggle — admin sees truncation-relaxed,
   but redact-by-key still applies (sprint-050-A caveat #4
   invariant).
4. Rendering: tree-indented lines, monospace, one key-value per
   line. Accept that deeply nested schemas will be long — operators
   reading a tool diff are specifically trying to see what changed,
   so verbosity is fine.

**Tests.**

- *New* `json-diff-body.test.tsx` — 8–10 cases:
  added key, removed key, value change, nested object
  change, array element change, identical objects, deeply nested,
  sanitisation applied to both sides.
- Update `tool-view.test.tsx` — toggle + diff render.

**Effort.** 6–9 hours. JSON-diff is the bulk.

**Operator impact.** Medium. Lowest raw usage frequency of the
four gates (tools change less often than SOPs) but completing the
matrix matters for operator trust.

---

### 1.4 Gate C4 — Citation fragment end-to-end verification

**Goal.** Now that C1 has shipped heading anchors, B3 citations
actually work. Verify end-to-end: agent emits a citation with a
`#section` fragment, chip renders, click opens the drawer, the
drawer renders markdown, the heading anchor exists, and the page
scrolls to it.

**Files.**

- No new component files. This gate is a verification + a small
  amount of plumbing confirmation.
- [`backend/src/build-tune-agent/system-prompt.ts`](../../backend/src/build-tune-agent/system-prompt.ts)
  — the `<citation_grammar>` section shipped in 051-A B3 teaches
  the citation format. **Verify** it teaches the slug rule that
  C1's `markdown-body.tsx` uses. If the rule is absent or
  different, fold one into the other. This is the single place
  where a frontend/backend mismatch bites silently.
- [`frontend/lib/slug.ts`](../../frontend/lib/slug.ts) (from C1) —
  export the slug rule; reference it in a doc comment in
  `system-prompt.ts` so the next reader knows where the contract
  lives.
- *Existing regression test* — 051-A B3 shipped a backend test
  that locks the citation grammar. Extend that test to assert the
  slug rule in the prompt matches the frontend's slug function's
  behaviour.

**Implementation sketch.**

1. Read the 051-A `<citation_grammar>` block. If the slug rule is
   specified as examples only ("Use `section-early-checkin` style
   slugs"), extend with an explicit rule: "Lowercase, replace any
   non-alphanumeric run with a single `-`, strip leading/trailing
   `-`."
2. Fold the slug rule into the citation-grammar regression test:
   parse the block, find the rule, assert it matches the frontend
   `slug` function's output for 4–5 sample headings.
3. Manual: in the owner-side walkthrough, the agent is prompted
   to cite an SOP section by exact heading. Confirm the chip
   renders, click opens, scroll lands.

**Tests.**

- Backend: extend `citation-grammar.test.ts` with the slug-rule
  match.
- Integration: a frontend test where a citation chip with a
  known section opens the drawer and the matching heading's
  element is in the viewport.

**Effort.** 2–3 hours. Mostly verification.

**Operator impact.** **High.** The fraction of B3 that was
half-shipped becomes fully shipped. Without this gate, C1 leaves
a frontend/backend slug drift latent forever.

---

### 1.5 Gate C5 — Verification

**Goal.** tsc clean both sides, full test suites green, end-to-end
manual pass.

**Checks.**

1. `cd backend && npx tsc --noEmit` clean.
2. `cd frontend && npx tsc --noEmit` clean.
3. `cd backend && npm run test` — full green.
4. `cd frontend && npm test` — full green. Expect +30 cases.
5. Manual (the 050-A + 051-A walkthrough should have run before
   this sprint started — re-check the combined surface):
   - Open an SOP in the drawer. Body renders as formatted
     markdown with headings styled, lists bulleted, code blocks
     monospace. No monospace-wall.
   - Toggle "View changes" — diff renders against pre-session
     body via `diff-body.tsx`. Toggle off — markdown returns.
   - Click a citation chip in chat that has a `#section-*`
     fragment. Drawer opens, scrolls to the section.
   - Open a system_prompt artifact with pending changes. Diff
     toggle works; pending grammar applies (italic + Unsaved).
   - Open a tool artifact with pending changes. JSON diff renders;
     secrets redacted on both sides.
6. Read `PROGRESS.md`, append "Sprint 052 — Session A" with
   per-gate SHAs, tests, caveats, and note that the B bundle is
   now considered complete.

---

## §2 Non-negotiables

- **`ai.service.ts` untouched.** Guest messaging flow out of scope.
- **No schema changes.** Prisma untouched. No `prisma db push`.
- **Viewer-only.** No inline-edit from the drawer.
- **A1 origin-grammar invariant extends to markdown bodies.**
  Pending state is italic + inkMuted with an Unsaved badge,
  same as `<pre>` today. Reader can't tell the grammar comes
  from a wrapper div vs a `<pre>` — and they shouldn't.
- **Sanitisation applies in JSON diff on both sides.** No secret
  leaks through "removed value" rendering.
- **Slug rule is a shared contract.** Frontend + backend use the
  same rule. Regression-locked by C4.
- **Diff mode renders raw text.** Markdown only applies when
  diff is off. Documented in `markdown-body.tsx` top-of-file
  comment so the next reader understands the choice.
- **`react-markdown` + `remark-gfm` are acceptable deps; no
  heavyweight JSON-diff library.** Budget: two small frontend
  deps only.
- **No admin-only toggle regression.** Full-output toggle and
  redact-by-key invariant from sprint-050-A4 still hold in
  `ToolView`.

---

## §3 Deferred (explicitly not in this sprint)

- Markdown-AST structured diff (diff-view still uses raw text).
- Version slider / per-version navigation in the drawer.
- Inline-edit from the drawer.
- Cross-artifact linking (click a ref in one artifact jumps
  to another).
- Audit-row quote emit (agent summaries, not verbatim — right
  call to keep deferred).
- Tiered permissions / typed-confirm / dry-run-before-write
  (Bundle C, next sprint).
- Try-it composer (Bundle C).
- Session-list task board (Bundle D).
- Queued follow-ups during streaming (Bundle D).
- Posture banner / brownfield opportunities (Bundle E).
- Suggested-fix rollback → "reverted" state (sprint-050-A caveat
  #3, still a backend refactor).
- A11y sprint (focus trap + origin-grammar screen-reader
  announcements).
- Markdown rendering inside the chat message body (if someday we
  want AI replies to render markdown formatting — separate
  concern, separate scope).

---

## §4 Gate sheet

| Gate | Title | Files (primary) | Tests | Effort |
| ---- | ----- | --------------- | ----- | ------ |
| C1 | Markdown render + heading anchors | *new* `markdown-body.tsx`, *new* `slug.ts` (frontend+backend), `sop-view.tsx`, `faq-view.tsx`, `system-prompt-view.tsx`, `artifact-drawer.tsx`, package.json | *new* `markdown-body.test.tsx` (6–8) + *new* `slug.test.ts` (4–5) + view-snapshot updates | 8–12 h |
| C2 | SystemPromptView diff activation | `system-prompt-view.tsx`, `artifact-drawer.tsx`, `session-artifacts.tsx`, `build-api.ts` (confirm) | `system-prompt-view.test.tsx` +3 cases + integration | 3–5 h |
| C3 | ToolView JSON-schema diff | *new* `json-diff-body.tsx`, `tool-view.tsx`, `artifact-drawer.tsx` | *new* `json-diff-body.test.tsx` (8–10) + `tool-view.test.tsx` +toggle | 6–9 h |
| C4 | Citation fragment e2e | `system-prompt.ts` backend (confirm slug rule), `slug.ts` (shared reference), extend `citation-grammar.test.ts` | slug-rule regression + frontend integration | 2–3 h |
| C5 | Verification | tsc + suites + manual walkthrough + `PROGRESS.md` | — | 2 h |

Total rough: 21–31 hours. Smaller than 051-A by design — this is a
close-the-debt sprint, not a new-primitive sprint.

---

## §5 Success criteria

- **SC-1.** Every drawer view that accepts markdown-style bodies
  (SOP, FAQ answer, system_prompt) renders formatted markdown with
  headings, lists, bold, code blocks, and GFM tables. No monospace-
  wall.
- **SC-2.** Every top-level heading in a rendered body has a
  slug-id anchor. The same slug rule is enforced on both the
  frontend (via `slug.ts`) and the backend's
  `<citation_grammar>` prompt instructions, locked by a
  regression test.
- **SC-3.** B3 citation chips with `#section-*` fragments open the
  drawer and scroll to the matching heading. Stale fragments
  degrade to no-scroll (no crash, no console noise).
- **SC-4.** `SystemPromptView` and `ToolView` both offer a "View
  changes" toggle when the current session has touched the
  artifact. Tool JSON diffs render with per-key change
  annotations; sanitisation applies to both prev and current
  sides.
- **SC-5.** A1 origin-grammar invariant holds across the
  markdown-rendered body, the line-diff body, and the JSON-diff
  body. Pending state is italic grey + Unsaved badge in all three.
- **SC-6.** `npx tsc --noEmit` clean on both sides; both test
  suites green; ~30 new cases land.
- **SC-7.** No regression on 050-A + 051-A surfaces: tool-call
  drawer, session artifacts panel, typographic attribution,
  artifact drawer shell, SOP/FAQ diff, inline citations (pre-
  fragment), `data-artifact-quote` click-through.
- **SC-8.** `PROGRESS.md` has a "Sprint 052 — Session A" block
  with commit SHAs, tests, any caveats, and an explicit statement
  that the B bundle is now complete.

---

## §6 Handoff

After C5 is green:

1. Commit each gate separately with the repo's imperative,
   scope-prefixed one-line style.
2. Append `PROGRESS.md` with the session block.
3. **Rewrite `NEXT.md`** — archive the current kickoff as
   `NEXT.sprint-052-session-a.archive.md`, then write a new
   `NEXT.md` that surfaces two candidates for sprint-053-A:
   - **Bundle C primary** — tiered permissions (§5.1) + Try-it
     composer (§7.1) + dry-run-before-write for system_prompt
     only (§5.2). Fold sprint-050-A caveat #3 (suggested-fix
     rollback → "reverted" state + write-ledger unification) in
     as gate C1 since it aligns with the permissions work.
   - **Correctness carry-over bundle** — the still-deferred
     sprint-049 items (P1-5, P1-2, P1-4, P1-6, F1, P1-3 DB-half)
     plus any 051-A / 052-A caveats that haven't been absorbed.
     P1-5 is the cheapest single item at 2–3h if an interleave
     feels overdue.
4. Branch `sprint-052-a` stacks on `sprint-051-a` stacks on
   `sprint-050-a`. All three stay off `main` until the owner
   runs the combined walkthrough. If the owner has already run
   the 050-A + 051-A walkthrough by this sprint's kickoff, the
   052-A walkthrough is the final gate before all three merge
   as a train.

End of session A.
