# Sprint 050 — Session A: BUILD audit-unlock (Bundle A)

> First UX sprint on the BUILD / Studio screen. Scope is deliberately
> the three items from Bundle A in
> [`ui-ux-brainstorm-build.md`](./ui-ux-brainstorm-build.md) §16:
> tool-call chain drill-in, typographic attribution, session
> artifacts panel. Together they convert BUILD from "watch the agent
> work and hope" into "audit the agent's work before approving it."
>
> This is pure frontend + capability-layer work. No backend tool
> changes. No schema changes. No guest-message-pipeline touches.
> `ai.service.ts` is not opened.
>
> Read sections in order: §0 context, §1 gates, §2 non-negotiables,
> §3 deferred, §4 gate sheet, §5 success criteria, §6 handoff.

---

## §0 Context

### Where we are

Sprint 049 closed clean at `3f419c3`. The `[TUNING_DIAGNOSTIC_FAILURE]`
log tag shipped at all four tuning fire-and-forget sites; legacy-Copilot
`approveSuggestion` P0 pair fixed; inbox checklist + approve-pill now
toast failures. `NEXT.md` auto-rewrote to six sprint-050 correctness
candidates — we're pivoting to UX for this sprint instead, per the
brainstorm handoff.

### Why this bundle first

Bundle A is the highest-impact BUILD UX change available today because
it makes every subsequent trust-loop improvement possible. The
artifact drawer (Bundle B), tiered permissions (Bundle C), and
onboarding (Bundle E) all assume operators can already *see what the
agent did*. Today they can't — tool outputs are invisible outside the
admin-only Trace drawer, every text span looks the same regardless of
origin, and there's no surface that lists "the artifacts this session
touched."

### Read list before touching code

1. **This file** (§1 through §6).
2. [`ui-ux-brainstorm-build.md`](./ui-ux-brainstorm-build.md) §1
   (current-state code audit), §3.2, §3.5, §4.2, §9 (trace drawer —
   the thing this sprint partially promotes out of admin-only).
3. [`frontend/components/studio/studio-chat.tsx`](../../frontend/components/studio/studio-chat.tsx)
   — read end to end. The whole sprint modifies this file plus 2–3
   new sibling files.
4. [`frontend/components/studio/studio-surface.tsx`](../../frontend/components/studio/studio-surface.tsx)
   — the three-pane shell. Right rail hosts the new artifacts panel.
5. [`backend/src/build-tune-agent/data-parts.ts`](../../backend/src/build-tune-agent/data-parts.ts)
   and [`backend/src/build-tune-agent/tools/index.ts`](../../backend/src/build-tune-agent/tools/index.ts)
   — shape of tool-call parts and write-tool registry (needed to
   classify which tool calls have outputs worth rendering).
6. [`frontend/components/build/plan-checklist.tsx`](../../frontend/components/build/plan-checklist.tsx)
   — the existing write-ritual surface. A3 adds artifacts to the rail
   from the same approvals this component already handles.

### Non-goals (do not scope-creep)

- **No artifact drawer.** Bundle B. Out of scope. Artifact rows in the
  rail are clickable placeholders that deep-link to existing tuning
  pages for this sprint — the unified drawer lands later.
- **No tiered permissions or dry-run-before-write.** Bundle C.
- **No editable plans, per-item approval, or prompt queue.**
- **No backend tool changes.** The data-part shape is already
  sufficient for everything below.
- **No trace drawer promotion.** A2 ships operator-visible tool-call
  drill-in via a new lightweight drawer; the existing admin-only
  trace drawer stays behind its flag untouched.

---

## §1 Gates

Three user-facing gates + one verification gate. Ordering matters:
A1 establishes the typographic grammar that A2 inherits.

### 1.1 Gate A1 — Typographic attribution

**Goal.** Every text span in the Studio chat renders in a type-colour
that reflects origin: human-typed = `ink` black; agent-written =
`inkMuted` grey; quoted existing-artifact content = monospace block
with a left-rule attribution chip; pending agent-proposed text
(inside a not-yet-approved plan or suggested fix) = italic grey with
an "unsaved" badge.

**Files.**

