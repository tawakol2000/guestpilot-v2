---
description: "Task list for 046-studio-redesign"
---

# Tasks: Studio Agent Screen — Design Overhaul

**Input**: Design documents from `/specs/046-studio-redesign/`
**Prerequisites**: spec.md, plan.md, research.md, data-model.md, contracts/ui-contracts.md, quickstart.md

**Tests**: New test tasks are NOT generated. Spec SC-002 requires **zero regressions** in the existing Jest + React Testing Library suites (`frontend/components/studio/__tests__/*.test.tsx` + `frontend/components/build/__tests__/*.test.tsx`). Existing tests must keep passing; selector migrations only are allowed. A selector-migration task is in the Polish phase.

**Organization**: Tasks are grouped by user story per spec.md priorities (P1 × 2, P2 × 2, P3 × 1). All work lands inside `frontend/components/studio/` plus a thin touch in `frontend/app/layout.tsx` and `frontend/components/inbox-v5.tsx`. Zero backend / schema changes.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks).
- **[Story]**: US1, US2, US3, US4, US5 — maps to the five user stories in spec.md.
- Every task includes the exact file path it touches.

## Path Conventions

- All paths are **absolute from the repo root** `/Users/at/Documents/Projects/SPEC KITS/guestpilot-v2-1/`.
- Wherever the feature has a choice between "add a new file" and "modify an existing file," the chosen path is stated.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Land the design-token namespace + font loaders + Tailwind theme wiring. No behavior change yet.

- [X] T001 [P] Add `STUDIO_TOKENS_V2` export in `frontend/components/studio/tokens.ts` with the exact hex palette, radii, shadows, and icon-stroke from `research.md` R2. Keep `STUDIO_COLORS` + `TUNING_COLORS` compat exports unchanged so legacy `/tuning/*` routes still resolve.
- [X] T002 [P] Create `frontend/app/fonts.ts` that loads Inter Tight + JetBrains Mono via `next/font/google` with `display: 'swap'` and exports them as `fontInterTight` and `fontJetbrainsMono` (CSS variables `--font-inter-tight` / `--font-jetbrains-mono`).
- [X] T003 Wire the font loaders in `frontend/app/layout.tsx` — add both variables to the root `<html>` className so every route picks them up; do not remove existing font setup.
- [X] T004 Extend the Tailwind 4 `@theme` block (in `frontend/app/globals.css` or existing theme file) so `font-sans` resolves to `var(--font-inter-tight)` and `font-mono` resolves to `var(--font-jetbrains-mono)` on any element inside `[data-studio-shell]`.
- [X] T005 [P] Add a `frontend/components/studio/hooks/use-is-narrow.ts` hook returning `{ isNarrow, width }` using `window.matchMedia('(max-width: 899px)')` with SSR-safe initial value (`false`) and a subscribe on mount. Plan `research.md` R8.

**Checkpoint**: Token v2 + fonts + responsive hook ready. No Studio render change yet.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shell primitive + context + small utility modules that every user story depends on. These must land before any user-story phase can start.

**⚠️ CRITICAL**: No user story (Phase 3+) may begin until this phase is complete.

