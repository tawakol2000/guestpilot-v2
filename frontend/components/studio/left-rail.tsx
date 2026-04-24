'use client'

// Sprint 046 — Studio design overhaul (plan T033–T036 + FR-010…FR-015).
//
// Redesigned left rail: brand row + search + "New chat" button + grouped
// session list (Recent / Earlier) + read-only footer property row.
// Preserves the existing "Show empty sessions" toggle and its
// `data-testid="show-empty-sessions-toggle"` so existing tests resolve.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  apiCreateTuningConversation,
  apiListTuningConversations,
  type TuningConversationSummary,
} from '@/lib/api'
import { STUDIO_TOKENS_V2 } from './tokens'
import { BrandAsteriskIcon, HotelIcon, PlusIcon, SearchIcon } from './icons'

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const ONE_HOUR_MS = 60 * 60 * 1000
const SEARCH_DEBOUNCE_MS = 150

export interface LeftRailV2Props {
  tenantName: string
  propertyCount: number
  selectedId: string
  onSelect: (id: string) => void
}

export function LeftRailV2({
  tenantName,
  propertyCount,
  selectedId,
  onSelect,
}: LeftRailV2Props) {
  const [items, setItems] = useState<TuningConversationSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showEmpty, setShowEmpty] = useState(false)
  const [searchInput, setSearchInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('')

  // Debounce search
  const debounceTimer = useRef<number | null>(null)
  useEffect(() => {
    if (debounceTimer.current !== null) window.clearTimeout(debounceTimer.current)
    debounceTimer.current = window.setTimeout(() => {
      setSearchQuery(searchInput)
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      if (debounceTimer.current !== null) window.clearTimeout(debounceTimer.current)
    }
  }, [searchInput])

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

  const startNew = useCallback(async () => {
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
  }, [onSelect])

  const now = Date.now()
  const filteredItems = useMemo(() => {
    const base = showEmpty
      ? items
      : items.filter((c) => {
          if (c.id === selectedId) return true
          if (c.messageCount > 0) return true
          const createdAt = Date.parse(c.createdAt)
          if (!Number.isFinite(createdAt)) return true
          return now - createdAt < ONE_HOUR_MS
        })
    if (!searchQuery.trim()) return base
    const q = searchQuery.trim().toLowerCase()
    return base.filter((c) => (c.title || '').toLowerCase().includes(q))
  }, [items, searchQuery, showEmpty, selectedId, now])

  const hiddenCount = items.length - filteredItems.length

  const { recent, earlier } = useMemo(() => {
    const r: TuningConversationSummary[] = []
    const e: TuningConversationSummary[] = []
    for (const c of filteredItems) {
      const updatedAt = Date.parse(c.updatedAt)
      if (Number.isFinite(updatedAt) && now - updatedAt < SEVEN_DAYS_MS) {
        r.push(c)
      } else {
        e.push(c)
      }
    }
    return { recent: r, earlier: e }
  }, [filteredItems, now])

  return (
    <div className="flex h-full flex-col">
      {/* Brand row */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 14px 10px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: STUDIO_TOKENS_V2.radiusMd,
              border: `1px solid ${STUDIO_TOKENS_V2.border}`,
              background: STUDIO_TOKENS_V2.bg,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: STUDIO_TOKENS_V2.blue,
              flexShrink: 0,
            }}
          >
            <BrandAsteriskIcon size={18} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <span
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: STUDIO_TOKENS_V2.ink,
              }}
            >
              Studio
            </span>
            <span
              style={{
                fontSize: 11,
                color: STUDIO_TOKENS_V2.muted,
                fontFamily: 'var(--font-mono, JetBrains Mono, monospace)',
              }}
            >
              Sonnet 4.6
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={startNew}
          aria-label="Start a new Studio session"
          style={{
            width: 28,
            height: 28,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: STUDIO_TOKENS_V2.radiusSm,
            background: 'transparent',
            color: STUDIO_TOKENS_V2.muted,
            border: 'none',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <PlusIcon size={16} />
        </button>
      </header>

      {/* Search */}
      <div style={{ margin: '2px 10px 6px' }}>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            height: 32,
            padding: '0 10px',
            border: `1px solid ${STUDIO_TOKENS_V2.border}`,
            borderRadius: STUDIO_TOKENS_V2.radiusMd,
            background: STUDIO_TOKENS_V2.bg,
          }}
        >
          <SearchIcon size={14} style={{ color: STUDIO_TOKENS_V2.muted2, flexShrink: 0 }} />
          <input
            type="search"
            role="searchbox"
            aria-label="Search sessions"
            placeholder="Search chats…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            style={{
              flex: 1,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              fontSize: 13,
              color: STUDIO_TOKENS_V2.ink,
              minWidth: 0,
            }}
          />
        </label>
      </div>

      {/* New chat button */}
      <div style={{ margin: '6px 10px 10px' }}>
        <button
          type="button"
          onClick={startNew}
          aria-label="Start a new Studio session"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            width: '100%',
            padding: '8px 10px',
            borderRadius: STUDIO_TOKENS_V2.radiusMd,
            background: STUDIO_TOKENS_V2.ink,
            color: '#FFFFFF',
            border: 'none',
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          <PlusIcon size={14} />
          New chat
        </button>
      </div>

      {/* List */}
      <nav
        aria-label="Studio sessions"
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '6px 10px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          minHeight: 0,
        }}
      >
        {loading && items.length === 0 ? (
          <span style={{ padding: '8px 8px', fontSize: 11, color: STUDIO_TOKENS_V2.muted2 }}>
            Loading…
          </span>
        ) : null}
        {error ? (
          <span style={{ padding: '8px 8px', fontSize: 11, color: STUDIO_TOKENS_V2.red }}>
            {error}
          </span>
        ) : null}
        {!loading && !error && filteredItems.length === 0 ? (
          <span style={{ padding: '8px 8px', fontSize: 12, color: STUDIO_TOKENS_V2.muted }}>
            {searchQuery.trim() ? 'No matching sessions.' : 'No sessions yet.'}
          </span>
        ) : null}

        {recent.length > 0 ? (
          <section>
            <SectionLabel>Recent</SectionLabel>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {recent.map((c) => (
                <SessionRow
                  key={c.id}
                  item={c}
                  active={c.id === selectedId}
                  onSelect={onSelect}
                  tenantName={tenantName}
                />
              ))}
            </ul>
          </section>
        ) : null}

        {earlier.length > 0 ? (
          <section>
            <SectionLabel>Earlier</SectionLabel>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {earlier.map((c) => (
                <SessionRow
                  key={c.id}
                  item={c}
                  active={c.id === selectedId}
                  onSelect={onSelect}
                  tenantName={tenantName}
                />
              ))}
            </ul>
          </section>
        ) : null}
      </nav>

      {/* Empty-sessions toggle (preserved from legacy rail) */}
      {(hiddenCount > 0 || showEmpty) && (
        <div
          style={{
            padding: '8px 14px',
            borderTop: `1px solid ${STUDIO_TOKENS_V2.border}`,
          }}
        >
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 11,
              color: STUDIO_TOKENS_V2.muted,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              data-testid="show-empty-sessions-toggle"
              checked={showEmpty}
              onChange={(e) => setShowEmpty(e.target.checked)}
            />
            Show empty sessions
            {!showEmpty && hiddenCount > 0 ? (
              <span style={{ marginLeft: 'auto', fontSize: 10.5, color: STUDIO_TOKENS_V2.muted2 }}>
                {hiddenCount} hidden
              </span>
            ) : null}
          </label>
        </div>
      )}

      {/* Footer property row — READ-ONLY per Clarifications Q3 */}
      <footer
        data-testid="studio-property-footer"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 14px',
          borderTop: `1px solid ${STUDIO_TOKENS_V2.border}`,
        }}
      >
        <div
          aria-hidden
          style={{
            width: 28,
            height: 28,
            borderRadius: STUDIO_TOKENS_V2.radiusMd,
            background: STUDIO_TOKENS_V2.blueSoft,
            color: STUDIO_TOKENS_V2.blue,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <HotelIcon size={14} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 500,
              color: STUDIO_TOKENS_V2.ink,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={tenantName}
          >
            {tenantName}
          </span>
          <span style={{ fontSize: 11, color: STUDIO_TOKENS_V2.muted }}>
            {propertyCount} propert{propertyCount === 1 ? 'y' : 'ies'} · operator
          </span>
        </div>
      </footer>
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2
      style={{
        margin: 0,
        padding: '8px 8px 6px',
        fontSize: 10.5,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        color: STUDIO_TOKENS_V2.muted2,
      }}
    >
      {children}
    </h2>
  )
}

