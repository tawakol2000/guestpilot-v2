'use client'

/**
 * Sprint 046 Session C — StudioChat.
 *
 * Replaces `components/build/build-chat.tsx` inside the Studio tab.
 * Key differences from BuildChat:
 *   - Plain hairline-separated rows. No rounded-2xl chat bubbles.
 *   - Flat `#0A0A0A` ink send button. No gradient.
 *   - `<ReasoningLine/>` replaces the chevron-accordion reasoning block.
 *   - `StandalonePart` switch covers every part type in
 *     `backend/src/build-tune-agent/data-parts.ts` (plan §6.3). Unknown
 *     parts render as a muted "(unsupported card: <type>)" line, never
 *     raw JSON.
 *
 * Data-part hoisting:
 *   - `data-state-snapshot` → onStateSnapshot (right rail)
 *   - `data-test-pipeline-result` → onTestResult (parent may show in
 *      right rail; also rendered inline for discoverability — Studio is
 *      more minimal than /build's dedicated preview pane).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import { ArrowUp, AlertTriangle, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { getToken } from '@/lib/api'
import {
  apiAcceptSuggestedFix,
  apiEnhancePrompt,
  apiRejectSuggestedFix,
  buildTurnEndpoint,
  type BuildPlanData,
  type BuildTenantState,
  type TestPipelineResultData,
} from '@/lib/build-api'
import { TenantStateBanner } from './tenant-state-banner'
import { SessionDiffCard, type SessionDiffSummaryData } from './session-diff-card'
import { STUDIO_COLORS, STUDIO_TOKENS_V2, getStudioCategoryStyle } from './tokens'
import { useStudioShell } from './studio-shell-context'
import { FileIcon, FlaskIcon } from './icons'
import { SuggestedFixCard, type SuggestedFixTarget } from './suggested-fix'
import { QuestionChoicesCard } from './question-choices'
import { AuditReportCard, type AuditReportRowData } from './audit-report'
import type { StateSnapshotData } from './state-snapshot'
import { ReasoningLine } from './reasoning-line'
import { PlanChecklist } from '../build/plan-checklist'
import { TestPipelineResult } from '../build/test-pipeline-result'
import { ToolCallDrawer, type ToolCallDrawerPart } from './tool-call-drawer'
import { ToolChainSummary } from './tool-chain-summary'
import type {
  SessionArtifact,
  SessionArtifactType,
} from './session-artifacts'
import {
  parseCitations,
  type CitationArtifactType,
} from './citation-parser'
import { CitationChip } from './citation-chip'
import { AgentProse } from './agent-prose'

export interface StudioChatProps {
  conversationId: string
  greenfield: boolean
  initialMessages: UIMessage[]
  onStateSnapshot?: (data: StateSnapshotData) => void
  onTestResult?: (data: TestPipelineResultData) => void
  onPlanApproved?: (transactionId: string) => void
  onPlanRolledBack?: (transactionId: string) => void
  /**
   * Sprint 050 A3 — emitted when a plan is approved or a suggested fix
   * is accepted. Parent (StudioSurface) upserts into the right-rail
   * session-artifacts panel.
   */
  onArtifactTouched?: (artifact: SessionArtifact) => void
  /**
   * Sprint 051 A B3 — open the unified artifact drawer from an inline
   * citation chip or (B4) a `data-artifact-quote` attribution chip.
   * Wired through `StudioSurface`. `section` is the optional
   * `#section` fragment from the citation marker.
   */
  onOpenArtifact?: (
    artifact: SessionArtifactType,
    artifactId: string,
    section?: string | null,
  ) => void
  /**
   * Sprint 050 A2 — admin-only "Show full output" toggle inside the
   * tool-call drawer. Both flags must be true to surface the toggle; the
   * sanitiser defaults to operator-tier redaction+truncation when the
   * toggle is off, matching the gate used by the existing Trace drawer.
   */
  isAdmin?: boolean
  traceViewEnabled?: boolean
  /**
   * Sprint 054-A F4 — opens the artifact drawer in history view for a
   * given BuildArtifactHistory row id so the Verification section is
   * visible. Wired by the parent which owns the drawer + ledger rows.
   */
  onOpenVerificationForHistoryId?: (historyId: string) => void
  /**
   * Sprint 058-A F9f — fired whenever the operator sends a new user
   * message (live send OR queue flush, NOT seed/suggestion picks).
   * StudioSurface uses this to auto-name the session from the first
   * substantive user message.
   */
  onUserMessageSent?: (text: string) => void
  /**
   * Sprint 058-A F5 — tenant state supplied by the surface for the
   * sticky banner at the top of the chat scroll area. Optional so old
   * tests that don't plumb it through still render.
   */
  tenantState?: BuildTenantState | null
  /** Sprint 058-A F5 — open the raw-prompt drawer when the banner's
   *  caption or chevron is clicked (admin + raw-prompt-editor flag). */
  onOpenPrompt?: () => void
  /**
   * Anchored discussion — when the operator clicks "Discuss in Tuning"
   * on a main-AI message, the tuning conversation is created with an
   * anchor. On first mount into an empty transcript we auto-send an
   * opener prompt so the agent summarises what the main AI did on that
   * message, rather than showing a blank chat. Null for
   * operator-initiated ("New session") Studio conversations.
   */
  anchorMessage?: { id: string; content?: string } | null
}

// Sprint 058-A F9c — AI SDK internal lifecycle markers. These are
// stream-ordering delimiters (step-start / step-finish / start /
// finish), not user-visible content. Any part whose type is in this
// set, or whose type starts with "step-", is silently dropped before
// the unsupported-card fallback renders.
const SDK_INTERNAL_LIFECYCLE_TYPES = new Set<string>([
  'step-start',
  'step-finish',
  'start-step',
  'finish-step',
  'start',
  'finish',
])

// Sprint 050 A3 — helpers that turn a plan-approval or suggested-fix
// accept into SessionArtifact records. Lives here because this is the
// file that sees both callback shapes.
const PLAN_ITEM_TYPE_TO_ARTIFACT: Record<string, SessionArtifactType> = {
  sop: 'sop',
  faq: 'faq',
  system_prompt: 'system_prompt',
  tool_definition: 'tool',
}
const FIX_ARTIFACT_TO_TYPE: Record<string, SessionArtifactType> = {
  sop: 'sop',
  faq: 'faq',
  system_prompt: 'system_prompt',
  tool_definition: 'tool',
  property_override: 'property_override',
}
function planItemToArtifact(
  transactionId: string,
  item: { type: string; name: string; target?: { artifactId?: string; sectionId?: string; slotKey?: string } },
  now: string,
): SessionArtifact | null {
  const type = PLAN_ITEM_TYPE_TO_ARTIFACT[item.type]
  if (!type) return null
  const artifactId = item.target?.artifactId ?? `${item.type}:${item.name}`
  // Stable key — transactionId scopes the artifact to this approval so
  // a rollback can flip it to "reverted" without touching later work.
  const id = `tx:${transactionId}:${type}:${artifactId}`
  return {
    id,
    artifact: type,
    artifactId,
    title: item.name,
    action: 'created',
    at: now,
  }
}
function fixToArtifact(
  data: {
    id?: string
    target?: { artifact?: string; artifactId?: string; sectionId?: string }
    category?: string
  },
  now: string,
): SessionArtifact | null {
  const artifactKey = data.target?.artifact ?? ''
  const type = FIX_ARTIFACT_TO_TYPE[artifactKey]
  if (!type) return null
  const artifactId =
    data.target?.artifactId ??
    data.target?.sectionId ??
    `fix:${data.id ?? Date.now()}`
  const id = `fix:${type}:${artifactId}`
  const title =
    artifactKey === 'system_prompt' && data.target?.sectionId
      ? `Prompt · §${data.target.sectionId}`
      : `${type.toUpperCase()} · ${artifactId.slice(0, 12)}`
  return {
    id,
    artifact: type,
    artifactId,
    title,
    action: 'modified',
    at: now,
  }
}