- [`frontend/components/studio/studio-chat.tsx`](../../frontend/components/studio/studio-chat.tsx)
  — `MessageRow` (line ~282) and the text-part branch (line ~326) are
  the main edit surfaces.
- [`frontend/components/studio/tokens.ts`](../../frontend/components/studio/tokens.ts)
  — add 2–3 attribution tokens (`attributionQuoteBg`,
  `attributionQuoteRule`, `attributionUnsavedFg`) if the existing
  palette can't cover them. Reuse existing tokens wherever possible.
- [`frontend/components/studio/suggested-fix.tsx`](../../frontend/components/studio/suggested-fix.tsx)
  and [`frontend/components/build/plan-checklist.tsx`](../../frontend/components/build/plan-checklist.tsx)
  — proposed-but-not-approved state renders with the "unsaved"
  italic-grey grammar.

**Implementation sketch.**

1. Add a lightweight `AttributedText` component (or extend
   `MessageRow`'s text branch) that takes an `origin: 'user' | 'agent'
   | 'quoted' | 'pending'` plus optional `sourceLabel` for quoted
   blocks. Not a renderer switch — just a styling wrapper.
2. `MessageRow`'s `isUser` check already distinguishes user vs agent
   at the role level. Use that to pick `origin='user'` vs
   `origin='agent'` on text parts by default.
3. For **quoted content**, extend the backend `data-artifact-quote`
   part — *new* part type, additive to `data-parts.ts`. Payload:
   `{ artifact: 'sop'|'faq'|'system_prompt'|'tool', artifactId: string,
   sourceLabel: string, body: string }`. When the agent wants to
   quote existing artifact content inline, it emits this part
   instead of inlining the text in the `text` part. Renders as a
   monospace block with a 2px left-rule and the source chip above.
4. For **pending** state, `PlanChecklist` + `SuggestedFixCard`
   already know their state. Where they render proposed-new-content
   (the "after" side of a diff, new FAQ body, etc.), wrap in
   `origin='pending'`. On approval, the state change flips the class
   to `origin='agent'` (committed). Visual: italic grey → upright
   muted grey with "unsaved" badge removed.

**Data-parts change (additive only).**

Add `data-artifact-quote` to
[`backend/src/build-tune-agent/data-parts.ts`](../../backend/src/build-tune-agent/data-parts.ts)
`DATA_PART_TYPES`. Emit path is agent-controlled — no tool shape
changes. Ship the renderer first; emitter work can follow as a
`propose_suggestion` tool enhancement in a later gate.

**Tests.**

- Extend `components/studio/__tests__/studio-chat.spec.tsx` with
  origin-class assertions for each origin branch.
- Snapshot test the quoted block's monospace + left-rule grammar.

**Effort.** 4–6 hours. Pure styling + small component seam.

**Operator impact.** Medium on its own; **foundational for A2 and
A3.** Legibility compounds across every BUILD session.

---

### 1.2 Gate A2 — Tool-call chain drill-in (operator-visible)

**Goal.** Click any tool-call chip in the centre pane → opens a
drill-in drawer (or expanding card) that shows: tool name, input
args, output (if available), latency, error (if any). Sanitised
payload only — no raw API keys, no other tenants' data. Admin-only
full-output toggle reuses the existing `capabilities.traceViewEnabled`
gate.

**Files.**

- [`frontend/components/studio/studio-chat.tsx`](../../frontend/components/studio/studio-chat.tsx)
  — `ToolCallChip` (line ~590) gains a click handler that opens the
  new drawer. Chip style stays unchanged.
- *New file*
  `frontend/components/studio/tool-call-drawer.tsx` — 250–350 line
  component. Slide-out from the right side of the centre pane (not
  the full-screen right rail). Closable with Esc.
- *New file* `frontend/lib/tool-call-sanitise.ts` — redaction
  helpers. Walks a tool input/output payload, removes known
  sensitive keys (`apiKey`, `token`, `secret`, `Authorization`),
  truncates output to 1000 chars operator-side (unlimited for
  admin).
- [`frontend/components/studio/studio-chat.tsx`](../../frontend/components/studio/studio-chat.tsx)
  — lift a `openToolDrawer` callback so `MessageRow` can pass the
  click through.
- [`backend/src/build-tune-agent/data-parts.ts`](../../backend/src/build-tune-agent/data-parts.ts)
  — confirm the `tool-*` data parts already carry `input` and
  `output` (they do — AI-SDK native). No shape change, just
  confirming we render them.

**Implementation sketch.**

1. `ToolCallChip` already knows `toolName` + `state`. Extend its
   props with the full part object so the drawer can render
   `part.input` and `part.output`. Add `onClick` handler.
2. Drawer layout (320px wide, slides over the right 1/3 of the
   centre pane, does NOT cover the rail — this matters so the
   state snapshot stays visible):
   - Header: tool short-name (same stripping as the chip) + state
     chip + close X.
   - "Input" section: pretty-printed JSON (syntax highlighted —
     reuse lightweight `react-json-view` or equivalent if it's
     already in the tree; otherwise a plain `<pre>` with
     `JSON.stringify(val, null, 2)` is acceptable).
   - "Output" section: same, with the sanitiser applied. If
     `state === 'output-error'`, show the error in the danger
     palette.
   - Metadata: model used (if present on part), latency (if
     present on part), turn index.
   - Admin-only "Show full output" toggle — gated on
     `capabilities.isAdmin && capabilities.traceViewEnabled`.
3. Deliberate negative space: **no re-run button, no edit-args
   button.** Those are Bundle B/C territory. Viewer-only for now.
4. Esc closes. Click-outside closes. Focus returns to the chip
   that opened it.

**Sanitisation rules.** Redact-by-key for anything matching:
`/api[_-]?key/i`, `/token/i`, `/secret/i`, `/authorization/i`,
`/password/i`, `/credential/i`. Values become `'[redacted]'`.
Truncate string values > 1000 chars with `'…[truncated]'` suffix
(operator tier only; admins see full). Unit test the sanitiser
against a sample payload.

**Tests.**

- Unit test `tool-call-sanitise.ts` (5–7 cases covering each rule).
- Component test: opening the drawer surfaces input/output; closing
  via Esc restores focus to the chip; admin-gated toggle only
  renders for admin-flagged capabilities.

**Effort.** 8–10 hours. New component + sanitiser + integration.

**Operator impact.** **Very high.** This is the single feature that
converts BUILD from "trust the agent" to "verify the agent."

---

### 1.3 Gate A3 — Session artifacts panel (right rail)

**Goal.** New right-rail card below `StateSnapshotCard` titled
"Session artifacts." Auto-populates on every approved build plan
and every accepted suggested-fix within the current session. Rows
show artifact-type icon, title + truncated ID, state chip
("created · 30 sec ago" / "modified · 2 min ago" / "reverted · 5
min ago"). Click opens the deep-link to the existing tuning page
for that artifact (placeholder until Bundle B drawer).

**Files.**

- [`frontend/components/studio/studio-surface.tsx`](../../frontend/components/studio/studio-surface.tsx)
  — `RightRail` function (line ~430). Add a new
  `<SessionArtifactsCard>` between `<StateSnapshotCard>` and the
  test-results card.
- *New file* `frontend/components/studio/session-artifacts.tsx` —
  the card component + row renderer. ~180 lines.
- [`frontend/components/studio/studio-surface.tsx`](../../frontend/components/studio/studio-surface.tsx)
  — new React state `sessionArtifacts: SessionArtifact[]` + a
  callback passed down to `StudioChat`. `StudioChat` calls it when
  `data-build-plan` flips to `approved` and when
  `data-suggested-fix` gets `accept`'d.
- [`frontend/components/studio/studio-chat.tsx`](../../frontend/components/studio/studio-chat.tsx)
  — `PlanChecklist`'s `onApproved` and `SuggestedFixCard`'s
  `onAccept` wiring both now emit a record that reaches the new
  callback.

**Implementation sketch.**

1. Define the shape:
   ```ts
   type SessionArtifact = {
     id: string            // artifactId + subsection (stable key)
     artifact: 'sop' | 'faq' | 'system_prompt' | 'tool' | 'property_override'
     artifactId: string
     title: string         // human label ("SOP: early-checkin · CONFIRMED")
     action: 'created' | 'modified' | 'reverted'
     at: string            // ISO
     deepLink?: string     // e.g. /tuning/sops/xxx; null → disabled click
   }
   ```
2. `StudioSurface` owns the `sessionArtifacts` array. Callback
   `handleArtifactTouched(next: SessionArtifact)` upserts by `id`
   (newer action wins; revert overrides create/modify).
3. `StudioChat` wires two paths to the callback:
   - `onPlanApproved(transactionId)`: call `GET /api/build/plans/:id`
     (or enrich the `data-build-plan` part itself to carry the
     per-item artifact metadata) so the card knows what artifacts
     the plan wrote. If the plan part already carries
     `items[].target.artifactId` (read
     [`plan-checklist.tsx`](../../frontend/components/build/plan-checklist.tsx)
     to confirm — it does, via `BuildPlanItemTarget`), no extra
     round-trip is needed.
   - `onAccept` on `SuggestedFixCard`: the accept payload already has
     `target.artifactId`. Shape directly.
4. Session artifacts reset when `conversationId` changes (handled
   automatically since state lives inside `StudioSurface`, which
   rehydrates on conversationId change via `bootstrapRef` already).
5. Rendering: one row per artifact, accent-type icon, title, state
   chip, relative-time ("2m ago"). Click opens `deepLink` in the
   same tab (operator workflow is single-pane-focus).
6. Empty state: "No artifacts touched in this session yet." at
   `inkSubtle`.

**Deep-link routing.** Use a static map inside
`session-artifacts.tsx` for now:
- `sop` → `/tuning/sops/:id`
- `faq` → `/tuning/faqs/:id`
- `tool` → `/tools/:id`
- `system_prompt` → `/configure-ai?section=:id`
- `property_override` → `/properties/:id#overrides`

These deep-links are intentionally coarse — clicking lands on the
existing page. Unified artifact drawer (Bundle B) replaces this
map later.

**Tests.**

- Component test for `SessionArtifactsCard` rendering: create /
  modify / revert state chips, empty state, deep-link anchors.
- Integration-ish test: approving a plan in `StudioChat` inserts the
  artifacts into the rail card.

**Effort.** 6–8 hours. New card + wiring + state lift.

**Operator impact.** **High.** Every session becomes reviewable at
a glance: "here's what actually changed today."

---

### 1.4 Gate A4 — Verification

**Goal.** End-to-end manual pass + full unit/component test suite
green on both sides.

**Checks.**

1. `cd backend && npx tsc --noEmit` clean.
2. `cd frontend && npx tsc --noEmit` clean.
3. `cd backend && npm run test` → all existing green, any new
   tests green.
4. `cd frontend && npm test` → same.
5. Manual: open `/inbox?navTab=studio` with a fresh conversation.
   - Send a message that triggers a tool call.
   - Confirm the chip is clickable; drawer opens; Esc closes.
   - Confirm admin-only "Show full output" toggle hidden for
     non-admin tenants.
6. Manual: emit an approve a build-plan (pick a small SOP
   create). Confirm the artifact lands in the right-rail panel with
   the correct state chip. Click — confirm it deep-links to the
   tuning page.
7. Manual: run the same approval as admin; confirm no regression on
   existing trace drawer behaviour.
8. Read `PROGRESS.md` and append a "Sprint 050 — Session A" section
   with commits, tests, and caveats.

**No new database state.** Schema unchanged. No `prisma db push`
needed.

---

## §2 Non-negotiables

- **`ai.service.ts` untouched.** Guest messaging flow out of scope.
- **No schema changes.** Prisma untouched. `prisma db push` not run.
- **No agent-side tool shape changes.** `data-parts.ts` gains one
  additive new type (`data-artifact-quote`) but the emitter isn't
  wired this sprint — it's renderer-only so the backend can ship
  the emitter independently later.
- **Admin-only surfaces stay admin-only** — the existing
  triple-gated Trace drawer is not promoted. A2's drawer is
  operator-tier but with an admin-gated "Show full output" toggle.
- **Graceful degradation on every new UI state.** Artifacts panel
  with no artifacts → empty-state string. Drawer with a tool part
  that has no output yet (still streaming) → "Waiting for output…"
  not a crash.
- **Sanitisation is mandatory on the operator-tier drawer path.**
  Unit-tested. No raw-API-key leak.
- **Keyboard: Esc closes the tool-call drawer.** Click-outside
  closes. No other hotkeys this sprint.

---

## §3 Deferred (explicitly not in this sprint)

- Artifact unified drawer (Bundle B). Deep-links are placeholders.
- Inline citations in chat text (Bundle B — depends on drawer).
- Tiered permissions / typed-confirm / dry-run-before-write
  (Bundle C).
- Try-it composer (Bundle C).
- Session-list task board + grouping (Bundle D).
- Queued follow-ups during streaming (Bundle D).
- Posture banner and brownfield opportunities (Bundle E).
- Expandable state-snapshot rows (Bundle E foundation).
- Remembered-preferences card / cleared rejections UI.
- Dark mode.
- Full raw-prompt Canvas.

If any of the above feels urgent mid-sprint, surface it as a
**post-session note** in `PROGRESS.md` — do not scope-expand.

---

## §4 Gate sheet

| Gate | Title | Files (primary) | Tests | Effort |
| ---- | ----- | --------------- | ----- | ------ |
| A1 | Typographic attribution | `studio-chat.tsx`, `tokens.ts`, `suggested-fix.tsx`, `plan-checklist.tsx`, `data-parts.ts` (add type) | `studio-chat.spec.tsx` origin-class cases + snapshot | 4–6 h |
| A2 | Tool-call drill-in drawer | *new* `tool-call-drawer.tsx`, *new* `tool-call-sanitise.ts`, `studio-chat.tsx` | sanitiser unit (5–7 cases) + drawer component test | 8–10 h |
| A3 | Session artifacts panel | *new* `session-artifacts.tsx`, `studio-surface.tsx`, `studio-chat.tsx` | artifacts card component test + integration case | 6–8 h |
| A4 | Verification | tsc + test suites both sides + manual walkthrough + `PROGRESS.md` entry | — | 1–2 h |

Total rough: 19–26 hours. One focused session.

---

## §5 Success criteria

- **SC-1.** Every text span in the Studio chat has a visible,
  consistent origin style. Reviewer can look at a session and point
  at which sentences were human vs agent vs quoted.
- **SC-2.** Clicking any tool-call chip opens a drawer that shows
  input, output (sanitised), latency, and error state. Esc closes.
  Operator-tier users see no raw secrets in any payload.
- **SC-3.** Approving a build-plan or accepting a suggested-fix
  inserts a row in the right-rail "Session artifacts" card within
  500ms. Revert flips the row's state chip and style.
- **SC-4.** Clicking a session artifact row navigates to the
  existing tuning page for that artifact type.
- **SC-5.** `npx tsc --noEmit` clean on both backend and frontend.
  Both test suites green.
- **SC-6.** No regression on existing BUILD flows: plan approval,
  rollback, suggested-fix accept/reject, admin trace drawer.
- **SC-7.** `PROGRESS.md` has a "Sprint 050 — Session A" section
  with commit SHAs, what shipped, what deferred, and at least one
  surfaced caveat worth the next session's attention.

---

## §6 Handoff

After A4 is green:

1. Commit each gate separately with messages in the repo's
   established style (imperative, scope-prefixed, one-line).
2. Append `PROGRESS.md` with the session block.
3. **Rewrite `NEXT.md`** — archive the current sprint-050 kickoff as
   `NEXT.sprint-050-session-a.archive.md`, then write a new
   `NEXT.md` that surfaces Bundle B (artifact drawer + citations +
   diff rendering) as the primary candidate, with the remaining
   sprint-049 correctness carry-overs (P1-5, P1-2, P1-4, P1-6, F1,
   DB-backed badge) as §2 "still deferred" for explicit re-choice.
4. Do NOT merge to `main` without owner review — branch `sprint-050-a`
   stays until owner signs off on the operator-tier trace exposure.
   The sanitisation layer is load-bearing for that sign-off.

End of session A.
