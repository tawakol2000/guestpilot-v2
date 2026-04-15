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
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
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
      <div
        className="flex h-full items-center justify-center px-4 py-6 text-[12px]"
        style={{ color: TUNING_COLORS.inkSubtle }}
      >
        Loading conversation…
      </div>
    )
  }
  if (hydrateError) {
    return (
      <div
        className="p-4 text-[12px]"
        style={{ color: TUNING_COLORS.diffDelFg }}
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
  // Build the transport once, memoed on conversationId so changing
  // conversations creates a fresh transport (auth header reads the token
  // lazily via the header factory so expired tokens refresh cleanly).
  const transport = useMemo(() => {
    return new DefaultChatTransport<UIMessage>({
      api: tuningChatEndpoint(),
      credentials: 'omit',
      headers: (): Record<string, string> => {
        const token = getToken()
        return token ? { Authorization: `Bearer ${token}` } : {}
      },
      body: () => ({ conversationId, suggestionId }),
    })
  }, [conversationId, suggestionId])

  const { messages, sendMessage, status, error } = useChat({
    id: conversationId,
    messages: initialMessages,
    transport,
  })

  const [draft, setDraft] = useState('')
  const scrollerRef = useRef<HTMLDivElement>(null)

  // Auto-scroll on new message.
  useEffect(() => {
    if (!scrollerRef.current) return
    scrollerRef.current.scrollTo({ top: scrollerRef.current.scrollHeight })
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
    // Proactive opener: if the conversation has no messages yet, send a
    // zero-content turn ("please greet the manager") to kick the agent
    // into action. The agent's system prompt handles the actual greeting
    // — this is just the trigger.
    if (proactiveRequested.current) return
    if (initialMessages.length > 0) return
    if (messages.length > 0) return
    proactiveRequested.current = true
    const openerPrompt = anchor
      ? `I just opened this conversation to discuss a specific main-AI message (id=${anchor.id}). Please summarize what the main AI did on that message using fetch_evidence_bundle, and tell me what stands out. Keep it tight.`
      : `Greet me and summarize the pending suggestion queue. If there's one obvious place to start, say so.`
    sendMessage({ text: openerPrompt })
  }, [anchor, initialMessages, messages, sendMessage])

  return (
    <div className="flex h-full flex-col">
      {anchor ? (
        <div
          className="border-b px-3 py-2 text-[11px]"
          style={{
            borderColor: TUNING_COLORS.hairline,
            background: TUNING_COLORS.surfaceSunken,
            color: TUNING_COLORS.inkMuted,
          }}
        >
          <div className="uppercase tracking-[0.14em]">Anchored to message</div>
          <div className="mt-1 line-clamp-2 text-[12px]" style={{ color: TUNING_COLORS.ink }}>
            {anchor.content.slice(0, 200)}
          </div>
        </div>
      ) : null}

      <div ref={scrollerRef} className="flex-1 overflow-auto px-3 py-4">
        {messages.length === 0 ? (
          <div
            className="mt-4 text-center text-[12px] italic"
            style={{ color: TUNING_COLORS.inkSubtle }}
          >
            Starting conversation…
          </div>
        ) : null}
        <div className="space-y-4">
          {messages.map((m) => (
            <MessageRow
              key={m.id}
              message={m}
              onSuggestionAction={sendCannedSanction}
            />
          ))}
        </div>
        {error ? (
          <div
            className="mt-3 rounded border px-3 py-2 text-[12px]"
            style={{
              borderColor: TUNING_COLORS.diffDelBg,
              background: TUNING_COLORS.diffDelBg,
              color: TUNING_COLORS.diffDelFg,
            }}
          >
            {error.message}
          </div>
        ) : null}
      </div>

      <form
        onSubmit={onSubmit}
        className="border-t px-3 py-2"
        style={{ borderColor: TUNING_COLORS.hairline, background: TUNING_COLORS.surfaceRaised }}
      >
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                onSubmit(e as unknown as React.FormEvent)
              }
            }}
            rows={2}
            placeholder={status === 'streaming' ? 'agent is replying…' : 'Tell your tuner what you see.'}
            disabled={status === 'streaming'}
            className="flex-1 resize-none rounded border bg-white px-2 py-1.5 font-sans text-[13px] leading-5 focus:outline-none focus:ring-1"
            style={{
              borderColor: TUNING_COLORS.hairline,
              color: TUNING_COLORS.ink,
            }}
          />
          <button
            type="submit"
            disabled={status === 'streaming' || !draft.trim()}
            className="rounded-md px-3 py-1.5 text-[12px] font-medium disabled:opacity-40"
            style={{ background: TUNING_COLORS.accent, color: '#FFFFFF' }}
          >
            Send
          </button>
        </div>
        <div
          className="mt-1 text-[10px] uppercase tracking-[0.14em]"
          style={{ color: TUNING_COLORS.inkSubtle }}
        >
          {status === 'streaming' ? 'streaming' : status === 'submitted' ? 'sending…' : 'ready'}
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

  const aligned = isUser ? 'items-end' : 'items-start'
  return (
    <div className={`flex flex-col gap-2 ${aligned}`}>
      <div
        className="text-[10px] uppercase tracking-[0.14em]"
        style={{ color: TUNING_COLORS.inkSubtle }}
      >
        {isUser ? 'you' : 'tuning agent'}
      </div>
      <div className={`flex w-full flex-col gap-2 ${isUser ? 'items-end' : 'items-start'}`}>
        {(parts ?? []).map((p, idx) => (
          <PartView key={idx} part={p} onSuggestionAction={onSuggestionAction} />
        ))}
      </div>
    </div>
  )
}

function PartView({
  part,
  onSuggestionAction,
}: {
  part: Record<string, any>
  onSuggestionAction: (action: 'apply' | 'queue' | 'reject' | 'edit', previewId: string) => void
}) {
  if (!part || typeof part !== 'object') return null
  const type = typeof part.type === 'string' ? part.type : ''

  if (type === 'text') {
    return <TextPart text={part.text ?? ''} />
  }
  if (type === 'reasoning') {
    return <ThinkingSection text={part.text ?? ''} />
  }
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
