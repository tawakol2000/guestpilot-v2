'use client'

/**
 * Feature 041 sprint 07 expanded — /tuning/playground
 *
 * Sandbox test chat against the current published agent config. Mirrors
 * OpenAI Platform's right-panel chat + Claude Console's "Ask Claude"
 * experience. Uses `apiSandboxChatStream` — the backend streams reply
 * deltas that we append in real time, then returns a final envelope
 * with tools called, escalations raised, tokens used, and timing.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowUp,
  Gauge,
  RotateCcw,
  Settings2,
  ShieldAlert,
  Sparkles,
  Wrench,
} from 'lucide-react'
import {
  apiGetProperties,
  apiSandboxChatStream,
  type ApiProperty,
  type SandboxChatResponse,
} from '@/lib/api'
import { TuningAuthGate } from '@/components/tuning/auth-gate'
import { TuningTopNav } from '@/components/tuning/top-nav'
import { TUNING_COLORS } from '@/components/tuning/tokens'

const RESERVATION_STATUSES = ['INQUIRY', 'PENDING', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT'] as const
type Status = (typeof RESERVATION_STATUSES)[number]

const CHANNELS = ['AIRBNB', 'BOOKING', 'DIRECT', 'WHATSAPP'] as const
type Channel = (typeof CHANNELS)[number]

type Turn = {
  id: string
  role: 'guest' | 'host'
  content: string
  // When role==='host' (the AI reply), we attach the final envelope so the
  // message can render tool chips + escalation notices + token footer.
  meta?: SandboxChatResponse | null
  streaming?: boolean
}

function uid() {
  return Math.random().toString(36).slice(2, 10)
}

function PlaygroundInner() {
  const searchParams = useSearchParams()
  const scopeParam = searchParams.get('scope')

  const [properties, setProperties] = useState<ApiProperty[]>([])
  const [propertyId, setPropertyId] = useState<string>('')
  const [status, setStatus] = useState<Status>(
    scopeParam === 'screening' ? 'INQUIRY' : 'CONFIRMED',
  )
  const [channel, setChannel] = useState<Channel>('AIRBNB')
  const [guestName, setGuestName] = useState('Jamie Guest')
  const [checkIn, setCheckIn] = useState<string>(() => {
    const d = new Date()
    d.setDate(d.getDate() + 7)
    return d.toISOString().slice(0, 10)
  })
  const [checkOut, setCheckOut] = useState<string>(() => {
    const d = new Date()
    d.setDate(d.getDate() + 10)
    return d.toISOString().slice(0, 10)
  })
  const [guestCount, setGuestCount] = useState<number>(2)
  const [reasoning, setReasoning] = useState<'low' | 'medium' | 'high'>('medium')
  const [settingsOpen, setSettingsOpen] = useState(true)

  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    apiGetProperties()
      .then((list) => {
        if (cancelled) return
        setProperties(list)
        if (list[0]) setPropertyId((cur) => cur || list[0].id)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(
          e instanceof Error
            ? `Couldn’t load properties: ${e.message}`
            : 'Couldn’t load properties.',
        )
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!scrollerRef.current) return
    scrollerRef.current.scrollTo({
      top: scrollerRef.current.scrollHeight,
      behavior: 'smooth',
    })
  }, [turns])

  const clearChat = useCallback(() => {
    setTurns([])
    setError(null)
  }, [])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || sending) return
    if (!propertyId) {
      setError('Pick a property before sending.')
      return
    }
    setError(null)
    const guestTurn: Turn = { id: uid(), role: 'guest', content: text }
    const assistantTurn: Turn = {
      id: uid(),
      role: 'host',
      content: '',
      streaming: true,
      meta: null,
    }
    setTurns((t) => [...t, guestTurn, assistantTurn])
    setDraft('')
    setSending(true)

    // Build the backend payload from the full history we have so far, plus the new guest turn.
    const history = [...turns, guestTurn].map((t) => ({
      role: t.role,
      content: t.content,
    }))

    try {
      const envelope = await apiSandboxChatStream(
        {
          propertyId,
          reservationStatus: status,
          channel,
          guestName,
          checkIn,
          checkOut,
          guestCount,
          reasoningEffort: reasoning,
          messages: history,
        },
        (delta) => {
          setTurns((list) =>
            list.map((t) =>
              t.id === assistantTurn.id ? { ...t, content: t.content + delta } : t,
            ),
          )
        },
      )
      setTurns((list) =>
        list.map((t) =>
          t.id === assistantTurn.id
            ? {
                ...t,
                streaming: false,
                content: envelope.response || t.content,
                meta: envelope,
              }
            : t,
        ),
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      setTurns((list) => list.filter((t) => t.id !== assistantTurn.id))
    } finally {
      setSending(false)
    }
  }, [draft, sending, propertyId, turns, status, channel, guestName, checkIn, checkOut, guestCount, reasoning])

  const canSend = !!draft.trim() && !sending && !!propertyId
  const property = useMemo(
    () => properties.find((p) => p.id === propertyId) ?? null,
    [properties, propertyId],
  )

  return (
    <div className="flex h-dvh flex-col">
      <TuningTopNav />
      <div className="flex flex-1 overflow-hidden">
        {/* Scenario / settings rail */}
        <aside
          className="hidden w-[320px] shrink-0 flex-col overflow-hidden border-r bg-white md:flex"
          style={{ borderColor: TUNING_COLORS.hairline }}
        >
          <div
            className="flex items-center justify-between border-b px-5 py-3"
            style={{ borderColor: TUNING_COLORS.hairlineSoft }}
          >
            <div className="flex items-center gap-2">
              <Settings2 size={14} strokeWidth={2} className="text-[#6B7280]" aria-hidden />
              <span className="text-sm font-semibold text-[#1A1A1A]">Scenario</span>
            </div>
            <button
              type="button"
              onClick={() => setSettingsOpen((v) => !v)}
              className="text-xs font-medium text-[#6B7280] hover:text-[#1A1A1A]"
              aria-expanded={settingsOpen}
            >
              {settingsOpen ? 'Hide' : 'Show'}
            </button>
          </div>

          {settingsOpen ? (
            <div className="flex-1 space-y-4 overflow-auto px-5 py-4">
              <Field label="Property">
                <select
                  value={propertyId}
                  onChange={(e) => setPropertyId(e.target.value)}
                  className="w-full rounded-lg border bg-white px-3 py-2 text-sm outline-none transition-all duration-200 focus:border-[#6C5CE7] focus:ring-2 focus:ring-[#F0EEFF]"
                  style={{ borderColor: TUNING_COLORS.hairline }}
                >
                  {properties.length === 0 ? (
                    <option value="">Loading…</option>
                  ) : null}
                  {properties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Reservation status">
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as Status)}
                  className="w-full rounded-lg border bg-white px-3 py-2 text-sm outline-none transition-all duration-200 focus:border-[#6C5CE7] focus:ring-2 focus:ring-[#F0EEFF]"
                  style={{ borderColor: TUNING_COLORS.hairline }}
                >
                  {RESERVATION_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Channel">
                <select
                  value={channel}
                  onChange={(e) => setChannel(e.target.value as Channel)}
                  className="w-full rounded-lg border bg-white px-3 py-2 text-sm outline-none transition-all duration-200 focus:border-[#6C5CE7] focus:ring-2 focus:ring-[#F0EEFF]"
                  style={{ borderColor: TUNING_COLORS.hairline }}
                >
                  {CHANNELS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Check-in">
                  <DateInput value={checkIn} onChange={setCheckIn} />
                </Field>
                <Field label="Check-out">
                  <DateInput value={checkOut} onChange={setCheckOut} />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Guests">
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={guestCount}
                    onChange={(e) => setGuestCount(Number(e.target.value) || 1)}
                    className="w-full rounded-lg border bg-white px-3 py-2 text-sm tabular-nums outline-none transition-all duration-200 focus:border-[#6C5CE7] focus:ring-2 focus:ring-[#F0EEFF]"
                    style={{ borderColor: TUNING_COLORS.hairline }}
                  />
                </Field>
                <Field label="Reasoning">
                  <select
                    value={reasoning}
                    onChange={(e) => setReasoning(e.target.value as 'low' | 'medium' | 'high')}
                    className="w-full rounded-lg border bg-white px-3 py-2 text-sm outline-none transition-all duration-200 focus:border-[#6C5CE7] focus:ring-2 focus:ring-[#F0EEFF]"
                    style={{ borderColor: TUNING_COLORS.hairline }}
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </Field>
              </div>

              <Field label="Guest name">
                <input
                  type="text"
                  value={guestName}
                  onChange={(e) => setGuestName(e.target.value)}
                  className="w-full rounded-lg border bg-white px-3 py-2 text-sm outline-none transition-all duration-200 focus:border-[#6C5CE7] focus:ring-2 focus:ring-[#F0EEFF]"
                  style={{ borderColor: TUNING_COLORS.hairline }}
                />
              </Field>

              <button
                type="button"
                onClick={clearChat}
                className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border bg-white px-3 py-2 text-xs font-medium text-[#6B7280] transition-colors duration-200 hover:bg-[#F3F4F6] hover:text-[#1A1A1A]"
                style={{ borderColor: TUNING_COLORS.hairline }}
              >
                <RotateCcw size={12} strokeWidth={2} aria-hidden />
                <span>Clear chat</span>
              </button>
            </div>
          ) : null}

          <footer
            className="border-t px-5 py-3 text-xs leading-5 text-[#9CA3AF]"
            style={{ borderColor: TUNING_COLORS.hairlineSoft }}
          >
            Replies come from the live published config, not a staged one.{' '}
            <Link href="/tuning/agent" className="text-[#6C5CE7] hover:underline">
              Edit agent →
            </Link>
          </footer>
        </aside>

        {/* Chat area */}
        <main className="flex flex-1 flex-col bg-[#F9FAFB]">
          <header
            className="flex items-center justify-between border-b bg-white px-6 py-3"
            style={{ borderColor: TUNING_COLORS.hairlineSoft }}
          >
            <div className="flex min-w-0 items-center gap-2">
              <Sparkles size={14} strokeWidth={2} className="text-[#6C5CE7]" aria-hidden />
              <span className="truncate text-sm font-semibold text-[#1A1A1A]">Playground</span>
              {property ? (
                <>
                  <span aria-hidden className="text-[#D1D5DB]">·</span>
                  <span className="truncate text-xs text-[#6B7280]">{property.name}</span>
                </>
              ) : null}
              <span aria-hidden className="text-[#D1D5DB]">·</span>
              <span className="text-xs text-[#6B7280]">{status.replace('_', ' ').toLowerCase()}</span>
            </div>
          </header>

          <div ref={scrollerRef} className="flex-1 overflow-auto px-6 py-6">
            {turns.length === 0 ? (
              <EmptyState status={status} />
            ) : (
              <div className="mx-auto flex max-w-3xl flex-col gap-4">
                {turns.map((t) => (
                  <TurnRow key={t.id} turn={t} />
                ))}
              </div>
            )}

            {error ? (
              <div
                className="mx-auto mt-4 max-w-3xl rounded-lg border-l-2 px-4 py-3 text-sm"
                style={{
                  background: TUNING_COLORS.dangerBg,
                  borderLeftColor: TUNING_COLORS.dangerFg,
                  color: TUNING_COLORS.dangerFg,
                }}
              >
                {error}
              </div>
            ) : null}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault()
              send()
            }}
            className="border-t bg-white px-6 py-4"
            style={{ borderColor: TUNING_COLORS.hairlineSoft }}
          >
            <div
              className="mx-auto flex max-w-3xl items-end gap-3 rounded-2xl border bg-white p-2 transition-all duration-200 focus-within:border-[#6C5CE7] focus-within:ring-2 focus-within:ring-[#F0EEFF]"
              style={{ borderColor: TUNING_COLORS.hairline }}
            >
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    send()
                  }
                }}
                rows={1}
                placeholder={
                  sending ? 'Waiting for the AI…' : 'Send a message as the guest…'
                }
                disabled={sending}
                aria-label="Send a guest-style message"
                className="min-h-[44px] flex-1 resize-none border-0 bg-transparent px-3 py-2.5 text-sm leading-6 text-[#1A1A1A] outline-none placeholder:text-[#9CA3AF] disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={!canSend}
                aria-label="Send"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full shadow-sm transition-all duration-200 hover:shadow-md disabled:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A29BFE] focus-visible:ring-offset-2"
                style={{
                  background: canSend ? TUNING_COLORS.accent : TUNING_COLORS.hairline,
                  color: canSend ? '#FFFFFF' : TUNING_COLORS.inkSubtle,
                }}
              >
                <ArrowUp size={18} strokeWidth={2.25} aria-hidden />
              </button>
            </div>
            <p className="mx-auto mt-2 max-w-3xl text-xs text-[#9CA3AF]">
              Messages go through the same pipeline your guests see — SOPs, FAQ,
              tool calls, escalations. Nothing is sent to Hostaway.
            </p>
          </form>
        </main>
      </div>
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-[#6B7280]">{label}</span>
      {children}
    </label>
  )
}

