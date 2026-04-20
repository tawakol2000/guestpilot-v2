# Sprint 046 — Session C: Shell merge

> Session 3 of 4 for sprint 046. Implements Phase C of
> [`sprint-046-plan.md`](./sprint-046-plan.md) §8.
>
> Owner: Abdelrahman. Branch: `feat/046-studio-unification` (continue
> on the branch Session A opened; do NOT branch off again).

---

## 0. Starting state (handed off by Session B)

All seven Session-B gates are green; see
[`PROGRESS.md`](./PROGRESS.md) "Sprint 046 — Session B" for the full
table. Highlights relevant to Session C:

- Backend — tools `ask_manager`, `emit_audit`, `get_current_state`
  live in both BUILD + TUNE allow-lists. `propose_suggestion` now
  emits BOTH `data-suggestion-preview` (legacy) and `data-suggested-fix`
  (new Studio shape) so TUNE's existing diff-viewer stays wired while
  Studio cards can consume the richer shape.
- Backend — `plan-build-changes` item schema gained optional
  `target` (artifactId/sectionId/slotKey/lineRange) + `previewDiff`
  (before/after). `PlanChecklist` in `frontend/components/build/*`
  must be re-palettized AND extended to render the chip + expandable
  disclosure.
- Backend — shared-prefix `<tools>` doc now lists entries 15/16/17
  (get_current_state scopes, ask_manager, emit_audit). Region A at
  3,541 tokens (+258 vs Session A close, under the +300 budget).
- Frontend — five new card components shipped under
  `frontend/components/studio/`:
  `suggested-fix.tsx`, `question-choices.tsx`, `audit-report.tsx`,
  `state-snapshot.tsx`, `reasoning-line.tsx`. All presentation-only;
  their `onAccept` / `onChoose` / `onFixTopFinding` handlers are
  callbacks with no-op defaults. Session C wires them to real
  endpoints.
