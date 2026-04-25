'use client'

/**
 * Sprint 046 Session C — StudioSurface.
 *
 * Three-pane layout mounted inside `inbox-v5.tsx`'s `navTab === 'studio'`
 * branch (plan §3.1 + §3.2). Does NOT render the main-app header/tab
 * strip — that chrome comes from the parent.
 *
 *   | Left rail (240) | Centre pane (chat) | Right rail (320) |
 *
 * - Left rail: Studio conversation list (migrated from /tuning queue).
 * - Centre: <StudioChat/>.
 * - Right rail: <StateSnapshotCard/> wired to the forced-first-turn
 *   `data-state-snapshot` part. Falls back to the `/api/build/tenant-state`
 *   response until the first agent turn fires.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { UIMessage } from 'ai'
import { toast } from 'sonner'
import {
  apiCreateTuningConversation,
  apiGetTuningConversation,
  apiListTuningConversations,
  apiPatchTuningConversation,
  isAuthenticated,
  type StudioStateMachineSnapshot,
  type TuningConversationAnchor,
  type TuningConversationMessage,
  type TuningConversationSummary,
} from '@/lib/api'
import {
  autoTitleFromFirstArtifact,
  autoTitleFromFirstMessage,
  isDefaultTitle,
  isFirstMessageTooShortForTitle,
} from './session-autoname'
import {
  apiGetBuildCapabilities,
  apiGetBuildTenantState,
  apiGetSessionArtifacts,
  BuildModeDisabledError,
  type BuildCapabilities,
  type BuildTenantState,
  type SessionArtifactRow,
  type TestPipelineResultData,
} from '@/lib/build-api'
import { BuildDisabled } from '@/components/build/build-disabled'
import { PropagationBanner } from '@/components/build/propagation-banner'
import { StudioChat } from './studio-chat'
import { StudioErrorBoundary } from './studio-error-boundary'
import { StateChip } from './state-chip'
import { StateSnapshotCard, type StateSnapshotData, type StateSnapshotSummary } from './state-snapshot'
import { WriteLedgerCard, ledgerArtifactType } from './write-ledger'
import {
  apiListBuildArtifactHistory,
  apiRevertArtifactFromHistory,
  type BuildArtifactHistoryRow,
} from '@/lib/build-api'
import { TraceDrawer } from './trace-drawer'
import { RawPromptDrawer } from './raw-prompt-drawer'
import {
  SessionArtifactsCard,
  upsertSessionArtifact,
  type SessionArtifact,
} from './session-artifacts'
import {
  ArtifactDrawer,
  type ArtifactDrawerTarget,
} from './artifact-drawer'
import { STUDIO_COLORS, STUDIO_TOKENS_V2 } from './tokens'
import { StudioShell } from './studio-shell'
import { TopBar } from './top-bar'
import { RightPanelTabs } from './right-panel-tabs'
import { PlanTab } from './tabs/plan-tab'
import { PreviewTab } from './tabs/preview-tab'
import { TestsTab } from './tabs/tests-tab'
import { LedgerTab } from './tabs/ledger-tab'
import { LeftRailV2 } from './left-rail'

export interface StudioSurfaceProps {
  /** Optional — sync the chosen conversation id back to the parent (URL). */
  conversationId: string | null
  onConversationChange?: (id: string | null) => void
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'disabled' }
  | { kind: 'unauthenticated' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready'
      tenantState: BuildTenantState
      conversationId: string
      initialMessages: UIMessage[]
      anchorMessage: TuningConversationAnchor | null
      // Sprint 060-C — present when GET returned the snapshot field.
      stateMachineSnapshot: StudioStateMachineSnapshot | null
    }

