# Phase 1 — UI Component Contracts: Studio Redesign

Every new component's prop shape + emitted events + DOM contract (role, testid) so each can be implemented and unit-tested in isolation. Existing components that stay as-is are listed at the bottom with no contract (they don't change).

---

## Layout primitives

### `<StudioShell/>`

Three-pane layout host. Owns `LayoutState`, `PreviewInputState`, and `ReferencePickerState`. Renders: `LeftRail` → `main` (TopBar + center pane) → `RightPanelTabs` → portaled `ArtifactDrawer` / `TraceDrawer` / `RawPromptDrawer` / `ReferencePicker`.

```ts
interface StudioShellProps {
  // Session context (from StudioSurface)
  tenantState: BuildTenantState
  conversationId: string
  capabilities: BuildCapabilities

  // Data streams (from StudioSurface)
  sessionArtifacts: SessionArtifact[]
  testResults: TestPipelineResultData[]
  snapshot: StateSnapshotData
  ledgerRefreshKey: number

  // Session list (from StudioSurface)
  sessions: TuningConversationSummary[]
  sessionsLoading: boolean
  sessionsError: string | null
  onSelectSession: (id: string) => void
  onCreateSession: () => Promise<void>
  onReloadSessions: () => Promise<void>

  // Chat child (rendered in the center pane)
  children: React.ReactNode  // <StudioChat/> with a composer slot

  // Drawer/admin wiring (from StudioSurface)
  onOpenArtifactDrawer: (target: ArtifactDrawerTarget) => void
  onOpenTrace: () => void
  onOpenRawPrompt: () => void
  onOpenLedgerRow: (row: BuildArtifactHistoryRow) => void
  onRevertLedgerRow: (row: BuildArtifactHistoryRow) => Promise<void>
}
```

**Exposed via React Context (`StudioShellContext`)** for descendants:

```ts
interface StudioShellContextValue {
  // Layout toggles
  activeRightTab: RightPanelTab
  setActiveRightTab: (t: RightPanelTab) => void
  rightCollapsed: boolean
  setRightCollapsed: (v: boolean) => void
  leftCollapsed: boolean
  setLeftCollapsed: (v: boolean) => void

  // Preview + composer-chip bridge
  previewInput: PreviewInputState
  setPreviewInputText: (t: string) => void
  runPreview: (text: string) => void  // sets state + fires pipeline + focuses Preview tab

  // Reference picker
  openReferencePicker: (anchorEl: HTMLElement) => void
  closeReferencePicker: () => void
}
```

**Invariants**:
- `activeRightTab === 'ledger'` only when `capabilities.isAdmin && capabilities.rawPromptEditorEnabled`.
- Capability loss resets `activeRightTab` to `'plan'`.

**DOM contract**:
- Outer `<div data-studio-shell>` with `role="application"` ? — no, keep default. No special role.
- Left rail: `<aside aria-label="Studio sessions">`.
- Right panel: `<aside aria-label="Studio plan, preview, and tests">`.

---

### `<LeftRail/>`

Brand row + search + "New chat" + grouped session list + read-only footer property row.

```ts
interface LeftRailProps {
  // From shell context + parent
  sessions: TuningConversationSummary[]
  loading: boolean
  error: string | null
  selectedId: string
  onSelect: (id: string) => void
  onCreate: () => Promise<void>

  tenantName: string                // for the footer property row sublabel
  propertyCount: number             // for "{N} properties · operator"
}
```

**DOM contract**:
- Search input: `<input aria-label="Search sessions" role="searchbox">`.
- "New chat" button: `<button aria-label="Start a new Studio session">`.
- Section label: `<h2 className="sr-only">Recent sessions</h2>` + visible uppercase label.
- Chat row: `<button role="menuitem" aria-current={active ? 'page' : undefined}>`.
- Footer: `<div data-testid="studio-property-footer">` — NOT a button, no click handler.
- Preserves existing `data-testid="show-empty-sessions-toggle"` on the toggle.

---

### `<TopBar/>`

Breadcrumb + Draft pill. No Publish button (spec Clarifications Q1).

```ts
interface TopBarProps {
  tenantName: string
  sessionTitle: string
}
```

**DOM contract**:
- `<header role="banner">` with a `<nav aria-label="Studio breadcrumb">` containing the three breadcrumb segments.
- Draft pill: `<span role="status" aria-label="Draft environment">`.

---

### `<RightPanelTabs/>`

Tab bar + active tab panel.

