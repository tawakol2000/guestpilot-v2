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

export interface StudioChatProps {
  conversationId: string
  greenfield: boolean
  initialMessages: UIMessage[]
  onStateSnapshot?: (data: StateSnapshotData) => void
  onTestResult?: (data: TestPipelineResultData) => void
  onPlanApproved?: (transactionId: string) => void
  onPlanRolledBack?: (transactionId: string) => void
}

export function StudioChat({
  conversationId,
  greenfield,
  initialMessages,
  onStateSnapshot,
  onTestResult,
  onPlanApproved,
  onPlanRolledBack,
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
    <div className="flex h-full min-h-0 flex-col" style={{ background: STUDIO_COLORS.canvas }}>
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex max-w-3xl flex-col">
          {empty ? <StudioEmptyState greenfield={greenfield} onPick={(text) => sendMessage({ text })} /> : null}

          {messages.map((m, idx) => (
            <MessageRow
              key={m.id}
              message={m}
              isLast={idx === messages.length - 1}
              conversationId={conversationId}
              onPlanApproved={onPlanApproved}
              onPlanRolledBack={onPlanRolledBack}
              onSendText={(text) => sendMessage({ text })}
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
  onPlanApproved,
  onPlanRolledBack,
  onSendText,
}: {
  message: UIMessage
  isLast: boolean
  conversationId: string
  onPlanApproved?: (transactionId: string) => void
  onPlanRolledBack?: (transactionId: string) => void
  onSendText?: (text: string) => void
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
            <p
              key={`t:${i}`}
              className="whitespace-pre-wrap text-[14px] leading-[1.55]"
              style={{ color: STUDIO_COLORS.ink, margin: 0 }}
            >
              {p.text ?? ''}
            </p>
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
              onPlanApproved={onPlanApproved}
              onPlanRolledBack={onPlanRolledBack}
              onSendText={onSendText}
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
  onPlanApproved,
  onPlanRolledBack,
  onSendText,
}: {
  part: Record<string, any>
  conversationId: string
  onPlanApproved?: (transactionId: string) => void
  onPlanRolledBack?: (transactionId: string) => void
  onSendText?: (text: string) => void
}) {
  const rejectionConversationId = conversationId
  if (!part || typeof part !== 'object') return null
  const type = typeof part.type === 'string' ? part.type : ''

  if (type.startsWith('tool-')) {
    const toolName = part.toolName ?? type.slice('tool-'.length)
    const state = part.state ?? 'input-available'
    return <ToolCallChip toolName={toolName} state={state} />
  }

  if (type === 'data-build-plan') {
    return (
      <PlanChecklist
        data={part.data as BuildPlanData}
        onApproved={onPlanApproved}
        onRolledBack={onPlanRolledBack}
      />
    )
  }

  if (type === 'data-test-pipeline-result') {
    // Render inline too (parent right rail already has a copy via
    // onTestResult hoisting; showing the card inline makes it easy to
    // reference while reading the conversation).
    return (
      <div style={{ maxWidth: 720 }}>
        <TestPipelineResult data={part.data as TestPipelineResultData} />
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
          await apiRejectSuggestedFix(id, {
            conversationId: rejectionConversationId,
            category: typeof data.category === 'string' ? data.category : undefined,
            subLabel: typeof data.subLabel === 'string' ? data.subLabel : undefined,
            target: (data.target as { artifactId?: string; sectionId?: string; slotKey?: string }) ?? undefined,
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
}: {
  toolName: string
  state: string
}) {
  const short = toolName.replace(/^mcp__[^_]+__/, '').replace(/_/g, ' ')
  const running = state === 'input-available' || state === 'input-start'
  const err = state === 'output-error'
  const style = getStudioCategoryStyle(undefined)
  return (
    <span
      className="inline-flex items-center gap-1.5 self-start rounded-full px-2.5 py-0.5 text-[11px] font-medium"
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
    </span>
  )
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