export function StudioSurface({ conversationId, onConversationChange }: StudioSurfaceProps) {
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' })
  const [snapshot, setSnapshot] = useState<StateSnapshotData | null>(null)
  const [showPropagationBanner, setShowPropagationBanner] = useState(false)
  const [testResults, setTestResults] = useState<TestPipelineResultData[]>([])
  const [capabilities, setCapabilities] = useState<BuildCapabilities>({
    traceViewEnabled: false,
    rawPromptEditorEnabled: false,
    isAdmin: false,
  })
  const [traceOpen, setTraceOpen] = useState(false)
  const [rawPromptOpen, setRawPromptOpen] = useState(false)
  // Sprint 050 A3 — session artifacts panel. Resets when conversationId
  // changes (handled automatically by the bootstrap effect's reload).
  const [sessionArtifacts, setSessionArtifacts] = useState<SessionArtifact[]>([])
  // Sprint 051 A B1 — unified artifact drawer state.
  const [artifactDrawer, setArtifactDrawer] = useState<{
    open: boolean
    target: ArtifactDrawerTarget | null
  }>({ open: false, target: null })
  // Sprint 053-A D4 — bumps to force the WriteLedgerCard to re-fetch
  // (after a successful Apply or Revert).
  const [ledgerRefreshKey, setLedgerRefreshKey] = useState(0)
  // Timestamp used by the drawer's "View changes" lookup — stable per
  // session, refreshed on conversationId change via the same bootstrap
  // reset that clears sessionArtifacts.
  const [sessionStartIso, setSessionStartIso] = useState<string>(() =>
    new Date().toISOString(),
  )
  // Element that held focus when the drawer opened, so we can restore
  // it on close. Brief §1.1: focus returned to the opener.
  const artifactDrawerOpenerRef = useRef<HTMLElement | null>(null)
  const bootstrapRef = useRef(false)
  // Bugfix (2026-04-23, React #185): the bootstrap effect below both
  // FETCHES the current conversation id (if provided) AND FALLS THROUGH
  // to CREATE a fresh one when the fetch fails. Combined with the
  // post-create `onConversationChange(selectedId)` — which flips the
  // prop and re-runs the effect — a transient fetch failure produced a
  // "create → prop-change → fetch fails → create" infinite loop that
  // React short-circuits as error #185.
  //
  // `createdIdsRef` remembers every conversation id this StudioSurface
  // instance has created. When the effect re-runs because we just
  // pushed an id via onConversationChange, we skip the fetch (we know
  // we just made it) AND we never create a second one in the same
  // mount. Cleared on unmount via the same bootstrapRef=false reset
  // that already fires on conversationId change.
  const createdIdsRef = useRef<Set<string>>(new Set())

  // Sprint 058-A F9f — session auto-naming state.
  //   currentTitleRef: title we last observed for the current session
  //     (initially the bootstrap default like "Studio session"). Null
  //     when no session is loaded yet.
  //   autoTitleSetRef: whether we've already auto-named this session.
  //     First-write wins — never overwrite once set.
  //   Both reset on conversationId change via the same effect that
  //   clears sessionArtifacts.
  const currentTitleRef = useRef<string | null>(null)
  const autoTitleSetRef = useRef<boolean>(false)

  // Fetch capabilities once on mount. Both flags default to false so a
  // failed fetch leaves the gear icon hidden — the safer direction.
  useEffect(() => {
    let cancelled = false
    apiGetBuildCapabilities()
      .then((caps) => {
        if (!cancelled) setCapabilities(caps)
      })
      .catch(() => {
        /* silent — stay on default (hidden) */
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Reset the bootstrap when the URL-driven conversation id changes so we
  // can rehydrate from the new row.
  useEffect(() => {
    bootstrapRef.current = false
    // Session artifacts are per-conversation — empty on switch.
    setSessionArtifacts([])
    // Sprint 051 A B2 — "this session" window restarts with the convo.
    setSessionStartIso(new Date().toISOString())
    // Sprint 058-A F9f — auto-naming state is per-session.
    currentTitleRef.current = null
    autoTitleSetRef.current = false
  }, [conversationId])

  useEffect(() => {
    if (bootstrapRef.current) return
    if (!isAuthenticated()) {
      setLoad({ kind: 'unauthenticated' })
      return
    }
    bootstrapRef.current = true

    let cancelled = false
    async function bootstrap() {
      setLoad({ kind: 'loading' })
      try {
        const tenantState = await apiGetBuildTenantState()

        let selectedId = conversationId
        let initialMessages: UIMessage[] = []
        let anchorMessage: TuningConversationAnchor | null = null
        let initialSnapshot: StudioStateMachineSnapshot | null = null

        if (selectedId) {
          // Bugfix (2026-04-23, React #185): if this id was created by a
          // prior bootstrap in THIS mount, the parent pushed it back to
          // us via onConversationChange and the effect re-ran. Skip the
          // fetch — we already know the body is empty — and go straight
          // to ready. Prevents the "fetch fails → create again" loop
          // when replication lag or an ephemeral 5xx makes the row
          // temporarily invisible.
          // Sprint 060-C — placeholder; the createdIds branch returns
          // immediately with a default snapshot below.
          if (createdIdsRef.current.has(selectedId)) {
            if (cancelled) return
            setLoad({
              kind: 'ready',
              tenantState,
              conversationId: selectedId,
              initialMessages: [],
              anchorMessage: null,
              stateMachineSnapshot: null,
            })
            return
          }
          try {
            const { conversation } = await apiGetTuningConversation(selectedId)
            initialMessages = rehydrate(conversation.messages)
            anchorMessage = conversation.anchorMessage
            // Sprint 060-C — pull the snapshot so the chip can paint on
            // initial load without waiting for the next turn's SSE.
            initialSnapshot = conversation.stateMachineSnapshot ?? null
            // F9f — remember the loaded title so we know whether to
            // auto-rename on first user message. Also treat it as
            // "already named" if it's non-default (operator edited).
            currentTitleRef.current = conversation.title ?? null
            if (!isDefaultTitle(conversation.title)) {
              autoTitleSetRef.current = true
            }
          } catch (err) {
            console.warn('[studio] conversation rehydrate failed:', err)
            // Surface the error instead of silently minting another
            // conversation — creating a fresh row here is exactly what
            // produced React #185. The manager can retry by hitting
            // "New session" or by navigating away and back, both of
            // which resolve through the left-rail list rather than
            // the failing id.
            const msg = err instanceof Error ? err.message : String(err)
            if (cancelled) return
            setLoad({ kind: 'error', message: `Couldn’t load conversation: ${msg}` })
            toast.error('Couldn’t load Studio conversation', { description: msg })
            return
          }
        }

        if (!selectedId) {
          const { conversation } = await apiCreateTuningConversation({
            triggerType: 'MANUAL',
            title: tenantState.isGreenfield ? 'Studio — initial setup' : 'Studio session',
          })
          selectedId = conversation.id
          createdIdsRef.current.add(selectedId)
          initialMessages = []
          // F9f — fresh session starts at the default title, so auto-naming
          // is free to overwrite on first intent.
          currentTitleRef.current = conversation.title ?? null
          autoTitleSetRef.current = false
          onConversationChange?.(selectedId)
        }

        if (cancelled) return
        setLoad({
          kind: 'ready',
          tenantState,
          conversationId: selectedId,
          initialMessages,
          anchorMessage,
          stateMachineSnapshot: initialSnapshot,
        })

        // Sprint 058-A F9d — hydrate the session-artifacts rail from the
        // server so a page reload doesn't blank the card. Fire-and-forget:
        // a failure here falls back to the empty-state render path that
        // the rail was already using pre-058. Never blocks Studio boot.
        apiGetSessionArtifacts(selectedId)
          .then((page) => {
            if (cancelled) return
            const seeded = sessionArtifactsFromApi(page.rows)
            if (seeded.length === 0) return
            // Merge in a way that doesn't stomp rows already upserted
            // between kind:'ready' and this fetch returning. Start from
            // the fresh list and let the existing upsert helper layer
            // any live-stream rows on top.
            setSessionArtifacts((prev) => {
              if (prev.length === 0) return seeded
              const next = [...seeded]
              for (const row of prev) {
                const idx = next.findIndex((r) => r.id === row.id)
                if (idx === -1) next.unshift(row)
                else next[idx] = row
              }
              return next
            })
          })
          .catch(() => {
            /* silent — rail stays on empty / current state */
          })
      } catch (err) {
        if (cancelled) return
        if (err instanceof BuildModeDisabledError) {
          setLoad({ kind: 'disabled' })
          return
        }
        const message = err instanceof Error ? err.message : String(err)
        setLoad({ kind: 'error', message })
        toast.error('Couldn’t load Studio', { description: message })
      }
    }

    bootstrap()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId])

  const handleStateSnapshot = useCallback((data: StateSnapshotData) => {
    setSnapshot(data)
  }, [])
  const handleTestResult = useCallback((data: TestPipelineResultData) => {
    setTestResults((prev) => [data, ...prev].slice(0, 3))
  }, [])
  const handlePlanApproved = useCallback(() => {
    setShowPropagationBanner(true)
  }, [])
  const handlePlanRolledBack = useCallback((transactionId: string) => {
    apiGetBuildTenantState()
      .then((next) => {
        setLoad((prev) => (prev.kind === 'ready' ? { ...prev, tenantState: next } : prev))
      })
      .catch(() => {
        /* stays on stale state — a reload will refresh */
      })
    // Flip any session artifacts that came from this transaction to
    // "reverted". We don't track transaction→artifact mapping locally,
    // so the safest thing is to mark every existing row as reverted
    // when the only plan just rolled back. A finer-grained fix lands
    // when Bundle B lifts the per-artifact tx id into the payload.
    setSessionArtifacts((prev) =>
      prev.map((a) =>
        a.id.startsWith(`tx:${transactionId}:`)
          ? {
              ...a,
              id: a.id,
              action: 'reverted',
              at: new Date().toISOString(),
            }
          : a,
      ),
    )
  }, [])
  const handleArtifactTouched = useCallback((next: SessionArtifact) => {
    setSessionArtifacts((prev) => upsertSessionArtifact(prev, next))
    // Sprint 058-A F9f step 2 — fallback auto-name: first artifact
    // touched becomes the session title when the first user message was
    // too short to title on. First-write wins.
    if (autoTitleSetRef.current) return
    if (load.kind !== 'ready') return
    if (!isDefaultTitle(currentTitleRef.current)) {
      autoTitleSetRef.current = true
      return
    }
    const title = autoTitleFromFirstArtifact({
      operation: next.action,
      artifactType: next.artifact,
      artifactName: next.title,
    })
    if (!title) return
    autoTitleSetRef.current = true
    currentTitleRef.current = title
    apiPatchTuningConversation(load.conversationId, { title }).catch(() => {
      // Silent — a failed rename is cosmetic; keep the cached title so
      // we don't retry-spam the endpoint this session.
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load])

  // Sprint 058-A F9f step 1 — on first substantive user message, auto-rename
  // the session. First-write wins; too-short messages fall through to the
  // artifact-based fallback in handleArtifactTouched.
  const handleUserMessageSent = useCallback(
    (text: string) => {
      if (autoTitleSetRef.current) return
      if (load.kind !== 'ready') return
      if (!isDefaultTitle(currentTitleRef.current)) {
        autoTitleSetRef.current = true
        return
      }
      if (isFirstMessageTooShortForTitle(text)) return
      const title = autoTitleFromFirstMessage(text)
      if (!title) return
      autoTitleSetRef.current = true
      currentTitleRef.current = title
      apiPatchTuningConversation(load.conversationId, { title }).catch(() => {
        // Silent — same rationale as handleArtifactTouched.
      })
    },
    [load],
  )

  const openArtifactDrawer = useCallback((target: ArtifactDrawerTarget) => {
    if (typeof document !== 'undefined') {
      artifactDrawerOpenerRef.current =
        (document.activeElement as HTMLElement | null) ?? null
    }
    setArtifactDrawer({ open: true, target })
  }, [])
  // 054-A F4 — open the drawer for a given history row id (used by the
  // test-pipeline-result source-write chip + ledger verdict chip).
  // Fetches the row via the rail endpoint, which already returns the full
  // row shape; drawer then renders the rationale + Verification section.
  const conversationIdForHistoryLookup =
    load.kind === 'ready' ? load.conversationId : undefined
  const openArtifactDrawerForHistoryId = useCallback(
    async (historyId: string) => {
      try {
        const page = await apiListBuildArtifactHistory({
          conversationId: conversationIdForHistoryLookup,
          limit: 50,
        })
        const row = page.rows.find((r) => r.id === historyId)
        if (!row) return
        setArtifactDrawer({
          open: true,
          target: {
            artifact: ledgerArtifactType(row.artifactType),
            artifactId: row.artifactId,
            historyRow: row,
            scrollToSection: 'verification',
          },
        })
      } catch {
        // Silent — user can click the ledger row directly as a fallback.
      }
    },
    [conversationIdForHistoryLookup],
  )
  const closeArtifactDrawer = useCallback(() => {
    setArtifactDrawer((prev) => ({ ...prev, open: false }))
    const opener = artifactDrawerOpenerRef.current
    if (opener && typeof opener.focus === 'function') {
      // Defer to avoid racing with the drawer's unmount focus churn.
      requestAnimationFrame(() => opener.focus())
    }
    artifactDrawerOpenerRef.current = null
  }, [])
  const openArtifactFromRow = useCallback(
    (a: SessionArtifact) => {
      openArtifactDrawer({
        artifact: a.artifact,
        artifactId: a.artifactId,
        sessionArtifact: a,
        isPending: false,
      })
    },
    [openArtifactDrawer],
  )
  // Sprint 051 A B3 — citation-chip click path. Same drawer target as
  // a row click, plus the optional `#section` fragment from the marker.
  const openArtifactFromCitation = useCallback(
    (
      artifact: SessionArtifact['artifact'],
      artifactId: string,
      section?: string | null,
    ) => {
      // If the session-artifacts rail already has this artifact, reuse
      // its record (carries the human title) so the drawer header
      // reads the same as a row click.
      const match = sessionArtifacts.find(
        (a) => a.artifact === artifact && a.artifactId === artifactId,
      )
      openArtifactDrawer({
        artifact,
        artifactId,
        sessionArtifact: match ?? null,
        isPending: false,
        scrollToSection: section ?? null,
      })
    },
    [openArtifactDrawer, sessionArtifacts],
  )

  if (load.kind === 'loading') {
    return (
      <div
        className="flex h-full items-center justify-center text-[12px]"
        style={{ color: STUDIO_COLORS.inkMuted, background: STUDIO_COLORS.canvas }}
      >
        Loading Studio…
      </div>
    )
  }
  if (load.kind === 'unauthenticated') {
    return (
      <div
        className="flex h-full items-center justify-center text-[12px]"
        style={{ color: STUDIO_COLORS.inkMuted, background: STUDIO_COLORS.canvas }}
      >
        You need to sign in to use Studio.
      </div>
    )
  }
  if (load.kind === 'disabled') {
    return <BuildDisabled />
  }
  if (load.kind === 'error') {
    return (
      <div
        className="flex h-full items-center justify-center px-6"
        style={{ background: STUDIO_COLORS.canvas }}
      >
        <div
          className="max-w-md rounded-md border-l-2 px-3 py-2 text-[12px]"
          style={{
            background: STUDIO_COLORS.dangerBg,
            borderLeftColor: STUDIO_COLORS.dangerFg,
            color: STUDIO_COLORS.dangerFg,
          }}
        >
          {load.message}
        </div>
      </div>
    )
  }

  const { tenantState } = load
  const effectiveSnapshot: StateSnapshotData =
    snapshot ?? deriveSnapshotFromTenantState(tenantState)

  // Sprint 046 T010 — new StudioShell wraps the three-pane layout. All
  // existing bootstrap state (load, capabilities, drawers, auto-naming,
  // createdIdsRef loop-guard, etc.) remains in this component; the
  // shell renders its leftRail / rightPanel / drawers slots from the
  // same LeftRail / RightRail / *Drawer components that used to be
  // siblings inside the old tree. Feature parity first — the legacy
  // LeftRail and RightRail mounts stay until their Phase-5 / Phase-4
  // replacements land (T033 / T026).

  return (
    <StudioShell
      tenantName={'Studio'}
      tenantState={tenantState}
      conversationId={load.conversationId}
      capabilities={capabilities}
      onRunPreview={(text) => {
        // Sprint 046 bug-fix — route shell.runPreview through the real
        // chat pipeline so the build agent actually receives the test
        // request. Previously unwired, which silently failed every
        // Preview tab Send / composer Test chip / Tests tab Re-run.
        if (typeof window === 'undefined') return
        window.dispatchEvent(
          new CustomEvent('studio:send-message', { detail: { text } }),
        )
      }}
      onReferencePicked={(ref) => {
        // Sprint 046 T013 — emit a window event the composer listens
        // for. The composer appends the citation marker to its draft.
        const marker = `{{cite:${ref.kind}:${ref.id}}}`
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('studio:composer-insert', { detail: { text: marker } }),
          )
        }
      }}
      topBar={
        <TopBar
          tenantName={'Studio'}
          sessionTitle={currentTitleRef.current ?? 'Studio session'}
          rightSlot={
            <StateChip
              conversationId={load.conversationId}
              snapshot={load.stateMachineSnapshot}
              onSnapshotChange={(next) =>
                setLoad((prev) =>
                  prev.kind === 'ready'
                    ? { ...prev, stateMachineSnapshot: next }
                    : prev,
                )
              }
            />
          }
        />
      }
      leftRail={
        <LeftRailV2
          tenantName={tenantState.isGreenfield ? 'Studio' : 'Workspace'}
          propertyCount={tenantState.propertyCount}
          selectedId={load.conversationId}
          onSelect={(id) => onConversationChange?.(id)}
        />
      }
      banner={
        showPropagationBanner ? (
          <div
            className="border-b px-5 py-2"
            style={{
              borderColor: STUDIO_COLORS.hairlineSoft,
              background: STUDIO_COLORS.surfaceRaised,
            }}
          >
            <PropagationBanner onDismiss={() => setShowPropagationBanner(false)} />
          </div>
        ) : null
      }
      rightPanel={
        <RightPanelTabs
          isAdmin={capabilities.isAdmin}
          rawPromptEditorEnabled={Boolean(capabilities.rawPromptEditorEnabled)}
          planPanel={
            <PlanTab
              snapshot={effectiveSnapshot}
              sessionArtifacts={sessionArtifacts}
              onOpenArtifact={openArtifactFromRow}
            />
          }
          previewPanel={<PreviewTab />}
          testsPanel={<TestsTab />}
          ledgerPanel={
            <LedgerTab
              conversationId={load.conversationId}
              refreshKey={ledgerRefreshKey}
              onOpenRow={(row: BuildArtifactHistoryRow) => {
                setArtifactDrawer({
                  open: true,
                  target: {
                    artifact: ledgerArtifactType(row.artifactType),
                    artifactId: row.artifactId,
                    historyRow: row,
                  },
                })
              }}
              onRevertRow={async (row: BuildArtifactHistoryRow) => {
                // Two-step: dry-run preview, then native confirm before commit.
                try {
                  const preview = await apiRevertArtifactFromHistory(row.id, {
                    dryRun: true,
                  })
                  if (!preview.ok) {
                    alert(`Revert preview failed: ${preview.error ?? 'unknown'}`)
                    return
                  }
                  const proceed = window.confirm(
                    `Revert ${row.artifactType} "${row.artifactId}" to its pre-write state? This writes a REVERT row to the ledger.`,
                  )
                  if (!proceed) return
                  const result = await apiRevertArtifactFromHistory(row.id, {
                    dryRun: false,
                  })
                  if (!result.ok) {
                    alert(`Revert failed: ${result.error ?? 'unknown'}`)
                    return
                  }
                  setLedgerRefreshKey((k) => k + 1)
                } catch (err) {
                  alert(
                    `Revert error: ${err instanceof Error ? err.message : String(err)}`,
                  )
                }
              }}
            />
          }
          utilityFooter={
            capabilities.isAdmin && (capabilities.traceViewEnabled || capabilities.rawPromptEditorEnabled) ? (
              <>
                {capabilities.traceViewEnabled ? (
                  <button
                    type="button"
                    onClick={() => setTraceOpen(true)}
                    aria-label="Open agent trace (admin)"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      width: '100%',
                      padding: '6px 10px',
                      fontSize: 11,
                      fontWeight: 500,
                      border: `1px solid ${STUDIO_TOKENS_V2.border}`,
                      background: STUDIO_TOKENS_V2.bg,
                      color: STUDIO_TOKENS_V2.muted,
                      borderRadius: STUDIO_TOKENS_V2.radiusSm,
                      cursor: 'pointer',
                    }}
                  >
                    Agent trace
                  </button>
                ) : null}
                {capabilities.rawPromptEditorEnabled ? (
                  <button
                    type="button"
                    onClick={() => setRawPromptOpen(true)}
                    aria-label="Open raw system prompt (admin)"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      width: '100%',
                      padding: '6px 10px',
                      fontSize: 11,
                      fontWeight: 500,
                      border: `1px solid ${STUDIO_TOKENS_V2.border}`,
                      background: STUDIO_TOKENS_V2.bg,
                      color: STUDIO_TOKENS_V2.muted,
                      borderRadius: STUDIO_TOKENS_V2.radiusSm,
                      cursor: 'pointer',
                    }}
                  >
                    Raw system prompt
                  </button>
                ) : null}
              </>
            ) : undefined
          }
        />
      }
      drawers={
        <>
          <TraceDrawer
            open={traceOpen}
            onClose={() => setTraceOpen(false)}
            conversationId={load.conversationId}
          />
          <RawPromptDrawer
            open={rawPromptOpen}
            onClose={() => setRawPromptOpen(false)}
            conversationId={load.conversationId}
          />
          <ArtifactDrawer
            open={artifactDrawer.open}
            target={artifactDrawer.target}
            onClose={closeArtifactDrawer}
            isAdmin={capabilities.isAdmin}
            traceViewEnabled={capabilities.traceViewEnabled}
            rawPromptEditorEnabled={Boolean(capabilities.rawPromptEditorEnabled)}
            sessionStartIso={sessionStartIso}
          />
        </>
      }
    >
      {/* Sprint 058-A F9a — catch render errors inside StudioChat so the
          whole Studio surface never blanks out. The boundary's recovery
          card is itself a graceful-degradation surface (spec §1). */}
      <StudioErrorBoundary>
        <StudioChat
          conversationId={load.conversationId}
          greenfield={tenantState.isGreenfield}
          initialMessages={load.initialMessages}
          anchorMessage={load.anchorMessage}
          onStateSnapshot={handleStateSnapshot}
          onTestResult={handleTestResult}
          onStateMachineSnapshot={(next) =>
            setLoad((prev) =>
              prev.kind === 'ready' ? { ...prev, stateMachineSnapshot: next } : prev,
            )
          }
          onPlanApproved={handlePlanApproved}
          onPlanRolledBack={handlePlanRolledBack}
          onArtifactTouched={handleArtifactTouched}
          onOpenArtifact={openArtifactFromCitation}
          isAdmin={capabilities.isAdmin}
          traceViewEnabled={capabilities.traceViewEnabled}
          onOpenVerificationForHistoryId={openArtifactDrawerForHistoryId}
          onUserMessageSent={handleUserMessageSent}
          tenantState={tenantState}
          onOpenPrompt={
            capabilities.isAdmin && capabilities.rawPromptEditorEnabled
              ? () => setRawPromptOpen(true)
              : undefined
          }
        />
      </StudioErrorBoundary>
    </StudioShell>
  )
}