```ts
interface RightPanelTabsProps {
  isAdmin: boolean
  rawPromptEditorEnabled: boolean
  traceViewEnabled: boolean

  // Data for each tab
  snapshot: StateSnapshotData
  testResult: TestPipelineResultData | null
  sessionArtifacts: SessionArtifact[]
  ledgerConversationId: string
  ledgerRefreshKey: number

  // Utility actions
  onOpenTrace: () => void
  onOpenRawPrompt: () => void
  onOpenLedgerRow: (row: BuildArtifactHistoryRow) => void
  onRevertLedgerRow: (row: BuildArtifactHistoryRow) => Promise<void>
}
```

**DOM contract**:
- Tab list: `<div role="tablist" aria-label="Studio right panel">`.
- Each tab: `<button role="tab" aria-selected aria-controls="panel-{id}" id="tab-{id}">`.
- Panels: `<section role="tabpanel" id="panel-{id}" aria-labelledby="tab-{id}">`.
- Ledger tab only rendered when both admin flags true. No disabled stub.
- Keyboard: Left/Right arrows move selection within the tablist; Enter/Space activates.

---

### `<PlanTab/>`

Header + progress bar + existing plan-checklist + divider + CONTEXT IN USE list.

```ts
interface PlanTabProps {
  snapshot: StateSnapshotData
  sessionArtifacts: SessionArtifact[]
  // conversationId is implicit from shell context
}
```

- Renders the existing `<PlanChecklist/>` component from `frontend/components/build/plan-checklist.tsx` verbatim; the Plan tab is a visual wrapper.
- `CONTEXT IN USE` list: filters `sessionArtifacts` to those with `action === 'read'` (if the existing API surfaces that) else falls back to showing the most recent 3 artifacts.

---

### `<PreviewTab/>`

Inline test-message input + send + conversation render + latency/tokens/cost cards.

```ts
interface PreviewTabProps {
  tenantState: BuildTenantState
  // Other reads via StudioShellContext: previewInput, runPreview
}
```

**DOM contract**:
- Header: `<h3>REPLY AGENT PREVIEW</h3>` with model name + `draft` env pill.
- Input: `<input data-testid="studio-preview-input" aria-label="Test guest message">`.
- Send button: `<button data-testid="studio-preview-send">Send test</button>`, disabled when `previewInput.isSending || !previewInput.text.trim()`.
- Guest bubble: `<div role="article" aria-label="Test guest message">`.
- Agent bubble: `<div role="article" aria-label="Draft reply agent response">`.
- Latency/tokens/cost row: three `<div role="group">` cards.

**Pipeline call**: reuses `apiRunTestPipeline(conversationId, { message })` — existing; no new endpoint.

---

### `<TestsTab/>`

Test suite header + per-variant case rows + in-place expansion of `<TestPipelineResult/>`.

```ts
interface TestsTabProps {
  result: TestPipelineResultData | null    // latest run from previewInput.lastResult
  onReRunVariant: (variantId: string) => void  // FR-034 Re-run chevron
}
```

**DOM contract**:
- Header: `<header>TEST SUITE</header>` + `<h3>{runLabel} · {N} cases</h3>`.
- Row: `<button role="button" aria-expanded={expanded} aria-controls="case-{variantId}">`.
- Status dot: `<span role="img" aria-label="{status}">` (done / running / pending).
- Expanded body: `<div id="case-{variantId}" role="region">` containing `<TestPipelineResult variant={v}/>`.
- Empty state: "No tests yet. Run one from the Preview tab." with a button that flips `activeRightTab` to `'preview'`.

**Accordion behavior**: clicking an already-expanded row collapses it (toggle).

---

### `<LedgerTab/>`

Admin-only 4th tab. Wraps existing `<WriteLedgerCard/>`.

```ts
interface LedgerTabProps {
  conversationId: string
  refreshKey: number
  onOpenRow: (row: BuildArtifactHistoryRow) => void
  onRevertRow: (row: BuildArtifactHistoryRow) => Promise<void>
}
```

- Renders `<WriteLedgerCard visible conversationId refreshKey onOpenRow={onOpenRow} onRevertRow={onRevertRow}/>` — existing API preserved.

---

### `<ComposerCard/>` + `<ComposerChips/>`

Replace the current composer chrome in `studio-chat.tsx` with a design-matching card that includes Reference + Test chips.

```ts
interface ComposerCardProps {
  value: string                      // textarea content
  onChange: (v: string) => void
  onSend: () => void
  disabled: boolean                  // while a turn is streaming
  placeholder?: string
  // Chip actions
  onReferenceClick: (anchorEl: HTMLElement) => void
  onTestChip: (currentText: string) => void
}
```

**DOM contract**:
- Outer: `<form data-testid="studio-composer" aria-label="Studio chat composer">`.
- Textarea: `<textarea aria-label="Message" rows={1}>` with auto-grow.
- Chips row: `<div role="toolbar" aria-label="Composer actions">` containing `<button data-chip="reference">` + `<button data-chip="test">`.
- Send: `<button type="submit" aria-label={disabled ? 'Sending…' : 'Send message'}>` — enabled when `value.trim() && !disabled`.