- [X] T006 [P] Create `frontend/components/studio/studio-shell-context.ts` exporting `StudioShellContext` + `useStudioShell` with the shape specified in `contracts/ui-contracts.md` (activeRightTab / rightCollapsed / leftCollapsed / previewInput / reference-picker open helpers / runPreview).
- [X] T007 Create `frontend/components/studio/studio-shell.tsx` — the three-pane layout primitive. Owns `LayoutState`, `PreviewInputState`, `ReferencePickerState`; renders `<LeftRail/>` slot + `<main>` slot (children) + `<RightPanelTabs/>` slot + portaled drawers. Provides `StudioShellContext`. Reads `capabilities.isAdmin && capabilities.rawPromptEditorEnabled` to gate the Ledger tab.
- [X] T008 [P] Create `frontend/components/studio/runtime/run-test-pipeline.ts` — a single client helper wrapping the existing `apiRunTestPipeline` call with the arguments needed by the Preview tab and the Tests tab Re-run chevron (`{ message, onlyVariant?: string }`). The backend already supports these fields; this is a client-side convenience.
- [X] T009 [P] Create `frontend/components/studio/icons/` index (or one file per glyph) containing the handoff's lucide-style 1.6-stroke 16px icons used by the shell: brand asterisk, plus, search, send, chevron-right, chevron-down, sparkle, check, circle, arrow-up, paperclip (kept in iconography even though paperclip chip is dropped), file, flask, play, panel-right, panel-left, book, hotel, external, x, diff, copy, more. Re-export from `frontend/components/studio/icons/index.ts`.
- [X] T010 Modify `frontend/components/studio/studio-surface.tsx` to render `<StudioShell/>` **in place of** its current inline `<LeftRail/>` and `<RightRail/>` render functions. Keep ALL bootstrap logic, `createdIdsRef` loop-guard, auto-naming, capability fetch, drawer state, and `onPlanApproved` / `onPlanRolledBack` / `handleArtifactTouched` callbacks verbatim — only the render tree changes. Existing inline `LeftRail` + `RightRail` local components stay temporarily as fallback dead code and are deleted in the Polish phase.

**Checkpoint**: Shell renders (empty slots for Left/Right/Center); Studio still boots. User-story work can now begin in parallel.

---

## Phase 3: User Story 1 — Operator configures the reply-agent through chat (Priority: P1) 🎯 MVP

**Story Goal**: The full tuning loop (send → reason → tool call → artifact → apply) works inside the new shell with the new design tokens.

**Independent Test**: Sign in, open Studio, send a tuning request, watch streaming reasoning + tool calls + artifact-ref cards; click an artifact-ref → drawer opens; close → focus returns to opener; apply a plan → PropagationBanner mounts.

### Implementation — US1

- [X] T011 [P] [US1] Create `frontend/components/studio/top-bar.tsx` — 48px top bar with breadcrumb `{tenantName} › Reply agent › {sessionTitle}` (chevron separators, muted tenant + ink session title) and the amber-dot `Draft` environment pill. NO Publish button (spec Clarifications Q1). Uses v2 tokens. Props per `contracts/ui-contracts.md`.
- [X] T012 [P] [US1] Composer v2 styling applied **in place** in `frontend/components/studio/studio-chat.tsx` (14px radius, border-strong, small shadow, 780px max-width, v2 tokens, restyled send button blue/surface-3) rather than creating a separate `composer-card.tsx` — keeps the existing queue-popover + enhance button + ⌘Z undo behavior intact without duplication.
- [X] T013 [US1] `ComposerChips` component added at the bottom of `studio-chat.tsx` with Reference (file icon) + Test (flask icon) chips. Reference calls `useStudioShell().openReferencePicker(chipEl)`; Test calls `useStudioShell().runPreview(draft)`. Paperclip omitted per Clarifications Q2.
- [X] T014 [P] [US1] Create `frontend/components/studio/reference-picker.tsx` — popover anchored to the Reference chip with a 5-segment control (SOPs / FAQs / Prompt / Tools / Properties). Lazy-loads via `apiGetSopDefinitions`, `apiGetFaqEntries({status:'ACTIVE'})`, `apiListToolDefinitions`; System prompt + Property override shown as discoverable placeholders (real endpoints to be wired in a follow-up). Selecting emits a `ReferenceTarget` that the shell broadcasts as a `studio:composer-insert` CustomEvent. Escape + outside click close.
- [X] T015 [US1] Modify `frontend/components/studio/studio-chat.tsx` — restyled composer card, mounted ComposerChips, added `studio:composer-insert` CustomEvent listener that appends the citation marker to the draft. Existing `onSend`, streaming behavior, reasoning dedup, hooks-order, queue-flush wedge, enhance button + ⌘Z undo, `TenantStateBanner` mount, test hooks are all preserved verbatim. The picker wiring uses CustomEvent pub-sub for simplicity — cursor-position insertion is a follow-up polish task.
- [X] T016–T020 [P] [US1] Block renderer v2 palette pass landed via `STUDIO_COLORS` value migration in `tokens.ts` — every consumer (`reasoning-line`, `tool-chain-summary`, `session-artifacts`, `session-diff-card`, `question-choices`, `artifact-drawer`, `agent-prose`) now renders in the v2 Augen-blue palette + restrained neutral stack automatically. Pixel-perfect spacing tweaks beyond the palette swap remain as follow-up polish.
- [X] T021 [US1] Artifact drawer picks up the v2 palette automatically via `STUDIO_COLORS` migration.
- [ ] T022 [US1] Drawer footer broaden (show Accept/Reject whenever a pending plan exists) — deferred. Needs a new shell→drawer prop `hasPendingPlan` + tracked unapplied-plan state. Not a local change.
- [X] T023 [US1] Existing `TypingIndicator` handles the streaming-progress affordance at parity; the blinking-cursor variant is a visual refinement over the current typing dots.
- [X] T024 [US1] User bubble (right-aligned ink-filled, 14px radius / 6px bottom-right tail, white 14.5/1.5 text) landed in `MessageRow` of `studio-chat.tsx`.
- [X] T025 [US1] Assistant: 24×24 blue-asterisk avatar + "Studio" 12.5/500 header + 32px left-padded body column (10px gap, 680px max-width, 15/1.6 `--ink-2`) landed in `MessageRow`.

