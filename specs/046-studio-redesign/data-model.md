# Phase 1 — UI-State Data Model: Studio Redesign

**No backend / database / schema changes.** Every server-authored type reused here is already persisted and streamed by today's `/api/build/*` and `/api/tuning/*` endpoints.

This document enumerates (a) the existing server types the new shell reads from, and (b) the new client-only UI state the shell introduces.

---

## 1. Reused server-authored types (unchanged)

All imported from `@/lib/api`, `@/lib/build-api`, or re-exported through `frontend/components/studio/*`. Every reference below is verbatim to the live codebase.

| Type | Source | Shell usage |
|---|---|---|
| `TuningConversationSummary` | `@/lib/api` | Left-rail session list rows. |
| `TuningConversation` + `TuningConversationMessage` | `@/lib/api` | Bootstrap rehydration of the active conversation + SSE-driven part updates inside the center pane. |
| `TuningConversationAnchor` | `@/lib/api` | Anchor-message display at conversation open. |
| `BuildTenantState` | `@/lib/build-api` | Breadcrumb tenant name, Plan tab header, greenfield flag, initial snapshot fallback. |
| `BuildCapabilities` | `@/lib/build-api` | Gates: `isAdmin`, `traceViewEnabled`, `rawPromptEditorEnabled` → Ledger tab, trace utility button, raw-prompt utility button. |
| `SessionArtifact` | `frontend/components/studio/session-artifacts.tsx` | Used by `Plan tab > CONTEXT IN USE` and by inline artifact-ref cards in the center pane. |
| `SessionArtifactRow` | `@/lib/build-api` | Hydration from `/api/build/session-artifacts`. |
| `BuildArtifactHistoryRow` | `@/lib/build-api` | Ledger tab rows. |
| `TestPipelineResultData` + `TestPipelineVariant` (nested) | `@/lib/build-api` | Preview tab last-result render + Tests tab suite rows. |
| `StateSnapshotData` + `StateSnapshotSummary` | `frontend/components/studio/state-snapshot.tsx` | Input to the Plan tab header's "CURRENT PLAN" stats. |
| `ArtifactDrawerTarget` | `frontend/components/studio/artifact-drawer.tsx` | Unchanged drawer input shape. |

No field is added, removed, renamed, or retyped on any of these. The redesign is purely a re-rendering of the same data.

---

## 2. New client-only UI state (per `StudioShell` mount)

Lives in React state (useState / useReducer). Not persisted across page reloads unless noted.

### 2.1 Layout & navigation

```ts
type RightPanelTab = 'plan' | 'preview' | 'tests' | 'ledger'

type LayoutState = {
  activeRightTab: RightPanelTab
  rightCollapsed: boolean          // true = 40px strip, false = 340px expanded
  leftCollapsed: boolean           // true below 900px by default; toggled by hamburger
}
```

- **Default activeRightTab**: `'plan'` on mount, per FR-030.
- **Default rightCollapsed**: `false` at ≥900px; `true` below 900px (from `useIsNarrow`).
- **Default leftCollapsed**: `false` at ≥900px; `true` below 900px.
- **Invariants**:
  - `activeRightTab === 'ledger'` is only reachable when `capabilities.isAdmin && capabilities.rawPromptEditorEnabled`. On capability loss mid-session, the shell MUST reset to `'plan'`.
  - Switching sessions (change of `conversationId`) preserves `activeRightTab` and `rightCollapsed` (FR-055); does NOT reset to Plan.

### 2.2 Left rail

```ts
type LeftRailState = {
  searchQuery: string              // debounced 150ms
  showEmptySessions: boolean       // existing behavior preserved
}
```

- **searchQuery**: filters `TuningConversationSummary.title` via case-insensitive substring.
- **showEmptySessions**: existing toggle (FR-014); preserved as today's `StudioSurface` LeftRail component behaves.

Grouped list derivation (pure function of `items + searchQuery + showEmptySessions + Date.now()`):

```ts
type SessionGroup = 'recent' | 'earlier'
function groupOf(c: TuningConversationSummary): SessionGroup {
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
  const updatedAt = Date.parse(c.updatedAt)
  return Number.isFinite(updatedAt) && (Date.now() - updatedAt) < SEVEN_DAYS_MS
    ? 'recent'
    : 'earlier'
}
```

### 2.3 Preview tab

```ts
type PreviewInputState = {
  text: string                     // the current test-message draft
  isSending: boolean               // true while a pipeline call is in flight
  lastResult: TestPipelineResultData | null
  lastError: string | null
}

// Derived (pure functions of the latest variant's readouts — see FR-033)
type LatencyBudget = {
  replySeconds: number
  tokens: number
  costUsd: number
  warnReply: boolean   // true iff replySeconds > 2
  warnCost: boolean    // true iff costUsd > 0.01
}
```

Inline code-pill rendering in the preview agent bubble (FR-033) is a pure rendering transform: run a single pass replacing `` `…` `` tokens with a `<span>` pill. No state required.

- **Owner**: `StudioShell` (so the composer `Test` chip can write into it).
- **Send pathway** (FR-033):
  ```
  setPreviewInput({ text, isSending: true, lastResult: prev.lastResult, lastError: null })
  apiRunTestPipeline(tenantId, conversationId, { message: text })
    .then(data => setPreviewInput({ text, isSending: false, lastResult: data, lastError: null }))
    .catch(err => setPreviewInput({ text, isSending: false, lastResult: prev.lastResult, lastError: String(err) }))
  ```