export function StudioChat({
  conversationId,
  greenfield,
  initialMessages,
  onStateSnapshot,
  onTestResult,
  onPlanApproved,
  onPlanRolledBack,
  onArtifactTouched,
  onOpenArtifact,
  isAdmin = false,
  traceViewEnabled = false,
  onOpenVerificationForHistoryId,
  onUserMessageSent,
  tenantState,
  onOpenPrompt,
  anchorMessage,
}: StudioChatProps) {
  // Flag flipped to true for the single auto-opener send triggered below
  // on fresh anchored conversations. The transport `body:` factory reads
  // it, attaches `isOpener: true`, and flips it back to false so any
  // subsequent real user send is persisted normally. Same pattern as
  // the legacy /tuning ChatPanel.
  const openerRef = useRef(false)
  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: buildTurnEndpoint(),
        credentials: 'omit',
        headers: (): Record<string, string> => {
          const token = getToken()
          return token ? { Authorization: `Bearer ${token}` } : {}
        },
        body: () => {
          const payload: Record<string, unknown> = { conversationId }
          if (openerRef.current) {
            payload.isOpener = true
            openerRef.current = false
          }
          return payload
        },
      }),
    [conversationId],
  )

  const { messages, sendMessage, status, error } = useChat({
    id: conversationId,
    messages: initialMessages,
    transport,
  })

  // Auto-opener — when the operator clicks "Discuss in Tuning" on an
  // inbox message, a TuningConversation is created with anchorMessageId
  // set and we get dropped into Studio with zero messages. Without this
  // effect the operator sees a blank chat; instead, fire a short opener
  // prompt that points the agent at the anchor. At-most-once per mount,
  // guarded by the ref so React Strict Mode double-invocation doesn't
  // produce two turns.
  const proactiveRequestedRef = useRef(false)
  useEffect(() => {
    // Bugfix (2026-04-23): the original guard ordering left a window
    // where StrictMode's double-invoke could fire two sendMessage
    // calls — the second invoke could observe `proactiveRequestedRef
    // .current === false` if the React 19 reconciler scheduled the
    // re-mount before we flipped the ref. Flip the ref FIRST, then
    // guard on payload validity. Same shape as the backend's
    // updateMany/atomic-claim pattern: claim the slot, then act.
    //
    // Also tightened the anchor null-check: was `!anchorMessage`,
    // which passed when `anchorMessage = { id: undefined }`, then
    // crashed at the template literal. Use optional chain on `.id`
    // so a malformed/deleted anchor returns early instead.
    if (proactiveRequestedRef.current) return
    proactiveRequestedRef.current = true
    if (!anchorMessage?.id) return
    if (initialMessages.length > 0) return
    if (messages.length > 0) return
    openerRef.current = true
    const preview =
      typeof anchorMessage.content === 'string'
        ? anchorMessage.content.slice(0, 160)
        : ''
    const text = `I just opened this conversation to discuss a specific main-AI message (id=${anchorMessage.id}${preview ? `, preview: "${preview.replace(/"/g, '\\"')}"` : ''}). Please use get_context to pull the anchored message, then summarize what the main AI did on it and what stands out. Keep it tight.`
    sendMessage({ text })
  }, [anchorMessage, initialMessages, messages, sendMessage])

  // Hoist data-state-snapshot + data-test-pipeline-result to the parent
  // (right rail). Track forwarded ids so rerenders don't re-fire the
  // callback.
  //
  // Bugfix (2026-04-22): the previous key was `p.id ?? ${m.id}:${t}`.
  // During streaming a part can first arrive without `p.id` (fallback
  // key used), then gain a real id later (real key used) — so BOTH
  // keys land in the Set and the callback fires twice. The duplicate
  // showed up as a momentary extra row in the right-rail testResults
  // panel before the slice(0, 3) window rolled it out. Fix: key by
  // the stable `${m.id}:${t}:${partIndex}` triple, which doesn't
  // depend on whether p.id has arrived yet. Parts within a message
  // stream in-order and don't get reordered in Vercel AI SDK v5, so
  // the index is stable.
  const forwardedIds = useRef<Set<string>>(new Set())
  // Bugfix (2026-04-23): the Set lived for the full component lifetime,
  // so switching between two Studio conversations without unmounting
  // left keys from conversation A in memory. A state-snapshot from
  // conversation B with the same `${m.id}:type:partIdx}` — which is
  // possible because UIMessage ids can collide across sessions when
  // the agent SDK re-uses its running counter — would be silently
  // skipped. Reset whenever `conversationId` changes so each session
  // starts with a fresh ledger.
  useEffect(() => {
    forwardedIds.current.clear()
  }, [conversationId])
  useEffect(() => {
    for (const m of messages) {
      const parts = (m as any).parts as Array<Record<string, any>> | undefined
      if (!Array.isArray(parts)) continue
      for (let partIdx = 0; partIdx < parts.length; partIdx++) {
        const p = parts[partIdx]
        const t = typeof p?.type === 'string' ? p.type : ''
        if (t !== 'data-state-snapshot' && t !== 'data-test-pipeline-result') continue
        // Include conversationId in the key so even if the Set clear
        // misses (StrictMode double-invocation etc.) cross-conversation
        // collisions can't happen.
        const stableKey = `${conversationId}:${m.id}:${t}:${partIdx}`
        if (forwardedIds.current.has(stableKey)) continue
        // Only forward once the payload has arrived. Before the data
        // lands we leave the Set alone so this effect can re-evaluate
        // when the next streaming render populates `p.data`.
        if (t === 'data-state-snapshot' && p.data) {
          forwardedIds.current.add(stableKey)
          onStateSnapshot?.(p.data as StateSnapshotData)
        } else if (t === 'data-test-pipeline-result' && p.data) {
          forwardedIds.current.add(stableKey)
          onTestResult?.(p.data as TestPipelineResultData)
        }
      }
    }
  }, [messages, onStateSnapshot, onTestResult, conversationId])

  const [draft, setDraft] = useState('')
  const scrollerRef = useRef<HTMLDivElement>(null)

  // Sprint 046 T013 — listen for composer-insert events from the
  // ReferencePicker (shell-level component). Appends the citation
  // marker to the current draft at textarea focus position (simplified
  // to "append at end" — cursor-position insertion lands in polish).
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onInsert = (e: Event) => {
      const ce = e as CustomEvent<{ text: string }>
      const text = ce.detail?.text
      if (!text) return
      setDraft((prev) => (prev && !prev.endsWith(' ') ? `${prev} ${text}` : `${prev}${text}`))
    }
    window.addEventListener('studio:composer-insert', onInsert)
    return () => window.removeEventListener('studio:composer-insert', onInsert)
  }, [])

  // Sprint 058-A F8 — composer ✨ enhance-prompt button. Nano rewrites
  // the operator's draft into a tighter, clearer instruction. The
  // pre-enhance text is kept for up to 15 seconds so ⌘Z can restore it.
  // Clearing on next submit prevents the undo-slot from resurrecting
  // stale text in a later turn.
  const [enhancing, setEnhancing] = useState(false)
  const preEnhanceDraftRef = useRef<{ text: string; until: number } | null>(null)
  const enhanceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearEnhanceUndoSlot = useCallback(() => {
    preEnhanceDraftRef.current = null
    if (enhanceTimeoutRef.current) {
      clearTimeout(enhanceTimeoutRef.current)
      enhanceTimeoutRef.current = null
    }
  }, [])

  const handleEnhanceClick = useCallback(async () => {
    const current = draft
    if (current.trim().length < 10 || enhancing) return
    setEnhancing(true)
    try {
      const res = await apiEnhancePrompt(current, conversationId)
      if (res.ok && typeof res.rewrite === 'string' && res.rewrite.trim()) {
        // Stash pre-enhance so ⌘Z can restore within 15s.
        if (enhanceTimeoutRef.current) clearTimeout(enhanceTimeoutRef.current)
        preEnhanceDraftRef.current = {
          text: current,
          until: Date.now() + 15_000,
        }
        enhanceTimeoutRef.current = setTimeout(() => {
          preEnhanceDraftRef.current = null
          enhanceTimeoutRef.current = null
        }, 15_000)
        setDraft(res.rewrite)
      } else {
        // Graceful degradation — don't clobber the draft, just explain.
        toast("Couldn't enhance — try again")
      }
    } catch {
      toast("Couldn't enhance — try again")
    } finally {
      setEnhancing(false)
    }
  }, [draft, enhancing, conversationId])
  // eslint-disable-next-line react-hooks/exhaustive-deps — setDraft is stable
  useEffect(() => {
    return () => {
      if (enhanceTimeoutRef.current) clearTimeout(enhanceTimeoutRef.current)
    }
  }, [])

  // Sprint 050 A2 — tool-call drill-in drawer. `lastChipRef` captures
  // the element that opened the drawer so Esc/close restores focus.
  const [activeToolPart, setActiveToolPart] = useState<ToolCallDrawerPart | null>(null)
  const [showFullOutput, setShowFullOutput] = useState(false)
  const lastChipRef = useRef<HTMLElement | null>(null)
  const openToolDrawer = useCallback(
    (part: ToolCallDrawerPart, origin: HTMLElement | null) => {
      lastChipRef.current = origin
      setActiveToolPart(part)
    },
    [],
  )
  const closeToolDrawer = useCallback(() => {
    setActiveToolPart(null)
    setShowFullOutput(false)
    // Restore focus to the chip that opened the drawer.
    lastChipRef.current?.focus()
  }, [])

  // ─── F3a — scroll discipline ─────────────────────────────────────────────
  // Track whether the operator is scrolled to the bottom. Messages that
  // arrive while scrolled away increment the pill counter instead of
  // force-scrolling.
  const [isAtBottom, setIsAtBottom] = useState(true)
  const [newMsgCount, setNewMsgCount] = useState(0)
  // Tracks message ids we have already accounted for so re-renders don't
  // double-count. Cleared on each fresh conversation via the dependency on
  // `conversationId` is implicit — the component re-mounts on id change.
  const seenMsgIds = useRef<Set<string>>(new Set())

  const handleScroll = useCallback(() => {
    if (!scrollerRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollerRef.current
    setIsAtBottom(scrollHeight - scrollTop - clientHeight < 64)
  }, [])

  // Skip auto-scroll on the first paint so loading a historical
  // conversation lands at the top (operator reads intro → scroll down),
  // not jammed at the bottom with everyone's context missing above.
  // After the first non-empty render, subsequent new messages auto-scroll
  // as before when the scroller is already at the bottom.
  const didInitialMessagesRender = useRef(false)
  useEffect(() => {
    if (!messages.length) return
    const newIds = messages.filter((m) => !seenMsgIds.current.has(m.id))
    newIds.forEach((m) => seenMsgIds.current.add(m.id))

    if (!didInitialMessagesRender.current) {
      didInitialMessagesRender.current = true
      // Defer one frame so the scroller's scrollHeight is settled before
      // we pin to 0 — otherwise a late-arriving child (e.g. the tool
      // drawer portal) can nudge the browser past our scrollTo.
      requestAnimationFrame(() => {
        scrollerRef.current?.scrollTo({ top: 0 })
      })
      setNewMsgCount(0)
      return
    }

    if (isAtBottom) {
      scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: 'smooth' })
      setNewMsgCount(0)
    } else {
      setNewMsgCount((prev) => prev + newIds.length)
    }
  }, [messages, isAtBottom])

  // ─── F3b — auto-queue while agent is working ─────────────────────────────
  // Queue is in-memory only and resets on page reload (intentional per spec:
  // persisting a partial conversation queue across reloads would confuse the
  // agent context. Use localStorage only if a future spec explicitly allows it.)
  const [queuedMessages, setQueuedMessages] = useState<string[]>([])
  const [showQueuePopover, setShowQueuePopover] = useState(false)
  const isFlushingRef = useRef(false)

  // Flush the first queued message when the agent returns to ready.
  //
  // Bugfix (2026-04-22): this effect used to leave the `isFlushingRef`
  // guard stuck if `sendMessage` failed silently (e.g. network blip the
  // transport ate without transitioning status to 'error'). The guard is
  // meant to prevent a same-render double-fire, not a cross-turn wedge.
  // Two safety nets now protect against silent failure:
  //   1. `sendMessage` is wrapped in a promise-catch so a rejected
  //      send clears the ref immediately.
  //   2. A 5-second safety timeout clears the ref if the transport
  //      hasn't transitioned status by then — indicating a silent
  //      no-op we can't directly observe. Any real transition through
  //      effect B below clears the timeout first.
  useEffect(() => {
    if (status !== 'ready' || queuedMessages.length === 0 || isFlushingRef.current) return
    isFlushingRef.current = true
    const [first, ...rest] = queuedMessages
    setQueuedMessages(rest)
    // Treat as an operator-initiated send — jump to bottom so the message
    // is visible when it lands.
    setIsAtBottom(true)
    scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: 'smooth' })

    let silenceTimeoutId: ReturnType<typeof setTimeout> | undefined
    try {
      // sendMessage may return void or a Promise. Promise.resolve() smooths
      // over both so we can attach a catch handler without breaking the
      // void-return case.
      Promise.resolve(sendMessage({ text: first })).catch((err) => {
        console.warn('[StudioChat] queued-message flush failed, releasing guard', err)
        isFlushingRef.current = false
        toast('Send failed — try again from the composer.')
      })
    } catch (err) {
      // Synchronous throw from sendMessage (rare but possible if the
      // transport is misconfigured). Release the guard immediately.
      console.warn('[StudioChat] queued-message flush threw synchronously', err)
      isFlushingRef.current = false
      toast('Send failed — try again from the composer.')
    }

    // Safety timeout: if the transport never transitions away from 'ready'
    // we'd otherwise wedge the rest of the queue. 5s is long enough to not
    // race normal submissions (submitted → streaming typically lands in
    // <200ms) and short enough to avoid visibly blocking the operator.
    silenceTimeoutId = setTimeout(() => {
      if (isFlushingRef.current) {
        console.warn(
          '[StudioChat] queued-message flush did not transition status within 5s, releasing guard',
        )
        isFlushingRef.current = false
      }
    }, 5_000)

    return () => {
      if (silenceTimeoutId) clearTimeout(silenceTimeoutId)
    }
  }, [status, queuedMessages, sendMessage])

  // Reset the flushing guard whenever the agent leaves ready (i.e. it just
  // picked up the flushed message and started processing). 'error' also
  // counts — the useChat transport enters 'error' on a failed POST, at
  // which point the queue can re-fire once the user retries.
  useEffect(() => {
    if (status !== 'ready') {
      isFlushingRef.current = false
    }
  }, [status])

  const isStreaming = status === 'streaming'
  const isSending = status === 'submitted'
  const isBusy = isStreaming || isSending || status === 'error'
  const canSend = !!draft.trim() && !isBusy

  const onSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      const text = draft.trim()
      if (!text) return

      // When agent is busy, queue the message instead of blocking the send.
      if (isBusy) {
        if (queuedMessages.length >= 3) {
          toast('Queue full — wait for the agent to finish before sending more.')
          return
        }
        setQueuedMessages((prev) => [...prev, text])
        setDraft('')
        // F9f — still count as a user message for auto-naming purposes;
        // the parent decides whether it's actually the session's first.
        onUserMessageSent?.(text)
        // F8 — any stashed pre-enhance undo slot becomes stale once the
        // enhanced text has been committed to the queue.
        clearEnhanceUndoSlot()
        return
      }

      setDraft('')
      // F9f — notify the parent so it can auto-name the session on the
      // first substantive user message.
      onUserMessageSent?.(text)
      // F8 — clear the undo slot so a later ⌘Z doesn't resurrect a
      // draft that has already been sent.
      clearEnhanceUndoSlot()
      sendMessage({ text })
    },
    [draft, isBusy, queuedMessages.length, sendMessage, onUserMessageSent, clearEnhanceUndoSlot],
  )

  // Surface stream errors as toasts (once per distinct message).
  const lastReportedErrorRef = useRef<string | null>(null)
  useEffect(() => {
    if (!error) {
      lastReportedErrorRef.current = null
      return
    }
    const message = error.message
    if (lastReportedErrorRef.current === message) return
    lastReportedErrorRef.current = message
    toast.error('Agent reply failed', {
      description: message || 'Please try sending the message again.',
    })
  }, [error])

  const empty = messages.length === 0

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      style={{ background: STUDIO_COLORS.canvas, position: 'relative' }}
    >
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-auto" style={{ position: 'relative' }} onScroll={handleScroll}>
        {/* Sprint 058-A F5 — sticky tenant-state banner. Sits inside the
            scroll container so it stays pinned while messages scroll
            below. Returns null when tenantState is nullish. */}
        {tenantState ? (
          <TenantStateBanner
            state={tenantState}
            onOpenPrompt={onOpenPrompt}
          />
        ) : null}
        {/* F3a — jump-to-latest pill. Appears when operator has scrolled
            up and new messages have arrived. Clicking jumps to bottom and
            clears the counter. */}
        {!isAtBottom && newMsgCount > 0 && (
          <button
            data-testid="scroll-to-bottom-pill"
            className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 px-3 py-1 rounded-full text-sm font-medium shadow-md"
            style={{ background: STUDIO_COLORS.accent, color: '#fff' }}
            onClick={() => {
              scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: 'smooth' })
              setNewMsgCount(0)
              setIsAtBottom(true)
            }}
          >
            ↓ {newMsgCount} new
          </button>
        )}
        <div className="mx-auto flex max-w-3xl flex-col">
          {empty ? <StudioEmptyState greenfield={greenfield} onPick={(text) => sendMessage({ text })} /> : null}

          {messages.map((m, idx) => (
            <MessageRow
              key={m.id}
              message={m}
              isLast={idx === messages.length - 1}
              conversationId={conversationId}
              conversationMessages={messages}
              setDraft={setDraft}
              onPlanApproved={onPlanApproved}
              onPlanRolledBack={onPlanRolledBack}
              onArtifactTouched={onArtifactTouched}
              onOpenArtifact={onOpenArtifact}
              onSendText={(text) => sendMessage({ text })}
              onOpenToolDrawer={openToolDrawer}
              onOpenVerificationForHistoryId={onOpenVerificationForHistoryId}
            />
          ))}

          {isBusy ? <TypingIndicator /> : null}

          {error ? (
            <div
              className="mx-5 my-3 rounded-md border-l-2 px-3 py-2 text-xs"
              style={{
                background: STUDIO_COLORS.dangerBg,
                borderLeftColor: STUDIO_COLORS.dangerFg,
                color: STUDIO_COLORS.dangerFg,
              }}
            >
              {error.message}
            </div>
          ) : null}
        </div>
      </div>

      <form
        onSubmit={onSubmit}
        className="border-t"
        style={{
          borderColor: STUDIO_TOKENS_V2.border,
          background: STUDIO_TOKENS_V2.bg,
          padding: '8px 20px 14px',
        }}
      >
        {/* Sprint 046 T012 — composer card, v2 tokens. 14px radius,
           border-strong, small shadow, 780px max-width per FR-025. */}
        <div
          className="mx-auto flex flex-col gap-2"
          style={{
            maxWidth: 780,
            background: STUDIO_TOKENS_V2.bg,
            border: `1px solid ${STUDIO_TOKENS_V2.borderStrong}`,
            borderRadius: STUDIO_TOKENS_V2.radiusXl,
            padding: '10px 12px 8px',
            boxShadow: STUDIO_TOKENS_V2.shadowSm,
          }}
        >
          <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                onSubmit(e as unknown as React.FormEvent)
                return
              }
              // Sprint 058-A F8 — ⌘Z (mac) / Ctrl+Z (others) within 15s of an
              // ✨ enhance restores the pre-enhance draft. No-op once the
              // window expires or no undo slot is stashed.
              if (
                (e.metaKey || e.ctrlKey) &&
                !e.shiftKey &&
                e.key.toLowerCase() === 'z'
              ) {
                const slot = preEnhanceDraftRef.current
                if (slot && Date.now() < slot.until) {
                  e.preventDefault()
                  setDraft(slot.text)
                  clearEnhanceUndoSlot()
                  toast('Restored your original')
                }
              }
            }}
            rows={2}
            placeholder={
              isBusy
                ? queuedMessages.length > 0
                  ? `Queuing… (${queuedMessages.length}/3 queued)`
                  : // Sprint 058-A F9e — composer is typeable during streaming
                    // (textarea is never disabled). The placeholder tells the
                    // operator what pressing Enter will do.
                    'Type to queue — will send when the agent finishes'
                : greenfield
                  ? 'Tell me about your properties.'
                  : 'What do you want to build or change?'
            }
            disabled={false}
            className="min-h-[44px] flex-1 resize-none border-0 bg-transparent px-2.5 py-2 text-sm leading-5 outline-none placeholder:text-[#9CA3AF] disabled:opacity-60"
            style={{ color: STUDIO_COLORS.ink }}
            aria-label="Message the studio agent"
          />
          {/* F3b — queued-messages badge. Shows count + popover to inspect/remove
              queued messages while the agent is processing. Clicking × on an
              item removes it from the queue. */}
          {queuedMessages.length > 0 && (
            <div className="relative shrink-0">
              <button
                type="button"
                data-testid="queue-badge"
                className="text-xs font-medium px-2 py-1 rounded"
                style={{ color: STUDIO_COLORS.accent }}
                onClick={() => setShowQueuePopover((v) => !v)}
                aria-label={`${queuedMessages.length} message${queuedMessages.length === 1 ? '' : 's'} queued`}
              >
                Queued ({queuedMessages.length})
              </button>
              {showQueuePopover && (
                <div
                  data-testid="queue-popover"
                  className="absolute bottom-8 right-0 bg-white border rounded shadow-lg p-2 w-56 z-20"
                  style={{ borderColor: STUDIO_COLORS.hairline }}
                >
                  {queuedMessages.map((msg, i) => (
                    <div key={i} className="flex items-center justify-between text-sm py-1">
                      <span
                        className="truncate flex-1 mr-2"
                        style={{ color: STUDIO_COLORS.ink, fontSize: 12 }}
                      >
                        {msg}
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove queued message: ${msg}`}
                        data-testid="queue-item-remove"
                        onClick={(e) => {
                          e.stopPropagation()
                          setQueuedMessages((prev) => prev.filter((_, j) => j !== i))
                        }}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: STUDIO_COLORS.inkMuted,
                          cursor: 'pointer',
                          fontSize: 14,
                          padding: '0 2px',
                          flexShrink: 0,
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {/* Sprint 058-A F8 — enhance-prompt ✨ button. Shown once the
              operator's draft crosses 10 chars. Clicking replaces the
              draft with a Nano rewrite; the pre-enhance text is stashed
              for 15s so ⌘Z in the textarea can restore it. A failed
              call toasts "Couldn't enhance — try again" and leaves the
              draft untouched. */}
          {draft.trim().length >= 10 ? (
            <button
              type="button"
              data-testid="composer-enhance-button"
              disabled={enhancing}
              onClick={handleEnhanceClick}
              aria-label="Enhance draft with AI"
              title="Enhance draft (AI)"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md disabled:opacity-60"
              style={{
                background: STUDIO_COLORS.surfaceSunken,
                color: enhancing ? STUDIO_COLORS.inkSubtle : STUDIO_COLORS.accent,
                border: `1px solid ${STUDIO_COLORS.hairline}`,
                cursor: enhancing ? 'progress' : 'pointer',
              }}
            >
              <Sparkles size={15} strokeWidth={2.25} aria-hidden />
            </button>
          ) : null}
          <button
            type="submit"
            disabled={!canSend}
            aria-label="Send message"
            className="flex shrink-0 items-center justify-center disabled:opacity-60"
            style={{
              width: 30,
              height: 30,
              borderRadius: STUDIO_TOKENS_V2.radiusMd,
              background: canSend ? STUDIO_TOKENS_V2.blue : STUDIO_TOKENS_V2.surface3,
              color: canSend ? '#FFFFFF' : STUDIO_TOKENS_V2.muted2,
            }}
          >
            <ArrowUp size={16} strokeWidth={2.25} aria-hidden />
          </button>
          </div>
          {/* Sprint 046 T013 — composer chips row. Reference opens the
             artifact-picker popover (FR-025a); Test forwards the draft
             to the Preview tab's test-pipeline (FR-025b). Paperclip is
             dropped (Clarifications Q2). */}
          <ComposerChips draft={draft} />
        </div>
        {/* Sprint 046 FR-025 — foot line. */}
        <p
          className="mx-auto mt-2"
          style={{
            maxWidth: 780,
            fontSize: 11,
            color: STUDIO_TOKENS_V2.muted2,
            textAlign: 'center',
          }}
        >
          Studio · Sonnet 4.6 · Edits are drafts until you publish
        </p>
      </form>

      <ToolCallDrawer
        open={activeToolPart !== null}
        onClose={closeToolDrawer}
        part={activeToolPart}
        isAdmin={isAdmin}
        traceViewEnabled={traceViewEnabled}
        showFull={showFullOutput}
        onToggleShowFull={setShowFullOutput}
      />
    </div>
  )
}

// ─── Empty-state ───────────────────────────────────────────────────────────

function StudioEmptyState({
  greenfield,
  onPick,
}: {
  greenfield: boolean
  onPick: (text: string) => void
}) {
  // Sprint 046 T037 — new empty-state illustration per design handoff:
  // 48×48 blue-soft message icon + "Start a new thread" headline +
  // muted subtext + ink-filled "Get started" button.
  const prompt = greenfield
    ? 'I run short-let apartments. Help me set this up from scratch.'
    : 'Review my current setup and tell me the single biggest gap.'
  const headline = greenfield ? 'Start a new thread' : 'Start a new thread'
  const sub = greenfield
    ? 'Describe your property business in plain English — I’ll ask a few follow-up questions and never write without your sign-off.'
    : 'Ask me to audit your setup, add an SOP, change an FAQ, or rewrite a prompt section. Every change is atomic and revertable.'
  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '60px 24px',
        minHeight: '60%',
      }}
    >
      {/* 48×48 blue-soft square with message-square icon */}
      <div
        aria-hidden
        style={{
          width: 48,
          height: 48,
          borderRadius: STUDIO_TOKENS_V2.radiusMd,
          background: STUDIO_TOKENS_V2.blueSoft,
          color: STUDIO_TOKENS_V2.blue,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 18,
        }}
      >
        <svg
          width={24}
          height={24}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 5a2 2 0 012-2h12a2 2 0 012 2v10a2 2 0 01-2 2H9l-5 4V5z" />
        </svg>
      </div>
      <h1
        style={{
          fontSize: 18,
          fontWeight: 500,
          color: STUDIO_TOKENS_V2.ink,
          margin: 0,
          letterSpacing: '-0.01em',
        }}
      >
        {headline}
      </h1>
      <p
        style={{
          marginTop: 6,
          maxWidth: 440,
          textAlign: 'center',
          fontSize: 14,
          lineHeight: 1.5,
          color: STUDIO_TOKENS_V2.muted,
        }}
      >
        {sub}
      </p>
      <button
        type="button"
        onClick={() => onPick(prompt)}
        style={{
          marginTop: 20,
          padding: '8px 14px',
          borderRadius: STUDIO_TOKENS_V2.radiusMd,
          background: STUDIO_TOKENS_V2.ink,
          color: '#FFFFFF',
          border: 'none',
          fontSize: 13,
          fontWeight: 500,
          cursor: 'pointer',
        }}
      >
        {greenfield ? 'Start with a walkthrough' : 'Start with an audit'}
      </button>
    </section>
  )
}

// ─── Message row (plain, no bubbles) ───────────────────────────────────────

function MessageRow({
  message,
  isLast,
  conversationId,
  conversationMessages,
  setDraft,
  onPlanApproved,
  onPlanRolledBack,
  onArtifactTouched,
  onOpenArtifact,
  onSendText,
  onOpenToolDrawer,
  onOpenVerificationForHistoryId,
}: {
  message: UIMessage
  isLast: boolean
  conversationId: string
  conversationMessages: UIMessage[]
  setDraft: React.Dispatch<React.SetStateAction<string>>
  onPlanApproved?: (transactionId: string) => void
  onPlanRolledBack?: (transactionId: string) => void
  onArtifactTouched?: (artifact: SessionArtifact) => void
  onOpenArtifact?: (
    artifact: SessionArtifactType,
    artifactId: string,
    section?: string | null,
  ) => void
  onSendText?: (text: string) => void
  onOpenToolDrawer?: (part: ToolCallDrawerPart, origin: HTMLElement | null) => void
  onOpenVerificationForHistoryId?: (historyId: string) => void
}) {
  const isUser = message.role === 'user'
  const parts = ((message as any).parts as Array<Record<string, any>>) ?? []

  // Sprint 057-A F1 — track whether the tool-chain summary is expanded so
  // we can show/hide the standalone tool-chip section in sync.
  const [toolChainExpanded, setToolChainExpanded] = useState(false)

  const textParts: Array<Record<string, any>> = []
  const reasoningParts: Array<Record<string, any>> = []
  const toolParts: Array<Record<string, any>> = []
  const standaloneParts: Array<Record<string, any>> = []
  // Sprint 058-A F9b — merge consecutive reasoning parts into a single
  // entry so each reasoning streak renders as one <ReasoningLine>, not
  // one per SDK chunk. Without this, chunk boundaries produce the
  // duplicate "Agent reasoning · viewAgent reasoning · view" regression.
  let lastClassified: 'text' | 'reasoning' | 'tool' | 'standalone' | null = null
  for (const p of parts) {
    const t = typeof p?.type === 'string' ? p.type : ''
    if (t === 'text') {
      textParts.push(p)
      lastClassified = 'text'
    } else if (t === 'reasoning') {
      if (lastClassified === 'reasoning' && reasoningParts.length > 0) {
        const prev = reasoningParts[reasoningParts.length - 1]
        const merged = `${prev.text ?? ''}${p.text ?? ''}`
        reasoningParts[reasoningParts.length - 1] = { ...prev, text: merged }
      } else {
        reasoningParts.push(p)
      }
      lastClassified = 'reasoning'
    } else if (t.startsWith('tool-')) {
      toolParts.push(p)
      lastClassified = 'tool'
    } else {
      standaloneParts.push(p)
      lastClassified = 'standalone'
    }
  }

  // Sprint 046 T024+T025 — bubble redesign.
  //
  // User messages: right-aligned ink-filled bubble (max 85% width, 14px
  //   radius with 6px bottom-right "tail", white 14.5px text).
  // Assistant messages: 24×24 avatar + "Studio" header + 32px left-padded
  //   body column with 10px gap between blocks (reasoning, tool-chain,
  //   artifact refs, etc).
  return (
    <div
      style={{
        padding: '0 24px',
        marginBottom: 28,
      }}
    >
      {isUser ? (
        // ── User bubble (right-aligned, blue-soft pill) ─────────────
        // Sprint 046 — pill styling per user review screenshot: full
        // rounded corners, `--blue-soft` background, `--blue` text.
        // Readable contrast and unmistakably a guest turn.
        <div style={{ display: 'flex', justifyContent: 'flex-end', maxWidth: 780, margin: '0 auto' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', maxWidth: '85%' }}>
            <div
              style={{
                padding: '10px 16px',
                borderRadius: 18,
                background: STUDIO_TOKENS_V2.blueSoft,
                color: STUDIO_TOKENS_V2.blue,
                fontSize: 14.5,
                lineHeight: 1.5,
                wordBreak: 'break-word',
              }}
            >
              {textParts.length > 0
                ? textParts.map((p, i) => (
                    <AttributedText
                      key={`t:${i}`}
                      text={p.text ?? ''}
                      isUser
                      onOpenArtifact={onOpenArtifact}
                    />
                  ))
                : null}
            </div>
          </div>
        </div>
      ) : (
        // ── Assistant message with avatar header + body column ──────
        <div style={{ maxWidth: 780, margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div
              aria-hidden
              style={{
                width: 24,
                height: 24,
                borderRadius: STUDIO_TOKENS_V2.radiusSm,
                border: `1px solid ${STUDIO_TOKENS_V2.border}`,
                background: STUDIO_TOKENS_V2.bg,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: STUDIO_TOKENS_V2.blue,
                flexShrink: 0,
              }}
            >
              <svg
                width={14}
                height={14}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.6}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 4v16" />
                <path d="M4 12h16" />
                <path d="M6 6l12 12" />
                <path d="M18 6L6 18" />
              </svg>
            </div>
            <span style={{ fontSize: 12.5, fontWeight: 500, color: STUDIO_TOKENS_V2.ink }}>Studio</span>
          </div>
          <div
            style={{
              paddingLeft: 32,
              marginTop: 6,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            {/* Sprint 057-A F1 — tool-chain summary. */}
            <ToolChainSummary
              parts={toolParts}
              onOpenToolDrawer={onOpenToolDrawer}
              onExpandedChange={setToolChainExpanded}
            />

            {textParts.length > 0 && (
              <div
                className="flex flex-col gap-2"
                style={{
                  fontSize: 15,
                  lineHeight: 1.6,
                  color: STUDIO_TOKENS_V2.ink2,
                  maxWidth: 680,
                }}
              >
                {textParts.map((p, i) => (
                  <AttributedText
                    key={`t:${i}`}
                    text={p.text ?? ''}
                    isUser={false}
                    onOpenArtifact={onOpenArtifact}
                  />
                ))}
              </div>
            )}

            {reasoningParts.length > 0 && (
              // Sprint 058-A F9b — `flex flex-col gap-1` defensively separates
              // adjacent <ReasoningLine> instances so their inline labels never
              // run together.
              <div className="flex flex-col gap-1">
                {reasoningParts.map((p, i) => (
                  <ReasoningLine key={`r:${i}`} content={p.text ?? ''} />
                ))}
              </div>
            )}

            {/* Standalone tool chips — hidden when the summary is collapsed. */}
            {toolParts.length > 0 && (
              <div
                className="flex flex-col gap-2"
                style={{ display: toolChainExpanded ? undefined : 'none' }}
                aria-hidden={!toolChainExpanded}
              >
                {toolParts.map((p, i) => (
                  <StandalonePart
                    key={`tool:${i}`}
                    part={p}
                    conversationId={conversationId}
                    conversationMessages={conversationMessages}
                    setDraft={setDraft}
                    onPlanApproved={onPlanApproved}
                    onPlanRolledBack={onPlanRolledBack}
                    onArtifactTouched={onArtifactTouched}
                    onOpenArtifact={onOpenArtifact}
                    onSendText={onSendText}
                    onOpenToolDrawer={onOpenToolDrawer}
                    onOpenVerificationForHistoryId={onOpenVerificationForHistoryId}
                  />
                ))}
              </div>
            )}

            {standaloneParts.length > 0 && (
              <div className="flex flex-col gap-2">
                {standaloneParts.map((p, i) => (
                  <StandalonePart
                    key={`s:${i}`}
                    part={p}
                    conversationId={conversationId}
                    conversationMessages={conversationMessages}
                    setDraft={setDraft}
                    onPlanApproved={onPlanApproved}
                    onPlanRolledBack={onPlanRolledBack}
                    onArtifactTouched={onArtifactTouched}
                    onOpenArtifact={onOpenArtifact}
                    onSendText={onSendText}
                    onOpenToolDrawer={onOpenToolDrawer}
                    onOpenVerificationForHistoryId={onOpenVerificationForHistoryId}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Standalone part switch ────────────────────────────────────────────────
// Must cover every type registered in
// `backend/src/build-tune-agent/data-parts.ts#DATA_PART_TYPES`.

function StandalonePart({
  part,
  conversationId,
  conversationMessages,
  setDraft,
  onPlanApproved,
  onPlanRolledBack,
  onArtifactTouched,
  onOpenArtifact,
  onSendText,
  onOpenToolDrawer,
  onOpenVerificationForHistoryId,
}: {
  part: Record<string, any>
  conversationId: string
  conversationMessages: UIMessage[]
  setDraft: React.Dispatch<React.SetStateAction<string>>
  onPlanApproved?: (transactionId: string) => void
  onPlanRolledBack?: (transactionId: string) => void
  onArtifactTouched?: (artifact: SessionArtifact) => void
  onOpenArtifact?: (
    artifact: SessionArtifactType,
    artifactId: string,
    section?: string | null,
  ) => void
  onSendText?: (text: string) => void
  onOpenToolDrawer?: (part: ToolCallDrawerPart, origin: HTMLElement | null) => void
  onOpenVerificationForHistoryId?: (historyId: string) => void
}) {
  const rejectionConversationId = conversationId
  if (!part || typeof part !== 'object') return null
  const type = typeof part.type === 'string' ? part.type : ''

  // Sprint 058-A F9c — AI SDK internal lifecycle markers are delimiters,
  // not content. Silent-drop them before they fall through to the
  // unsupported-card fallback and leak "(unsupported card: step-start)"
  // into the message body.
  if (SDK_INTERNAL_LIFECYCLE_TYPES.has(type) || type.startsWith('step-')) {
    return null
  }

  if (type.startsWith('tool-')) {
    const toolName = part.toolName ?? type.slice('tool-'.length)
    const state = part.state ?? 'input-available'
    return (
      <ToolCallChip
        toolName={toolName}
        state={state}
        onClick={(origin) =>
          onOpenToolDrawer?.(
            {
              type,
              toolName,
              state,
              input: part.input,
              output: part.output,
              providerMetadata: part.providerMetadata,
              errorText: typeof part.errorText === 'string' ? part.errorText : undefined,
            },
            origin,
          )
        }
      />
    )
  }

  if (type === 'data-build-plan') {
    const planData = part.data as BuildPlanData | undefined
    // Sprint 055-A F1 — accumulate write history from data-build-history
    // parts scoped to this transactionId. Since data-build-history is not
    // yet emitted by the backend the list gracefully stays empty and rows
    // render in pending/current state.
    const txId = planData?.transactionId
    const appliedItems: Array<{ type: string; name: string }> = []
    if (txId) {
      for (const m of conversationMessages) {
        const mParts = (m as any).parts as Array<Record<string, any>> | undefined
        if (!Array.isArray(mParts)) continue
        for (const mp of mParts) {
          if (mp?.type === 'data-build-history' && mp?.data?.transactionId === txId) {
            const entries = Array.isArray(mp.data.entries) ? mp.data.entries : []
            for (const e of entries) {
              if (e?.type && e?.name) appliedItems.push({ type: e.type, name: e.name })
            }
          }
        }
      }
    }
    return (
      <PlanChecklist
        data={planData as BuildPlanData}
        appliedItems={appliedItems as Array<{ type: 'sop' | 'faq' | 'system_prompt' | 'tool_definition'; name: string }>}
        conversationId={conversationId}
        onOpenArtifact={onOpenArtifact ? (type, artifactId) => onOpenArtifact(type, artifactId) : undefined}
        onApproved={(txId) => {
          // Sprint 050 A3 — seed the session-artifacts rail from every
          // plan item so the operator can see "here's what this plan
          // wrote" the moment they approve it.
          if (planData && onArtifactTouched) {
            const now = new Date().toISOString()
            for (const it of planData.items ?? []) {
              const artifact = planItemToArtifact(txId, it, now)
              if (artifact) onArtifactTouched(artifact)
            }
          }
          onPlanApproved?.(txId)
        }}
        onRolledBack={onPlanRolledBack}
        onSeedComposer={(text) => setDraft((prev) => prev ? prev + ' ' + text : text)}
      />
    )
  }

  if (type === 'data-test-pipeline-result') {
    // Render inline too (parent right rail already has a copy via
    // onTestResult hoisting; showing the card inline makes it easy to
    // reference while reading the conversation).
    const testData = part.data as TestPipelineResultData
    return (
      <div style={{ maxWidth: 720 }}>
        <TestPipelineResult
          data={testData}
          sourceWriteLabel={testData.sourceWriteLabel ?? undefined}
          onOpenSourceWrite={
            testData.sourceWriteHistoryId
              ? () => onOpenVerificationForHistoryId?.(testData.sourceWriteHistoryId!)
              : undefined
          }
        />
      </div>
    )
  }

  if (type === 'data-state-snapshot') {
    // Rendered in the right rail via onStateSnapshot hoisting — suppress
    // inline so it doesn't double-render.
    return null
  }

  if (type === 'data-build-history') {
    // Consumed by PlanChecklist (scanned from conversationMessages to
    // populate appliedItems). Has no standalone visual — suppress so it
    // doesn't leak through the unsupported-card fallback.
    return null
  }

  if (type === 'data-suggested-fix') {
    const data = part.data ?? {}
    return (
      <SuggestedFixCard
        id={data.id ?? part.id ?? `fix:${Date.now()}`}
        target={(data.target as SuggestedFixTarget) ?? {}}
        before={typeof data.before === 'string' ? data.before : ''}
        after={typeof data.after === 'string' ? data.after : ''}
        rationale={typeof data.rationale === 'string' ? data.rationale : ''}
        impact={typeof data.impact === 'string' ? data.impact : undefined}
        category={typeof data.category === 'string' ? data.category : undefined}
        createdAt={typeof data.createdAt === 'string' ? data.createdAt : undefined}
        onAccept={async (id) => {
          const target = (data.target as SuggestedFixTarget | undefined) ?? {}
          // Sprint 050 A3 — emit the session-artifact record before the
          // network call so the rail updates immediately; if the write
          // throws the later toast still surfaces the failure.
          if (onArtifactTouched) {
            const artifact = fixToArtifact(
              {
                id: typeof data.id === 'string' ? data.id : id,
                target: {
                  artifact: (target as any).artifact,
                  artifactId: target.artifactId,
                  sectionId: target.sectionId,
                },
                category: typeof data.category === 'string' ? data.category : undefined,
              },
              new Date().toISOString(),
            )
            if (artifact) onArtifactTouched(artifact)
          }
          await apiAcceptSuggestedFix(id, {
            conversationId: rejectionConversationId,
            category: typeof data.category === 'string' ? data.category : undefined,
            subLabel: typeof data.subLabel === 'string' ? data.subLabel : undefined,
            rationale: typeof data.rationale === 'string' ? data.rationale : undefined,
            before: typeof data.before === 'string' ? data.before : undefined,
            after: typeof data.after === 'string' ? data.after : undefined,
            target: {
              artifactId: target.artifactId,
              sectionId: target.sectionId,
              slotKey: target.slotKey,
              sopCategory: (target as any).sopCategory,
              sopStatus: (target as any).sopStatus,
              sopPropertyId: (target as any).sopPropertyId,
              faqEntryId: (target as any).faqEntryId,
              systemPromptVariant: (target as any).systemPromptVariant,
            },
          })
          toast.success('Fix accepted')
        }}
        onReject={async (id) => {
          // Sprint 047 Session C — pass `target.artifact` through so the
          // backend can key the durable RejectionMemory row correctly.
          const rejectTarget = (data.target ?? undefined) as
            | {
                artifact?: 'system_prompt' | 'sop' | 'faq' | 'tool_definition' | 'property_override'
                artifactId?: string
                sectionId?: string
                slotKey?: string
              }
            | undefined
          await apiRejectSuggestedFix(id, {
            conversationId: rejectionConversationId,
            category: typeof data.category === 'string' ? data.category : undefined,
            subLabel: typeof data.subLabel === 'string' ? data.subLabel : undefined,
            target: rejectTarget
              ? {
                  artifact: rejectTarget.artifact,
                  artifactId: rejectTarget.artifactId,
                  sectionId: rejectTarget.sectionId,
                  slotKey: rejectTarget.slotKey,
                }
              : undefined,
          })
          toast.success('Fix rejected')
        }}
      />
    )
  }

  if (type === 'data-question-choices') {
    const data = part.data ?? {}
    return (
      <QuestionChoicesCard
        question={typeof data.question === 'string' ? data.question : ''}
        options={Array.isArray(data.options) ? data.options : []}
        allowCustomInput={data.allowCustomInput === true}
        onChoose={(optionId) => {
          const opt = (data.options ?? []).find((o: any) => o.id === optionId)
          const label = opt?.label ?? optionId
          onSendText?.(label)
        }}
        onCustomAnswer={(text) => onSendText?.(text)}
      />
    )
  }

  if (type === 'data-audit-report') {
    const data = part.data ?? {}
    return (
      <AuditReportCard
        rows={Array.isArray(data.rows) ? (data.rows as AuditReportRowData[]) : []}
        topFindingId={typeof data.topFindingId === 'string' ? data.topFindingId : null}
        summary={typeof data.summary === 'string' ? data.summary : undefined}
        onFixTopFinding={(findingId) => {
          // Scroll the matching SuggestedFixCard into view, if it's
          // already in the DOM. Session D can extend this to auto-send
          // "show me the fix" if the card hasn't landed yet.
          const el = document.querySelector(
            `[data-suggested-fix-id="${CSS.escape(findingId)}"]`,
          )
          if (el instanceof HTMLElement) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' })
          }
        }}
        onViewRow={(row) => {
          // Sprint 047 Session A — route non-top-finding View clicks into
          // a natural-language turn the agent resolves via
          // get_current_state. Consistent with how the rest of Studio
          // talks to the agent.
          const label = row.artifactId
            ? `Show me the current ${row.artifact} (${row.artifactId}).`
            : `Show me the current ${row.artifact}.`
          onSendText?.(label)
        }}
      />
    )
  }

  if (type === 'data-session-diff-summary') {
    // Sprint 058-A F4 — agent-emitted turn summary. Renders inline with
    // the assistant message, not hoisted to a rail. Graceful: partial
    // data still renders because SessionDiffCard defaults missing
    // fields to zero.
    const data = (part.data ?? {}) as SessionDiffSummaryData
    return <SessionDiffCard data={data} />
  }

  if (type === 'data-advisory') {
    const data = part.data ?? {}
    const message = typeof data.message === 'string' ? data.message : ''
    if (!message) return null
    return (
      <div
        className="inline-flex items-center gap-1.5 self-start rounded-md border px-2 py-1 text-[11.5px]"
        style={{
          background: STUDIO_COLORS.warnBg,
          borderColor: STUDIO_COLORS.hairlineSoft,
          color: STUDIO_COLORS.warnFg,
        }}
      >
        <AlertTriangle size={12} strokeWidth={2.25} />
        {message}
      </div>
    )
  }

  if (type === 'data-agent-disabled') {
    return (
      <div
        className="rounded-md border-l-2 px-3 py-2 text-xs"
        style={{
          background: STUDIO_COLORS.dangerBg,
          borderLeftColor: STUDIO_COLORS.dangerFg,
          color: STUDIO_COLORS.dangerFg,
        }}
      >
        The agent is currently disabled.
      </div>
    )
  }

  if (type === 'data-artifact-quote') {
    // Sprint 050 A1 — typographic attribution. Renders existing artifact
    // content (what `get_current_state` surfaced) as a monospace block
    // with a left-rule + source chip, distinct from agent-authored prose.
    // Sprint 051 A B4 — clickable source chip opens the B1 artifact
    // drawer when onOpenArtifact is wired.
    const data = (part.data ?? {}) as {
      artifact?: string
      artifactId?: string
      sourceLabel?: string
      body?: string
    }
    const body = typeof data.body === 'string' ? data.body : ''
    const label =
      typeof data.sourceLabel === 'string' && data.sourceLabel
        ? data.sourceLabel
        : typeof data.artifact === 'string'
          ? `From ${data.artifact}${data.artifactId ? ` · ${data.artifactId.slice(0, 8)}` : ''}`
          : 'Quoted'
    if (!body) return null
    const drawerType = mapQuoteArtifactToDrawer(data.artifact)
    const canOpen =
      Boolean(onOpenArtifact) &&
      drawerType !== null &&
      typeof data.artifactId === 'string' &&
      data.artifactId.length > 0
    const chipProps = canOpen
      ? {
          as: 'button' as const,
          onClick: () =>
            onOpenArtifact?.(drawerType!, data.artifactId!, null),
          title: `Open ${label}`,
        }
      : { as: 'span' as const }
    return (
      <div className="flex flex-col gap-1" data-origin="quoted">
        {chipProps.as === 'button' ? (
          <button
            type="button"
            onClick={chipProps.onClick}
            title={chipProps.title}
            aria-label={chipProps.title}
            className="inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide"
            style={{
              background: STUDIO_COLORS.surfaceSunken,
              borderColor: STUDIO_COLORS.hairlineSoft,
              color: STUDIO_COLORS.accent,
              cursor: 'pointer',
              font: 'inherit',
              letterSpacing: 'inherit',
            }}
          >
            {label} ↗
          </button>
        ) : (
          <span
            className="inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide"
            style={{
              background: STUDIO_COLORS.surfaceSunken,
              borderColor: STUDIO_COLORS.hairlineSoft,
              color: STUDIO_COLORS.inkMuted,
            }}
          >
            {label}
          </span>
        )}
        <pre
          className="max-h-56 overflow-auto whitespace-pre-wrap rounded-r-md px-3 py-2 font-mono text-[12px] leading-[1.5]"
          style={{
            background: STUDIO_COLORS.attributionQuoteBg,
            color: STUDIO_COLORS.ink,
            borderLeft: `2px solid ${STUDIO_COLORS.attributionQuoteRule}`,
            wordBreak: 'break-word',
            margin: 0,
          }}
        >
          {body}
        </pre>
      </div>
    )
  }

  if (type === 'data-suggestion-preview') {
    // Legacy TUNE part — superseded by data-suggested-fix in Studio.
    // Render nothing here so we don't double-surface the same intent.
    // Session D removes the emitter.
    return null
  }

  // Unknown part — muted placeholder per plan §6.3.
  return (
    <span
      className="inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[11px]"
      style={{
        background: STUDIO_COLORS.surfaceSunken,
        color: STUDIO_COLORS.inkSubtle,
      }}
    >
      (unsupported card: {type || 'unknown'})
    </span>
  )
}

// ─── Minimal inline tool-call chip ─────────────────────────────────────────

function ToolCallChip({
  toolName,
  state,
  onClick,
}: {
  toolName: string
  state: string
  onClick?: (origin: HTMLElement | null) => void
}) {
  const short = toolName.replace(/^mcp__[^_]+__/, '').replace(/_/g, ' ')
  const running = state === 'input-available' || state === 'input-start'
  const err = state === 'output-error'
  const style = getStudioCategoryStyle(undefined)
  return (
    <button
      type="button"
      onClick={(e) => onClick?.(e.currentTarget)}
      aria-label={`Tool call details: ${short}`}
      className="inline-flex items-center gap-1.5 self-start rounded-full border-0 px-2.5 py-0.5 text-[11px] font-medium"
      style={{
        background: err
          ? STUDIO_COLORS.dangerBg
          : running
            ? STUDIO_COLORS.surfaceSunken
            : style.bg,
        color: err
          ? STUDIO_COLORS.dangerFg
          : running
            ? STUDIO_COLORS.inkMuted
            : style.fg,
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{
          background: err
            ? STUDIO_COLORS.dangerFg
            : running
              ? STUDIO_COLORS.accent
              : STUDIO_COLORS.successFg,
          opacity: running ? 0.7 : 1,
        }}
      />
      {short}
    </button>
  )
}

/**
 * Sprint 051 A B3 — renders a single agent/user text part, splitting on
 * `[[cite:...]]` markers and replacing them with clickable citation
 * chips. Plain text (no markers) renders exactly as the pre-B3 <p>
 * did — preserves the A1 typographic grammar (data-origin + colour).
 */
function AttributedText({
  text,
  isUser,
  onOpenArtifact,
}: {
  text: string
  isUser: boolean
  onOpenArtifact?: (
    artifact: SessionArtifactType,
    artifactId: string,
    section?: string | null,
  ) => void
}) {
  const tokens = useMemo(() => parseCitations(text), [text])
  const hasCitations = tokens.some((t) => t.kind === 'citation')
  // Bugfix (2026-04-23): prose was always rendered as raw <p>{text}</p>
  // so **bold** / *italic* / ordered lists surfaced as literal markdown.
  // Route plain chunks through AgentProse (react-markdown + remark-gfm)
  // and interleave citation chips inline for the marker-bearing chunks.
  if (!hasCitations) {
    return <AgentProse text={text} isUser={isUser} />
  }
  return (
    <div
      data-origin={isUser ? 'user' : 'agent'}
      style={{
        color: isUser ? STUDIO_COLORS.ink : STUDIO_COLORS.inkMuted,
      }}
    >
      {tokens.map((t, i) =>
        t.kind === 'text' ? (
          // Rendering each text chunk through AgentProse means citations
          // break out of any enclosing paragraph (react-markdown wraps
          // single-line text in <p>), but that matches the pre-fix
          // behaviour — chips sat inline with surrounding prose.
          <AgentProse key={`t:${i}`} text={t.text} isUser={isUser} />
        ) : (
          <CitationChip
            key={`c:${i}:${t.raw}`}
            artifact={t.artifact as CitationArtifactType}
            artifactId={t.artifactId}
            section={t.section}
            onOpen={
              onOpenArtifact
                ? (artifact, id, section) =>
                    onOpenArtifact(
                      artifact as SessionArtifactType,
                      id,
                      section ?? null,
                    )
                : undefined
            }
          />
        ),
      )}
    </div>
  )
}

/**
 * Sprint 051 A B4 — map the quote-part's artifact enum (which includes
 * 'tool_definition') to the drawer's BuildArtifactType enum (which
 * uses 'tool'). Return null for unknown values so the chip stays
 * non-interactive.
 */
function mapQuoteArtifactToDrawer(raw: unknown): SessionArtifactType | null {
  switch (raw) {
    case 'sop':
      return 'sop'
    case 'faq':
      return 'faq'
    case 'system_prompt':
      return 'system_prompt'
    case 'tool':
    case 'tool_definition':
      return 'tool'
    case 'property_override':
      return 'property_override'
    default:
      return null
  }
}

function TypingIndicator() {
  return (
    <div
      className="px-5 py-3 text-[12px]"
      style={{ color: STUDIO_COLORS.inkSubtle }}
    >
      <span>Agent is thinking…</span>
    </div>
  )
}

// ─── Sprint 046 T013 — composer chips (Reference + Test) ───────────────────

function ComposerChips({ draft }: { draft: string }) {
  const shell = useStudioShell()
  return (
    <div
      role="toolbar"
      aria-label="Composer actions"
      className="flex items-center gap-1"
      style={{ paddingLeft: 2 }}
    >
      <button
        type="button"
        data-chip="reference"
        aria-label="Insert reference to an SOP, FAQ, prompt, tool, or property override"
        onClick={(e) => shell.openReferencePicker(e.currentTarget as HTMLElement)}
        className="inline-flex items-center gap-1.5"
        style={{
          padding: '5px 8px',
          borderRadius: STUDIO_TOKENS_V2.radiusSm,
          fontSize: 12,
          color: STUDIO_TOKENS_V2.muted,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = STUDIO_TOKENS_V2.ink2
          e.currentTarget.style.background = STUDIO_TOKENS_V2.surface
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = STUDIO_TOKENS_V2.muted
          e.currentTarget.style.background = 'transparent'
        }}
      >
        <FileIcon size={14} aria-hidden />
        Reference
      </button>
      <button
        type="button"
        data-chip="test"
        aria-label="Test the current draft against the draft reply-pipeline"
        disabled={!draft.trim()}
        onClick={() => {
          if (!draft.trim()) return
          shell.runPreview(draft.trim())
        }}
        className="inline-flex items-center gap-1.5"
        style={{
          padding: '5px 8px',
          borderRadius: STUDIO_TOKENS_V2.radiusSm,
          fontSize: 12,
          color: draft.trim() ? STUDIO_TOKENS_V2.muted : STUDIO_TOKENS_V2.muted2,
          background: 'transparent',
          border: 'none',
          cursor: draft.trim() ? 'pointer' : 'default',
          opacity: draft.trim() ? 1 : 0.5,
        }}
      >
        <FlaskIcon size={14} aria-hidden />
        Test
      </button>
    </div>
  )
}