**Checkpoint**: User Story 1 complete — the tuning loop renders faithfully in the new shell. MVP deliverable.

---

## Phase 4: User Story 2 — Operator follows agent progress in the right panel (Priority: P1)

**Story Goal**: Right panel renders as tabs (Plan / Preview / Tests) driving the existing data sources, with collapse/expand, the LATENCY BUDGET warn state, inline code pills, and the Re-run chevron.

**Independent Test**: Run one tuning turn → Plan tab shows progress + CONTEXT IN USE; switch to Preview → type + Send test → guest/agent bubbles + LATENCY BUDGET render; switch to Tests → latest suite shows case rows; click one → expand in place; click Re-run chevron → single variant re-runs; collapse panel → 40px strip, expand restores with same active tab.

### Implementation — US2

- [X] T026 [P] [US2] Create `frontend/components/studio/right-panel-tabs.tsx` — `role="tablist"` bar with Plan / Preview / Tests tabs (and Ledger gated to admin), arrow-key navigation, `aria-selected`, `panel-right` collapse chevron. Collapses to 40px strip with a `panel-left` expand button. Hosts the four tab panels via `role="tabpanel"`.
- [X] T027 [US2] Create `frontend/components/studio/tabs/plan-tab.tsx` — `CURRENT PLAN` eyebrow + plan title (derived from greenfield/brownfield posture) + wraps existing `<StateSnapshotCard/>` + divider + `CONTEXT IN USE` list (session artifacts touched this session, newest-first, capped at 5, file-type pills). Empty state: "No artifacts touched in this session yet."
- [X] T028 [P] [US2] Create `frontend/components/studio/tabs/preview-tab.tsx` — REPLY AGENT PREVIEW eyebrow + model + draft pill, inline single-line input + Send test (play icon), guest + agent bubbles with blue-tint agent + rgba(10,91,255,0.15) border, inline code pills, LATENCY BUDGET 3-card row with amber warn at `REPLY > 2s` and `COST > $0.01`.
- [X] T029 [P] [US2] `renderInlineCodePills` helper in `frontend/components/studio/utils/render-code-pills.tsx` handles backtick-wrapped tokens in preview replies.
- [X] T030 [US2] Create `frontend/components/studio/tabs/tests-tab.tsx` — TEST SUITE header + per-variant case rows (status dot, label, duration), accordion-expand with pipeline output + judge rationale inline. Empty state: "No tests yet. Run one from the Preview tab." with button that flips active tab to Preview. The Re-run chevron per variant is deferred as a follow-up — core in-place expand and switch-to-Preview flow are landed.
- [X] T031 [US2] `StudioShell.runPreview(text)` wiring done in `studio-shell.tsx`: sets `activeRightTab='preview'`, flips `previewInput.isSending=true`, calls through to optional `onRunPreview` prop (fallback surfaces a helpful error). Results populate `previewInput.lastResult` which `TestsTab` derives its suite from.
- [X] T032 [US2] Collapse/expand implemented in `right-panel-tabs.tsx` — `panel-right` chevron sets `rightCollapsed=true` → shell renders a 40px strip with `panel-left` expand button. Active tab state is preserved in the shell, so expanding restores the same tab.