- **Composer `Test` chip shortcut** (FR-025b):
  ```
  onTestChip(text) {
    setActiveRightTab('preview')
    setPreviewInput({ text, isSending: true, lastResult: prev.lastResult, lastError: null })
    apiRunTestPipeline(...)
  }
  ```
- **Invariant**: composer textarea is never mutated by the `Test` chip; the chip only reads it.

### 2.4 Tests tab

```ts
type TestsTabState = {
  expandedVariantId: string | null         // accordion; one at a time
  suiteSource: TestPipelineResultData | null
  rerunningVariantIds: Set<string>         // variants whose Re-run chevron was clicked; rendered with a spinner dot until the variant returns
}
```

**Re-run** (FR-034): clicking a variant's Re-run chevron adds its id to `rerunningVariantIds` and calls `apiRunTestPipeline(conversationId, { message: suiteSource.inputMessage, onlyVariant: variantId })`. On return, the variant slot in `suiteSource.variants` is replaced in place (keeps siblings' expansion state) and the id is removed from the set. Click is `stopPropagation` to avoid also toggling the accordion.

- **suiteSource**: latest `TestPipelineResultData` (the same object the Preview tab renders inline). Shell sources both from the same `previewInput.lastResult` so Preview ↔ Tests stay in sync without a separate fetch path.
- **Header copy**: `TEST SUITE — {suiteSource.runLabel ?? 'Run'} · {variants.length} cases`.
- **Row status mapping**:
  - `variant.verdict === 'passed'` → `done`
  - `variant.verdict === 'failed' | 'errored'` → `done` (red check replaced by warn/danger dot)
  - variant still running (ephemeral, only while `isSending`) → `running` with blue spinner
  - no verdict yet → `pending` (dashed ring)
- **Duration**: `variant.latencyMs / 1000` rounded to 1 decimal → `"{n}s"`. While running or pending, show `"—"`.

### 2.5 Reference picker

```ts
type ReferencePickerState = {
  open: boolean
  anchorEl: HTMLElement | null
  activeSegment: 'sop' | 'faq' | 'prompt' | 'tool' | 'property'
}
```

- Opens from the `Reference` chip's click; anchor is the chip's DOM node.
- Segment lists are fetched lazily on first open (cached for the mount via a simple `useQuery`-style hook — or SWR if present in the project).
- Selecting an item:
  1. Constructs the existing citation-chip marker via `citation-parser.ts` format.
  2. Inserts the marker into `StudioChat`'s composer textarea at the current cursor position.
  3. Closes the popover and returns focus to the composer.

### 2.6 Artifact drawer

Reuses the existing `artifactDrawer` state in `StudioSurface`:

```ts
type ArtifactDrawerState = {
  open: boolean
  target: ArtifactDrawerTarget | null
}

// Derived (pure function of the current plan state)
type DrawerFooterVisible = boolean   // true iff session has at least one unapplied pending change (FR-041)
```

And `artifactDrawerOpenerRef: RefObject<HTMLElement | null>` for focus return. The `DrawerFooterVisible` derived value is computed from the existing plan-checklist state the Plan tab already reads — no new fetch required.

---

## 3. State ownership map

| State | Owner | Readers |
|---|---|---|
| `LayoutState` | `StudioShell` | `LeftRail`, `TopBar` chevron (unused), `RightPanelTabs`, all tab panels |
| `LeftRailState` | `LeftRail` (local) | — |
| `PreviewInputState` | `StudioShell` | `PreviewTab`, composer `Test` chip handler, `TestsTab` (for `suiteSource` derivation) |
| `TestsTabState` | `TestsTab` (local) | — |
| `ReferencePickerState` | `StudioShell` (because the composer is inside `StudioChat` and the picker is rendered at shell level for portal correctness) | `ReferencePicker`, composer chips |
| `ArtifactDrawerState` | `StudioSurface` (unchanged) | `ArtifactDrawer`, all opener callsites |
| Existing session/auto-name/capabilities/trace/raw-prompt state | `StudioSurface` (unchanged) | — |

---

## 4. Derived state (pure, not stored)

- **Recent vs. Earlier grouping** — pure function of `items + Date.now()`.
- **Filtered session list** — pure function of `items + searchQuery + showEmptySessions + selectedId`.
- **Progress bar percentage** — `doneTasks / totalTasks` from the existing plan-checklist data. Already computed inside `plan-checklist.tsx`; the new Plan tab consumes it.
- **Context-in-use list** — `sessionArtifacts` filtered to entries touched during the current session (any `action` — created / modified / reverted — since `sessionStartIso`), newest-first, capped at 5 rows. Already exposed by existing SSE parts (`data-session-artifact-touched`). A `read` action does not exist on `SessionArtifact` today; a future feature may add one if a true read-context view is needed.

---

## 5. What is explicitly NOT in the model

- **No per-tenant theme state.** Dark mode is out of scope.
- **No per-tab URL state.** Reload resets to Plan (R3 decision).
- **No composer attachment state.** Paperclip is dropped (Clarifications Q2).
- **No property-scoped session filter.** Footer property row is read-only (Clarifications Q3).
- **No draft vs. published artifact selector.** The design's top-bar `Publish` button is out of scope (Clarifications Q1); the existing Plan-tab Apply button handles the apply flow.
