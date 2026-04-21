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
import { ArrowUp, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { getToken } from '@/lib/api'
import {
  apiAcceptSuggestedFix,
  apiRejectSuggestedFix,
  buildTurnEndpoint,
  type BuildPlanData,
  type TestPipelineResultData,
} from '@/lib/build-api'
import { STUDIO_COLORS, getStudioCategoryStyle } from './tokens'
import { SuggestedFixCard, type SuggestedFixTarget } from './suggested-fix'
import { QuestionChoicesCard } from './question-choices'
import { AuditReportCard, type AuditReportRowData } from './audit-report'
import type { StateSnapshotData } from './state-snapshot'
import { ReasoningLine } from './reasoning-line'
import { PlanChecklist } from '../build/plan-checklist'
import { TestPipelineResult } from '../build/test-pipeline-result'
import { ToolCallDrawer, type ToolCallDrawerPart } from './tool-call-drawer'
import type {
  SessionArtifact,
  SessionArtifactType,
} from './session-artifacts'
import {
  parseCitations,
  type CitationArtifactType,
} from './citation-parser'
import { CitationChip } from './citation-chip'

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
}

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
}: StudioChatProps) {
  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: buildTurnEndpoint(),
        credentials: 'omit',
        headers: (): Record<string, string> => {
          const token = getToken()
          return token ? { Authorization: `Bearer ${token}` } : {}
        },
        body: () => ({ conversationId }),
      }),
    [conversationId],
  )

  const { messages, sendMessage, status, error } = useChat({
    id: conversationId,
    messages: initialMessages,
    transport,
  })

  // Hoist data-state-snapshot + data-test-pipeline-result to the parent
  // (right rail). Track forwarded ids so rerenders don't re-fire the
  // callback.
  const forwardedIds = useRef<Set<string>>(new Set())
  useEffect(() => {
    for (const m of messages) {
      const parts = (m as any).parts as Array<Record<string, any>> | undefined
      if (!Array.isArray(parts)) continue
      for (const p of parts) {
        const t = typeof p?.type === 'string' ? p.type : ''
        if (t !== 'data-state-snapshot' && t !== 'data-test-pipeline-result') continue
        const id = typeof p.id === 'string' ? p.id : `${m.id}:${t}`
        if (forwardedIds.current.has(id)) continue
        forwardedIds.current.add(id)
        if (t === 'data-state-snapshot' && p.data) {
          onStateSnapshot?.(p.data as StateSnapshotData)
        } else if (t === 'data-test-pipeline-result' && p.data) {
          onTestResult?.(p.data as TestPipelineResultData)
        }
      }
    }
  }, [messages, onStateSnapshot, onTestResult])

  const [draft, setDraft] = useState('')
  const scrollerRef = useRef<HTMLDivElement>(null)

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

  useEffect(() => {
    if (!scrollerRef.current) return
    scrollerRef.current.scrollTo({
      top: scrollerRef.current.scrollHeight,
      behavior: 'smooth',
    })
  }, [messages])

  const onSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      const text = draft.trim()
      if (!text) return
      setDraft('')
      sendMessage({ text })
    },
    [draft, sendMessage],
  )

  const isStreaming = status === 'streaming'
  const isSending = status === 'submitted'
  const canSend = !!draft.trim() && !isStreaming && !isSending

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
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-auto">
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

          {isStreaming || isSending ? <TypingIndicator /> : null}

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
        className="border-t px-5 py-3"
        style={{
          borderColor: STUDIO_COLORS.hairline,
          background: STUDIO_COLORS.surfaceRaised,
        }}
      >
        <div
          className="mx-auto flex max-w-3xl items-end gap-2 rounded-lg border bg-white p-1.5"
          style={{ borderColor: STUDIO_COLORS.hairline }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                if (isStreaming || isSending) return
                onSubmit(e as unknown as React.FormEvent)
              }
            }}
            rows={2}
            placeholder={
              isStreaming || isSending
                ? 'Agent is replying…'
                : greenfield
                  ? 'Tell me about your properties.'
                  : 'What do you want to build or change?'
            }
            disabled={isStreaming || isSending}
            className="min-h-[44px] flex-1 resize-none border-0 bg-transparent px-2.5 py-2 text-sm leading-5 outline-none placeholder:text-[#9CA3AF] disabled:opacity-60"
            style={{ color: STUDIO_COLORS.ink }}
            aria-label="Message the studio agent"
          />
          <button
            type="submit"
            disabled={!canSend}
            aria-label="Send message"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md disabled:opacity-60"
            style={{
              background: canSend ? STUDIO_COLORS.ink : STUDIO_COLORS.surfaceSunken,
              color: canSend ? '#FFFFFF' : STUDIO_COLORS.inkSubtle,
            }}
          >
            <ArrowUp size={16} strokeWidth={2.25} aria-hidden />
          </button>
        </div>
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
  // Kept minimal per plan §6.2 — no suggestion grid, one plain hint and a
  // single "get started" prompt. The agent's first turn will emit a
  // question_choices card, which is the real guided path.
  const prompt = greenfield
    ? 'I run short-let apartments. Help me set this up from scratch.'
    : 'Review my current setup and tell me the single biggest gap.'
  const headline = greenfield ? 'Let’s set up your AI.' : 'What should we change?'
  const sub = greenfield
    ? 'Tell me about your business in plain English. I’ll ask a few follow-up questions and never write anything without your sign-off.'
    : 'Ask me to audit your setup, add an SOP, change an FAQ, or rewrite a prompt section. Every change is atomic and revertable.'
  return (
    <section className="px-6 py-10">
      <div className="mx-auto max-w-xl">
        <h1 className="text-[18px] font-semibold leading-tight" style={{ color: STUDIO_COLORS.ink }}>
          {headline}
        </h1>
        <p className="mt-2 text-[13.5px] leading-5" style={{ color: STUDIO_COLORS.inkMuted }}>
          {sub}
        </p>
        <button
          type="button"
          onClick={() => onPick(prompt)}
          className="mt-5 inline-flex items-center gap-2 rounded-md border px-3 py-2 text-[13px] font-medium"
          style={{
            background: STUDIO_COLORS.surfaceSunken,
            borderColor: STUDIO_COLORS.hairline,
            color: STUDIO_COLORS.ink,
          }}
        >
          {greenfield ? 'Start with a walkthrough' : 'Start with an audit'}
        </button>
      </div>
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

  const textParts: Array<Record<string, any>> = []
  const reasoningParts: Array<Record<string, any>> = []
  const standaloneParts: Array<Record<string, any>> = []
  for (const p of parts) {
    const t = typeof p?.type === 'string' ? p.type : ''
    if (t === 'text') textParts.push(p)
    else if (t === 'reasoning') reasoningParts.push(p)
    else standaloneParts.push(p)
  }

  return (
    <div
      className="px-5 py-4"
      style={{
        borderBottom: isLast ? undefined : `1px solid ${STUDIO_COLORS.hairlineSoft}`,
      }}
    >
      <div
        className="mb-1 text-[11px] font-semibold uppercase tracking-wide"
        style={{ color: isUser ? STUDIO_COLORS.accent : STUDIO_COLORS.inkMuted }}
      >
        {isUser ? 'You' : 'Agent'}
      </div>

      {textParts.length > 0 && (
        <div className="flex flex-col gap-2">
          {textParts.map((p, i) => (
            <AttributedText
              key={`t:${i}`}
              text={p.text ?? ''}
              isUser={isUser}
              onOpenArtifact={onOpenArtifact}
            />
          ))}
        </div>
      )}

      {reasoningParts.length > 0 && (
        <div className="mt-1.5">
          {reasoningParts.map((p, i) => (
            <ReasoningLine key={`r:${i}`} content={p.text ?? ''} />
          ))}
        </div>
      )}

      {standaloneParts.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
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
  if (!hasCitations) {
    return (
      <p
        data-origin={isUser ? 'user' : 'agent'}
        className="whitespace-pre-wrap text-[14px] leading-[1.55]"
        style={{
          color: isUser ? STUDIO_COLORS.ink : STUDIO_COLORS.inkMuted,
          margin: 0,
        }}
      >
        {text}
      </p>
    )
  }
  return (
    <p
      data-origin={isUser ? 'user' : 'agent'}
      className="whitespace-pre-wrap text-[14px] leading-[1.55]"
      style={{
        color: isUser ? STUDIO_COLORS.ink : STUDIO_COLORS.inkMuted,
        margin: 0,
      }}
    >
      {tokens.map((t, i) =>
        t.kind === 'text' ? (
          <span key={`t:${i}`}>{t.text}</span>
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
    </p>
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