function SessionRow({
  item,
  active,
  onSelect,
  tenantName,
}: {
  item: TuningConversationSummary
  active: boolean
  onSelect: (id: string) => void
  tenantName: string
}) {
  return (
    <li style={{ marginBottom: 2 }}>
      <button
        type="button"
        role="menuitem"
        aria-current={active ? 'page' : undefined}
        onClick={() => onSelect(item.id)}
        title={item.title || undefined}
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          alignItems: 'flex-start',
          padding: '8px 10px',
          borderRadius: STUDIO_TOKENS_V2.radiusSm,
          background: active ? STUDIO_TOKENS_V2.surface2 : 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          gap: 3,
        }}
        onMouseEnter={(e) => {
          if (!active) e.currentTarget.style.background = STUDIO_TOKENS_V2.surface
        }}
        onMouseLeave={(e) => {
          if (!active) e.currentTarget.style.background = 'transparent'
        }}
      >
        <span
          className="line-clamp-1"
          style={{
            fontSize: 13,
            fontWeight: active ? 500 : 400,
            color: active ? STUDIO_TOKENS_V2.ink : STUDIO_TOKENS_V2.ink2,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            width: '100%',
          }}
        >
          {item.title || 'Untitled session'}
        </span>
        <span
          style={{
            fontSize: 11,
            color: STUDIO_TOKENS_V2.muted2,
          }}
        >
          {tenantName} · {relativeTime(item.updatedAt)}
        </span>
      </button>
    </li>
  )
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return '—'
  const diff = Date.now() - then
  if (diff < 60_000) return 'just now'
  if (diff < 60 * 60_000) {
    const m = Math.max(1, Math.round(diff / 60_000))
    return `${m}m ago`
  }
  if (diff < 24 * 60 * 60_000) {
    const h = Math.max(1, Math.round(diff / (60 * 60_000)))
    return `${h}h ago`
  }
  if (diff < 14 * 24 * 60 * 60_000) {
    const d = Math.max(1, Math.round(diff / (24 * 60 * 60_000)))
    return `${d}d ago`
  }
  const w = Math.max(1, Math.round(diff / (7 * 24 * 60 * 60_000)))
  return `${w}w ago`
}
