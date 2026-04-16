'use client'
/**
 * Feature 041 sprint 04 — chat history browser (left rail).
 *
 * Lists TuningConversation rows for the tenant. Clicking a row deep-links
 * to /tuning?conversationId=... which triggers the ChatPanel to rehydrate.
 * Substring search over TuningMessage.parts via the backend's ILIKE
 * endpoint (V1-simple, documented deferred upgrade to proper FTS).
 *
 * Sprint 07: Claude Code-style session list — sentence-case header, a
 * clean icon-decorated search input, and per-row rounded highlight on
 * hover/selected. Uses lucide icons for the pin indicator and new-session
 * affordance.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Pin, Plus, Search } from 'lucide-react'
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
  // Bug fix (round 11) — each refresh gets a monotonically-increasing id.
  // If the user types fast, an earlier (slower) request can complete AFTER
  // a later one, and without this guard the stale results would overwrite
  // the newer query's results. The generation check drops any response
  // whose id no longer matches the latest fired request.
  const refreshGenRef = useRef(0)

  const refresh = useCallback(async (query = '') => {
    const gen = ++refreshGenRef.current
    setLoading(true)
    setError(null)
    try {
      const res = await apiListTuningConversations({ limit: 50, q: query || undefined })
      if (gen !== refreshGenRef.current) return
      setItems(res.conversations)
    } catch (err) {
      if (gen !== refreshGenRef.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (gen === refreshGenRef.current) setLoading(false)
    }
  }, [])

  // Bug fix (round 14) — previously there were TWO effects: one that
  // called refresh() on mount, and a debounce effect that called refresh
  // 250ms after `q` changed (starting from ''). That produced two
  // identical requests on every mount. Consolidate: the debounce effect
  // handles both the first load (250ms delay from '' is fine) and
  // every subsequent keystroke.
  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current)
    // First load should feel immediate; later keystrokes use the
    // 250ms debounce.
    const delay = q === '' && refreshGenRef.current === 0 ? 0 : 250
    debounceRef.current = window.setTimeout(() => {
      refresh(q.trim())
    }, delay)
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
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
      <div className="flex items-center justify-between px-5 py-3">
        <div className="text-sm font-semibold text-[#1A1A1A]">Conversations</div>
        <button
          type="button"
          onClick={startNew}
          className="inline-flex items-center gap-1 rounded-lg border border-[#E5E7EB] bg-white px-2.5 py-1 text-xs font-medium text-[#1A1A1A] transition-all duration-200 hover:bg-[#F3F4F6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A29BFE] focus-visible:ring-offset-2"
        >
          <Plus size={12} strokeWidth={2.25} aria-hidden />
          <span>New</span>
        </button>
      </div>

      <div className="px-3 pb-3">
        <div
          className="flex items-center gap-2 rounded-lg border bg-white px-3 transition-all duration-200 focus-within:border-[#6C5CE7] focus-within:ring-2 focus-within:ring-[#F0EEFF]"
          style={{ borderColor: TUNING_COLORS.hairline }}
        >
          <Search
            size={14}
            strokeWidth={2}
            className="text-[#9CA3AF]"
            aria-hidden
          />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search conversations"
            className="flex-1 border-0 bg-transparent py-2 text-sm text-[#1A1A1A] outline-none placeholder:text-[#9CA3AF]"
            aria-label="Search conversations"
          />
        </div>
      </div>

      <ul className="max-h-[280px] space-y-0.5 overflow-auto px-2 pb-3">
        {loading && items.length === 0 ? (
          Array.from({ length: 3 }).map((_, i) => (
            <li
              key={`skel-${i}`}
              className="mx-1 mb-1 h-12 animate-pulse rounded-lg"
              style={{ background: TUNING_COLORS.surfaceSunken }}
            />
          ))
        ) : null}

        {!loading && items.length === 0 && !error ? (
          <li className="px-3 py-5 text-center text-xs text-[#9CA3AF]">
            No conversations yet — start one from a pending suggestion.
          </li>
        ) : null}

        {error ? (
          <li className="px-3 py-5 text-center">
            <p className="text-xs text-[#6B7280]">Couldn&rsquo;t load conversations.</p>
            <button
              type="button"
              onClick={() => refresh(q.trim())}
              className="mt-1 text-xs font-medium text-[#6C5CE7] hover:underline"
            >
              Retry
            </button>
          </li>
        ) : null}

        {items.map((c) => {
          const active = c.id === selectedId
          return (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onSelect(c.id)}
                className={
                  'group relative flex w-full flex-col gap-1 rounded-lg px-3 py-2 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A29BFE] ' +
                  (active ? '' : 'hover:bg-[#F3F4F6]')
                }
                style={{ background: active ? TUNING_COLORS.accentSoft : undefined }}
              >
                {active ? (
                  <span
                    aria-hidden
                    className="absolute bottom-2 left-0 top-2 w-[2px] rounded-full"
                    style={{ background: TUNING_COLORS.accent }}
                  />
                ) : null}
                <div className="flex items-center gap-2">
                  <span className="line-clamp-1 flex-1 text-sm font-medium text-[#1A1A1A]">
                    {c.title || 'Untitled conversation'}
                  </span>
                  {c.anchorMessageId ? (
                    <Pin
                      size={11}
                      strokeWidth={2}
                      className="shrink-0 text-[#9CA3AF]"
                      aria-label="Anchored to a main-AI message"
                    />
                  ) : null}
                </div>
                <div className="flex items-center gap-1.5 text-xs text-[#9CA3AF]">
                  <span className="tabular-nums">{c.messageCount}</span>
                  <span aria-hidden>·</span>
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