**Keyboard**: Enter → `onSend`; Shift+Enter → newline. Existing behavior preserved.

---

### `<ReferencePicker/>`

Popover anchored to the Reference chip.

```ts
interface ReferencePickerProps {
  open: boolean
  anchorEl: HTMLElement | null
  onClose: () => void
  onSelect: (ref: ReferenceTarget) => void
}

type ReferenceTarget =
  | { kind: 'sop'; id: string; title: string }
  | { kind: 'faq'; id: string; title: string }
  | { kind: 'system_prompt'; id: string; title: string }
  | { kind: 'tool'; id: string; title: string }
  | { kind: 'property_override'; id: string; title: string }
```

**DOM contract**:
- `<div role="dialog" aria-label="Reference artifact">`.
- Segment control: `<div role="tablist" aria-label="Artifact type">` with five tabs.
- List: `<ul role="listbox">`, each item `<li role="option" aria-selected={false}>`.
- Escape closes; click outside closes; Enter selects.

**Data fetching**: lazy per-segment via existing `apiListSops`, `apiListFaq`, etc. Loaded lists are cached for the popover's lifetime.

---

## Event flow (end-to-end)

| Trigger | Flow |
|---|---|
| Operator types + Enter in composer | `ComposerCard.onSend` → `StudioChat`'s existing send pipeline → SSE → chat-parts render inline. **Unchanged.** |
| Composer `Test` chip | `ComposerChips.onTestChip(text)` → `StudioShellContext.runPreview(text)` → sets `activeRightTab='preview'`, sets `previewInput.isSending=true`, fires `apiRunTestPipeline`, updates `previewInput.lastResult`. `PreviewTab` re-renders with the new result. |
| Composer `Reference` chip | `ComposerChips.onReferenceClick(chipEl)` → `StudioShellContext.openReferencePicker(chipEl)`. `ReferencePicker` opens, user selects, `onSelect(ref)` → shell inserts a citation-chip marker into the composer textarea via `citation-parser.ts`. |
| Right-panel tab click | `RightPanelTabs.onTabClick(id)` → `StudioShellContext.setActiveRightTab(id)`. |
| Right-panel collapse chevron | `RightPanelTabs` toggles `setRightCollapsed`. |
| Tests-tab row click | `TestsTab` toggles its local `expandedVariantId`. |
| Plan-tab Apply button | Existing `<PlanChecklist/>` → existing `onApprove` → `StudioSurface.handlePlanApproved` → `PropagationBanner` mounts above the conversation (unchanged). |
| Artifact-ref card click (inline or in Plan tab) | Existing chat-parts path → `StudioSurface.openArtifactFromRow` → `ArtifactDrawer` opens. |
| Citation-chip click inside a message | Existing path → `StudioSurface.openArtifactFromCitation` → drawer opens with `scrollToSection`. |
| Ledger row click | `LedgerTab` → `onOpenRow(row)` → `StudioSurface.setArtifactDrawer({ open: true, target: { … historyRow } })`. Existing behavior preserved. |
| Ledger row revert | `LedgerTab` → `onRevertRow(row)` → existing preview+confirm+commit flow in `StudioSurface`. |
| Admin trace utility button | Bottom of right panel → `onOpenTrace()` → existing `TraceDrawer` opens. |
| Admin raw-prompt utility button | Bottom of right panel → `onOpenRawPrompt()` → existing `RawPromptDrawer` opens. |
| Narrow viewport (<900px) | `useIsNarrow` returns `true` → `setRightCollapsed(true)` + `setLeftCollapsed(true)` on mount. Left rail mounts as off-canvas drawer with hamburger toggle. |

---

## Existing components reused without any interface change

- `<StudioChat/>` — minor: exposes the composer slot so `<ComposerCard/>` can host it; otherwise unchanged.
- `<ArtifactDrawer/>` — visual restyle only; API unchanged.
- `<PlanChecklist/>` — unchanged.
- `<PropagationBanner/>` — unchanged.
- `<TestPipelineResult/>` — unchanged, mounted inside both the Preview tab (full) and the Tests tab (per-variant).
- `<WriteLedgerCard/>` — visual restyle only; API unchanged.
- `<TraceDrawer/>` — unchanged.
- `<RawPromptDrawer/>` — unchanged.
- Block renderers: reasoning toggle, tool-call row, artifact-ref card, inline diff card, clarify card — visual restyle only (Inter Tight, new palette); API unchanged.

---

## Non-goals (for this contracts document)

- Backend endpoint shapes — not changing; see existing API files.
- Database schema — not changing.
- AI prompt content — not changing.