- Frontend — `studio/tokens.ts` holds the main-app palette (#0A0A0A
  ink, #FFFFFF canvas, #0070F3 accent). Category pastels retained.
  Zero imports from `components/tuning/*` for chrome.
- Branch is NOT pushed yet — Session A + B commits land together with
  Session C's shell-merge work.

Decisions locked in Session B that affect Session C:

- Studio cards have no route-level page. They mount inside
  `inbox-v5.tsx`'s `navTab === 'studio'` branch (plan §3.1 + §3.4).
- Studio chat uses a new `studio-chat.tsx` that replaces
  `build-chat.tsx` — plain hairline-separated rows, no rounded-2xl
  bubbles, no gradient CTAs, `reasoning-line.tsx` replacing the
  chevron accordion (plan §6.3).
- `/build`, `/tuning`, `/tuning/agent` become 302 redirects to
  `/?tab=studio[&conversationId=…]`. The full pages under those
  routes are deleted this session (they live one more sprint as
  redirects only, deletion of the redirect stubs is sprint 047).
- `frontend/components/tuning/*` reusable bits (diff-viewer,
  accept-controls, evidence-pane, category-pill, conversation-list)
  keep their file names; they get re-pointed at `studio/tokens.ts`
  rather than `tuning/tokens.ts`.

---

## 1. Read-before-you-start

Mandatory, in order:

1. [`CLAUDE.md`](../../CLAUDE.md) — constitution + critical rules.
2. [`sprint-046-plan.md`](./sprint-046-plan.md) — §3 (structural
   merge) is the core, plus §6.3 (studio-chat) and §7 (migration
   matrix for `/tuning` features). Read §8 Phase C end-to-end.
3. [`sprint-046-session-a.md`](./sprint-046-session-a.md) and
   [`NEXT.sprint-046-session-b.archive.md`](./NEXT.sprint-046-session-b.archive.md)
   — context on what already shipped.
4. [`PROGRESS.md`](./PROGRESS.md) Sprint 046 Session A + B sections.

Then read the code you'll touch:

- `frontend/components/inbox-v5.tsx` — the main app shell. You'll add
  `'studio'` to the `NavTab` union + render the Studio surface inline
  when `navTab === 'studio'`. Also: every internal `router.push(/tuning…)`
  or `router.push(/build…)` call becomes an in-place tab switch.
- `frontend/components/build/build-chat.tsx` — this becomes
  `frontend/components/studio/studio-chat.tsx`. Key diffs: plain row
  rendering, a `StandalonePart` switch covering every data-part type
  from `build-tune-agent/data-parts.ts`, flat ink send button.
- `frontend/app/build/page.tsx` + `frontend/app/tuning/page.tsx` +
  `frontend/app/tuning/agent/page.tsx` — these become 302 redirect
  stubs. The custom ActivityBar, LeftRail, and chat-panel bodies go.
- `frontend/lib/build-api.ts` — hooks for accept/reject of suggested
  fixes. Add `apiAcceptSuggestedFix(fixId)` /
  `apiRejectSuggestedFix(fixId)` that target the new
  `/api/build/suggested-fix/:id/{accept|reject}` endpoints (see §2.2
  for backend wire-up).
- `backend/src/controllers/build-controller.ts` — gains accept/reject
  suggested-fix handlers. For Session C these can be thin proxies to
  the existing `suggestion_action` path.

---

## 2. Scope — in this session

Each item is a gate. Order matters.

### 2.1 `inbox-v5.tsx` Studio tab

- Extend `NavTab` union with `'studio'`; add a "Studio" button to the
  tab strip (replacing the "Build" and "Tuning" entries when both
  are present — they've all been rolled into Studio).
- When `navTab === 'studio'`, render `<StudioSurface/>` inline (no
  `router.push`). Main-app header + tab strip stay on screen.
- Parse `?conversationId=` + `?tab=` off the URL on mount; set
  `navTab='studio'` if the query asked for it.

### 2.2 `studio-chat.tsx` + `StandalonePart` switch

- New file `frontend/components/studio/studio-chat.tsx`. Port
  `build-chat.tsx`'s Vercel-AI-SDK wiring; replace:
  - Rounded-2xl bubbles → hairline-separated plain rows.
  - Chevron accordion → `<ReasoningLine/>`.
  - Gradient send button → flat `#0A0A0A` ink button.
- The `StandalonePart` switch must cover every type in
  `DATA_PART_TYPES` (see `backend/src/build-tune-agent/data-parts.ts`).
  Unknown parts render as a muted "(unsupported card: <type>)" line,
  never raw JSON.
- Wire the accept/reject handlers in `<SuggestedFixCard/>` to
  `apiAcceptSuggestedFix` / `apiRejectSuggestedFix` calls.

### 2.3 `<StudioSurface/>` three-pane layout

- New file `frontend/components/studio/studio-surface.tsx`. Renders a
  three-pane layout (plan §3.2):
  - Left rail (240px): recent Studio conversations (migrated from
    `/tuning` queue). Tab switch between "Conversations" and
    "Pending" queue if time permits; otherwise just Conversations
    and defer Pending to Session D.
  - Centre pane: `<StudioChat/>`.
  - Right rail (320px, collapsible): `<StateSnapshotCard/>` wired to
    the forced-first-turn `data-state-snapshot` part.
- Composer uses the main-app ink button. No gradient CTA.

### 2.4 Re-palette + target-chip retrofit for `plan-checklist.tsx`

- Switch every import from `../tuning/tokens` → `../studio/tokens` in
  `frontend/components/build/plan-checklist.tsx`.
- Render `target` as a chip on each item row (format matches the
  chip in `suggested-fix.tsx` — `renderTargetChip`).
- Render `previewDiff` as an expandable `<details>` disclosure
  (collapsed by default).

### 2.5 Old-route 302 redirects

- Replace the bodies of `frontend/app/build/page.tsx`,
  `frontend/app/tuning/page.tsx`, and
  `frontend/app/tuning/agent/page.tsx` with thin redirect components
  that call `router.replace('/?tab=studio' + preserved_query)`.
- Delete everything else in those pages (custom ActivityBar,
  LeftRail, chat panels, auth-gate wrapping). The tab on the main
  app is now the only entry point.

### 2.6 Backend: accept/reject suggested-fix endpoints

- New routes:
  `POST /api/build/suggested-fix/:fixId/accept`
  `POST /api/build/suggested-fix/:fixId/reject`
- For Session C these can be thin proxies: accept = existing
  `suggestion_action({action:'apply'})` path if a TuningSuggestion
  row exists with that id, otherwise a no-op stub that returns OK
  (rejection memory wiring is Session D).
- Both endpoints 404 when `ENABLE_BUILD_MODE` is off (same guard as
  every other `/api/build/*` path).

### 2.7 Test gates

- Regression: `inbox-v5.tsx` smoke — clicking the Studio tab renders
  the three-pane layout. Run locally; note the pre-existing
  `inbox-v5.tsx` TS errors are not blockers but also should not
  multiply.
- `build-tune-agent/__tests__` + `tools/__tests__` stay 161/161.
- Integration suite stays 9/9.
- Frontend `tsc --noEmit` — no new errors inside
  `frontend/components/studio/*` or `frontend/app/build|tuning/*`.

---

## 3. Out of scope

- 48h cooldown removal + `data-advisory` recent-edit toast → Session D.
- Session-scoped rejection memory → Session D.
- Output-linter drop-not-log flip → Session D.
- Retiring the legacy `data-suggestion-preview` part → Session D.
- Deleting `tuning-agent/index.ts` shim → Session D.
- Deleting `frontend/components/tuning/tokens.ts` → Session D (keep
  as re-export shim so legacy TUNE files still compile during the
  migration).
- Any new backend tool. Sessions A + B shipped the tools; C is pure
  frontend + two thin proxy endpoints.

---

## 4. Gate sheet

Tick off as each lands.

| Gate | Item | Status |
|------|------|--------|
| C1   | `inbox-v5.tsx` `navTab='studio'` + URL sync | ☐ |
| C2   | `studio-chat.tsx` + `StandalonePart` switch covering all data-parts | ☐ |
| C3   | `<StudioSurface/>` three-pane layout + right-rail state-snapshot wiring | ☐ |
| C4   | `plan-checklist.tsx` re-palette + target chip + previewDiff disclosure | ☐ |
| C5   | Old-route 302 redirects for `/build`, `/tuning`, `/tuning/agent` | ☐ |
| C6   | Accept/reject suggested-fix backend endpoints | ☐ |
| C7   | Full suite green + `tsc --noEmit` clean + inbox smoke | ☐ |
| C8   | PROGRESS.md updated + NEXT.md for Session D | ☐ |

---

## 5. Non-negotiables

- Never break the main guest messaging flow. `ai.service.ts` is
  untouched this session.
- Prisma changes are unlikely this session; if needed apply via
  `prisma db push`, never migrations (CLAUDE.md).
- No violet anywhere in Studio chrome. Chrome uses `studio/tokens.ts`
  values only; category pastels stay on the artifact-type pills
  (plan §3.3 decision #3).
- `BuildToolCallLog` insertion failures remain fire-and-forget.
- The main-app shell must not regress — every existing inbox tab
  (Conversations, Reservations, Tools, Reports, Settings) keeps its
  current behaviour. Studio is additive.

---

## 6. Exit handoff

At session end, do all three:

### 6.1 Commit + push

Single commit per gate is fine. Push to
`feat/046-studio-unification` (the branch Session A opened; Session B
hasn't pushed yet, so Session C's push carries both).

### 6.2 Archive this NEXT.md

Move this file to `NEXT.sprint-046-session-c.archive.md`. Write a
fresh `NEXT.md` for Session D (cleanup — cooldown removal, rejection
memory, linter flip, shim deletions).

### 6.3 Update PROGRESS.md

Append a "Sprint 046 — Session C" section mirroring Session A + B's
shape: gate table, decisions, deferrals, blockers. Cache baselines
should not drift this session — if they do, investigate.

End of Session C brief.