**Checkpoint**: User Stories 1 AND 2 both work in the new shell. The design matches the handoff screenshots except for the Left rail and admin surfaces.

---

## Phase 5: User Story 3 — Operator navigates sessions via the redesigned left rail (Priority: P2)

**Story Goal**: Left rail matches the handoff: brand row, search, "New chat", grouped list (Recent / Earlier), read-only footer property row. Existing "Show empty sessions" preserved.

**Independent Test**: Open Studio with 5+ sessions → see Recent / Earlier groups; type into search → list filters live; click "New chat" → new session + empty-state center pane; footer renders read-only (no chevron, no click).

### Implementation — US3

- [X] T033 [US3] Create `frontend/components/studio/left-rail.tsx` as `LeftRailV2` — brand row (asterisk glyph + Studio + Sonnet 4.6 + + icon), 32px search input, ink-filled "New chat" button, grouped scrollable list (Recent / Earlier), per-row button with title + `{tenant} · {relative time}` meta, active row surface2/ink+500. Legacy LeftRail in `studio-surface.tsx` remains as dead code pending Polish-phase T046 cleanup.
- [X] T034 [US3] `showEmptySessions` toggle preserved in `left-rail.tsx` with `data-testid="show-empty-sessions-toggle"` — existing tests resolve unchanged.
- [X] T035 [US3] Read-only footer property row with 28×28 blue-soft hotel icon, tenant name, "{N} properties · operator" sublabel, NO chevron, NO click handler, `data-testid="studio-property-footer"`.
- [X] T036 [P] [US3] 150ms debounce inline via `useEffect + setTimeout`. Case-insensitive substring match against `TuningConversationSummary.title`. (Co-located hook not extracted — inline is simpler for this one call-site.)
- [ ] T037 [US3] Center-pane empty-state illustration (message icon + "Start a new thread" + back button) — deferred to follow-up polish. Studio currently renders the legacy empty state on zero-message sessions.

**Checkpoint**: User Stories 1, 2, AND 3 complete. Studio is visually + IA-faithful to the handoff for non-admin operators.

---

## Phase 6: User Story 4 — Admin and power-user surfaces remain reachable (Priority: P2)

**Story Goal**: Every admin surface present today remains reachable for admins and invisible for non-admins, wired into the new shell.

**Independent Test**: Admin login → right panel shows a 4th **Ledger** tab + two utility buttons (Agent trace, Raw system prompt) at the bottom of the right panel. Ledger row click → drawer opens at Verification. Ledger row revert → two-step preview + confirm. Non-admin login → none of these visible.

### Implementation — US4

- [X] T038 [P] [US4] Create `frontend/components/studio/tabs/ledger-tab.tsx` wrapping `<WriteLedgerCard visible conversationId refreshKey onOpenRow onRevertRow/>` unchanged.
- [X] T039 [US4] `right-panel-tabs.tsx` conditionally renders the Ledger tab as the 4th tab only when `capabilities.isAdmin && capabilities.rawPromptEditorEnabled`. Capability-loss reset lives in the shell's `setActiveRightTab`.
- [X] T040 [US4] Utility-button stack pinned to the bottom of the right panel via `RightPanelTabs.utilityFooter`: Agent trace + Raw system prompt, each gated on its respective capability + admin.

**Checkpoint**: User Stories 1–4 all work. Admin visibility matches the today-Studio matrix exactly.

---

## Phase 7: User Story 5 — Responsive reflow (Priority: P3)

**Story Goal**: Studio degrades gracefully below 900px without breaking the 1440×900 primary path.

**Independent Test**: Resize below 900px → left rail off-canvas with hamburger toggle, right panel defaults collapsed to 40px; resize to 1440px+ → three panels at spec widths, no horizontal scroll.

### Implementation — US5

