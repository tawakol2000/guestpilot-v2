'use client'
/**
 * Feature 041 sprint 04 — chat history browser (left rail).
 *
 * Lists TuningConversation rows for the tenant. Clicking a row deep-links
 * to /tuning?conversationId=... which triggers the ChatPanel to rehydrate.
 * Substring search over TuningMessage.parts via the backend's ILIKE
 * endpoint (V1-simple, documented deferred upgrade to proper FTS).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  apiCreateTuningConversation,
  apiListTuningConversations,
  type TuningConversationSummary,
} from '@/lib/api'
import { TUNING_COLORS } from './tokens'
import { RelativeTime } from './relative-time'

export function ConversationList({
  selectedId,
  onSelect,
  onCreated,
}: {
  selectedId: string | null
  onSelect: (id: string) => void
  onCreated: (id: string) => void
}) {
  const [items, setItems] = useState<TuningConversationSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [error, setError] = useState<string | null>(null)
  const debounceRef = useRef<number | null>(null)

  const refresh = useCallback(async (query = '') => {
    setLoading(true)
    setError(null)
    try {
      const res = await apiListTuningConversations({ limit: 50, q: query || undefined })
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

  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      refresh(q.trim())
    }, 250)
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current)
    }
  }, [q, refresh])

  const startNew = useCallback(async () => {
    try {
      const { conversation } = await apiCreateTuningConversation({
        triggerType: 'MANUAL',
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
      onCreated(conversation.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [onCreated])

  return (
    <div className="flex flex-col">
      <div
        className="flex items-center justify-between border-b px-3 py-2"
        style={{ borderColor: TUNING_COLORS.hairline }}
      >
        <div
          className="text-[10px] uppercase tracking-[0.14em]"
          style={{ color: TUNING_COLORS.inkMuted }}
        >
          Conversations
        </div>
        <button
          type="button"
          onClick={startNew}
          className="rounded px-2 py-0.5 text-[11px] font-medium transition-colors"
          style={{
            background: TUNING_COLORS.surfaceSunken,
            color: TUNING_COLORS.ink,
            border: `1px solid ${TUNING_COLORS.hairline}`,
          }}
        >
          + New
        </button>
      </div>
      <div className="px-3 py-2">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search…"
          className="w-full rounded border bg-white px-2 py-1 font-sans text-[12px] focus:outline-none focus:ring-1"
          style={{ borderColor: TUNING_COLORS.hairline, color: TUNING_COLORS.ink }}
        />
      </div>
      <ul className="max-h-[260px] overflow-auto px-1 pb-2">
        {loading ? (
          <li
            className="px-3 py-2 text-[11px] italic"
            style={{ color: TUNING_COLORS.inkSubtle }}
          >
            Loading…
          </li>
        ) : null}
        {!loading && items.length === 0 ? (
          <li
            className="px-3 py-2 text-[11px] italic"
            style={{ color: TUNING_COLORS.inkSubtle }}
          >
            No conversations yet.
          </li>
        ) : null}
        {error ? (
          <li className="px-3 py-2 text-[11px]" style={{ color: TUNING_COLORS.diffDelFg }}>
            {error}
          </li>
        ) : null}
        {items.map((c) => {
          const active = c.id === selectedId
          return (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onSelect(c.id)}
                className="w-full rounded px-3 py-2 text-left transition-colors"
                style={{
                  background: active ? TUNING_COLORS.accentSoft : 'transparent',
                  color: TUNING_COLORS.ink,
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="line-clamp-1 text-[13px] font-medium">
                    {c.title || 'Untitled conversation'}
                  </span>
                  {c.anchorMessageId ? (
                    <span
                      className="shrink-0 font-mono text-[10px]"
                      style={{ color: TUNING_COLORS.inkSubtle }}
                      title="Anchored to a main-AI message"
                    >
                      ⚓
                    </span>
                  ) : null}
                </div>
                <div
                  className="mt-0.5 flex items-center gap-2 font-mono text-[10px]"
                  style={{ color: TUNING_COLORS.inkSubtle }}
                >
                  <span>{c.messageCount} msgs</span>
                  <span>·</span>
                  <span>
                    <RelativeTime iso={c.updatedAt} />
                  </span>
                </div>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