// ─── Helpers ───────────────────────────────────────────────────────────────

function rehydrate(rows: TuningConversationMessage[]): UIMessage[] {
  return rows
    .filter((r) => r.role === 'user' || r.role === 'assistant')
    .map((r) => {
      const parts = Array.isArray(r.parts) ? r.parts : []
      return {
        id: r.id,
        role: r.role as 'user' | 'assistant',
        parts,
      } as unknown as UIMessage
    })
}

/**
 * Sprint 058-A F9d — map the server's BuildArtifactHistory-backed rows
 * into the client-side SessionArtifact shape the rail renders. The
 * server emits one row per write; we collapse duplicates (same
 * artifactType+artifactId) by keeping the newest.
 *
 * Graceful degradation: unknown artifact types map to null and are
 * dropped. An empty array produces an empty rail (no-op).
 */
function sessionArtifactsFromApi(rows: SessionArtifactRow[]): SessionArtifact[] {
  const out: SessionArtifact[] = []
  const seen = new Set<string>()
  // Rows arrive newest-first from the server — keep that order.
  for (const row of rows) {
    const artifact = mapApiArtifactType(row.artifactType)
    if (!artifact) continue
    const id = `hydrate:${artifact}:${row.artifactId}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      artifact,
      artifactId: row.artifactId,
      title: mapApiArtifactTitle(artifact, row.artifactId),
      action: mapApiArtifactAction(row.operation),
      at: row.touchedAt,
    })
  }
  return out
}

function mapApiArtifactType(
  raw: SessionArtifactRow['artifactType'],
): SessionArtifact['artifact'] | null {
  if (raw === 'sop') return 'sop'
  if (raw === 'faq') return 'faq'
  if (raw === 'system_prompt') return 'system_prompt'
  if (raw === 'tool' || raw === 'tool_definition') return 'tool'
  if (raw === 'property_override') return 'property_override'
  return null
}

function mapApiArtifactAction(
  op: SessionArtifactRow['operation'],
): SessionArtifact['action'] {
  if (op === 'CREATE') return 'created'
  if (op === 'REVERT') return 'reverted'
  return 'modified'
}

function mapApiArtifactTitle(
  artifact: SessionArtifact['artifact'],
  artifactId: string,
): string {
  const short = artifactId.length > 24 ? `${artifactId.slice(0, 21)}…` : artifactId
  switch (artifact) {
    case 'sop':
      return `SOP · ${short}`
    case 'faq':
      return `FAQ · ${short}`
    case 'system_prompt':
      return `Prompt · ${short}`
    case 'tool':
      return `Tool · ${short}`
    case 'property_override':
      return `Property · ${short}`
  }
}

/** Fallback StateSnapshotData derived from /api/build/tenant-state when
 *  the agent hasn't yet emitted `data-state-snapshot`.
 *
 *  Bugfix (2026-04-23): the right-rail CURRENT STATE card was reporting
 *  "System prompt — Empty" on every fresh Studio mount because this
 *  adapter hardcoded `systemPromptStatus: 'EMPTY'` + `sopsDefaulted: 0`
 *  regardless of the tenant's real state. The earlier service-level
 *  fix populated `BuildTenantState.systemPromptStatus` /
 *  `systemPromptEditCount` / `sopsDefaulted` on the wire (commit
 *  2b24007), but this adapter was never updated to read them. Now
 *  prefers the live wire fields and falls back to the stale defaults
 *  ONLY if a pre-fix backend is responding.
 */
function deriveSnapshotFromTenantState(ts: BuildTenantState): StateSnapshotData {
  const summary: StateSnapshotSummary = {
    posture: ts.isGreenfield ? 'GREENFIELD' : 'BROWNFIELD',
    systemPromptStatus: ts.systemPromptStatus ?? 'EMPTY',
    systemPromptEditCount: ts.systemPromptEditCount ?? 0,
    sopsDefined: ts.sopCount,
    sopsDefaulted: ts.sopsDefaulted ?? 0,
    faqsGlobal: ts.faqCounts.global,
    faqsPropertyScoped: ts.faqCounts.perProperty,
    customToolsDefined: ts.customToolCount,
    propertiesImported: ts.propertyCount,
    lastBuildSessionAt: ts.lastBuildTransaction?.createdAt ?? null,
  }
  return { scope: 'summary', summary }
}
