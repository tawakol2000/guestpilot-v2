'use client'

// Sprint 046 — Studio design overhaul (plan T007 + contracts/ui-contracts.md).
//
// Three-pane layout host: left rail (260px) | center main (flex) | right
// panel (340px, collapsible to 40px). Owns layout / preview-input /
// reference-picker state; exposes it via StudioShellContext so descendants
// (composer Test chip, Preview tab, Reference picker) can coordinate
// without prop-drilling.
//
// This scaffold intentionally renders slot placeholders for the left
// rail, top bar, and right panel in CP1/CP2. The real surfaces land in
// Phase 3+ (T011+) and Phase 5 (T033+). StudioSurface mounts the shell
// in T010 and passes the existing StudioChat / admin drawers as
// children; operator-visible surfaces remain identical until the tab
// + rail components replace the placeholders.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  BuildCapabilities,
  BuildTenantState,
  TestPipelineResultData,
} from '@/lib/build-api'
import { STUDIO_TOKENS_V2 } from './tokens'
import { useIsNarrow } from './hooks/use-is-narrow'
import {
  StudioShellContext,
  type DerivedContextItem,
  type PreviewInputState,
  type RightPanelTab,
  type StudioShellContextValue,
} from './studio-shell-context'
import { ReferencePicker, type ReferenceTarget } from './reference-picker'

export interface StudioShellProps {
  tenantName: string
  tenantState: BuildTenantState
  conversationId: string
  capabilities: BuildCapabilities

  /** Center pane content — StudioChat + any error boundary wrapper. */
  children: ReactNode

  /** Optional slots (wired in later phases — safe to omit during CP1/CP2). */
  leftRail?: ReactNode
  topBar?: ReactNode
  rightPanel?: ReactNode

  /** Optional propagation banner above the conversation column. */
  banner?: ReactNode

  /** Drawers + modals rendered as siblings (portal into the shell root). */
  drawers?: ReactNode

  /** Called when the shell routes a Test-chip or Preview-input send. */
  onRunPreview?: (text: string) => Promise<TestPipelineResultData | null> | void

  /** Called when the operator picks a reference from the ReferencePicker.
   *  Typically the host wires this to the composer's textarea so the
   *  selected citation chip lands at the current cursor position. */
  onReferencePicked?: (ref: ReferenceTarget) => void
}

