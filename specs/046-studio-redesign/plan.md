# Implementation Plan: Studio Agent Screen — Design Overhaul

**Branch**: `046-studio-redesign` | **Date**: 2026-04-24 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/046-studio-redesign/spec.md`

## Summary

Replace the current `StudioSurface` shell with a high-fidelity three-panel layout that matches the Claude-design HTML handoff: 260px left rail (brand row + search + grouped session list + read-only property footer), flex-1 center conversation (new breadcrumb top bar, composer with Reference + Test chips), and a 340px right panel with a **tabbed** controller (Plan / Preview / Tests, plus admin-only **Ledger**). All existing backend behavior — SSE streaming, tool-call pipeline, artifact drawer, test-pipeline-runner, propagation flow, session auto-naming, admin trace + raw-prompt drawers, and the write-ledger — is rewired into the new shell **unchanged**. No backend, schema, or AI-pipeline changes. Dark mode is explicitly out of scope.

The technical approach is: (1) add a new design-token module alongside the current `STUDIO_COLORS` with the exact hex values from the handoff, (2) introduce Inter Tight + JetBrains Mono via `next/font`, (3) build a small set of new layout components (`StudioShell`, `LeftRail`, `TopBar`, `RightPanelTabs`, `PlanTab`, `PreviewTab`, `TestsTab`, `LedgerTab`, `ReferencePicker`), (4) rewire the existing `StudioChat`, block renderers, `ArtifactDrawer`, and ledger interactions into the new shell, (5) compile existing acceptance tests against the new shell with selector updates where necessary, (6) visual-audit against the handoff.

## Technical Context

**Language/Version**: TypeScript 5.x on Node 18+ (frontend only)
**Primary Dependencies**: Next.js 16, React 19, Tailwind 4, shadcn/ui, `ai` (SDK), existing studio/build components, `next/font/google` for Inter Tight + JetBrains Mono
**Storage**: N/A — no backend or schema changes; all data comes from existing endpoints
**Testing**: Jest + React Testing Library (existing `frontend/components/studio/__tests__/*.test.tsx` + `frontend/components/build/__tests__/*.test.tsx`); axe-core for accessibility spot-checks; Playwright-capable MCP for visual verification
**Target Platform**: Modern evergreen browsers on desktop (Chrome/Safari/Firefox/Edge); viewport 900–1920px primary, graceful reflow below 900px
**Project Type**: Web application — frontend-only change within `frontend/components/studio/` plus a thin update inside `frontend/components/inbox-v5.tsx` where `StudioSurface` is mounted
**Performance Goals**: First assistant token visible within 500ms of stream start (parity with current Studio); no additional render work on hot paths (tab switch ≤1 frame; panel collapse/expand ≤150ms)
**Constraints**:
- Zero backend, schema, or AI-pipeline changes (spec A-10).
- 100% of existing `studio/__tests__` and `build/__tests__` MUST still pass (spec SC-002) — selector updates allowed only where the new shell renames a role.
- No dark-mode code paths ship in this change (spec Clarifications).
- The legacy `TUNING_COLORS` / `CATEGORY_STYLES` / `categoryStyle` / `triggerLabel` compat surface exported from `tokens.ts` MUST continue to resolve for the legacy `/tuning/*` routes that still compile against it.
- No new npm dependencies beyond `next/font` (already resolvable).
**Scale/Scope**: ~20 frontend component files touched; ~8 new components; estimated ~2,000 LOC of additions, ~1,000 LOC of targeted replacements (shell render tree + right-rail panel).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|---|---|---|
| I. Graceful Degradation (NON-NEGOTIABLE) | ✅ Pass | Pure frontend. Existing fallbacks (`load.kind === 'disabled'/'error'/'unauthenticated'` branches in `StudioSurface`) are preserved verbatim. No new optional dependencies. Main guest messaging flow is not touched. |
| II. Multi-Tenant Isolation (NON-NEGOTIABLE) | ✅ Pass | No new queries, no new API calls. Every surface continues to hit the same tenant-scoped endpoints (`/api/build/*`, `/api/tuning/*`). No tenantId surface introduced outside of existing data. |
| III. Guest Safety & Access Control (NON-NEGOTIABLE) | ✅ Pass | Studio is the operator-facing build surface, not guest-facing. No change to access-code gating or screening flow. |
| IV. Structured AI Output | ✅ Pass | No AI call changes. All json_schema enforcement remains in backend. |
| V. Escalate When In Doubt | ✅ Pass | Not applicable — no changes to escalation or task flow. |
| VI. Observability by Default | ✅ Pass | `AiApiLog`, Langfuse, Socket.IO event paths unchanged. The redesign replaces the render tree; emit/log paths downstream are identical. |
| VII. Tool-Based Architecture | ✅ Pass | Tool call loop and tool definitions are untouched. The design's "Reference" chip surfaces citations over existing artifact types; no new tools. |
| VIII. FAQ Knowledge Loop | ✅ Pass | FAQ auto-suggest pipeline untouched. The Reference picker reads the same FAQ read endpoint used elsewhere. |

**Development workflow compliance**:
- Branch strategy: `046-studio-redesign` merges directly to `main`. ✅
- Database changes: none. ✅
- Env var discipline: no new env vars. ✅
- Cost awareness: no AI call changes. ✅

**Gate verdict**: **PASS**. No complexity tracking entries required.

## Project Structure

### Documentation (this feature)

```text
specs/046-studio-redesign/
├── plan.md              # This file
├── spec.md              # Feature spec (already written, clarified)
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output (UI-state model, no DB)
├── quickstart.md        # Phase 1 output (how to run + verify)
├── contracts/
│   └── ui-contracts.md  # Phase 1 output — component prop contracts + event flow
├── checklists/
│   └── requirements.md  # Already written
└── tasks.md             # /speckit.tasks output — not created here
```

### Source Code (repository root)

This is a frontend-only change. All additions and modifications land inside `frontend/components/studio/` plus one mount point in `frontend/components/inbox-v5.tsx`.

```text
frontend/
├── app/
│   └── fonts.ts                                  # NEW — next/font loaders for Inter Tight + JetBrains Mono
├── components/
│   ├── studio/
│   │   ├── tokens.ts                             # MODIFIED — add STUDIO_TOKENS_V2 (new hex palette) alongside current STUDIO_COLORS; keep TUNING_COLORS compat exports
│   │   ├── studio-surface.tsx                    # MODIFIED — render new StudioShell; preserve all bootstrap + state logic
│   │   ├── studio-chat.tsx                       # MINOR MODIFIED — consume the new composer host slot + expose onReferencePick / onTestChip callbacks
│   │   ├── chat-parts/                           # NEW folder — if current chat-parts.* is split, extract block renderers that match the handoff's block set
│   │   ├── studio-shell.tsx                      # NEW — three-pane layout primitive; holds leftCollapsed / rightCollapsed state
│   │   ├── left-rail.tsx                         # NEW — brand row + search + "New chat" + grouped list + read-only footer property row
│   │   ├── top-bar.tsx                           # NEW — breadcrumb + draft pill
│   │   ├── right-panel-tabs.tsx                  # NEW — tab controller (Plan / Preview / Tests + admin Ledger)
│   │   ├── plan-tab.tsx                          # NEW — wraps existing plan-checklist + CONTEXT IN USE list
│   │   ├── preview-tab.tsx                       # NEW — inline guest-message input + existing TestPipelineResult render path
│   │   ├── tests-tab.tsx                         # NEW — test suite header + per-variant case rows + in-place expand
│   │   ├── ledger-tab.tsx                        # NEW — wraps existing WriteLedgerCard for the admin 4th tab
│   │   ├── reference-picker.tsx                  # NEW — artifact-picker popover (SOPs / FAQs / system prompt / tools / property overrides) that inserts a citation chip
│   │   ├── composer/                             # NEW folder (or inline in studio-chat.tsx if feasible)
│   │   │   ├── composer-card.tsx                 # NEW — rounded composer with Reference + Test chips + send button
│   │   │   └── composer-chips.tsx                # NEW — Reference chip + Test chip interaction
│   │   ├── artifact-drawer.tsx                   # MINOR MODIFIED — style pass to match new header / footer / sub-strip; no API changes
│   │   ├── state-snapshot.tsx                    # RETIRED from right panel (the Plan tab subsumes its data) — kept as source of truth for Plan tab's CONTEXT IN USE block
│   │   ├── session-artifacts.tsx                 # RETIRED from right panel (surfaced as inline artifact-ref cards via chat-parts; ledger tab shows history)
│   │   ├── write-ledger.tsx                      # MINOR MODIFIED — new visual treatment inside ledger-tab; existing logic unchanged
│   │   ├── trace-drawer.tsx                      # UNCHANGED — opened from right-panel utility button
│   │   ├── raw-prompt-drawer.tsx                 # UNCHANGED — opened from right-panel utility button
│   │   ├── citation-chip.tsx                     # UNCHANGED — reused by composer reference chip
│   │   ├── citation-parser.ts                    # UNCHANGED
│   │   ├── tokens.ts                             # (listed above)
│   │   ├── index.ts                              # MODIFIED — export new shell components
│   │   └── __tests__/*.test.tsx                  # MINOR MODIFIED — selector updates only (role/testid) where the shell renames; assertions preserved
│   ├── build/
│   │   ├── plan-checklist.tsx                    # UNCHANGED — rendered inside new plan-tab.tsx
│   │   ├── propagation-banner.tsx                # UNCHANGED — rendered above conversation unchanged
│   │   └── test-pipeline-result.tsx              # UNCHANGED — rendered inside preview-tab.tsx + tests-tab.tsx row expansion
│   └── inbox-v5.tsx                              # TINY MODIFIED — no logic change; renders <StudioSurface/> the same way
└── app/
    └── layout.tsx                                # TINY MODIFIED — load Inter Tight + JetBrains Mono fonts globally; Studio surface consumes them

backend/
└── (no changes)
```

**Structure Decision**: **Web-application frontend-only change, scoped to `frontend/components/studio/`**. No backend, database, API, or AI-pipeline files are touched. New components land in `frontend/components/studio/` alongside existing ones; the legacy surface stays importable during the transition (we'll remove retired files only after the last test migration lands). The `tokens.ts` file gains a v2 export namespace rather than a hard replacement so the legacy `/tuning/*` routes keep resolving.

## Phase 0 — Research (summary; full in `research.md`)

Unknowns from Technical Context resolved in `research.md`:

1. **Inter Tight + JetBrains Mono loading strategy** — Next.js 16 `next/font/google` with `display: "swap"`, preloaded in `app/layout.tsx`, exposed as CSS variables `--font-inter-tight` / `--font-jetbrains-mono`. Tailwind 4 config consumes the variables.
2. **Token v2 coexistence with existing `STUDIO_COLORS`** — introduce `STUDIO_TOKENS_V2` with spec hex values; keep `STUDIO_COLORS` exported for the compat surface re-exported into `TUNING_COLORS`. Studio chrome imports only v2; legacy code paths continue to resolve v1.
3. **Tab-controller state persistence** — in-memory per mount (matches spec FR-055); no localStorage. Dismiss on full page reload (acceptable per user path: operators rarely reload Studio mid-session).
4. **Preview-tab input vs. composer Test chip** — single pipeline, two entry points. Both call the same `apiRunTestPipeline(tenantId, conversationId, { message })` and both write into a shared `previewInput` state owned by `StudioShell` so the composer's Test chip can set-and-fire without re-implementing the pipeline.
5. **Tests-tab in-place expansion** — accordion pattern; one row open at a time. Collapsed state shows status dot + case name + duration; expanded state mounts `<TestPipelineResult variant={…}/>` inside the case card.
6. **Reference picker data sources** — one popover with four tab-like segments (SOPs / FAQs / Prompt / Tools / Property overrides), each backed by its existing list endpoint. The picker uses the existing `apiListSop`, `apiListFaq`, etc.
7. **Focus-return after drawer close** — existing `artifactDrawerOpenerRef` continues to work; no changes required.
8. **900px reflow trigger** — CSS-only via container queries (Tailwind 4 supports them) + a `useIsNarrow` hook for the imperative show/hide of the left-rail off-canvas drawer.

All NEEDS CLARIFICATION are resolved by research or by the spec's Clarifications section. No open questions escalate.

## Phase 1 — Design & Contracts (summaries; full files in this feature folder)

### `data-model.md` — UI-state model

No database changes. The UI state model is an enumeration of existing server types plus new transient client-only state:

- **Existing (server-authored, unchanged)**: `TuningConversation`, `TuningConversationMessage`, `BuildTenantState`, `SessionArtifact`, `BuildArtifactHistoryRow`, `TestPipelineResultData`, `BuildCapabilities`.
- **New (client-only, in-memory)**:
  - `RightPanelTab = 'plan' | 'preview' | 'tests' | 'ledger'` — activeTab state in `StudioShell`.
  - `RightPanelCollapsed = boolean`.
  - `LeftRailCollapsed = boolean` (driven by viewport hook).
  - `SessionSearchQuery = string` — debounced filter in left rail.
  - `PreviewInputState = { text: string; isSending: boolean; lastResult: TestPipelineResultData | null }`.
  - `TestsTabExpandedVariantId = string | null` — accordion state.
  - `ReferencePickerOpen = { open: boolean; anchorEl: HTMLElement | null }`.

### `contracts/ui-contracts.md` — component prop contracts

Enumerates the prop shape and events for every new component (`StudioShell`, `LeftRail`, `TopBar`, `RightPanelTabs`, `PlanTab`, `PreviewTab`, `TestsTab`, `LedgerTab`, `ReferencePicker`, `ComposerCard`) so that each can be implemented and unit-tested independently. Also documents the event flow:

- **User sends message** → `StudioChat.onSend(text)` → existing send pipeline → SSE streams into `StudioChat` → chat-parts render inside center pane. Unchanged.
- **Composer Test chip** → `ComposerChips.onTestChip(text)` → `StudioShell.setPreviewInput(text)` + `setActiveTab('preview')` + `PreviewTab.fire()`.
- **Reference chip click** → `ComposerChips.onReferenceClick(anchorEl)` → opens `ReferencePicker` → `onSelect(artifact)` → insert citation chip into composer textarea at cursor.
- **Tests-tab row click** → `TestsTab.setExpandedVariantId(id)` → inline mount of `TestPipelineResult`.
- **Plan tab Apply** → existing `plan-checklist.tsx` `onApprove()` → existing `StudioSurface.handlePlanApproved` → `PropagationBanner` mount above conversation.
- **Artifact-ref click / citation-chip click / ledger row click** → `StudioShell.openArtifactDrawer(target)` → existing `ArtifactDrawer` with existing logic.

### `quickstart.md`

Short operator-facing runbook:

1. `cd frontend && npm install && npm run dev`.
2. Log in as a tenant with `isAdmin: true` + `rawPromptEditorEnabled: true` (for full admin surface verification), plus a non-admin tenant for the gated-path verification.
3. Click Studio → verify the three panels render with the new tokens.
4. Send a tuning request → watch reasoning, tool calls, artifact-ref cards stream; open one artifact → read the drawer; close → focus returns to the opener.
5. Click Preview tab → type "my wifi doesn't work" → Send test → inspect the bubble pair + latency/tokens/cost.
6. Click Tests tab → confirm the latest run renders as a suite; expand a case row.
7. Admin only: click Ledger tab → row click opens the drawer with the Verification section; row revert → two-step preview+confirm.
8. Resize below 900px → left rail goes off-canvas; right panel collapses to 40px.

### Agent context update

Run `.specify/scripts/bash/update-agent-context.sh claude` to record the new file paths (shell, tabs, composer, reference picker) in the agent context so subsequent agents can navigate quickly.

## Post-design Constitution re-check

All gates stay green: the design phase introduced no new backend work, no new environment variables, no new AI calls, no new tenant-scoping surface, and no change to the graceful-degradation fallbacks in `StudioSurface`. The only risk surface is visual regression — covered by SC-002 (existing tests pass) and SC-005 (design conformance audit).

**Re-check verdict**: **PASS**. No complexity tracking entries required.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| *(none)* | *(none)* | *(none)* |
