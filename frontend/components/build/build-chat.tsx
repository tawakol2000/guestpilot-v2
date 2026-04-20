'use client'

/**
 * Sprint 045 Gate 6 — BuildChat. The center pane of the /build page.
 *
 * Lifts the /tuning chat pattern (Vercel AI SDK `useChat` + DefaultChatTransport
 * + UIMessage parts) and adapts it for the BUILD-only SSE part vocabulary:
 *
 *   - `data-build-plan`             → PlanChecklist (renders inline)
 *   - `data-test-pipeline-result`   → TestPipelineResult (hoisted to right pane)
 *   - `data-suggestion-preview`     → ignored here (TUNE-only; BUILD never emits
 *                                     it, but the parser handles it gracefully)
 *
 * Test-pipeline results are HOISTED to the right preview panel via the
 * `onTestResult` callback. Plans render inline in the chat so approve/discard
 * actions sit next to the conversation that produced them — matches
 * ui-mockup.html scene 1.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import { ArrowUp } from 'lucide-react'
import { getToken } from '@/lib/api'
import { buildTurnEndpoint, type BuildPlanData, type TestPipelineResultData } from '@/lib/build-api'
import { TUNING_COLORS } from '../tuning/tokens'
import { TextPart, ThinkingSection, ToolCallPart } from '../tuning/chat-parts'
import { PlanChecklist } from './plan-checklist'

export function BuildChat({
  conversationId,
  greenfield,
  initialMessages,
  onTestResult,
  onPlanApproved,
  onPlanRolledBack,
}: {
  conversationId: string
  greenfield: boolean
  initialMessages: UIMessage[]
  onTestResult?: (data: TestPipelineResultData) => void
  onPlanApproved?: (transactionId: string) => void
  onPlanRolledBack?: (transactionId: string) => void
}) {
  const transport = useMemo(() => {
    return new DefaultChatTransport<UIMessage>({
      api: buildTurnEndpoint(),
      credentials: 'omit',
      headers: (): Record<string, string> => {
        const token = getToken()
        return token ? { Authorization: `Bearer ${token}` } : {}
      },
      body: () => ({ conversationId }),
    })
  }, [conversationId])

  const { messages, sendMessage, status, error } = useChat({
    id: conversationId,
    messages: initialMessages,
    transport,
  })

  // Hoist test-pipeline results to the parent (preview panel) as they
  // arrive. We track which ones have already been forwarded so rerenders
  // don't fire the callback more than once per part.
  const forwardedTestIds = useRef<Set<string>>(new Set())
  useEffect(() => {
    for (const m of messages) {
      const parts = (m as any).parts as Array<Record<string, any>> | undefined
      if (!Array.isArray(parts)) continue
      for (const p of parts) {
        if (p?.type !== 'data-test-pipeline-result') continue
        const id = typeof p.id === 'string' ? p.id : `${m.id}:${p.type}`
        if (forwardedTestIds.current.has(id)) continue
        forwardedTestIds.current.add(id)
        if (p.data) onTestResult?.(p.data as TestPipelineResultData)
      }
    }
  }, [messages, onTestResult])

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

  const showEmptyHero = messages.length === 0

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: TUNING_COLORS.canvas }}>
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-auto px-6 py-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {showEmptyHero ? (
            <BuildHero greenfield={greenfield} onPick={(text) => sendMessage({ text })} />
          ) : null}

          {messages.map((m) => (
            <MessageRow
              key={m.id}
              message={m}
              onPlanApproved={onPlanApproved}
              onPlanRolledBack={onPlanRolledBack}
            />
          ))}

          {isStreaming ? <TypingIndicator /> : null}

          {error ? (
            <div
              className="rounded-lg border-l-2 px-4 py-3 text-sm"
              style={{
                background: TUNING_COLORS.dangerBg,
                borderLeftColor: TUNING_COLORS.dangerFg,
                color: TUNING_COLORS.dangerFg,
              }}
            >
              {error.message}
            </div>
          ) : null}
        </div>
      </div>

      <form
        onSubmit={onSubmit}
        className="border-t px-6 py-3"
        style={{
          borderColor: TUNING_COLORS.hairline,
          background: TUNING_COLORS.surfaceRaised,
        }}
      >
        <div
          className="mx-auto flex max-w-3xl items-end gap-2 rounded-xl border bg-white p-1.5 focus-within:border-[#6C5CE7] focus-within:ring-2 focus-within:ring-[#F0EEFF]"
          style={{ borderColor: TUNING_COLORS.hairline }}
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
            style={{ color: TUNING_COLORS.ink }}
            aria-label="Message the build agent"
          />
          <button
            type="submit"
            disabled={!canSend}
            aria-label="Send message"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white shadow-sm disabled:shadow-none"
            style={{
              background: canSend ? TUNING_COLORS.accent : TUNING_COLORS.hairline,
              color: canSend ? '#FFFFFF' : TUNING_COLORS.inkSubtle,
            }}
          >
            <ArrowUp size={16} strokeWidth={2.25} aria-hidden />
          </button>
        </div>
      </form>
    </div>
  )
}

// ─── Empty-state hero ──────────────────────────────────────────────────────

function BuildHero({
  greenfield,
  onPick,
}: {
  greenfield: boolean
  onPick: (text: string) => void
}) {
  const suggestions = greenfield
    ? [
        'I run short-let apartments. Help me build this from scratch.',
        'I manage vacation rentals across a few cities. Different channels, different rules.',
        'I just connected Hostaway. Walk me through what you need to know.',
        'Here is one real guest message I handled yesterday — use it as the starting point.',
      ]
    : [
        'Review my current setup and tell me what is missing.',
        'Something is wrong with how the AI is handling late check-ins.',
        'Add a new SOP for damage reports.',
        'Test a message through the pipeline: "What time can I check in?"',
      ]
  return (
    <section className="py-6 text-center">
      <div
        aria-hidden
        className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl text-xl font-bold text-white"
        style={{
          background: `linear-gradient(135deg, ${TUNING_COLORS.accent}, ${TUNING_COLORS.accentMuted})`,
        }}
      >
        gp
      </div>
      <h1
        className="text-2xl font-semibold"
        style={{ color: TUNING_COLORS.ink, fontFamily: 'Playfair Display, Georgia, serif' }}
      >
        {greenfield ? (
          <>
            Let's <em style={{ color: TUNING_COLORS.accent }}>build</em> your AI.
          </>
        ) : (
          <>
            What should we <em style={{ color: TUNING_COLORS.accent }}>change</em>?
          </>
        )}
      </h1>
      <p className="mx-auto mt-2 max-w-lg text-sm" style={{ color: TUNING_COLORS.inkMuted }}>
        {greenfield
          ? 'Tell me about your business in plain English. I’ll ask a few follow-up questions, draft a plan, and write nothing without your sign-off.'
          : 'I can add SOPs, FAQs, custom tools, or rewrite your system prompt. Every change is atomic and revertable.'}
      </p>
      <div className="mx-auto mt-8 grid max-w-2xl grid-cols-1 gap-2 md:grid-cols-2">
        {suggestions.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            className="rounded-xl border bg-white px-4 py-3 text-left text-[13px] transition-all hover:-translate-y-px hover:border-[#6C5CE7] hover:shadow-md"
            style={{ borderColor: TUNING_COLORS.hairline, color: TUNING_COLORS.ink }}
          >
            {s}
          </button>
        ))}
      </div>
    </section>
  )
}

// ─── Message / part rendering ──────────────────────────────────────────────

function MessageRow({
  message,
  onPlanApproved,
  onPlanRolledBack,
}: {
  message: UIMessage
  onPlanApproved?: (transactionId: string) => void
  onPlanRolledBack?: (transactionId: string) => void
}) {
  const isUser = message.role === 'user'
  const parts = ((message as any).parts as Array<Record<string, any>>) ?? []

  const bubbleParts: Array<Record<string, any>> = []
  const standaloneParts: Array<Record<string, any>> = []
  for (const p of parts) {
    const t = typeof p?.type === 'string' ? p.type : ''
    if (t === 'text' || t === 'reasoning') bubbleParts.push(p)
    else standaloneParts.push(p)
  }

  return (
    <div className={`flex flex-col gap-2 ${isUser ? 'items-end' : 'items-start'}`}>
      {bubbleParts.length > 0 ? (
        <div
          className="max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm"
          style={{
            background: isUser ? TUNING_COLORS.accent : TUNING_COLORS.surfaceRaised,
            color: isUser ? '#FFFFFF' : TUNING_COLORS.ink,
            border: isUser ? 'none' : `1px solid ${TUNING_COLORS.hairlineSoft}`,
            borderTopRightRadius: isUser ? 6 : undefined,
            borderTopLeftRadius: !isUser ? 6 : undefined,
          }}
        >
          {bubbleParts.map((p, idx) => {
            const t = typeof p?.type === 'string' ? p.type : ''
            if (t === 'text') return <TextPart key={idx} text={p.text ?? ''} inverted={isUser} />
            if (t === 'reasoning') return <ThinkingSection key={idx} text={p.text ?? ''} />
            return null
          })}
        </div>
      ) : null}

      {standaloneParts.length > 0 ? (
        <div className={`flex w-full flex-col gap-2 ${isUser ? 'items-end' : 'items-start'}`}>
          {standaloneParts.map((p, idx) => (
            <StandalonePart
              key={idx}
              part={p}
              onPlanApproved={onPlanApproved}
              onPlanRolledBack={onPlanRolledBack}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function StandalonePart({
  part,
  onPlanApproved,
  onPlanRolledBack,
}: {
  part: Record<string, any>
  onPlanApproved?: (transactionId: string) => void
  onPlanRolledBack?: (transactionId: string) => void
}) {
  if (!part || typeof part !== 'object') return null
  const type = typeof part.type === 'string' ? part.type : ''

  if (type.startsWith('tool-')) {
    const toolName = part.toolName ?? type.slice('tool-'.length)
    const state = part.state ?? 'input-available'
    return <ToolCallPart toolName={toolName} input={part.input} output={part.output} state={state} />
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
  // data-test-pipeline-result is rendered in the right preview panel — we
  // hoist it via onTestResult in the parent. Rendering inline too would
  // duplicate it, so we render nothing here.
  if (type === 'data-test-pipeline-result') return null
  // Unknown parts: render nothing. Do NOT add new part types here without
  // backend changes (spec §11 + session-5 hard constraint).
  return null
}

function TypingIndicator() {
  return (
    <div
      className="flex items-center gap-1.5 self-start rounded-2xl border bg-white px-3 py-2 shadow-sm"
      style={{ borderColor: TUNING_COLORS.hairlineSoft, borderTopLeftRadius: 6 }}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block h-1 w-1 rounded-full bg-[#9CA3AF] motion-reduce:animate-none"
          style={{ animation: 'typing-bounce 1.4s ease-in-out infinite', animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </div>
  )
}
