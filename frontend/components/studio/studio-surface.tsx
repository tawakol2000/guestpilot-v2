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
import { STUDIO_COLORS } from './tokens'

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

        if (selectedId) {
          try {
            const { conversation } = await apiGetTuningConversation(selectedId)
            initialMessages = rehydrate(conversation.messages)
            // F9f — remember the loaded title so we know whether to
            // auto-rename on first user message. Also treat it as
            // "already named" if it's non-default (operator edited).
            currentTitleRef.current = conversation.title ?? null
            if (!isDefaultTitle(conversation.title)) {
              autoTitleSetRef.current = true
            }
          } catch (err) {
            console.warn('[studio] conversation rehydrate failed, creating fresh:', err)
            selectedId = null
          }
        }

        if (!selectedId) {
          const { conversation } = await apiCreateTuningConversation({
            triggerType: 'MANUAL',
            title: tenantState.isGreenfield ? 'Studio — initial setup' : 'Studio session',
          })
          selectedId = conversation.id
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

  return (
    <div
      className="flex min-h-0 flex-1"
      style={{ background: STUDIO_COLORS.canvas, overflow: 'hidden' }}
    >
      <LeftRail
        selectedId={load.conversationId}
        onSelect={(id) => onConversationChange?.(id)}
      />

      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {showPropagationBanner ? (
          <div
            className="border-b px-5 py-2"
            style={{
              borderColor: STUDIO_COLORS.hairlineSoft,
              background: STUDIO_COLORS.surfaceRaised,
            }}
          >
            <PropagationBanner onDismiss={() => setShowPropagationBanner(false)} />
          </div>
        ) : null}
        <div className="min-h-0 flex-1">
          {/* Sprint 058-A F9a — catch render errors inside StudioChat so the
              whole Studio surface never blanks out. The boundary's recovery
              card is itself a graceful-degradation surface (spec §1). */}
          <StudioErrorBoundary>
            <StudioChat
              conversationId={load.conversationId}
              greenfield={tenantState.isGreenfield}
              initialMessages={load.initialMessages}
              onStateSnapshot={handleStateSnapshot}
              onTestResult={handleTestResult}
              onPlanApproved={handlePlanApproved}
              onPlanRolledBack={handlePlanRolledBack}
              onArtifactTouched={handleArtifactTouched}
              onOpenArtifact={openArtifactFromCitation}
              isAdmin={capabilities.isAdmin}
              traceViewEnabled={capabilities.traceViewEnabled}
              onOpenVerificationForHistoryId={openArtifactDrawerForHistoryId}
              onUserMessageSent={handleUserMessageSent}
            />
          </StudioErrorBoundary>
        </div>
      </main>

      <RightRail
        snapshot={effectiveSnapshot}
        testResults={testResults}
        sessionArtifacts={sessionArtifacts}
        onOpenArtifact={openArtifactFromRow}
        traceButtonVisible={capabilities.traceViewEnabled && capabilities.isAdmin}
        onOpenTrace={() => setTraceOpen(true)}
        rawPromptButtonVisible={
          Boolean(capabilities.rawPromptEditorEnabled) && capabilities.isAdmin
        }
        onOpenRawPrompt={() => setRawPromptOpen(true)}
        ledgerVisible={
          Boolean(capabilities.rawPromptEditorEnabled) && capabilities.isAdmin
        }
        ledgerConversationId={load.conversationId}
        ledgerRefreshKey={ledgerRefreshKey}
        onOpenLedgerRow={(row: BuildArtifactHistoryRow) => {
          // 054-A F2 — carry the full history row so the drawer can
          // render the rationale card above the diff when opened from
          // the ledger rail. Non-ledger opens (session-artifacts rail,
          // deep links) do NOT pass historyRow, so the drawer stays
          // clean in its normal read mode.
          setArtifactDrawer({
            open: true,
            target: {
              artifact: ledgerArtifactType(row.artifactType),
              artifactId: row.artifactId,
              historyRow: row,
            },
          })
        }}
        onRevertLedgerRow={async (row: BuildArtifactHistoryRow) => {
          // Two-step: dry-run preview, then native confirm before commit.
          // 054-A polish: in-drawer "Preview Revert + Confirm Revert" UI.
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
    </div>
  )
}

// ─── Left rail: Studio conversation list ───────────────────────────────────

function LeftRail({
  selectedId,
  onSelect,
}: {
  selectedId: string
  onSelect: (id: string) => void
}) {
  const [items, setItems] = useState<TuningConversationSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Sprint 058-A F9f step 3 — hide zero-message sessions older than 1h
  // by default so the sidebar stops reading as a graveyard of empty
  // rows. Operator can flip this to show them via the toggle.
  const [showEmpty, setShowEmpty] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await apiListTuningConversations({ limit: 30 })
      setItems(res.conversations)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // F9f — empty-session filter. Hide messageCount===0 rows older than
  // 1h unless the operator flipped the toggle. Also always show the
  // currently-selected session so the operator never "loses" their
  // active context to a filter.
  const ONE_HOUR_MS = 60 * 60 * 1000
  const now = Date.now()
  const visibleItems = showEmpty
    ? items
    : items.filter((c) => {
        if (c.id === selectedId) return true
        if (c.messageCount > 0) return true
        const createdAt = Date.parse(c.createdAt)
        if (!Number.isFinite(createdAt)) return true
        return now - createdAt < ONE_HOUR_MS
      })
  const hiddenCount = items.length - visibleItems.length

  async function startNew() {
    try {
      const { conversation } = await apiCreateTuningConversation({
        triggerType: 'MANUAL',
        title: 'Studio session',
      })
      setItems((list) => [
        {
          id: conversation.id,
          title: conversation.title,
          anchorMessageId: null,
          triggerType: conversation.triggerType,
          status: 'OPEN',
          messageCount: 0,
          createdAt: conversation.createdAt,
          updatedAt: conversation.createdAt,
        },
        ...list,
      ])
      onSelect(conversation.id)
    } catch (err) {
      toast.error('Couldn’t start a new Studio session', {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return (
    <aside
      className="flex flex-col border-r"
      style={{
        width: 240,
        minWidth: 240,
        borderColor: STUDIO_COLORS.hairline,
        background: STUDIO_COLORS.surfaceRaised,
      }}
    >
      <header
        className="flex items-center justify-between border-b px-3 py-2"
        style={{ borderColor: STUDIO_COLORS.hairlineSoft }}
      >
        <span
          className="text-[11px] font-semibold uppercase tracking-wide"
          style={{ color: STUDIO_COLORS.inkMuted }}
        >
          Sessions
        </span>
        <button
          type="button"
          onClick={startNew}
          className="rounded border px-2 py-0.5 text-[11px] font-medium"
          style={{
            borderColor: STUDIO_COLORS.hairline,
            background: STUDIO_COLORS.surfaceRaised,
            color: STUDIO_COLORS.ink,
          }}
        >
          New
        </button>
      </header>
      <ul className="flex-1 overflow-auto py-1">
        {loading && items.length === 0 ? (
          <li
            className="px-3 py-2 text-[11px]"
            style={{ color: STUDIO_COLORS.inkSubtle }}
          >
            Loading…
          </li>
        ) : null}
        {error ? (
          <li className="px-3 py-2 text-[11px]" style={{ color: STUDIO_COLORS.dangerFg }}>
            {error}
          </li>
        ) : null}
        {!loading && !error && items.length === 0 ? (
          <li className="px-3 py-2 text-[11px]" style={{ color: STUDIO_COLORS.inkSubtle }}>
            No sessions yet.
          </li>
        ) : null}
        {visibleItems.map((c) => {
          const active = c.id === selectedId
          return (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onSelect(c.id)}
                className="flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left"
                style={{
                  background: active ? STUDIO_COLORS.accentSoft : 'transparent',
                  color: STUDIO_COLORS.ink,
                  borderLeft: active
                    ? `2px solid ${STUDIO_COLORS.accent}`
                    : '2px solid transparent',
                }}
              >
                <span className="line-clamp-1 text-[12px] font-medium">
                  {c.title || 'Untitled session'}
                </span>
                <span className="text-[10.5px]" style={{ color: STUDIO_COLORS.inkSubtle }}>
                  {c.messageCount} message{c.messageCount === 1 ? '' : 's'}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {/* Sprint 058-A F9f — "Show empty sessions" toggle. Only renders
          when there is at least one hidden session, so the control doesn't
          clutter the rail for users who don't have the problem. */}
      {(hiddenCount > 0 || showEmpty) && (
        <footer
          className="border-t px-3 py-2"
          style={{ borderColor: STUDIO_COLORS.hairlineSoft }}
        >
          <label
            className="flex items-center gap-2 text-[11px]"
            style={{ color: STUDIO_COLORS.inkMuted, cursor: 'pointer' }}
          >
            <input
              type="checkbox"
              data-testid="show-empty-sessions-toggle"
              checked={showEmpty}
              onChange={(e) => setShowEmpty(e.target.checked)}
            />
            Show empty sessions
            {!showEmpty && hiddenCount > 0 ? (
              <span
                className="ml-auto text-[10.5px]"
                style={{ color: STUDIO_COLORS.inkSubtle }}
              >
                {hiddenCount} hidden
              </span>
            ) : null}
          </label>
        </footer>
      )}
    </aside>
  )
}

// ─── Right rail: state snapshot + latest test results ──────────────────────

function RightRail({
  snapshot,
  testResults,
  sessionArtifacts,
  onOpenArtifact,
  traceButtonVisible,
  onOpenTrace,
  rawPromptButtonVisible,
  onOpenRawPrompt,
  ledgerVisible,
  ledgerConversationId,
  ledgerRefreshKey,
  onOpenLedgerRow,
  onRevertLedgerRow,
}: {
  snapshot: StateSnapshotData
  testResults: TestPipelineResultData[]
  sessionArtifacts: SessionArtifact[]
  onOpenArtifact: (a: SessionArtifact) => void
  traceButtonVisible: boolean
  onOpenTrace: () => void
  rawPromptButtonVisible: boolean
  onOpenRawPrompt: () => void
  ledgerVisible: boolean
  ledgerConversationId: string | null
  ledgerRefreshKey: number
  onOpenLedgerRow: (row: BuildArtifactHistoryRow) => void
  onRevertLedgerRow: (row: BuildArtifactHistoryRow) => void
}) {
  return (
    <aside
      className="flex flex-col gap-3 border-l overflow-auto"
      style={{
        width: 320,
        minWidth: 320,
        borderColor: STUDIO_COLORS.hairline,
        background: STUDIO_COLORS.surfaceSunken,
        padding: 14,
      }}
    >
      <StateSnapshotCard data={snapshot} />
      <SessionArtifactsCard
        artifacts={sessionArtifacts}
        onOpen={onOpenArtifact}
      />
      {testResults.length > 0 && (() => {
        const latest = testResults[0]
        const variants = Array.isArray(latest.variants) ? latest.variants : []
        const firstVariant = variants[0]
        if (!firstVariant) return null
        const passed = variants.filter((v) => v.verdict === 'passed').length
        return (
          <div
            className="rounded-md border bg-white p-3"
            style={{ borderColor: STUDIO_COLORS.hairline }}
          >
            <div
              className="mb-2 text-[11px] font-semibold uppercase tracking-wide"
              style={{ color: STUDIO_COLORS.inkMuted }}
            >
              Recent test
            </div>
            <div
              className="mb-1 text-[12px] font-semibold"
              style={{
                color:
                  latest.aggregateVerdict === 'all_passed'
                    ? STUDIO_COLORS.successFg
                    : STUDIO_COLORS.warnFg,
              }}
            >
              {passed}/{variants.length} passed
            </div>
            <div className="text-[12px]" style={{ color: STUDIO_COLORS.ink }}>
              {firstVariant.pipelineOutput.slice(0, 140)}
              {firstVariant.pipelineOutput.length > 140 ? '…' : ''}
            </div>
            <div
              className="mt-1 text-[10.5px]"
              style={{ color: STUDIO_COLORS.inkSubtle }}
            >
              {firstVariant.latencyMs}ms · {firstVariant.replyModel}
            </div>
          </div>
        )
      })()}
      <WriteLedgerCard
        visible={ledgerVisible}
        conversationId={ledgerConversationId}
        refreshKey={ledgerRefreshKey}
        onOpenRow={onOpenLedgerRow}
        onRevertRow={onRevertLedgerRow}
      />
      {traceButtonVisible || rawPromptButtonVisible ? (
        <div
          style={{
            marginTop: 'auto',
            paddingTop: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {traceButtonVisible ? (
            <button
              type="button"
              onClick={onOpenTrace}
              aria-label="Open agent trace (admin)"
              title="Agent trace (admin)"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                width: '100%',
                padding: '6px 10px',
                fontSize: 11,
                fontWeight: 500,
                border: `1px solid ${STUDIO_COLORS.hairline}`,
                background: STUDIO_COLORS.surfaceRaised,
                color: STUDIO_COLORS.inkMuted,
                borderRadius: 5,
                cursor: 'pointer',
              }}
            >
              <GearIcon />
              <span>Agent trace</span>
            </button>
          ) : null}
          {rawPromptButtonVisible ? (
            <button
              type="button"
              onClick={onOpenRawPrompt}
              aria-label="Open raw system prompt (admin)"
              title="Raw system prompt (admin)"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                width: '100%',
                padding: '6px 10px',
                fontSize: 11,
                fontWeight: 500,
                border: `1px solid ${STUDIO_COLORS.hairline}`,
                background: STUDIO_COLORS.surfaceRaised,
                color: STUDIO_COLORS.inkMuted,
                borderRadius: 5,
                cursor: 'pointer',
              }}
            >
              <GearIcon />
              <span>Raw system prompt</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </aside>
  )
}

function GearIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
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
 *  the agent hasn't yet emitted `data-state-snapshot`. */
function deriveSnapshotFromTenantState(ts: BuildTenantState): StateSnapshotData {
  const summary: StateSnapshotSummary = {
    posture: ts.isGreenfield ? 'GREENFIELD' : 'BROWNFIELD',
    systemPromptStatus: 'EMPTY',
    systemPromptEditCount: 0,
    sopsDefined: ts.sopCount,
    sopsDefaulted: 0,
    faqsGlobal: ts.faqCounts.global,
    faqsPropertyScoped: ts.faqCounts.perProperty,
    customToolsDefined: ts.customToolCount,
    propertiesImported: ts.propertyCount,
    lastBuildSessionAt: ts.lastBuildTransaction?.createdAt ?? null,
  }
  return { scope: 'summary', summary }
}
