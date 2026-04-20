'use client'

/**
 * Sprint 045 Gate 6 — /build page.
 *
 * Three-pane layout matching specs/045-build-mode/ui-mockup.html:
 *   - Activity bar (56px) · Left rail (288px) · Chat (flex) · Preview (440px)
 *
 * On mount:
 *   1. GET /api/build/tenant-state → decides GREENFIELD vs BROWNFIELD vs
 *      disabled (404).
 *   2. Create (or reuse) a TuningConversation row so POST /api/build/turn
 *      has a row to write messages into. We persist the conversation id in
 *      the URL so reloads resume.
 *   3. Rehydrate prior turns via the existing /api/tuning/conversations/:id
 *      endpoint. Messages in BUILD are stored in the same table as /tuning
 *      (spec §9) — the controller writes there today.
 *
 * The palette is inherited verbatim from components/tuning/tokens.ts per
 * the session-5 hard constraint.
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import type { UIMessage } from 'ai'
import {
  Bell,
  Home,
  Inbox,
  LayoutGrid,
  MessageSquare,
  Plus,
  Settings,
} from 'lucide-react'
import {
  apiCreateTuningConversation,
  apiGetTuningConversation,
  getTenantMeta,
  isAuthenticated,
  type TuningConversationMessage,
} from '@/lib/api'
import { toast } from 'sonner'
import {
  apiGetBuildTenantState,
  BuildModeDisabledError,
  type BuildTenantState,
  type TestPipelineResultData,
} from '@/lib/build-api'
import { TUNING_COLORS } from '@/components/tuning/tokens'
import { BuildDisabled } from '@/components/build/build-disabled'
import { BuildChat } from '@/components/build/build-chat'
import { TestPipelineResult } from '@/components/build/test-pipeline-result'
import { SetupProgress } from '@/components/build/setup-progress'
import { TransactionHistory } from '@/components/build/transaction-history'
import { PropagationBanner } from '@/components/build/propagation-banner'
import { BuildPageSkeleton } from '@/components/build/page-skeleton'

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

function BuildPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const urlConversationId = searchParams.get('conversationId')

  const [load, setLoad] = useState<LoadState>({ kind: 'loading' })
  const [testResults, setTestResults] = useState<TestPipelineResultData[]>([])
  const [showPropagationBanner, setShowPropagationBanner] = useState(false)
  const bootstrapOnceRef = useRef(false)

  // Auth-gate locally rather than wrapping with a separate component.
  // Matches /tuning's pattern.
  useEffect(() => {
    if (!isAuthenticated()) {
      setLoad({ kind: 'unauthenticated' })
      router.replace('/login')
    }
  }, [router])

  const setConversationInUrl = useCallback(
    (id: string) => {
      const qs = new URLSearchParams(Array.from(searchParams.entries()))
      qs.set('conversationId', id)
      router.replace(`/build?${qs.toString()}`, { scroll: false })
    },
    [router, searchParams],
  )

  useEffect(() => {
    if (bootstrapOnceRef.current) return
    if (!isAuthenticated()) return
    bootstrapOnceRef.current = true

    let cancelled = false

    async function bootstrap() {
      try {
        const tenantState = await apiGetBuildTenantState()

        // Resolve conversation id: reuse the one from the URL, or create
        // a fresh TuningConversation and push it to the URL.
        let conversationId = urlConversationId
        let initialMessages: UIMessage[] = []

        if (conversationId) {
          try {
            const { conversation } = await apiGetTuningConversation(conversationId)
            initialMessages = rehydrate(conversation.messages)
          } catch (err) {
            // If the URL conversationId is stale/wrong tenant, fall back
            // to creating a new one rather than blocking.
            console.warn('[build] conversation rehydrate failed, creating fresh:', err)
            conversationId = null
          }
        }

        if (!conversationId) {
          const { conversation } = await apiCreateTuningConversation({
            triggerType: 'MANUAL',
            title: tenantState.isGreenfield
              ? 'Build — initial setup'
              : 'Build session',
          })
          conversationId = conversation.id
          initialMessages = []
        }

        if (cancelled) return
        setLoad({
          kind: 'ready',
          tenantState,
          conversationId,
          initialMessages,
        })

        // Only push to the URL after the first successful bootstrap so a
        // reload resumes the same conversation.
        if (!urlConversationId && conversationId) {
          setConversationInUrl(conversationId)
        }
      } catch (err) {
        if (cancelled) return
        if (err instanceof BuildModeDisabledError) {
          setLoad({ kind: 'disabled' })
          return
        }
        const message = err instanceof Error ? err.message : String(err)
        toast.error('Couldn’t load tenant state', {
          description: message,
          action: {
            label: 'Retry',
            onClick: () => {
              bootstrapOnceRef.current = false
              setLoad({ kind: 'loading' })
              setTimeout(() => {
                // Re-run bootstrap by flipping the ref + forcing a rerender
                // via setLoad above; the effect re-fires when bootstrapOnce
                // is reset. React won't re-trigger the effect on its own,
                // so we call the inner function directly.
                // eslint-disable-next-line @typescript-eslint/no-floating-promises
                bootstrap()
              }, 0)
            },
          },
        })
        setLoad({ kind: 'error', message })
      }
    }

    bootstrap()
    return () => {
      cancelled = true
    }
    // urlConversationId is captured at mount; we deliberately do NOT retrigger
    // on url changes because conversationId is driven BY this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleTestResult = useCallback((data: TestPipelineResultData) => {
    setTestResults((prev) => [data, ...prev])
  }, [])

  const handlePlanApproved = useCallback(() => {
    setShowPropagationBanner(true)
  }, [])

  const handlePlanRolledBack = useCallback(() => {
    // Refresh tenant state after a rollback so the sidebar counts update.
    apiGetBuildTenantState()
      .then((next) => {
        setLoad((prev) => (prev.kind === 'ready' ? { ...prev, tenantState: next } : prev))
      })
      .catch((err) => {
        if (err instanceof BuildModeDisabledError) return
        toast.error('Couldn’t refresh sidebar', {
          description:
            err instanceof Error ? err.message : 'Please reload to see the latest counts.',
        })
      })
  }, [])

  const tenantEmail = useMemo(() => getTenantMeta()?.email ?? '', [])
  const initials = useMemo(
    () => (tenantEmail ? tenantEmail.slice(0, 2).toUpperCase() : 'GP'),
    [tenantEmail],
  )

  if (load.kind === 'loading' || load.kind === 'unauthenticated') {
    return <BuildPageSkeleton />
  }

  if (load.kind === 'disabled') {
    return <BuildDisabled />
  }

  if (load.kind === 'error') {
    return (
      <div
        className="flex min-h-dvh items-center justify-center px-4"
        style={{ background: TUNING_COLORS.canvas }}
      >
        <div
          className="max-w-md rounded-lg border-l-2 px-4 py-3 text-sm"
          style={{
            background: TUNING_COLORS.dangerBg,
            borderLeftColor: TUNING_COLORS.dangerFg,
            color: TUNING_COLORS.dangerFg,
          }}
        >
          {load.message}
        </div>
      </div>
    )
  }

  const { tenantState, conversationId, initialMessages } = load

  return (
    <div
      className="h-dvh min-h-0 w-full"
      style={{
        background: TUNING_COLORS.canvas,
        display: 'grid',
        gridTemplateColumns: '56px 288px 1fr 440px',
      }}
    >
      <ActivityBar initials={initials} />
      <LeftRail
        tenantState={tenantState}
        onRolledBack={handlePlanRolledBack}
        onNewSession={() => {
          // Drop the conversationId param and reload. Full reload keeps the
          // state-init + auto-seed paths simple — a new BUILD session is
          // explicit and infrequent, so the skeleton flash is acceptable.
          if (typeof window !== 'undefined') {
            window.location.assign('/build')
          }
        }}
      />

      <main className="flex min-h-0 flex-col overflow-hidden">
        <ChatHead tenantState={tenantState} />
        {showPropagationBanner ? (
          <div
            className="border-b px-5 py-2"
            style={{ borderColor: TUNING_COLORS.hairlineSoft, background: TUNING_COLORS.surfaceRaised }}
          >
            <PropagationBanner onDismiss={() => setShowPropagationBanner(false)} />
          </div>
        ) : null}
        <div className="min-h-0 flex-1">
          <BuildChat
            conversationId={conversationId}
            greenfield={tenantState.isGreenfield}
            initialMessages={initialMessages}
            onTestResult={handleTestResult}
            onPlanApproved={handlePlanApproved}
            onPlanRolledBack={handlePlanRolledBack}
          />
        </div>
      </main>

      <PreviewPane results={testResults} />
    </div>
  )
}

// ─── Activity bar (left-most, 56px) ────────────────────────────────────────

function ActivityBar({ initials }: { initials: string }) {
  return (
    <nav
      className="flex flex-col items-center gap-1 border-r py-3"
      style={{
        borderColor: TUNING_COLORS.hairline,
        background: TUNING_COLORS.surfaceSunken,
      }}
    >
      <div
        aria-hidden
        className="mb-3 flex h-9 w-9 items-center justify-center rounded-[9px] text-[13px] font-bold text-white"
        style={{
          background: `linear-gradient(135deg, ${TUNING_COLORS.accent}, ${TUNING_COLORS.accentMuted})`,
          letterSpacing: '-0.02em',
        }}
      >
        gp
      </div>
      <ActivityIcon icon={<MessageSquare size={18} strokeWidth={1.8} />} active label="Build" />
      <ActivityIcon icon={<LayoutGrid size={18} strokeWidth={1.8} />} label="Artifacts" />
      <ActivityIcon icon={<Inbox size={18} strokeWidth={1.8} />} label="Inbox" href="/" />
      <ActivityIcon icon={<Home size={18} strokeWidth={1.8} />} label="Properties" />
      <ActivityIcon icon={<Bell size={18} strokeWidth={1.8} />} label="Alerts" />
      <div className="flex-1" />
      <ActivityIcon icon={<Settings size={18} strokeWidth={1.8} />} label="Settings" />
      <div
        aria-hidden
        className="mt-2 flex h-8 w-8 items-center justify-center rounded-full text-[11px] font-semibold text-white"
        style={{
          background: `linear-gradient(135deg, ${TUNING_COLORS.accentMuted}, ${TUNING_COLORS.accent})`,
        }}
      >
        {initials}
      </div>
    </nav>
  )
}

function ActivityIcon({
  icon,
  active,
  label,
  href,
}: {
  icon: React.ReactNode
  active?: boolean
  label: string
  href?: string
}) {
  const content = (
    <span
      title={label}
      aria-label={label}
      className="flex h-10 w-10 items-center justify-center rounded-lg transition-colors"
      style={{
        background: active ? TUNING_COLORS.surfaceRaised : 'transparent',
        color: active ? TUNING_COLORS.accent : TUNING_COLORS.inkSubtle,
        boxShadow: active ? '0 1px 2px rgba(17,24,39,0.04)' : 'none',
      }}
    >
      {icon}
    </span>
  )
  if (href) {
    return (
      <a href={href} className="outline-none">
        {content}
      </a>
    )
  }
  return content
}

// ─── Left rail (288px) ─────────────────────────────────────────────────────

function LeftRail({
  tenantState,
  onNewSession,
  onRolledBack,
}: {
  tenantState: BuildTenantState
  onNewSession: () => void
  onRolledBack?: (id: string) => void
}) {
  return (
    <aside
      className="flex min-h-0 flex-col overflow-hidden border-r"
      style={{ borderColor: TUNING_COLORS.hairline, background: TUNING_COLORS.surfaceRaised }}
    >
      <div
        className="flex h-[56px] shrink-0 items-center justify-between border-b px-4"
        style={{ borderColor: TUNING_COLORS.hairline }}
      >
        <span className="text-sm font-semibold" style={{ color: TUNING_COLORS.ink }}>
          Build
        </span>
        <button
          type="button"
          onClick={onNewSession}
          className="inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-xs font-medium text-white transition-colors hover:bg-[#5B4BD4]"
          style={{ background: TUNING_COLORS.accent }}
        >
          <Plus size={12} strokeWidth={2.4} />
          New
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
        <TransactionHistory
          last={tenantState.lastBuildTransaction}
          onRolledBack={onRolledBack}
        />
        <SetupProgress state={tenantState} />
      </div>
    </aside>
  )
}

// ─── Center chat header ────────────────────────────────────────────────────

function ChatHead({ tenantState }: { tenantState: BuildTenantState }) {
  const { isGreenfield, sopCount, faqCounts, customToolCount, propertyCount } = tenantState
  const totalArtifacts = sopCount + faqCounts.global + faqCounts.perProperty + customToolCount
  return (
    <header
      className="flex h-[56px] shrink-0 items-center justify-between border-b px-5"
      style={{
        borderColor: TUNING_COLORS.hairline,
        background: TUNING_COLORS.surfaceRaised,
      }}
    >
      <div className="flex items-center gap-3">
        <div
          aria-hidden
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[12px] font-bold text-white"
          style={{ background: `linear-gradient(135deg, ${TUNING_COLORS.accent}, ${TUNING_COLORS.accentMuted})` }}
        >
          gp
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[15px] font-semibold leading-tight" style={{ color: TUNING_COLORS.ink }}>
            Agent Studio
            <span
              className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-widest"
              style={{ background: TUNING_COLORS.accentSoft, color: TUNING_COLORS.accent }}
            >
              Build
            </span>
          </div>
          <div className="mt-0.5 text-[11.5px] leading-tight" style={{ color: TUNING_COLORS.inkMuted }}>
            {isGreenfield
              ? 'Greenfield tenant — nothing written yet.'
              : 'Everything you build here is atomic and revertable.'}
          </div>
        </div>
      </div>

      {/* Compact stat bar — collapses three lines of tenant-state into one header row. */}
      <div className="hidden items-center gap-4 md:flex">
        <HeaderStat label="Properties" value={propertyCount} />
        <HeaderDivider />
        <HeaderStat label="Artifacts" value={totalArtifacts} accent={totalArtifacts > 0} />
      </div>
    </header>
  )
}

