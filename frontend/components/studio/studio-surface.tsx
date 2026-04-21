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
  isAuthenticated,
  type TuningConversationMessage,
  type TuningConversationSummary,
} from '@/lib/api'
import {
  apiGetBuildCapabilities,
  apiGetBuildTenantState,
  BuildModeDisabledError,
  type BuildCapabilities,
  type BuildTenantState,
  type TestPipelineResultData,
} from '@/lib/build-api'
import { BuildDisabled } from '@/components/build/build-disabled'
import { PropagationBanner } from '@/components/build/propagation-banner'
import { StudioChat } from './studio-chat'
import { StateSnapshotCard, type StateSnapshotData, type StateSnapshotSummary } from './state-snapshot'
import { TraceDrawer } from './trace-drawer'
import { RawPromptDrawer } from './raw-prompt-drawer'
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
  const bootstrapRef = useRef(false)

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
          onConversationChange?.(selectedId)
        }

        if (cancelled) return
        setLoad({
          kind: 'ready',
          tenantState,
          conversationId: selectedId,
          initialMessages,
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
  const handlePlanRolledBack = useCallback(() => {
    apiGetBuildTenantState()
      .then((next) => {
        setLoad((prev) => (prev.kind === 'ready' ? { ...prev, tenantState: next } : prev))
      })
      .catch(() => {
        /* stays on stale state — a reload will refresh */
      })
  }, [])

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
          <StudioChat
            conversationId={load.conversationId}
            greenfield={tenantState.isGreenfield}
            initialMessages={load.initialMessages}
            onStateSnapshot={handleStateSnapshot}
            onTestResult={handleTestResult}
            onPlanApproved={handlePlanApproved}
            onPlanRolledBack={handlePlanRolledBack}
          />
        </div>
      </main>

      <RightRail
        snapshot={effectiveSnapshot}
        testResults={testResults}
        traceButtonVisible={capabilities.traceViewEnabled && capabilities.isAdmin}
        onOpenTrace={() => setTraceOpen(true)}
        rawPromptButtonVisible={
          Boolean(capabilities.rawPromptEditorEnabled) && capabilities.isAdmin
        }
        onOpenRawPrompt={() => setRawPromptOpen(true)}
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
        {items.map((c) => {
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
    </aside>
  )
}

// ─── Right rail: state snapshot + latest test results ──────────────────────

function RightRail({
  snapshot,
  testResults,
  traceButtonVisible,
  onOpenTrace,
  rawPromptButtonVisible,
  onOpenRawPrompt,
}: {
  snapshot: StateSnapshotData
  testResults: TestPipelineResultData[]
  traceButtonVisible: boolean
  onOpenTrace: () => void
  rawPromptButtonVisible: boolean
  onOpenRawPrompt: () => void
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
      {testResults.length > 0 && (
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
          <div className="text-[12px]" style={{ color: STUDIO_COLORS.ink }}>
            {testResults[0].reply.slice(0, 140)}
            {testResults[0].reply.length > 140 ? '…' : ''}
          </div>
          <div
            className="mt-1 text-[10.5px]"
            style={{ color: STUDIO_COLORS.inkSubtle }}
          >
            Judge score{' '}
            <strong style={{ color: STUDIO_COLORS.ink }}>
              {testResults[0].judgeScore.toFixed(2)}
            </strong>{' '}
            · {testResults[0].latencyMs}ms
          </div>
        </div>
      )}
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