export function StudioShell(props: StudioShellProps) {
  const { children, leftRail, topBar, rightPanel, banner, drawers, capabilities, onRunPreview, onReferencePicked } = props

  const { isNarrow } = useIsNarrow()

  // Layout state — defaults follow FR-030 (Plan), FR-055 (tab + collapse
  // preserved across session switches inside one mount), and SC-007
  // (narrow viewport defaults collapsed).
  //
  // Sprint 046 bug-fix: the `useState(() => isNarrow)` initializer
  // runs ONCE on mount. At that point useIsNarrow returns its SSR-safe
  // default (isNarrow: false, width: null) because its useEffect hasn't
  // run yet — so even on a 600px viewport both panels initialized to
  // expanded and only collapsed if the operator clicked the chevrons.
  // The useEffect below observes isNarrow after mount and syncs the
  // collapse state on the transition from the SSR default to the real
  // viewport size. A `didInitRef` guard prevents the sync from running
  // every time isNarrow flips, which would fight the operator's own
  // toggles.
  const [activeRightTab, setActiveRightTabRaw] = useState<RightPanelTab>('plan')
  const [rightCollapsed, setRightCollapsed] = useState<boolean>(false)
  const [leftCollapsed, setLeftCollapsed] = useState<boolean>(false)
  const didInitCollapseRef = useRef(false)
  useEffect(() => {
    if (didInitCollapseRef.current) return
    didInitCollapseRef.current = true
    if (isNarrow) {
      setRightCollapsed(true)
      setLeftCollapsed(true)
    }
  }, [isNarrow])

  // Ledger tab is admin-gated; if capabilities flip mid-session the
  // active tab must reset to Plan so the operator isn't stuck viewing
  // a disallowed tab (data-model §2.1 invariant).
  const setActiveRightTab = useCallback(
    (t: RightPanelTab) => {
      if (t === 'ledger' && !(capabilities.isAdmin && capabilities.rawPromptEditorEnabled)) {
        setActiveRightTabRaw('plan')
        return
      }
      setActiveRightTabRaw(t)
    },
    [capabilities.isAdmin, capabilities.rawPromptEditorEnabled],
  )

  // Preview-input state (FR-033 + R4). Shell owns this so the composer
  // Test chip (deep inside StudioChat) can drive the Preview tab.
  const [previewInput, setPreviewInput] = useState<PreviewInputState>({
    text: '',
    isSending: false,
    lastResult: null,
    lastError: null,
  })

  const setPreviewInputText = useCallback((text: string) => {
    setPreviewInput((prev) => ({ ...prev, text }))
  }, [])

  /**
   * 2026-04-24 — receive SSE-delivered test-pipeline results into the
   * shell so the Tests tab can render them. Called by the surface's
   * `handleTestResult`, which is fired from StudioChat when it sees a
   * `data-test-pipeline-result` part in the stream. Clears
   * `isSending` + `lastError` so the Preview tab stops showing the
   * spinner.
   */
  const setPreviewLastResult = useCallback((result: TestPipelineResultData) => {
    setPreviewInput((prev) => ({
      ...prev,
      isSending: false,
      lastResult: result,
      lastError: null,
    }))
    // Surface the result: flip the right-rail over to Tests so the
    // operator sees the per-variant case rows the moment the run
    // completes. Only auto-flip when we're currently on Preview —
    // don't interrupt the operator if they've navigated to Plan /
    // Ledger mid-run.
    setActiveRightTabRaw((prev) => (prev === 'preview' ? 'tests' : prev))
  }, [])

  const runPreview = useCallback(
    (text: string) => {
      if (!text.trim()) return
      setActiveRightTabRaw('preview')
      setPreviewInput({ text, isSending: true, lastResult: null, lastError: null })
      if (!onRunPreview) {
        // Without a runner wired in, surface the no-op gracefully so
        // the Preview tab shows "pending" rather than a silent swallow.
        setPreviewInput((prev) => ({
          ...prev,
          isSending: false,
          lastError: 'Preview runner not yet wired up (CP2 scaffold).',
        }))
        return
      }
      const resultMaybe = onRunPreview(text)
      if (!resultMaybe) {
        // Fire-and-forget path: the runner will deliver results via SSE
        // and the shell will receive them through a separate channel
        // (StudioChat's onTestResult → shell in T031). Leave isSending
        // true; the shell clears it when the SSE result arrives.
        return
      }
      Promise.resolve(resultMaybe)
        .then((result) => {
          setPreviewInput((prev) => ({
            text: prev.text,
            isSending: false,
            lastResult: result ?? prev.lastResult,
            lastError: null,
          }))
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          setPreviewInput((prev) => ({
            text: prev.text,
            isSending: false,
            lastResult: prev.lastResult,
            lastError: message,
          }))
        })
    },
    [onRunPreview],
  )

  // Derived-context state (bug follow-up) — populated by StudioChat as
  // tool-call parts stream in. PlanTab renders it in CONTEXT IN USE.
  const [derivedContext, setDerivedContext] = useState<DerivedContextItem[]>([])

  // Reference-picker state (FR-025a). The anchorEl ref lets the picker
  // popover attach to the composer chip that opened it.
  const [referencePickerOpen, setReferencePickerOpen] = useState(false)
  const referencePickerAnchorRef = useRef<HTMLElement | null>(null)

  const openReferencePicker = useCallback((anchorEl: HTMLElement) => {
    referencePickerAnchorRef.current = anchorEl
    setReferencePickerOpen(true)
  }, [])

  const closeReferencePicker = useCallback(() => {
    setReferencePickerOpen(false)
    referencePickerAnchorRef.current = null
  }, [])

  const ctx = useMemo<StudioShellContextValue>(
    () => ({
      activeRightTab,
      setActiveRightTab,
      rightCollapsed,
      setRightCollapsed,
      leftCollapsed,
      setLeftCollapsed,
      previewInput,
      setPreviewInputText,
      runPreview,
      setPreviewLastResult,
      openReferencePicker,
      closeReferencePicker,
      derivedContext,
      setDerivedContext,
    }),
    [
      activeRightTab,
      setActiveRightTab,
      rightCollapsed,
      leftCollapsed,
      previewInput,
      setPreviewInputText,
      runPreview,
      setPreviewLastResult,
      openReferencePicker,
      closeReferencePicker,
      derivedContext,
    ],
  )

  const handleReferenceSelect = useCallback(
    (ref: ReferenceTarget) => {
      onReferencePicked?.(ref)
      setReferencePickerOpen(false)
    },
    [onReferencePicked],
  )

  const rightWidth = rightCollapsed ? 40 : 340
  const showLeftRail = !isNarrow || !leftCollapsed

  return (
    <StudioShellContext.Provider value={ctx}>
      <div
        data-studio-shell
        className="flex min-h-0 flex-1"
        style={{
          background: STUDIO_TOKENS_V2.bg,
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {showLeftRail ? (
          isNarrow ? (
            <>
              {/* Narrow viewport: render left rail as an off-canvas
                  drawer with a backdrop. Drawer slides from the left;
                  backdrop click closes it. */}
              <button
                type="button"
                aria-label="Close navigation"
                onClick={() => setLeftCollapsed(true)}
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'rgba(10, 12, 20, 0.35)',
                  zIndex: 40,
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                }}
              />
              <aside
                aria-label="Studio sessions"
                style={{
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  left: 0,
                  width: 260,
                  minWidth: 260,
                  borderRight: `1px solid ${STUDIO_TOKENS_V2.border}`,
                  background: STUDIO_TOKENS_V2.surface,
                  zIndex: 50,
                  display: 'flex',
                  flexDirection: 'column',
                  boxShadow: STUDIO_TOKENS_V2.shadowMd,
                }}
              >
                {leftRail}
              </aside>
            </>
          ) : (
            <aside
              aria-label="Studio sessions"
              style={{
                width: 260,
                minWidth: 260,
                borderRight: `1px solid ${STUDIO_TOKENS_V2.border}`,
                background: STUDIO_TOKENS_V2.surface,
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              {leftRail}
            </aside>
          )
        ) : null}

        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {topBar}
          {banner}
          <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        </main>

        <aside
          aria-label="Studio plan, preview, and tests"
          style={{
            width: rightWidth,
            minWidth: rightWidth,
            borderLeft: `1px solid ${STUDIO_TOKENS_V2.border}`,
            background: STUDIO_TOKENS_V2.surface,
            display: 'flex',
            flexDirection: 'column',
            transition: 'width 200ms ease-out, min-width 200ms ease-out',
          }}
        >
          {rightPanel}
        </aside>

        {drawers}
        <ReferencePicker
          open={referencePickerOpen}
          anchorEl={referencePickerAnchorRef.current}
          onClose={closeReferencePicker}
          onSelect={handleReferenceSelect}
        />
      </div>
    </StudioShellContext.Provider>
  )
}
