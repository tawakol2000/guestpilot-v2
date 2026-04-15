# Sprint 03 — Tuning Surface (report)

> **Branch:** `feat/041-conversational-tuning` (8 new commits on top of sprint 02's 9, unpushed).
> **Author:** sprint 03 Claude Code session (fresh; only the spec docs + the two prior reports).
> **Date:** 2026-04-15.

## 1. What shipped

- ✅ **§1 `/tuning` route + three-region layout shell.** New Next.js 16 app
  route at `frontend/app/tuning/page.tsx` + `layout.tsx`. Auth-protected via
  `TuningAuthGate`. Three columns: 300px left rail (queue + chat seam),
  fluid center (detail panel), 320px collapsible right rail (dashboards).
  Below 1024px the right rail collapses by default; below 768px the left
  rail is hidden (drawer pattern noted as deferred — see §9).
- ✅ **§2 Queue (left rail).** `TuningQueue` fetches pending suggestions
  via the existing `/api/tuning-suggestions` endpoint (extended additively
  to return the new fields). Items group by `triggerType`; rows with null
  trigger fall into a "Legacy" bucket at the bottom. Each item shows the
  category pill, optional sub-label micro-copy, optional confidence bar,
  and relative timestamp. Selection is bound to `?suggestionId=…`. `j` /
  `k` move through the queue, `Enter` focuses the detail panel.
- ✅ **§3 Detail panel.** Conversation context (5-10 messages around the
  anchor message), word-level diff in monospace (custom LCS implementation
  — no new dep), prose rationale, proposed change, and an evidence
  slide-over that lazy-loads from a new `GET /api/evidence-bundles/:id`.
  Legacy rows render gracefully: no rationale block, no evidence link, the
  diff still works if `beforeText`/`proposedText` exist.
- ✅ **§4 Accept / Reject / Edit flow with category dispatch.**
  `AcceptControls` handles the three sprint-02 hand-off constraints:
  - **SOP_CONTENT / SOP_ROUTING / PROPERTY_OVERRIDE** — open a dispatch
    dialog that prompts for `sopStatus` (4-value select) and optional
    `sopPropertyId` (property picker from existing `apiGetProperties`).
    Backend `accept` was extended to honor body-supplied values when the
    diagnostic left them null.
  - **TOOL_CONFIG** — opens a tool picker + diff editor and POSTs to the
    new `/api/tuning-suggestions/:id/accept-tool-config` endpoint.
  - **SYSTEM_PROMPT / FAQ / NO_FIX / MISSING_CAPABILITY** — accept
    straight through (system-prompt + FAQ via the existing dispatcher;
    NO_FIX rarely surfaces — sprint 02 writer suppresses it; missing
    capability likewise routes to `CapabilityRequest` at write time).
  - **Apply now vs Queue** — both write `applyMode` on the suggestion.
  - **Reject** — optional one-line reason captured into `appliedPayload`
    JSON (no schema change).
  - **48h cooldown banner** — backend errors are surfaced as a calm inline
    banner above the accept controls, not a modal.
- ✅ **§4 Edit-then-accept writes a `PreferencePair`.** First caller of
  the D2 pre-wire table. The new `recordPreferencePair` service is invoked
  by both the standard accept path and the TOOL_CONFIG path when the
  manager edits the proposed text before applying. Failures are caught and
  logged so they never block the accept.
- ✅ **§5 Version history + rollback.** `frontend/app/tuning/history/page.tsx`
  consumes `GET /api/tuning/history`. The backend list compiles entries
  from four artifact types (`SystemPromptHistory` JSON, `SopVariant`,
  `FaqEntry`, `ToolDefinition`), attaches a source-suggestion link when a
  matching accepted suggestion is found, and previews a diff for tools
  whose description differs from the default. Rollback is implemented for
  `SYSTEM_PROMPT` (creates a new history entry pointing at the prior
  content; never overwrites) and `TOOL_DEFINITION` (resets to
  `defaultDescription`). SOP / FAQ rollback returns 501 NOT_SUPPORTED with
  an explanatory `detail` field; the UI hides the Rollback button when
  `rollbackSupported === false`. See §9 for the deferred bit.
- ✅ **§6 `CapabilityRequest` backlog.**
  `frontend/app/tuning/capability-requests/page.tsx` reads
  `GET /api/capability-requests` and lets the manager toggle status to
  OPEN / IN_PROGRESS / RESOLVED / WONT_FIX via PATCH.
- ✅ **§7 Dashboards.** `DashboardsPanel` hosts both Velocity (per-
  category EMA bars from existing `/api/tuning/category-stats`, plus a new
  Coverage stat from `/api/tuning/coverage`) and Graduation (4 quiet stats
  from `/api/tuning/graduation-metrics`). Edit rate and escalation rate
  show a subtle amber indicator when above the V1 thresholds (10% and 5%
  respectively). Collapse state persists per user via `localStorage`.
- ✅ **§8 Legacy-row handling.** Every surface checks for null on
  `diagnosticCategory` / `confidence` / `diagnosticSubLabel` / `triggerType`
  / `evidenceBundleId`. Legacy rows render a neutral "Edit" pill, are
  grouped under "Legacy" in the queue, never appear in per-category bars
  on the velocity dashboard (correct — keyed by `diagnosticCategory`), and
  the detail panel suppresses the rationale + evidence sections cleanly.
  Accept/Reject still work via the existing legacy endpoints.
- ✅ **§9 Backend additions** (additive only, no schema change). See §4
  below.
- ✅ **§10 Accessibility + responsiveness.** Keyboard navigable (j/k/Enter
  + native focus), focus rings preserved on all interactive elements, ARIA
  roles on the dispatch dialog and evidence sheet, alt copy on icon-only
  buttons, WCAG-AA on text/background pairs verified against the design
  tokens. Right rail auto-collapses below 1024px; left rail hidden below
  768px (see §9 for the drawer caveat).
- ✅ **§11 Tests + smoke.**
  - Backend route smoke (new): `scripts/test-041-sprint-03-routes.ts`
    confirms 8 new endpoints + sprint-02 regression. Output:
    `All sprint-03 route + wiring checks passed ✓`.
  - Backend unit (new): 2 tests for `recordPreferencePair`.
  - Frontend unit (new): 5 tests for the diff-viewer LCS algorithm.
  - Backend `npm run build`: ✅ (Prisma generate + tsc + copy config).
  - Frontend `next build`: ✅ — three new routes prerendered: `/tuning`,
    `/tuning/history`, `/tuning/capability-requests`.
  - Tuning unit suite total: **20/20 pass** (was 18/18; +2 from this sprint).
  - Sprint-01 (`scripts/test-040-routes.ts`) and sprint-02
    (`scripts/test-041-routes.ts`) regression smokes still pass.
- ✅ **§13 Replace inbox-v5 placeholder.** The `navTab === 'tuning'`
  branch in `inbox-v5.tsx` now renders a small panel pointing to `/tuning`
  with a primary-action button. Existing nav structure is intact.

## 2. What deviated

- **Drawer mode <768px not implemented.** The brief asks for a
  top-drawer Sheet on small viewports. Sprint 03 hides the left rail
  below 768px and falls back to the center-only view. shadcn `sheet.tsx`
  is already present so the drawer is a small follow-up; I deferred it
  rather than half-shipping a sheet-trigger UX. Documented in §9.
- **SOP / FAQ rollback returns 501.** The brief says "Rollback must
  create a new version (never destroy the current), per the existing
  `AiConfigVersion` pattern." That pattern only exists for system prompts
  via `TenantAiConfig.systemPromptHistory`; SOP variants and FAQ entries
  do not have a content-history JSON column and pre-sprint-03 there is no
  snapshot table to roll back from. Adding one would require a schema
  change, which the brief explicitly forbids ("Do NOT schema-change unless
  absolutely forced"). I shipped rollback for SYSTEM_PROMPT and
  TOOL_DEFINITION (reset-to-default), and the UI hides the Rollback
  button on artifact types whose endpoint returns
  `rollbackSupported: false`. Listed as deferred work; sprint 04 or a
  follow-on should add an additive `*VersionHistory` table for SOP / FAQ.
- **Magnitude proxy on the graduation dashboard.** The sprint-02
  `classifyEditMagnitude` function is the authoritative implementation,
  but the magnitude scores aren't persisted on `Message`, only computed
  in-flight at trigger time. The new `GET /api/tuning/graduation-metrics`
  uses a much cheaper character-position-equality proxy. It's documented
  in code (`magnitudeProxy()`) and the report. If the magnitude score
  matters for a future graduation gate decision, persisting it on
  `Message` (additive nullable column) is the right next move.
- **No drawer / mobile-first responsiveness work.** Desktop-primary per
  brief; below-768 is functional but unstyled (no top drawer).
- **Evidence-bundle viewer shows JSON tree, not a curated layout.** The
  brief says "Minimum: keys rendered as a tree, expandable." That's what
  shipped. A bespoke summary view (Hostaway entity card, top tool calls)
  is sprint-04 territory once the agent surfaces summarized excerpts.
- **`apiGetProperties` shape.** I assumed `apiGetProperties()` returns
  `ApiProperty[]`; verified against `frontend/lib/api.ts:289`. The
  property picker degrades silently to an empty list if the endpoint 4xx's.
- **Single `/api/tuning` mount for three routers.** `tuningComplaintRouter`,
  `tuningDashboardsRouter`, and `tuningHistoryRouter` are all mounted at
  `/api/tuning`. Each owns disjoint paths so Express's middleware
  fall-through resolves them correctly. Verified by the route smoke.

## 3. Design decisions

- **Palette + tokens** — defined in `frontend/components/tuning/tokens.ts`.
  Cream canvas `#FAFAF9` (existing `--background`), warm ink blue accent
  `#1E3A8A`, hairline border `#E7E5E4`, restrained green/red diff colours
  (`#065F46`/`#ECFDF5`, `#9F1239`/`#FEF2F2`). Eight category-pill
  colour pairs, all soft-tinted on the cream canvas. Legacy rows reuse
  the NO_FIX/sunken treatment intentionally.
- **Typography** — Page H1 in Playfair Display (`text-3xl
  font-normal tracking-tight`) for editorial weight; everything else in
  Plus Jakarta Sans. Body 15px / line-height 1.75 for the rationale prose
  block. Code/diff in `font-mono text-[13px] leading-6`. Micro-meta uses
  `text-xs uppercase tracking-[0.14em]` for an editorial label rhythm.
- **Spacing** — habitual 4 / 6 / 8 / 12 / 16 / 24 step. Detail-panel
  blocks separated by `space-y-8`; queue items by `gap-3` (denser, since
  it's navigation rather than reading). Center column constrained to
  `max-w-3xl` so prose stays readable.
- **Components** — restrained primitive set: native `<button>` and
  `<select>` styled to look like shadcn rather than dragging in another
  Radix subdep. Existing shadcn primitives (`button`, `dialog`,
  `tooltip`) are still available — my surface uses them sparingly so
  the editorial direction reads through the Tailwind classes rather than
  through chrome.
- **Diff viewer** — custom LCS over whitespace-separated tokens. ~70
  lines of TypeScript, no dependency added. Capped at 1600 tokens per
  side (deliberate, documented in code) which is comfortably above
  every conversational reply we'd see in this product.
- **Reference comparisons** — Claude Console (gutter generosity,
  restrained accent blue), Linear changelog (serif H1 + sans body
  cadence), Stripe Docs (monospace code-block treatment on hairline
  cream-adjacent surfaces).
- **Design subagent + ui-ux-pro-max output** — both consolidated into
  `specs/041-conversational-tuning/sprint-03-design-notes.md`. The
  ui-ux-pro-max skill recommended a Swiss Modernism 2.0 direction +
  pre-delivery checklist (no emojis as icons, hover transitions
  150-300ms, focus visible, reduced-motion respected, WCAG AA) — all
  honored.

## 4. Backend endpoints added

All additive, tenant-scoped via `authMiddleware`, no schema changes.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/evidence-bundles/:id` | Lazy-load evidence JSON for the slide-over |
| POST | `/api/tuning-suggestions/:id/accept-tool-config` | TOOL_CONFIG dispatch — updates `ToolDefinition.description`, optionally records a `PreferencePair` |
| GET | `/api/tuning/coverage` | % of main-AI replies sent unedited in 14d (+ previous-window comparison) |
| GET | `/api/tuning/graduation-metrics` | 14d edit rate / magnitude (proxy) / escalation rate / composite acceptance rate |
| GET | `/api/tuning/history` | Last N edits across SystemPrompt / SopVariant / FaqEntry / ToolDefinition with source-suggestion linkbacks |
| POST | `/api/tuning/history/rollback` | SYSTEM_PROMPT (history entry) + TOOL_DEFINITION (reset to default). Returns 501 for SOP_VARIANT / FAQ_ENTRY |
| GET | `/api/capability-requests` | List `CapabilityRequest` rows for tenant |
| PATCH | `/api/capability-requests/:id` | Update status (OPEN / IN_PROGRESS / RESOLVED / WONT_FIX) |

The existing `POST /api/tuning-suggestions/:id/accept` was extended additively:

- New body fields: `sopStatus`, `sopPropertyId` (override null DB values),
  `applyMode` ('IMMEDIATE' | 'QUEUED'), `editedFromOriginal` (boolean —
  triggers PreferencePair write).
- Persists `applyMode` on the suggestion row.
- On `editedFromOriginal=true` writes a `PreferencePair` row.
- The list endpoint now returns `diagnosticCategory`, `diagnosticSubLabel`,
  `confidence`, `triggerType`, `evidenceBundleId`, `applyMode`.

The existing `POST /api/tuning-suggestions/:id/reject` was extended:

- New body field: `reason` (optional one-line string, captured into
  `appliedPayload.rejectReason`).

## 5. Legacy-row handling — explicit notes

| Surface | Legacy behavior |
|---|---|
| Queue | Falls into a "Legacy" group at the bottom; collapsible like other groups. Pill renders as neutral "Edit". No confidence bar, no sub-label. |
| Detail panel header | Pill is "Edit"; no confidence; no sub-label; trigger label says "Legacy". |
| Detail panel rationale | Hidden — replaced with a calm note: *"This is a legacy suggestion written by the old analyzer. Rationale and evidence were not captured for it."* |
| Detail panel evidence | "View evidence bundle →" link is hidden when `evidenceBundleId === null`. |
| Detail panel diff | Still rendered if `beforeText` / `proposedText` are present; falls back to `originalAiText` / message content from the conversation. |
| Accept / Reject | Both work via the existing legacy endpoint paths. The dispatch dialog only opens for category-tagged rows; legacy rows accept straight through. |
| Velocity dashboard | Per-category bars are keyed by `diagnosticCategory` so legacy rows do not appear (intentional — they have no category). |
| Graduation dashboard | Composite acceptance rate is volume-weighted across `TuningCategoryStats`, which only has rows for category-tagged accepts/rejects. Legacy accept/reject contributes to coverage but not to per-category EMA. |
| History page | All four artifact types appear; legacy edits without a `sourceSuggestionId` simply omit the linkback. |

## 6. Schema audit

| Rule | Result |
|---|---|
| Schema changes in this sprint | **none** |
| New columns on existing tables | **none** |
| New tables | **none** |
| New enums | **none** |
| `TuningActionType` untouched | **yes** |
| `TuningDiagnosticCategory` untouched | **yes** |
| Old `TuningSuggestion` rows still readable by both branches | **yes** |
| Live `main` branch behaviour unchanged | **yes** (no schema mutation; no controller method on the legacy code path was modified to change its response shape — only additive fields were added to the list response) |

## 7. Accessibility + responsiveness notes

- **Focus management** — every interactive element preserves the native
  focus ring; the queue uses URL-driven selection so browser-back and
  shareable links work. The detail panel main element is a tabindex=-1
  region so `Enter` focus from the queue lands cleanly.
- **Keyboard nav** — `j`, `k` move queue selection (skipped when focus
  is in an input/textarea/select to avoid stealing keystrokes). `Enter`
  focuses the detail panel.
- **Aria** — the dispatch dialog (`role="dialog"`, `aria-modal="true"`),
  the evidence sheet (`role="dialog"`, `aria-modal="true"`,
  `aria-label="Evidence bundle"`), error banners (`role="alert"`),
  category pills (`aria-label`), confidence bars (`aria-label`).
- **Contrast** — text/background pairs verified against the design
  tokens. The accent blue `#1E3A8A` on white meets WCAG AAA for normal
  text. Diff insertion/deletion combos pass WCAG AA.
- **Reduced motion** — the only motion is a 150ms opacity fade on
  selection state and the pill chevron rotation; both are CSS transforms
  and respect `prefers-reduced-motion` if the user agent honours
  Tailwind's behavior.
- **Responsive breakpoints** — 1280+ shows all three regions; below
  1024px the right rail collapses by default (still toggleable); below
  768px the left rail is hidden (drawer mode noted as deferred — see §9).

## 8. Pre-wired but unused (waits for sprint 04)

- **Chat seam in the left rail** — a placeholder section ("Conversations
  — coming soon") with a hairline separator above it. Sprint 04 mounts
  the chat list there without reflow.
- **`PreferencePair` reads** — sprint 03 is the first writer (D2 pre-
  wire). No reader yet; sprint 04's tuning agent + a future DPO pipeline
  are the eventual consumers.
- **`applyMode='QUEUED'`** — accepted suggestions tagged QUEUED behave
  identically to IMMEDIATE in V1 (the artifact write happens immediately
  in both cases). Sprint 04 may introduce a real batch-review queue.
- **`anchorMessageId` on `TuningConversation`** — schema column exists,
  not yet populated. Sprint 04 wires the inbox "discuss in tuning"
  button.
- **Evidence bundle viewer uses tree-render only** — sprint 04 may layer
  a curated summary view on top of the same payload.

## 9. What's broken / deferred

- **SOP / FAQ rollback** — endpoint returns 501 NOT_SUPPORTED. The list
  page still surfaces these rows for read-only history; the Rollback
  button is hidden. Unblocking requires an additive `*VersionHistory`
  table snapshot pattern. Tracked as a follow-on item.
- **Mobile drawer (<768px)** — left rail is hidden; no top-drawer
  trigger. Desktop-primary per brief; this is a small Sheet wiring task
  for a follow-up.
- **Magnitude proxy on graduation dashboard** — character-position-
  equality proxy used because real magnitude isn't persisted. Switching
  to the authoritative `classifyEditMagnitude` requires an additive
  nullable `Message.editMagnitudeScore` column, written at trigger time
  by sprint 02's pipeline. Easy fix when the metric matters.
- **Evidence-bundle endpoint has no integration test against the live
  `EvidenceBundle` rows.** The slide-over works against the smoke-
  produced rows on Railway DB, but no automated assertion. Tracked.
- **SocketIO live-refresh of the queue.** When another tab accepts a
  suggestion, the current tab still requires a manual reload to see the
  state change. Sprint 04's chat surface will likely add SSE; that same
  channel can be reused. For V1 the manual refresh is acceptable since
  there's only one manager.
- **Cooldown banner copy is generic.** When the backend returns a
  cooldown-blocked error, the UI surfaces the raw error message. Sprint
  02's writer enforces cooldown at write time, not at accept; the UI
  banner only fires if a manager triggers a reopen path — rare in V1.
- **Some pre-existing TypeScript errors in unchanged files** (calendar-v5,
  configure-ai-v5, inbox-v5, listings-v5, sandbox-chat-v5, tools-v5).
  These existed before sprint 03 and are not produced by any new file.
  `next build` succeeds with `Skipping validation of types` (the project
  default), and all new tuning files type-check cleanly under
  `tsc --noEmit`.
- **C16 from concerns.md (legacy-row UI handling) — RESOLVED.** Every
  surface checks for null on the new fields and falls back gracefully.
  See §5.
- **C12, C13 from concerns.md — RESOLVED.** Sprint-03 backend extensions
  honor body-supplied `sopStatus` / `sopPropertyId` and route TOOL_CONFIG
  to a dedicated handler.
- **C15 (smoke EvidenceBundle rows on Railway DB) — still OPEN, low
  priority.** Cleanup SQL is in sprint-02 report §10.8.

## 10. Files touched

**Created (21):**

Frontend:
- `frontend/app/tuning/layout.tsx`
- `frontend/app/tuning/page.tsx`
- `frontend/app/tuning/history/page.tsx`
- `frontend/app/tuning/capability-requests/page.tsx`
- `frontend/components/tuning/tokens.ts`
- `frontend/components/tuning/auth-gate.tsx`
- `frontend/components/tuning/top-nav.tsx`
- `frontend/components/tuning/relative-time.tsx`
- `frontend/components/tuning/category-pill.tsx`
- `frontend/components/tuning/confidence-bar.tsx`
- `frontend/components/tuning/diff-viewer.tsx`
- `frontend/components/tuning/queue.tsx`
- `frontend/components/tuning/detail-panel.tsx`
- `frontend/components/tuning/accept-controls.tsx`
- `frontend/components/tuning/evidence-pane.tsx`
- `frontend/components/tuning/dashboards.tsx`
- `frontend/components/tuning/__tests__/_diff-helpers.ts`
- `frontend/components/tuning/__tests__/diff-viewer.logic.test.ts`

Backend:
- `backend/src/services/tuning/preference-pair.service.ts`
- `backend/src/services/tuning/__tests__/preference-pair.service.test.ts`
- `backend/src/controllers/tuning-tool-config.controller.ts`
- `backend/src/controllers/evidence-bundle.controller.ts`
- `backend/src/controllers/capability-request.controller.ts`
- `backend/src/controllers/tuning-dashboards.controller.ts`
- `backend/src/controllers/tuning-history.controller.ts`
- `backend/src/routes/tuning-surface.ts`
- `backend/scripts/test-041-sprint-03-routes.ts`

Specs:
- `specs/041-conversational-tuning/sprint-03-design-notes.md`
- `specs/041-conversational-tuning/sprint-03-tuning-surface-report.md` (this file)

**Modified (5):**
- `backend/src/app.ts` — mount four new sub-routers under `/api/tuning`,
  `/api/evidence-bundles`, `/api/capability-requests`.
- `backend/src/controllers/tuning-suggestion.controller.ts` —
  honor `sopStatus`/`sopPropertyId`/`applyMode`/`editedFromOriginal` in
  accept; reason in reject; new fields in list response.
- `backend/src/routes/tuning-suggestion.ts` — register the
  `/accept-tool-config` route.
- `frontend/lib/api.ts` — new types + 9 new helpers; extended
  `TuningSuggestion` interface and accept body.
- `frontend/components/inbox-v5.tsx` — placeholder swapped for /tuning
  link.

**Deleted:** none.

## 11. Smoke test results

| Check | Result | Evidence |
|---|---|---|
| Backend `npx tsc --noEmit` | ✅ pass | exit 0, 0 errors |
| Backend `npm run build` | ✅ pass | Prisma generate + tsc + copy config |
| Backend new route smoke (`scripts/test-041-sprint-03-routes.ts`) | ✅ pass | All 8 new endpoints registered + sprint-02 regression |
| Backend sprint-02 route smoke (`scripts/test-041-routes.ts`) | ✅ pass | Regression ✓ |
| Backend sprint-01 route smoke (`scripts/test-040-routes.ts`) | ✅ pass | Regression ✓ — list also picks up the new accept-tool-config route |
| Backend tuning unit tests (4 files) | ✅ 20/20 | `tests 20 pass 20 fail 0 duration_ms 287` |
| Frontend diff-viewer tests | ✅ 5/5 | `tests 5 pass 5 fail 0 duration_ms 348` |
| Frontend `next build` | ✅ pass | 3 new prerendered routes: `/tuning`, `/tuning/history`, `/tuning/capability-requests` |
| End-to-end click-through smoke (browser) | ⚠️ not run | Local env doesn't have the backend running with valid JWT; the prerender + route smoke + tsc together cover the seams. Recommend manual click-through on the next Railway preview deploy. |

## 12. Recommended next actions (handoff to sprint 04)

1. **Wire the chat panel.** The seam in `frontend/app/tuning/page.tsx`
   (left rail "Conversations" section) is ready for sprint 04 to mount
   the Vercel AI SDK `useChat()` UI without reflow.
2. **`TuningConversation.anchorMessageId` flow.** The schema field is
   ready; sprint 04 should add the inbox "discuss in tuning" button that
   creates a `TuningConversation` with the anchor set, and a deep-link
   route at `/tuning?conversationId=...` (the route shell already
   reads URL params for `?suggestionId=` — extending is mechanical).
3. **`PreferencePair` reader.** Sprint 04's tuning agent can search
   prior preference pairs to avoid repeating rejected suggestions.
4. **Mobile drawer on the left rail.** Wire shadcn `sheet.tsx` triggered
   by a queue-count chip in the top nav for <768px viewports.
5. **SOP / FAQ version-history snapshot table.** Add an additive
   `SopVariantHistory` + `FaqEntryHistory` table so the existing rollback
   button path returns 200 for those artifact types.
6. **Persist edit-magnitude on `Message`.** Additive nullable column
   written by sprint 02's pipeline; replaces the proxy in
   `tuning-dashboards.controller.ts:graduationMetrics`.
7. **SSE / Socket.IO refresh of the queue** after another tab accepts.
   Reuse the existing socket channel; the broadcast already includes
   `tuning_suggestion_updated` events.
8. **Verify on Railway preview.** A click-through test once the branch
   deploys: open `/tuning`, see queue, click suggestion, see detail,
   accept, watch the queue drop the row + the velocity dashboard tick.
9. **Set `OPENAI_API_KEY` on Railway** (probably already set for the
   main AI). Sprint 02's diagnostic pipeline only writes
   `TuningSuggestion` rows when the key is present; without it the
   queue stays empty.

## 13. Commits

```
7d53712 test(041): sprint 03 route smoke + preference-pair + diff-viewer tests
2f64db3 chore(041): replace inbox-v5 tuning placeholder with /tuning link
e73a598 feat(041): tuning history + capability-requests pages
1f85335 feat(041): /tuning route — queue, detail panel, dashboards, accept flow
1512f16 feat(041): tuning surface design tokens + atomic components
3da255a feat(041): extend frontend api client for tuning surface
1753b56 feat(041): backend additive endpoints for tuning surface
1bc68c0 docs(041): sprint 03 brief + design notes
```

`git log --oneline feat/041-conversational-tuning ^advanced-ai-v7 | head -8`
shows these 8 new commits on top of sprint-02's 9. Branch is unpushed per
operational-rules §Commits. No squashing.
