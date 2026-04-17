'use client'
/**
 * Feature 041 sprint 04 — /tuning chat panel.
 *
 * Mounts in the left-rail seam that sprint-03 reserved ("Conversations —
 * coming soon"). Drives a multi-turn tuning-agent conversation via the
 * Vercel AI SDK `useChat` hook with a custom transport that includes our
 * JWT auth header and the conversationId/suggestionId body params.
 *
 * Rehydrates existing TuningMessage rows on mount via
 * apiGetTuningConversation so long-running conversations survive reload.
 *
 * Sprint 07: restyled with rounded message bubbles, a focus-ring input,
 * and a circular send button.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import { ArrowUp, Pin } from 'lucide-react'
import {
  apiGetTuningConversation,
  getToken,
  tuningChatEndpoint,
  type TuningConversationDetail,
  type TuningConversationMessage,
} from '@/lib/api'
import { TUNING_COLORS } from './tokens'
import {
  AgentDisabledCard,
  EvidenceInline,
  FollowUpPart,
  SuggestionCard,
  TextPart,
  ThinkingSection,
  ToolCallPart,
  type EvidenceInlineData,
  type SuggestionPreviewData,
} from './chat-parts'

export function ChatPanel({
  conversationId,
  suggestionId,
}: {
  conversationId: string
  suggestionId?: string | null
}) {
  const [initialMessages, setInitialMessages] = useState<UIMessage[] | null>(null)
  const [anchor, setAnchor] = useState<TuningConversationDetail['anchorMessage']>(null)
  const [hydrateError, setHydrateError] = useState<string | null>(null)

  // Rehydrate the conversation on mount or when conversationId changes.
  useEffect(() => {
    let cancelled = false
    setInitialMessages(null)
    setAnchor(null)
    apiGetTuningConversation(conversationId)
      .then(({ conversation }) => {
        if (cancelled) return
        setAnchor(conversation.anchorMessage)
        setInitialMessages(rehydrateMessages(conversation.messages))
      })
      .catch((err) => {
        if (cancelled) return
        setHydrateError(err instanceof Error ? err.message : String(err))
        setInitialMessages([])
      })
    return () => {
      cancelled = true
    }
  }, [conversationId])

  if (initialMessages === null) {
    return (
      <div className="flex h-full items-center justify-center px-4 py-6 text-sm text-[#9CA3AF]">
        Loading conversation…
      </div>
    )
  }
  if (hydrateError) {
    return (
      <div
        className="mx-4 mt-4 rounded-lg border-l-2 px-4 py-3 text-sm"
        style={{
          background: TUNING_COLORS.dangerBg,
          borderLeftColor: TUNING_COLORS.dangerFg,
          color: TUNING_COLORS.dangerFg,
        }}
      >
        {hydrateError}
      </div>
    )
  }

  return (
    <ChatPanelInner
      conversationId={conversationId}
      suggestionId={suggestionId ?? null}
      anchor={anchor}
      initialMessages={initialMessages}
    />
  )
}

function ChatPanelInner({
  conversationId,
  suggestionId,
  anchor,
  initialMessages,
}: {
  conversationId: string
  suggestionId: string | null
  anchor: TuningConversationDetail['anchorMessage']
  initialMessages: UIMessage[]
}) {
  const openerRef = useRef(false)
  const transport = useMemo(() => {
    return new DefaultChatTransport<UIMessage>({
      api: tuningChatEndpoint(),
      credentials: 'omit',
      headers: (): Record<string, string> => {
        const token = getToken()
        return token ? { Authorization: `Bearer ${token}` } : {}
      },
      body: () => {
        const payload: Record<string, unknown> = { conversationId, suggestionId }
        // Flag the first turn of an empty conversation so the backend skips
        // persisting the trigger prompt as a visible user turn.
        if (openerRef.current) {
          payload.isOpener = true
          openerRef.current = false
        }
        return payload
      },
    })
  }, [conversationId, suggestionId])

  const { messages, sendMessage, status, error } = useChat({
    id: conversationId,
    messages: initialMessages,
    transport,
  })

  const [draft, setDraft] = useState('')
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [scrollShadows, setScrollShadows] = useState({ top: false, bottom: false })

  useEffect(() => {
    if (!scrollerRef.current) return
    // Sprint 07: smooth scroll instead of a jump.
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

  const sendCannedSanction = useCallback(
    (action: 'apply' | 'queue' | 'reject' | 'edit', previewId: string) => {
      const text =
        action === 'apply'
          ? `Yes, apply that (previewId: ${previewId}).`
          : action === 'queue'
          ? `Queue it for review (previewId: ${previewId}).`
          : action === 'reject'
          ? `Reject that one (previewId: ${previewId}).`
          : `I want to edit that first (previewId: ${previewId}). Show me the editable text.`
      sendMessage({ text })
    },
    [sendMessage],
  )

  const proactiveRequested = useRef(false)
  useEffect(() => {
    if (proactiveRequested.current) return
    if (initialMessages.length > 0) return
    if (messages.length > 0) return
    proactiveRequested.current = true
    openerRef.current = true
    const openerPrompt = anchor
      ? `I just opened this conversation to discuss a specific main-AI message (id=${anchor.id}). Please summarize what the main AI did on that message using fetch_evidence_bundle, and tell me what stands out. Keep it tight.`
      : `Greet me and summarize the pending suggestion queue. If there's one obvious place to start, say so.`
    sendMessage({ text: openerPrompt })
  }, [anchor, initialMessages, messages, sendMessage])

  const isStreaming = status === 'streaming'
  const isSending = status === 'submitted'
  const trimmedDraft = draft.trim()
  const canSend = !!trimmedDraft && !isStreaming && !isSending

  return (
    // Bug fix (round 16) — `min-h-0` on nested flex columns is the classic
    // Tailwind/Flexbox fix for "overflow-auto children don't actually
    // shrink". Without it, a very tall transcript inside `flex-1` can
    // push its parent past the viewport despite the outer h-dvh lock,
    // because flex items default to min-height:auto (content height).
    <div className="flex h-full min-h-0 flex-col bg-white">
      {anchor ? (
        // Compact anchor banner — single row with pin + inline excerpt.
        // Reduces from ~72px to ~36px of vertical space.
        <div
          className="flex items-center gap-2 border-b px-4 py-2"
          style={{
            borderColor: TUNING_COLORS.hairlineSoft,
            background: TUNING_COLORS.accentSoft,
          }}
        >
          <Pin size={11} strokeWidth={2} className="shrink-0 text-[#6C5CE7]" aria-hidden />
          <span className="shrink-0 text-xs font-medium text-[#6B7280]">
            Anchored to
          </span>
          <span className="truncate text-xs text-[#1A1A1A]" title={anchor.content}>
            {anchor.content.slice(0, 200)}
          </span>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
      <div
        ref={scrollerRef}
        onScroll={(e) => {
          const el = e.currentTarget
          setScrollShadows({
            top: el.scrollTop > 4,
            bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 4,
          })
        }}
        className="h-full overflow-auto px-4 py-4 md:px-6 md:py-5"
        style={{ background: TUNING_COLORS.canvas }}
      >
        {messages.length === 0 ? (
          <div className="mt-4 flex items-center justify-center gap-2 text-xs text-[#9CA3AF]">
            <span
              aria-hidden
              className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[#6C5CE7] motion-reduce:animate-none"
            />
            <span>Starting conversation…</span>
          </div>
        ) : null}

        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {messages.map((m, idx) => {
            // Hide the first-ever user turn when it was the proactive-opener trigger.
            const isFirstUserTrigger =
              idx === 0 &&
              m.role === 'user' &&
              messages.length > 0 &&
              initialMessages.length === 0 &&
              isOpenerTriggerText(((m as any).parts ?? []) as Array<{ type?: string; text?: string }>)
            if (isFirstUserTrigger) return null
            return (
              <MessageRow
                key={m.id}
                message={m}
                onSuggestionAction={sendCannedSanction}
              />
            )
          })}

          {isStreaming ? <TypingIndicator /> : null}
        </div>

        {error ? (
          <div
            className="mx-auto mt-4 max-w-3xl rounded-lg border-l-2 px-4 py-3 text-sm"
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
      {/* Scroll shadow overlays */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-8 transition-opacity duration-200"
        style={{
          background: `linear-gradient(to bottom, ${TUNING_COLORS.canvas}, rgba(249,250,251,0))`,
          opacity: scrollShadows.top ? 1 : 0,
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-8 transition-opacity duration-200"
        style={{
          background: `linear-gradient(to top, ${TUNING_COLORS.canvas}, rgba(249,250,251,0))`,
          opacity: scrollShadows.bottom ? 1 : 0,
        }}
      />
      </div>

      <form
        onSubmit={onSubmit}
        className="border-t px-4 py-3 md:px-6"
        style={{
          borderColor: TUNING_COLORS.hairlineSoft,
          background: TUNING_COLORS.surfaceRaised,
        }}
      >
        <div
          className="mx-auto flex max-w-3xl items-end gap-2 rounded-xl border bg-white p-1.5 transition-all duration-200 focus-within:border-[#6C5CE7] focus-within:ring-2 focus-within:ring-[#F0EEFF]"
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
            rows={1}
            placeholder={
              isStreaming || isSending
                ? 'Agent is replying…'
                : 'Tell your tuner what you see.'
            }
            disabled={isStreaming || isSending}
            className="min-h-[36px] flex-1 resize-none border-0 bg-transparent px-2.5 py-2 text-sm leading-5 text-[#1A1A1A] outline-none placeholder:text-[#9CA3AF] disabled:opacity-60"
            aria-label="Message the tuning agent"
          />
          <button
            type="submit"
            disabled={!canSend}
            aria-label="Send message"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white shadow-sm transition-all duration-200 hover:shadow-md disabled:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A29BFE] focus-visible:ring-offset-2"
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

function MessageRow({
  message,
  onSuggestionAction,
}: {
  message: UIMessage
  onSuggestionAction: (action: 'apply' | 'queue' | 'reject' | 'edit', previewId: string) => void
}) {
  const isUser = message.role === 'user'
  const parts = (message as any).parts as Array<Record<string, any>> | undefined

  // Split parts into "bubble text" (text/reasoning) vs "standalone cards"
  // (tool calls, suggestion preview, evidence, follow-up). This way a user
  // bubble renders as a single accent chip and an agent response renders
  // as a text bubble followed by any attached tool/suggestion cards.
  const bubbleParts: Array<Record<string, any>> = []
  const standaloneParts: Array<Record<string, any>> = []
  for (const p of parts ?? []) {
    const type = typeof p?.type === 'string' ? p.type : ''
    if (type === 'text' || type === 'reasoning') bubbleParts.push(p)
    else standaloneParts.push(p)
  }

  return (
    <div
      // Subtle fade + translate-up on mount so newly-arrived messages ease
      // into place instead of popping. Respects reduced-motion via Tailwind's
      // built-in `animate-in` media query contract.
      className={`flex flex-col gap-2 animate-in fade-in slide-in-from-bottom-1 duration-200 ${isUser ? 'items-end' : 'items-start'}`}
    >
      {bubbleParts.length > 0 ? (
        <div
          className="max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm transition-shadow duration-200"
          style={{
            background: isUser ? TUNING_COLORS.accent : TUNING_COLORS.surfaceRaised,
            color: isUser ? '#FFFFFF' : TUNING_COLORS.ink,
            border: isUser ? 'none' : `1px solid ${TUNING_COLORS.hairlineSoft}`,
            borderTopRightRadius: isUser ? 6 : undefined,
            borderTopLeftRadius: !isUser ? 6 : undefined,
          }}
        >
          {bubbleParts.map((p, idx) => {
            const type = typeof p?.type === 'string' ? p.type : ''
            if (type === 'text') {
              return <TextPart key={idx} text={p.text ?? ''} inverted={isUser} />
            }
            if (type === 'reasoning') {
              return <ThinkingSection key={idx} text={p.text ?? ''} />
            }
            return null
          })}
        </div>
      ) : null}

      {standaloneParts.length > 0 ? (
        <div
          className={`flex w-full flex-col gap-2 ${isUser ? 'items-end' : 'items-start'}`}
        >
          {standaloneParts.map((p, idx) => (
            <StandalonePart
              key={idx}
              part={p}
              onSuggestionAction={onSuggestionAction}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function StandalonePart({
  part,
  onSuggestionAction,
}: {
  part: Record<string, any>
  onSuggestionAction: (action: 'apply' | 'queue' | 'reject' | 'edit', previewId: string) => void
}) {
  if (!part || typeof part !== 'object') return null
  const type = typeof part.type === 'string' ? part.type : ''
  if (type.startsWith('tool-')) {
    const toolName = part.toolName ?? type.slice('tool-'.length)
    const state = part.state ?? 'input-available'
    return (
      <ToolCallPart
        toolName={toolName}
        input={part.input}
        output={part.output}
        state={state}
      />
    )
  }
  if (type === 'data-suggestion-preview') {
    const data = part.data as SuggestionPreviewData
    return <SuggestionCard data={data} onAction={(a) => onSuggestionAction(a, data.previewId)} />
  }
  if (type === 'data-evidence-inline') {
    return <EvidenceInline data={part.data as EvidenceInlineData} />
  }
  if (type === 'data-follow-up') {
    return <FollowUpPart suggestion={part.data?.suggestion ?? ''} />
  }
  if (type === 'data-agent-disabled') {
    return <AgentDisabledCard reason={part.data?.reason ?? 'disabled'} />
  }
  return null
}

function TypingIndicator() {
  return (
    // Compact typing indicator: smaller bubble, tighter dots.
    <div
      className="flex items-center gap-1.5 self-start rounded-2xl border bg-white px-3 py-2 shadow-sm"
      style={{ borderColor: TUNING_COLORS.hairlineSoft, borderTopLeftRadius: 6 }}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block h-1 w-1 rounded-full bg-[#9CA3AF] motion-reduce:animate-none"
          style={{
            animation: 'typing-bounce 1.4s ease-in-out infinite',
            animationDelay: `${i * 0.15}s`,
          }}
        />
      ))}
    </div>
  )
}

/**
 * Detect the client-originated proactive-opener trigger text. The backend
 * does not persist this turn, so on reload the user's transcript shows
 * only the agent's greeting. This check hides the single-session trigger
 * from the visible message list on the first turn.
 */
function isOpenerTriggerText(parts: Array<{ type?: string; text?: string }>): boolean {
  const text = parts
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text!)
    .join('\n')
  if (!text) return false
  return (
    text.startsWith('I just opened this conversation to discuss a specific main-AI message') ||
    text.startsWith('Greet me and summarize the pending suggestion queue.')
  )
}

/**
 * Convert persisted TuningMessage rows into UIMessage shape. Our backend
 * already stores the parts array in Vercel AI SDK shape, so this is mostly
 * a wrapper + id normalization.
 */
function rehydrateMessages(rows: TuningConversationMessage[]): UIMessage[] {
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