function DateInput({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  return (
    <input
      type="date"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-lg border bg-white px-3 py-2 text-sm tabular-nums outline-none transition-all duration-200 focus:border-[#6C5CE7] focus:ring-2 focus:ring-[#F0EEFF]"
      style={{ borderColor: TUNING_COLORS.hairline }}
    />
  )
}

function EmptyState({ status }: { status: Status }) {
  const suggestions = getStarterSuggestions(status)
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center gap-5 py-16 text-center">
      <span
        className="inline-flex h-10 w-10 items-center justify-center rounded-full text-[#6C5CE7]"
        style={{ background: TUNING_COLORS.accentSoft }}
      >
        <Sparkles size={18} strokeWidth={2} aria-hidden />
      </span>
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-[#1A1A1A]">
          Test what your AI would say
        </h2>
        <p className="mt-1.5 max-w-prose text-sm leading-6 text-[#6B7280]">
          Pick a scenario on the left, then type a guest message below.
          Replies stream in real time and show every tool the AI called.
        </p>
      </div>
      {suggestions.length > 0 ? (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {suggestions.map((s) => (
            <span
              key={s}
              className="rounded-full border bg-white px-3 py-1 text-xs text-[#6B7280]"
              style={{ borderColor: TUNING_COLORS.hairline }}
            >
              {s}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function getStarterSuggestions(status: Status): string[] {
  switch (status) {
    case 'INQUIRY':
      return [
        '"Hi — what\'s the deposit and cancellation policy?"',
        '"I\'m 3 adults + 1 kid, does the 2-bed unit fit us?"',
        '"Do you accept Egyptian nationals?"',
      ]
    case 'CONFIRMED':
      return [
        '"Can I extend my stay by 2 nights?"',
        '"What time can I check in?"',
        '"What\'s the Wi-Fi password?"',
      ]
    case 'CHECKED_IN':
      return [
        '"The AC isn\'t cooling, can someone look at it?"',
        '"Late check-out on Sunday possible?"',
      ]
    default:
      return []
  }
}

function TurnRow({ turn }: { turn: Turn }) {
  const isGuest = turn.role === 'guest'
  return (
    <div className={`flex flex-col gap-2 ${isGuest ? 'items-end' : 'items-start'}`}>
      <div
        className="max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm"
        style={{
          background: isGuest ? TUNING_COLORS.accent : TUNING_COLORS.surfaceRaised,
          color: isGuest ? '#FFFFFF' : TUNING_COLORS.ink,
          border: isGuest ? 'none' : `1px solid ${TUNING_COLORS.hairlineSoft}`,
          borderTopRightRadius: isGuest ? 6 : undefined,
          borderTopLeftRadius: !isGuest ? 6 : undefined,
        }}
      >
        {turn.content || (turn.streaming ? <span className="text-[#9CA3AF]">Thinking…</span> : null)}
      </div>

      {turn.meta ? <ReplyMeta meta={turn.meta} /> : null}
    </div>
  )
}

function ReplyMeta({ meta }: { meta: SandboxChatResponse }) {
  const totalTokens = meta.inputTokens + meta.outputTokens
  return (
    <div className="flex w-full max-w-[85%] flex-wrap items-center gap-2">
      {meta.toolUsed && meta.toolName ? (
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium"
          style={{ background: '#EDE9FE', color: '#6D28D9' }}
          title={
            meta.toolDurationMs !== undefined
              ? `Tool call took ${meta.toolDurationMs}ms`
              : undefined
          }
        >
          <Wrench size={11} strokeWidth={2} aria-hidden />
          <span>{meta.toolName}</span>
          {meta.toolDurationMs !== undefined ? (
            <span className="font-mono text-[10px] opacity-80">{meta.toolDurationMs}ms</span>
          ) : null}
        </span>
      ) : null}
      {meta.escalation ? (
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium"
          style={{ background: TUNING_COLORS.warnBg, color: TUNING_COLORS.warnFg }}
          title={meta.escalation.note}
        >
          <ShieldAlert size={11} strokeWidth={2} aria-hidden />
          <span>Escalated · {meta.escalation.urgency}</span>
        </span>
      ) : null}
      {meta.manager?.needed ? (
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium"
          style={{ background: TUNING_COLORS.accentSoft, color: TUNING_COLORS.accent }}
          title={meta.manager.note}
        >
          <Sparkles size={11} strokeWidth={2} aria-hidden />
          <span>Manager needed</span>
        </span>
      ) : null}
      <span className="ml-auto inline-flex items-center gap-1.5 font-mono text-xs tabular-nums text-[#9CA3AF]">
        <Gauge size={11} strokeWidth={2} aria-hidden />
        <span>{totalTokens.toLocaleString()} tok</span>
        <span aria-hidden>·</span>
        <span>{meta.durationMs}ms</span>
      </span>
    </div>
  )
}

export default function PlaygroundPage() {
  return (
    <TuningAuthGate>
      <Suspense
        fallback={
          <div className="flex min-h-dvh items-center justify-center bg-[#F9FAFB]">
            <span className="text-sm text-[#9CA3AF]">Loading…</span>
          </div>
        }
      >
        <PlaygroundInner />
      </Suspense>
    </TuningAuthGate>
  )
}