function HeaderStat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="flex flex-col items-end leading-none">
      <span
        className="font-mono text-[15px] font-semibold"
        style={{ color: accent ? TUNING_COLORS.accent : TUNING_COLORS.ink }}
      >
        {value}
      </span>
      <span
        className="mt-0.5 text-[9.5px] font-semibold uppercase tracking-[0.08em]"
        style={{ color: TUNING_COLORS.inkSubtle }}
      >
        {label}
      </span>
    </div>
  )
}

function HeaderDivider() {
  return <span className="h-6 w-px" style={{ background: TUNING_COLORS.hairline }} />
}

// ─── Preview pane (right, 440px) ───────────────────────────────────────────

function PreviewPane({ results }: { results: TestPipelineResultData[] }) {
  return (
    <aside
      className="flex min-h-0 flex-col overflow-hidden border-l"
      style={{ borderColor: TUNING_COLORS.hairline, background: TUNING_COLORS.surfaceRaised }}
    >
      <div
        className="flex h-[56px] shrink-0 items-center gap-2 border-b px-4"
        style={{ borderColor: TUNING_COLORS.hairline }}
      >
        <span className="text-sm font-semibold" style={{ color: TUNING_COLORS.ink }}>
          Test pipeline
        </span>
        <span className="text-[11px]" style={{ color: TUNING_COLORS.inkMuted }}>
          · independent judge grades each reply
        </span>
        <span
          className="ml-auto rounded-full px-2 py-0.5 font-mono text-[11px]"
          style={{ background: TUNING_COLORS.surfaceSunken, color: TUNING_COLORS.inkSubtle }}
        >
          {results.length} run{results.length === 1 ? '' : 's'}
        </span>
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
        style={{ background: TUNING_COLORS.canvas }}
      >
        <div className="flex flex-col gap-3">
          {results.length === 0 ? (
            <div
              className="rounded-lg border border-dashed px-4 py-6 text-center text-xs leading-relaxed"
              style={{ borderColor: TUNING_COLORS.hairline, color: TUNING_COLORS.inkSubtle }}
            >
              No test runs yet.
              <br />
              Ask the agent to{' '}
              <span style={{ color: TUNING_COLORS.ink }}>test a guest message</span> — it runs through
              the current tenant config and an independent judge grades the reply.
            </div>
          ) : (
            results.map((r, i) => <TestPipelineResult key={i} data={r} />)
          )}
        </div>
      </div>
    </aside>
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

// ─── Suspense wrapper (useSearchParams requirement) ────────────────────────

export default function BuildPage() {
  return (
    <Suspense fallback={<BuildPageSkeleton />}>
      <BuildPageInner />
    </Suspense>
  )
}