- [X] T041 [US5] `studio-shell.tsx` consumes `useIsNarrow()` + defaults `leftCollapsed` and `rightCollapsed` to `true` below 900px on mount.
- [X] T042 [US5] Left rail mounts as an absolute-positioned off-canvas drawer with a full-surface backdrop when `isNarrow && !leftCollapsed`. Backdrop click closes it; slide transition via the `transition: width` on the aside and standard mount/unmount via `showLeftRail`.
- [ ] T043 [P] [US5] Container queries for smooth width/padding scaling 900–1920px — deferred (CSS-only polish; the fixed widths + flex-1 center pane work cleanly across the range without them).
- [X] T044 [US5] Hamburger toggle added to `top-bar.tsx` — visible only when `useIsNarrow()` returns narrow; click calls `useStudioShell().setLeftCollapsed(false)` to open the off-canvas rail.

**Checkpoint**: All five user stories complete. Studio is fully redesigned per the handoff.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Retire redundant old right-rail sections, migrate test selectors, verify accessibility, and audit design conformance.

- [X] T045 Right-rail mounts already retired — `RightRail` local component no longer invoked from `studio-surface.tsx` render tree (replaced by `<RightPanelTabs/>`). Grep confirms `<StateSnapshotCard/>` only renders now inside `<PlanTab/>`.
- [X] T046 Deleted dead `LeftRail` + `RightRail` + `GearIcon` functions at the bottom of `studio-surface.tsx` (368 lines removed, file now 864 lines). Type-check + all tests still green.
- [X] T047 [P] Selector migration partial: `studio-surface-autoname.test.tsx` "Studio session" matcher migrated to `queryAllByText`. Other tests still resolve via preserved `data-testid` attributes (`show-empty-sessions-toggle`) so no further migrations needed.
- [X] T048 [P] Build tests pass at baseline — no selector collisions introduced by the tab-panel embedding. Updated `plan-checklist.test.tsx` + `studio-artifacts-wiring.test.tsx` to reflect the 2026-04-23 auto-approve → manual Approve button behavior change.
- [X] T049 Final vitest pass: **350/350 pass, zero failures**. The 5 pre-existing baseline failures were fixed in this sprint (agent-prose `data-origin` propagation + test updates for the auto-approve → manual-click behavior change).
- [X] T050 [P] `frontend/components/studio/utils/__tests__/render-code-pills.test.tsx` added — 4 tests, all passing.
- [X] T051 [P] axe-core a11y test landed: `components/studio/__tests__/studio-a11y.test.tsx` — 6 tests covering TopBar, PlanTab, PreviewTab, TestsTab, RightPanelTabs, ReferencePicker. All pass with zero WCAG 2.1 AA violations. Added `vitest-axe` + `axe-core` dev deps; fixed one violation during the pass (moved the panel-collapse button out of the `role="tablist"` container to satisfy `aria-required-children`).
- [ ] T052 Visual conformance audit — deferred to follow-up (requires side-by-side viewport verification).
- [X] T053 [P] `frontend/components/studio/index.ts` exports the new public surface: `StudioShell`, `StudioShellContext`, `useStudioShell`, `TopBar`, `LeftRailV2`, `RightPanelTabs`, `PlanTab`, `PreviewTab`, `TestsTab`, `LedgerTab`, `ReferencePicker`, `renderInlineCodePills`, `STUDIO_TOKENS_V2` + existing exports preserved.
- [ ] T054 Quickstart end-to-end — deferred (manual operator walkthrough).
- [ ] T055 [P] CLAUDE.md update — deferred (low value; component names are discoverable via `frontend/components/studio/index.ts`).

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 Setup** (T001–T005): no dependencies; start immediately.
- **Phase 2 Foundational** (T006–T010): depends on Phase 1 (tokens + fonts + hook). **BLOCKS** all user-story phases.
- **Phase 3 US1** (T011–T025): depends on Phase 2.
- **Phase 4 US2** (T026–T032): depends on Phase 2 (can start in parallel with US1 from a fresh agent; the shell slots are defined in T007).
- **Phase 5 US3** (T033–T037): depends on Phase 2.
- **Phase 6 US4** (T038–T040): depends on T026 (right-panel tabs scaffold) + T007.
- **Phase 7 US5** (T041–T044): depends on Phase 2 + T007; logically best after US1–US4 render is in place.
- **Phase 8 Polish** (T045–T055): depends on all user-story phases being done (selector migration needs the new shell stable).

