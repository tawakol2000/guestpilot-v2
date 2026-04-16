'use client'

/**
 * Feature 041 sprint 07 expanded — /tuning/sessions
 *
 * Session inspector for REAL guest conversations, modelled on Claude
 * Console's session debug view. Left rail = conversation list
 * (apiGetConversations). Main = transcript with event chips for the
 * SOPs fired + tool calls found on each AI message's aiMeta. Right
 * rail = detail pane when a message is clicked (full content + tool
 * names + delivery status).
 *
 * Deliberately read-only. The "Discuss in tuning" link on each AI
 * message deep-links into /tuning?conversationId=… so the manager can
 * hand the conversation to the tuning agent for analysis.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  Bot,
  CircleUser,
  Filter,
  MessageSquareText,
  Pin,
  Radio,
  Search,
  Wrench,
} from 'lucide-react'
import {
  apiGetConversation,
  apiGetConversations,
  type ApiConversationDetail,
  type ApiConversationSummary,
  type ApiMessage,
} from '@/lib/api'
import { TuningAuthGate } from '@/components/tuning/auth-gate'
import { TuningTopNav } from '@/components/tuning/top-nav'
import { RelativeTime } from '@/components/tuning/relative-time'
import { TUNING_COLORS } from '@/components/tuning/tokens'

type Filter = 'all' | 'ai-replied' | 'starred'

function SessionsInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const selectedId = searchParams.get('id')

  const [conversations, setConversations] = useState<ApiConversationSummary[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [detail, setDetail] = useState<ApiConversationDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [focusedMessageId, setFocusedMessageId] = useState<string | null>(null)

  const loadList = useCallback(async () => {
    setListError(null)
    try {
      const res = await apiGetConversations()
      setConversations(res)
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e))
      setConversations([])
    }
  }, [])

  useEffect(() => {
    loadList()
  }, [loadList])

  useEffect(() => {
    if (!selectedId) {
      setDetail(null)
      return
    }
    let cancelled = false
    setDetailLoading(true)
    setDetailError(null)
    apiGetConversation(selectedId)
      .then((d) => !cancelled && setDetail(d))
      .catch((e) => !cancelled && setDetailError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setDetailLoading(false))
    return () => {
      cancelled = true
    }
  }, [selectedId])

  const filteredConversations = useMemo(() => {
    if (!conversations) return []
    const needle = q.trim().toLowerCase()
    return conversations.filter((c) => {
      if (filter === 'ai-replied' && c.lastMessageRole !== 'AI') return false
      if (filter === 'starred' && !c.starred) return false
      if (needle) {
        const hay = `${c.guestName ?? ''} ${c.propertyName ?? ''} ${c.lastMessage ?? ''}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [conversations, q, filter])

  const select = useCallback(
    (id: string | null) => {
      const qs = new URLSearchParams(Array.from(searchParams.entries()))
      if (id) qs.set('id', id)
      else qs.delete('id')
      router.replace(`/tuning/sessions${qs.toString() ? `?${qs.toString()}` : ''}`, {
        scroll: false,
      })
      setFocusedMessageId(null)
    },
    [router, searchParams],
  )

  return (
    <div className="flex h-dvh flex-col">
      <TuningTopNav />
      <div className="flex flex-1 overflow-hidden">
        {/* Left rail — conversation list */}
        <aside
          className="hidden w-[340px] shrink-0 flex-col overflow-hidden border-r bg-[#F9FAFB] md:flex"
          style={{ borderColor: TUNING_COLORS.hairline }}
        >
          <div
            className="border-b px-5 py-4"
            style={{ borderColor: TUNING_COLORS.hairlineSoft }}
          >
            <div className="flex items-baseline justify-between">
              <div className="text-sm font-semibold text-[#1A1A1A]">Sessions</div>
              <div className="text-xs font-medium text-[#9CA3AF] tabular-nums">
                {conversations ? filteredConversations.length : '…'}
              </div>
            </div>
            <p className="mt-1 text-xs leading-5 text-[#6B7280]">
              Recent guest conversations. Click any AI reply to see the SOPs and tools it used.
            </p>
          </div>

          <div className="space-y-2 px-3 pt-3">
            <div
              className="flex items-center gap-2 rounded-lg border bg-white px-3 transition-all duration-200 focus-within:border-[#6C5CE7] focus-within:ring-2 focus-within:ring-[#F0EEFF]"
              style={{ borderColor: TUNING_COLORS.hairline }}
            >
              <Search size={14} strokeWidth={2} className="text-[#9CA3AF]" aria-hidden />
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search guest, property, message…"
                aria-label="Search sessions"
                className="flex-1 border-0 bg-transparent py-2 text-sm text-[#1A1A1A] outline-none placeholder:text-[#9CA3AF]"
              />
            </div>
            <div className="flex items-center gap-1">
              <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>
                All
              </FilterChip>
              <FilterChip active={filter === 'ai-replied'} onClick={() => setFilter('ai-replied')}>
                <Bot size={11} strokeWidth={2} className="mr-1" aria-hidden />
                AI replied
              </FilterChip>
              <FilterChip active={filter === 'starred'} onClick={() => setFilter('starred')}>
                <Pin size={11} strokeWidth={2} className="mr-1" aria-hidden />
                Starred
              </FilterChip>
            </div>
          </div>

          <ul className="flex-1 overflow-auto px-2 py-3">
            {conversations === null ? (
              Array.from({ length: 6 }).map((_, i) => (
                <li
                  key={`skel-${i}`}
                  className="mb-1 h-16 animate-pulse rounded-lg"
                  style={{ background: TUNING_COLORS.surfaceSunken }}
                />
              ))
            ) : null}
            {listError ? (
              <li className="px-3 py-4 text-center">
                <p className="text-xs text-[#6B7280]">Couldn&rsquo;t load conversations.</p>
                <button
                  type="button"
                  onClick={loadList}
                  className="mt-1 text-xs font-medium text-[#6C5CE7] hover:underline"
                >
                  Retry
                </button>
              </li>
            ) : null}
            {conversations && filteredConversations.length === 0 && !listError ? (
              <li className="px-3 py-8 text-center text-xs text-[#9CA3AF]">
                No sessions match that filter.
              </li>
            ) : null}
            {filteredConversations.map((c) => {
              const active = c.id === selectedId
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => select(c.id)}
                    className={
                      'relative flex w-full flex-col gap-1 rounded-lg px-3 py-2.5 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A29BFE] ' +
                      (active ? '' : 'hover:bg-white')
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
                        {c.guestName || 'Unknown guest'}
                      </span>
                      {c.starred ? (
                        <Pin size={10} strokeWidth={2} className="shrink-0 text-[#9CA3AF]" aria-hidden />
                      ) : null}
                      <span className="shrink-0 text-[10px] tabular-nums text-[#9CA3AF]">
                        <RelativeTime iso={c.lastMessageAt} />
                      </span>
                    </div>
                    <div className="line-clamp-1 text-xs text-[#6B7280]">
                      <span className="font-medium">{c.propertyName}</span>
                      <span aria-hidden> · </span>
                      <span>{c.channel.toLowerCase()}</span>
                      <span aria-hidden> · </span>
                      <span>{c.reservationStatus.replace('_', ' ').toLowerCase()}</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-[#9CA3AF]">
                      <RoleIcon role={c.lastMessageRole} />
                      <span className="line-clamp-1 flex-1">{c.lastMessage}</span>
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        </aside>

        {/* Main — session detail */}
        <main className="flex-1 overflow-hidden bg-[#F9FAFB]">
          {!selectedId ? (
            <SessionsEmptyState />
          ) : detailError ? (
            <div className="flex h-full items-center justify-center">
              <div
                className="max-w-md rounded-lg border-l-2 px-4 py-3 text-sm"
                style={{
                  background: TUNING_COLORS.dangerBg,
                  borderLeftColor: TUNING_COLORS.dangerFg,
                  color: TUNING_COLORS.dangerFg,
                }}
              >
                {detailError}
              </div>
            </div>
          ) : detailLoading || !detail ? (
            <div className="flex h-full items-center justify-center text-sm text-[#9CA3AF]">
              Loading conversation…
            </div>
          ) : (
            <SessionDetail
              detail={detail}
              focusedMessageId={focusedMessageId}
              onFocusMessage={setFocusedMessageId}
            />
          )}
        </main>

        {/* Right rail — event inspector */}
        {selectedId && detail ? (
          <aside
            className="hidden w-[340px] shrink-0 flex-col overflow-hidden border-l bg-white md:flex"
            style={{ borderColor: TUNING_COLORS.hairline }}
          >
            <EventInspector
              detail={detail}
              focusedMessageId={focusedMessageId}
            />
          </aside>
        ) : null}
      </div>
    </div>
  )
}

function FilterChip({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A29BFE]"
      style={{
        background: active ? TUNING_COLORS.accentSoft : 'transparent',
        color: active ? TUNING_COLORS.accent : TUNING_COLORS.inkMuted,
      }}
    >
      {children}
    </button>
  )
}

function RoleIcon({ role }: { role: ApiConversationSummary['lastMessageRole'] }) {
  if (role === 'AI') return <Bot size={11} strokeWidth={2} className="shrink-0 text-[#6C5CE7]" aria-hidden />
  if (role === 'GUEST') return <CircleUser size={11} strokeWidth={2} className="shrink-0 text-[#9CA3AF]" aria-hidden />
  if (role === 'HOST') return <Radio size={11} strokeWidth={2} className="shrink-0 text-[#9CA3AF]" aria-hidden />
  return <MessageSquareText size={11} strokeWidth={2} className="shrink-0 text-[#9CA3AF]" aria-hidden />
}

function SessionsEmptyState() {
  return (
    <div className="mx-auto flex h-full max-w-xl flex-col items-center justify-center gap-4 px-6 text-center">
      <span
        className="inline-flex h-10 w-10 items-center justify-center rounded-full text-[#6C5CE7]"
        style={{ background: TUNING_COLORS.accentSoft }}
      >
        <Filter size={18} strokeWidth={2} aria-hidden />
      </span>
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-[#1A1A1A]">
          Pick a session to inspect
        </h2>
        <p className="mt-1.5 max-w-prose text-sm leading-6 text-[#6B7280]">
          Real guest conversations with the main AI — not tuning chats.
          Click any row on the left to see the transcript + every SOP and
          tool your AI used for each reply.
        </p>
      </div>
    </div>
  )
}

function SessionDetail({
  detail,
  focusedMessageId,
  onFocusMessage,
}: {
  detail: ApiConversationDetail
  focusedMessageId: string | null
  onFocusMessage: (id: string | null) => void
}) {
  return (
    <div className="flex h-full flex-col">
      <header
        className="flex items-center gap-3 border-b bg-white px-6 py-3"
        style={{ borderColor: TUNING_COLORS.hairlineSoft }}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold text-[#1A1A1A]">
              {detail.guest.name}
            </h2>
            <span aria-hidden className="text-[#D1D5DB]">·</span>
            <span className="truncate text-xs text-[#6B7280]">{detail.property.name}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-[#9CA3AF]">
            <span>{detail.channel.toLowerCase()}</span>
            <span aria-hidden>·</span>
            <span>{detail.status.toLowerCase()}</span>
            <span aria-hidden>·</span>
            <span>{detail.reservation.guestCount} guests</span>
          </div>
        </div>
        <Link
          href={`/tuning?conversationId=${detail.id}`}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border bg-white px-3 py-1.5 text-xs font-medium text-[#6C5CE7] transition-colors duration-200 hover:bg-[#F0EEFF]"
          style={{ borderColor: TUNING_COLORS.hairline }}
        >
          <MessageSquareText size={12} strokeWidth={2} aria-hidden />
          <span>Discuss in tuning</span>
        </Link>
      </header>

      <div className="flex-1 overflow-auto">
        <ol className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
          {detail.messages.map((m) => (
            <TranscriptRow
              key={m.id}
              message={m}
              focused={focusedMessageId === m.id}
              onClick={() => onFocusMessage(focusedMessageId === m.id ? null : m.id)}
            />
          ))}
        </ol>
      </div>
    </div>
  )
}

function TranscriptRow({
  message,
  focused,
  onClick,
}: {
  message: ApiMessage
  focused: boolean
  onClick: () => void
}) {
  const isGuest = message.role === 'GUEST'
  const isAi = message.role === 'AI' || message.role === 'AI_PRIVATE'
  const sops = message.aiMeta?.sopCategories ?? []
  const tools = message.aiMeta?.toolNames ?? (message.aiMeta?.toolName ? [message.aiMeta.toolName] : [])

  // Sprint-07 bug fix — render AI messages as <button> (inspectable), but
  // render guest / host / manager-private messages as <div> so screen
  // readers don't announce them as dead buttons.
  const bubbleClassName = `max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-left text-sm leading-relaxed transition-all duration-200 ${isAi ? 'cursor-pointer hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A29BFE] focus-visible:ring-offset-2' : ''}`
  const bubbleStyle: React.CSSProperties = {
    background: isGuest
      ? TUNING_COLORS.accent
      : message.role === 'HOST'
        ? TUNING_COLORS.surfaceSunken
        : TUNING_COLORS.surfaceRaised,
    color: isGuest ? '#FFFFFF' : TUNING_COLORS.ink,
    border: isGuest
      ? 'none'
      : `1px solid ${focused ? TUNING_COLORS.accentMuted : TUNING_COLORS.hairlineSoft}`,
    borderTopRightRadius: isGuest ? 6 : undefined,
    borderTopLeftRadius: !isGuest ? 6 : undefined,
    boxShadow: focused
      ? '0 0 0 3px rgba(108,92,231,0.12), 0 1px 2px rgba(0,0,0,0.04)'
      : isGuest
        ? undefined
        : '0 1px 2px rgba(0,0,0,0.04)',
  }

  return (
    <li className={`flex flex-col gap-2 ${isGuest ? 'items-end' : 'items-start'}`}>
      {isAi ? (
        <button
          type="button"
          onClick={onClick}
          aria-pressed={focused}
          aria-label={`Inspect AI reply — ${message.content.slice(0, 60)}${message.content.length > 60 ? '…' : ''}`}
          className={bubbleClassName}
          style={bubbleStyle}
        >
          {message.content}
        </button>
      ) : (
        <div className={bubbleClassName} style={bubbleStyle}>
          {message.content}
        </div>
      )}

      <div className={`flex flex-wrap items-center gap-1.5 ${isGuest ? 'justify-end' : ''}`}>
        <RoleBadge role={message.role} />
        <span className="text-xs text-[#9CA3AF]">
          <RelativeTime iso={message.sentAt} />
        </span>
        {message.deliveryStatus === 'failed' ? (
          <span className="rounded-full px-2 py-0.5 text-xs font-medium" style={{ background: TUNING_COLORS.dangerBg, color: TUNING_COLORS.dangerFg }}>
            failed
          </span>
        ) : null}
        {message.editedByUserId ? (
          <span className="rounded-full px-2 py-0.5 text-xs font-medium" style={{ background: TUNING_COLORS.warnBg, color: TUNING_COLORS.warnFg }}>
            edited
          </span>
        ) : null}
        {sops.length > 0 ? (
          <span
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
            style={{ background: '#FEF9C3', color: '#854D0E' }}
            title={`SOPs fired: ${sops.join(', ')}`}
          >
            <Filter size={10} strokeWidth={2} aria-hidden />
            <span>{sops.length} SOP{sops.length === 1 ? '' : 's'}</span>
          </span>
        ) : null}
        {tools.length > 0 ? (
          <span
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
            style={{ background: '#EDE9FE', color: '#6D28D9' }}
            title={`Tools: ${tools.join(', ')}`}
          >
            <Wrench size={10} strokeWidth={2} aria-hidden />
            <span>{tools.length} tool{tools.length === 1 ? '' : 's'}</span>
          </span>
        ) : null}
      </div>
    </li>
  )
}

function RoleBadge({ role }: { role: ApiMessage['role'] }) {
  const styles: Record<ApiMessage['role'], { bg: string; fg: string; label: string }> = {
    GUEST: { bg: '#F3F4F6', fg: '#6B7280', label: 'Guest' },
    AI: { bg: '#F0EEFF', fg: '#6C5CE7', label: 'AI' },
    HOST: { bg: '#DBEAFE', fg: '#1E40AF', label: 'Host' },
    AI_PRIVATE: { bg: '#F0EEFF', fg: '#6C5CE7', label: 'AI (private)' },
    MANAGER_PRIVATE: { bg: '#F3F4F6', fg: '#6B7280', label: 'Manager note' },
  }
  const s = styles[role]
  return (
    <span
      className="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
      style={{ background: s.bg, color: s.fg }}
    >
      {s.label}
    </span>
  )
}

function EventInspector({
  detail,
  focusedMessageId,
}: {
  detail: ApiConversationDetail
  focusedMessageId: string | null
}) {
  const focused = detail.messages.find((m) => m.id === focusedMessageId) ?? null

  return (
    <>
      <header
        className="border-b px-5 py-4"
        style={{ borderColor: TUNING_COLORS.hairlineSoft }}
      >
        <div className="text-xs font-medium text-[#6B7280]">Inspector</div>
        <div className="mt-0.5 text-sm font-semibold text-[#1A1A1A]">
          {focused ? 'Message detail' : 'Session summary'}
        </div>
      </header>

      <div className="flex-1 overflow-auto px-5 py-4">
        {focused ? (
          <dl className="space-y-3 text-xs">
            <Row label="Role">
              <RoleBadge role={focused.role} />
            </Row>
            <Row label="Sent">
              <span className="text-[#1A1A1A]">
                {new Date(focused.sentAt).toLocaleString()}
              </span>
            </Row>
            {focused.channel ? <Row label="Channel">{focused.channel.toLowerCase()}</Row> : null}
            {focused.deliveryStatus ? (
              <Row label="Delivery">{focused.deliveryStatus}</Row>
            ) : null}
            {focused.originalAiText && focused.originalAiText !== focused.content ? (
              <Row label="Original AI draft">
                <p className="italic text-[#6B7280]">&ldquo;{focused.originalAiText}&rdquo;</p>
              </Row>
            ) : null}
            {focused.aiMeta?.sopCategories && focused.aiMeta.sopCategories.length > 0 ? (
              <Row label="SOPs fired">
                <ul className="space-y-1">
                  {focused.aiMeta.sopCategories.map((s) => (
                    <li key={s} className="font-mono text-xs text-[#1A1A1A]">
                      {s}
                    </li>
                  ))}
                </ul>
              </Row>
            ) : null}
            {focused.aiMeta?.toolNames && focused.aiMeta.toolNames.length > 0 ? (
              <Row label="Tools called">
                <ul className="space-y-1">
                  {focused.aiMeta.toolNames.map((t) => (
                    <li key={t} className="font-mono text-xs text-[#1A1A1A]">
                      {t}
                    </li>
                  ))}
                </ul>
              </Row>
            ) : null}
          </dl>
        ) : (
          <dl className="space-y-3 text-xs">
            <Row label="Messages">
              <span className="font-mono tabular-nums text-[#1A1A1A]">
                {detail.messages.length}
              </span>
            </Row>
            <Row label="AI replies">
              <span className="font-mono tabular-nums text-[#1A1A1A]">
                {detail.messages.filter((m) => m.role === 'AI').length}
              </span>
            </Row>
            <Row label="Property">
              <span className="text-[#1A1A1A]">{detail.property.name}</span>
            </Row>
            <Row label="Stay">
              <span className="text-[#1A1A1A] tabular-nums">
                {new Date(detail.reservation.checkIn).toLocaleDateString()} →{' '}
                {new Date(detail.reservation.checkOut).toLocaleDateString()}
              </span>
            </Row>
            <Row label="Channel">
              <span className="text-[#1A1A1A]">{detail.channel.toLowerCase()}</span>
            </Row>
            <Row label="Reservation status">
              <span className="text-[#1A1A1A]">
                {detail.status.toLowerCase().replace('_', ' ')}
              </span>
            </Row>
          </dl>
        )}
      </div>

      <footer
        className="border-t px-5 py-3 text-xs leading-5 text-[#9CA3AF]"
        style={{ borderColor: TUNING_COLORS.hairlineSoft }}
      >
        {focused
          ? 'Click the message again to close this pane.'
          : 'Click an AI reply in the transcript to see the SOPs and tools it used.'}
      </footer>
    </>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-[#9CA3AF]">{label}</dt>
      <dd className="text-sm text-[#1A1A1A]">{children}</dd>
    </div>
  )
}

export default function SessionsPage() {
  return (
    <TuningAuthGate>
      <Suspense
        fallback={
          <div className="flex min-h-dvh items-center justify-center bg-[#F9FAFB]">
            <span className="text-sm text-[#9CA3AF]">Loading…</span>
          </div>
        }
      >
        <SessionsInner />
      </Suspense>
    </TuningAuthGate>
  )
}