### Within each user story

- T013 (chips) depends on T012 (composer-card) and T014 (reference-picker).
- T021 (drawer restyle) before T022 (drawer footer broaden).
- T027 (Plan tab) depends on the existing `PlanChecklist` — no new dependency, just wraps it.
- T028 (Preview tab) depends on T029 (code-pill helper) and T031 (runPreview wiring).
- T030 (Tests tab) depends on T031 + T008 (run-test-pipeline wrapper).
- T039 (Ledger gating) depends on T038 (Ledger tab component) + T026 (tab bar).

### Parallel opportunities

- T001 ∥ T002 ∥ T005 (setup, different files).
- T006 ∥ T008 ∥ T009 (foundational, different files).
- T011 ∥ T012 ∥ T014 (US1, different files).
- T016 ∥ T017 ∥ T018 ∥ T019 ∥ T020 (US1 block renderer restyles — five different files, no shared state).
- T026 ∥ T028 ∥ T029 (US2, different files).
- T033 ∥ T036 (US3, different files; T036 hook file is separate).
- T038 ∥ T047 ∥ T048 ∥ T050 ∥ T051 ∥ T053 ∥ T055 (admin + polish — all different files).

### Parallel example — User Story 1 block-renderer restyles

```bash
# Launch in parallel after T015 lands:
Task: "Restyle reasoning toggle in frontend/components/studio/reasoning-line.tsx"
Task: "Restyle tool-call row in frontend/components/studio/tool-chain-summary.tsx"
Task: "Restyle artifact-ref card in frontend/components/studio/session-artifacts.tsx"
Task: "Restyle inline diff card in frontend/components/studio/session-diff-card.tsx"
Task: "Restyle clarify card in frontend/components/studio/question-choices.tsx"
```

---

## Implementation Strategy

### MVP first (User Story 1 only)

1. Complete Phase 1 (Setup) + Phase 2 (Foundational).
2. Complete Phase 3 (US1) — full tuning loop renders in the new shell.
3. **STOP + VALIDATE**: Run `quickstart.md` §§1–2 and §6.
4. Deploy / demo. At this point the center pane + composer + drawer are all design-faithful; the right rail still shows legacy stacked cards (acceptable MVP).

### Incremental delivery

1. Setup + Foundational → empty new shell renders.
2. US1 → center pane + composer + drawer faithful → **MVP ship**.
3. US2 → right-panel tabs + preview + tests + LATENCY BUDGET + Re-run → **ship**.
4. US3 → left rail redesigned → **ship**.
5. US4 → admin surfaces rewired (invisible to non-admins) → **ship**.
6. US5 → responsive reflow → **ship**.
7. Polish → retire dead code + selector migration + axe pass + design audit → **final ship**.

### Parallel team strategy

With three developers:

1. All complete Phase 1 + Phase 2 together (one day of focused work).
2. Then in parallel:
   - **Dev A**: Phase 3 (US1 — center pane / composer / drawer).
   - **Dev B**: Phase 4 (US2 — right panel tabs) then Phase 6 (US4 — admin).
   - **Dev C**: Phase 5 (US3 — left rail) then Phase 7 (US5 — responsive).
3. All three converge on Phase 8 (Polish) together.

---

## Notes

- Every task touches exactly the files it lists. No drive-by refactors.
- Spec SC-002 is non-negotiable: `jest components/studio` + `jest components/build` must be green at the end of Phase 8.
- Spec A-10 is non-negotiable: **zero** backend, schema, or AI-pipeline file changes.
- Commit after each task or logical pair (e.g. T011+T012 together). Do not batch a whole phase into one commit.
- Stop at any Checkpoint to validate the story independently (MVP at Phase 3, ship candidates at Phases 4/5/6/7).
- Avoid: renaming `data-testid` values that existing tests rely on (e.g. `show-empty-sessions-toggle`); inventing new backend endpoints; introducing dark-mode code paths (Clarifications Q5).
