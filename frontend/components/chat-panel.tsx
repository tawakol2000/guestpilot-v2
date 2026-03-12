'use client'

import { useState, useRef, useEffect } from 'react'
import { Languages, Send, Plus, Sparkles, User, ChevronDown, Lock, X, ThumbsUp, ThumbsDown } from 'lucide-react'
import type { Conversation, Message, CheckInStatus } from '@/lib/inbox-data'
import { apiTranslateMessage, apiRateMessage } from '@/lib/api'

interface ChatPanelProps {
  conversation: Conversation
  aiEnabled: boolean
  onToggleAI: () => void
  onSend?: (content: string, channel: string) => Promise<void>
  onSendThroughAI?: (text: string, channel: string) => Promise<void>
  isSending?: boolean
  isLoadingDetail?: boolean
  pendingAiReply?: string | null   // expectedAt ISO string
  onCancelAi?: () => Promise<void>
  onSendAiNow?: () => Promise<void>
  copilotSuggestion?: string | null
  onApproveSuggestion?: (editedText: string) => Promise<void>
}

// ── Copilot suggestion bubble ─────────────────────────────────────────────────
function SuggestionBubble({ suggestion, onApprove, onDiscard }: {
  suggestion: string
  onApprove: (text: string) => void
  onDiscard: () => void
}) {
  const [editedText, setEditedText] = useState(suggestion)
  const [sending, setSending] = useState(false)

  return (
    <div style={{
      margin: '0 16px 8px',
      padding: '12px',
      background: '#FFFBEB',
      border: '1px solid #FCD34D',
      borderRadius: 10,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#92400E', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          🤖 AI Suggests
        </span>
      </div>
      <textarea
        value={editedText}
        onChange={e => setEditedText(e.target.value)}
        rows={3}
        style={{
          width: '100%',
          padding: '8px 10px',
          border: '1px solid #FCD34D',
          borderRadius: 6,
          fontSize: 13,
          fontFamily: 'inherit',
          resize: 'vertical',
          background: '#FFFDE7',
          color: 'var(--foreground)',
          boxSizing: 'border-box',
        }}
      />
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button
          onClick={onDiscard}
          style={{
            padding: '5px 12px',
            fontSize: 12,
            borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'var(--card)',
            color: 'var(--muted-foreground)',
            cursor: 'pointer',
          }}
        >
          Discard
        </button>
        <button
          onClick={async () => {
            setSending(true)
            await onApprove(editedText)
            setSending(false)
          }}
          disabled={sending || !editedText.trim()}
          style={{
            padding: '5px 12px',
            fontSize: 12,
            fontWeight: 600,
            borderRadius: 6,
            border: 'none',
            background: 'var(--terracotta)',
            color: '#fff',
            cursor: 'pointer',
            opacity: sending ? 0.6 : 1,
          }}
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  )
}

// ── Typing bubble (animated 3-dot + countdown) ────────────────────────────────
function TypingBubble({ expectedAt, onCancel, onSendNow }: { expectedAt: string; onCancel?: () => void; onSendNow?: () => void }) {
  const [secsLeft, setSecsLeft] = useState(() => Math.max(0, Math.ceil((new Date(expectedAt).getTime() - Date.now()) / 1000)))
  const [cancelling, setCancelling] = useState(false)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    const tick = () => setSecsLeft(Math.max(0, Math.ceil((new Date(expectedAt).getTime() - Date.now()) / 1000)))
    tick()
    const id = setInterval(tick, 500)
    return () => clearInterval(id)
  }, [expectedAt])

  async function handleCancel() {
    if (!onCancel || cancelling || sending) return
    setCancelling(true)
    try { await onCancel() } catch { /* silent */ } finally { setCancelling(false) }
  }

  async function handleSendNow() {
    if (!onSendNow || sending || cancelling) return
    setSending(true)
    try { await onSendNow() } catch { /* silent */ } finally { setSending(false) }
  }

  return (
    <div className="flex items-end gap-2 ml-auto flex-row-reverse" style={{ maxWidth: '72%' }}>
      {/* Robot avatar */}
      <div
        className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-sm"
        style={{ background: '#FFFBEB', border: '1.5px solid #FDE68A' }}
      >
        🤖
      </div>

      <div className="flex flex-col items-end gap-1">
        {/* Bubble */}
        <div
          className="rounded-xl rounded-br-sm px-4 py-3 flex items-center gap-3"
          style={{ background: '#FFFBEB', border: '1.5px solid #FDE68A' }}
        >
          {/* Animated dots */}
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            {[0, 160, 320].map((delay, i) => (
              <span
                key={i}
                style={{
                  width: 7, height: 7, borderRadius: '50%',
                  background: '#D97706',
                  display: 'inline-block',
                  animation: 'typing-bounce 1.1s infinite ease-in-out',
                  animationDelay: `${delay}ms`,
                }}
              />
            ))}
          </span>
          {/* Countdown */}
          {secsLeft > 0 && (
            <span
              className="text-xs font-semibold tabular-nums"
              style={{ color: '#92400E', minWidth: 28, textAlign: 'right' }}
            >
              {secsLeft}s
            </span>
          )}
        </div>

        {/* Label + actions */}
        <div className="flex items-center gap-1.5 mr-1">
          <span className="text-[10px] font-medium" style={{ color: 'var(--terracotta)' }}>
            Autopilot responding…
          </span>
          {onSendNow && (
            <button
              onClick={handleSendNow}
              disabled={sending || cancelling}
              title="Send now"
              className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold transition-colors hover:opacity-80 disabled:opacity-40"
              style={{ background: '#D97706', color: '#fff', border: 'none' }}
            >
              {sending ? '…' : 'Send now'}
            </button>
          )}
          {onCancel && (
            <button
              onClick={handleCancel}
              disabled={cancelling || sending}
              title="Cancel AI reply"
              className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium transition-colors hover:bg-red-50 disabled:opacity-50"
              style={{ color: '#EF4444', border: '1px solid #FECACA' }}
            >
              <X size={9} />
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Check-in status badge ─────────────────────────────────────────────────────
const checkInStatusConfig: Record<CheckInStatus, { label: string; bg: string; text: string }> = {
  confirmed:           { label: 'Confirmed',          bg: '#DCFCE7', text: '#15803D' },
  cancelled:           { label: 'Cancelled',          bg: '#FEE2E2', text: '#DC2626' },
  'checked-in':        { label: 'Checked In',         bg: '#DBEAFE', text: '#1D4ED8' },
  'checking-in-today': { label: 'Checking In Today',  bg: '#FEF9C3', text: '#A16207' },
  'checked-out':       { label: 'Checked Out',        bg: '#F3F4F6', text: '#6B7280' },
  inquiry:             { label: 'Inquiry',             bg: '#EDE9FE', text: '#7C3AED' },
}

function CheckInBadge({ status }: { status: CheckInStatus }) {
  const cfg = checkInStatusConfig[status]
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold"
      style={{ background: cfg.bg, color: cfg.text }}
    >
      {cfg.label}
    </span>
  )
}

// ── Avatar ────────────────────────────────────────────────────────────────────
function Avatar({ sender, initials }: { sender: string; initials?: string }) {
  if (sender === 'autopilot') {
    return (
      <div
        className="w-7 h-7 rounded-full flex items-center justify-center text-sm shrink-0"
        style={{ background: '#FFFBEB', border: '1.5px solid #FDE68A' }}
      >
        🤖
      </div>
    )
  }
  if (sender === 'host') {
    return (
      <div
        className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 text-white select-none"
        style={{ background: 'var(--terracotta)' }}
      >
        {initials ?? 'HO'}
      </div>
    )
  }
  return (
    <div
      className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
      style={{ background: 'var(--muted)', border: '1.5px solid var(--border)' }}
    >
      <User size={13} style={{ color: 'var(--muted-foreground)' }} />
    </div>
  )
}

// ── Message bubble ────────────────────────────────────────────────────────────
function MessageBubble({ msg, translation, isTranslating, onRate, currentRating }: {
  msg: Message
  translation?: string
  isTranslating?: boolean
  onRate?: (id: string, rating: 'positive' | 'negative') => void
  currentRating?: 'positive' | 'negative'
}) {
  // Private manager message — [MANAGER] prefix
  if (msg.text.startsWith('[MANAGER] ')) {
    const stripped = msg.text.slice('[MANAGER] '.length)
    const colonIdx = stripped.indexOf(': ')
    const title = colonIdx > -1 ? stripped.slice(0, colonIdx) : stripped
    const note = colonIdx > -1 ? stripped.slice(colonIdx + 2) : ''
    return (
      <div className="flex items-end gap-2 max-w-[72%]">
        <div
          className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
          style={{ background: '#FEF3C7', border: '1.5px solid #FDE68A' }}
        >
          <Lock size={12} style={{ color: '#D97706' }} />
        </div>
        <div className="flex flex-col items-start gap-0.5">
          <div
            className="rounded-xl rounded-bl-sm px-3.5 py-2.5 text-sm leading-relaxed"
            style={{ background: '#FFFBEB', border: '1.5px solid #FDE68A' }}
          >
            <div style={{ fontWeight: 600, color: '#92400E', marginBottom: note ? 4 : 0 }}>{title}</div>
            {note && <div style={{ color: '#78350F' }}>{note}</div>}
          </div>
          <div className="flex items-center gap-1.5 ml-1">
            <Lock size={9} style={{ color: '#D97706' }} />
            <span className="text-[10px] font-medium" style={{ color: '#D97706' }}>Private — not sent to guest</span>
            <span className="text-[10px]" style={{ color: 'var(--muted-foreground)' }}>{msg.time}</span>
          </div>
        </div>
      </div>
    )
  }

  if (msg.sender === 'guest') {
    const hasImages = (msg.imageUrls?.length ?? 0) > 0
    const hasText = msg.text && msg.text.trim() !== ''
    return (
      <div className="flex items-end gap-2 max-w-[72%]">
        <Avatar sender="guest" />
        <div className="flex flex-col items-start gap-1">
          {hasImages && (
            <div className="flex flex-col gap-1">
              {msg.imageUrls!.map((url, i) => (
                <img
                  key={i}
                  src={url}
                  alt="attachment"
                  className="rounded-xl cursor-pointer"
                  style={{ maxWidth: 240, maxHeight: 240, objectFit: 'cover' }}
                  onClick={() => window.open(url, '_blank')}
                />
              ))}
            </div>
          )}
          {hasText && (
            <div
              className="rounded-xl rounded-bl-sm px-3.5 py-2.5 text-sm text-black leading-relaxed"
              style={{ background: '#FFFFFF', border: '1px solid var(--border)' }}
            >
              {msg.text}
            </div>
          )}
          {/* Translation — shown when translateOn */}
          {(translation || isTranslating) && (
            <div className="mt-1 text-[10px] px-2.5 py-1 rounded-lg max-w-[75%]"
              style={{
                background: '#EFF6FF',
                color: '#1D4ED8',
                border: '1px solid #BFDBFE',
                fontStyle: 'italic',
              }}
            >
              {isTranslating ? '...' : translation}
            </div>
          )}
          <div className="flex items-center gap-1.5 ml-1">
            {msg.channel && <span className="text-[10px]" style={{ color: 'var(--muted-foreground)' }}>via {msg.channel}</span>}
            <span className="text-[10px]" style={{ color: 'var(--muted-foreground)' }}>{msg.time}</span>
          </div>
        </div>
      </div>
    )
  }

  if (msg.sender === 'autopilot') {
    return (
      <div className="flex items-end gap-2 max-w-[72%] ml-auto flex-row-reverse">
        <Avatar sender="autopilot" />
        <div className="flex flex-col items-end gap-0.5">
          <div
            className="rounded-xl rounded-br-sm px-3.5 py-2.5 text-sm text-black leading-relaxed"
            style={{ background: '#FFFBEB' }}
          >
            {msg.text}
          </div>
          <div className="flex items-center gap-1.5 mr-1">
            <span className="text-[10px] font-medium" style={{ color: 'var(--terracotta)' }}>
              Autopilot{msg.channel ? ` via ${msg.channel}` : ''}
            </span>
            <span className="text-[10px]" style={{ color: 'var(--muted-foreground)' }}>{msg.time}</span>
            {onRate && (
              <span style={{ display: 'flex', gap: 1, marginLeft: 2 }}>
                <button
                  onClick={() => onRate(msg.id, 'positive')}
                  title="Good response"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '1px 2px', color: currentRating === 'positive' ? '#16a34a' : 'rgba(0,0,0,0.22)', lineHeight: 1, display: 'flex' }}
                >
                  <ThumbsUp size={10} strokeWidth={1.8} />
                </button>
                <button
                  onClick={() => onRate(msg.id, 'negative')}
                  title="Poor response"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '1px 2px', color: currentRating === 'negative' ? '#dc2626' : 'rgba(0,0,0,0.22)', lineHeight: 1, display: 'flex' }}
                >
                  <ThumbsDown size={10} strokeWidth={1.8} />
                </button>
              </span>
            )}
          </div>
        </div>
      </div>
    )
  }

  if (msg.sender === 'host') {
    const initials = msg.agentName
      ? msg.agentName.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
      : 'HO'
    return (
      <div className="flex items-end gap-2 max-w-[72%] ml-auto flex-row-reverse">
        <Avatar sender="host" initials={initials} />
        <div className="flex flex-col items-end gap-0.5">
          <div
            className="rounded-xl rounded-br-sm px-3.5 py-2.5 text-sm leading-relaxed"
            style={{ background: '#2C7BE5' }}
          >
            <span className="text-white">{msg.text}</span>
          </div>
          <div className="flex items-center gap-1.5 mr-1">
            {msg.agentName && <span className="text-[10px]" style={{ color: 'var(--muted-foreground)' }}>{msg.agentName}</span>}
            <span className="text-[10px]" style={{ color: 'var(--muted-foreground)' }}>{msg.time}</span>
          </div>
        </div>
      </div>
    )
  }

  return null
}

// ── Channel picker dropdown (screenshot style) ───────────────────────────────
type ChannelOption = { key: string; label: string; icon: React.ReactNode; color?: string }

const CHANNEL_OPTIONS: ChannelOption[] = [
  {
    key: 'email',
    label: 'via email',
    icon: <span className="text-sm font-semibold" style={{ color: '#9CA3AF' }}>@</span>,
  },
  {
    key: 'whatsapp',
    label: 'via whatsapp',
    icon: (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="#25D366">
        <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
      </svg>
    ),
  },
  {
    key: 'airbnb',
    label: 'via channel',
    icon: (
      <img src="/logos/airbnb.png" alt="Airbnb" width={16} height={16}
        style={{ filter: 'grayscale(0)', objectFit: 'contain' }} />
    ),
    color: '#E24B3B',
  },
]

function ChannelPicker({
  selected,
  onChange,
}: {
  selected: string
  onChange: (k: string) => void
}) {
  const [open, setOpen] = useState(false)
  const current = CHANNEL_OPTIONS.find(o => o.key === selected) ?? CHANNEL_OPTIONS[2]

  return (
    <div className="relative">
      {/* Dropdown card */}
      {open && (
        <div
          className="absolute bottom-full left-0 mb-2 w-44 overflow-hidden"
          style={{
            background: '#fff',
            border: '1px solid var(--border)',
            borderRadius: 10,
            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
          }}
        >
          {CHANNEL_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              onClick={() => { onChange(opt.key); setOpen(false) }}
              className="w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-[var(--muted)] text-left"
              style={{ color: opt.color ?? 'var(--brown-dark)', fontWeight: opt.key === selected ? 600 : 400 }}
            >
              <span className="w-5 flex items-center justify-center shrink-0">{opt.icon}</span>
              {opt.label}
            </button>
          ))}
        </div>
      )}

      {/* Trigger: show current channel icon in textarea left */}
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1 px-1 py-1 rounded-lg transition-colors hover:bg-[var(--muted)]"
        title="Switch channel"
      >
        <span className="w-5 flex items-center justify-center">{current.icon}</span>
        <ChevronDown size={11} style={{ color: 'var(--muted-foreground)' }} />
      </button>
    </div>
  )
}

// ── Main chat panel ───────────────────────────────────────────────────────────
export function ChatPanel({ conversation, aiEnabled, onToggleAI, onSend, onSendThroughAI, isSending, isLoadingDetail, pendingAiReply, onCancelAi, onSendAiNow, copilotSuggestion, onApproveSuggestion }: ChatPanelProps) {
  const [replyText, setReplyText] = useState('')
  const [selectedChannel, setSelectedChannel] = useState('airbnb')
  const [translateOn, setTranslateOn] = useState(false)
  const [translations, setTranslations] = useState<Record<string, string>>({})
  const [translating, setTranslating] = useState<Record<string, boolean>>({})
  const [discardedSuggestions, setDiscardedSuggestions] = useState<Set<string>>(new Set())
  const [ratings, setRatings] = useState<Record<string, 'positive' | 'negative'>>({})
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Scroll to bottom when opening a conversation or when any message is added
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [conversation.id, conversation.messages.length])

  // Reset translations when conversation changes
  useEffect(() => {
    setTranslations({})
    setTranslating({})
  }, [conversation.id])

  // Translate all guest messages when translateOn becomes true
  useEffect(() => {
    if (!translateOn) return
    const guestMsgs = conversation.messages.filter(m => m.sender === 'guest' && !translations[m.id])
    if (!guestMsgs.length) return

    guestMsgs.forEach(async msg => {
      setTranslating(prev => ({ ...prev, [msg.id]: true }))
      try {
        const { translated } = await apiTranslateMessage(conversation.id, msg.text)
        setTranslations(prev => ({ ...prev, [msg.id]: translated }))
      } catch { /* silent */ } finally {
        setTranslating(prev => ({ ...prev, [msg.id]: false }))
      }
    })
  }, [translateOn, conversation.messages, conversation.id])

  // Translate new guest messages as they arrive when translateOn is true
  useEffect(() => {
    if (!translateOn) return
    const lastMsg = conversation.messages[conversation.messages.length - 1]
    if (!lastMsg || lastMsg.sender !== 'guest' || translations[lastMsg.id]) return
    apiTranslateMessage(conversation.id, lastMsg.text)
      .then(({ translated }) => setTranslations(prev => ({ ...prev, [lastMsg.id]: translated })))
      .catch(() => {})
  }, [conversation.messages.length])

  const fileInputRef = useRef<HTMLInputElement>(null)

  async function handleSend() {
    if (!replyText.trim() || isSending || !onSend) return
    await onSend(replyText.trim(), selectedChannel)
    setReplyText('')
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <main className="flex flex-col flex-1 min-w-0 h-full" style={{ background: '#F8F8FA' }}>

      {/* ── Header ── */}
      <div
        className="flex items-center justify-between gap-4 px-5 py-3 shrink-0"
        style={{ background: '#fff', borderBottom: '1px solid var(--border)' }}
      >
        {/* Left: name + badge */}
        <div className="flex flex-col min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2
              className="font-semibold text-[15px] leading-snug"
              style={{ color: 'var(--brown-dark)' }}
            >
              {conversation.guestName}
            </h2>
            <CheckInBadge status={conversation.checkInStatus} />
          </div>
          <p className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--muted-foreground)' }}>
            {conversation.unitName}
          </p>
        </div>

        {/* Right: translate toggle + AI indicator */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Translate toggle */}
          <button
            onClick={() => setTranslateOn(v => !v)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all"
            style={
              translateOn
                ? { background: '#EFF6FF', color: '#2563EB', border: '1.5px solid #BFDBFE' }
                : { background: 'var(--muted)', color: 'var(--muted-foreground)', border: '1.5px solid transparent' }
            }
          >
            <Languages size={12} />
            Translate
          </button>

          {/* AI status — indicator only, not clickable */}
          <div
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold select-none"
            style={
              aiEnabled
                ? { background: '#F0FDF4', color: '#16A34A', border: '1.5px solid #BBF7D0' }
                : { background: '#FFF1F2', color: '#E11D48', border: '1.5px solid #FECDD3' }
            }
          >
            <span
              className="w-2 h-2 rounded-full"
              style={{ background: aiEnabled ? '#22C55E' : '#F43F5E' }}
            />
            AI {aiEnabled ? 'ON' : 'OFF'}
          </div>
        </div>
      </div>

      {/* ── Messages ── */}
      <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-3.5">
        {isLoadingDetail && conversation.messages.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>Loading messages...</p>
          </div>
        ) : conversation.messages.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>No messages yet</p>
          </div>
        ) : (
          conversation.messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              msg={msg}
              translation={translateOn && msg.sender === 'guest' ? translations[msg.id] : undefined}
              isTranslating={translateOn && msg.sender === 'guest' ? translating[msg.id] : undefined}
              onRate={msg.sender === 'autopilot' ? (id, rating) => {
                apiRateMessage(id, rating).catch(() => {})
                setRatings(r => ({ ...r, [id]: rating }))
              } : undefined}
              currentRating={msg.sender === 'autopilot' ? ratings[msg.id] : undefined}
            />
          ))
        )}
        {pendingAiReply && (
          <TypingBubble expectedAt={pendingAiReply} onCancel={onCancelAi} onSendNow={onSendAiNow} />
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* ── Copilot suggestion ── */}
      {copilotSuggestion && onApproveSuggestion && !discardedSuggestions.has(copilotSuggestion) && (
        <SuggestionBubble
          suggestion={copilotSuggestion}
          onApprove={async (text) => {
            await onApproveSuggestion(text)
          }}
          onDiscard={() => {
            setDiscardedSuggestions(prev => new Set([...prev, copilotSuggestion]))
          }}
        />
      )}

      {/* ── Reply box ── */}
      <div
        className="shrink-0 px-4 pb-4 pt-3"
        style={{ background: '#fff', borderTop: '1px solid var(--border)' }}
      >
        {/* Textarea with channel picker on left, plus on right */}
        <div
          className="flex flex-col rounded-xl overflow-hidden mb-3"
          style={{ border: '1.5px solid var(--border)', background: 'var(--muted)' }}
        >
          <textarea
            placeholder="Type a reply... (⌘+Enter to send)"
            className="w-full resize-none text-sm bg-transparent outline-none px-4 pt-3 pb-2 leading-relaxed min-h-[72px]"
            style={{ color: 'var(--brown-dark)' }}
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          {/* Bottom bar: channel picker left, plus right */}
          <div
            className="flex items-center justify-between px-2.5 py-2"
            style={{ borderTop: '1px solid var(--border)' }}
          >
            <ChannelPicker selected={selectedChannel} onChange={setSelectedChannel} />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-7 h-7 flex items-center justify-center rounded-lg transition-colors hover:bg-[var(--border)]"
              style={{ color: 'var(--muted-foreground)' }}
              title="Attach photo or file"
            >
              <Plus size={15} />
            </button>
            <input ref={fileInputRef} type="file" className="hidden" multiple accept="image/*,application/pdf" />
          </div>
        </div>

        {/* Send buttons */}
        <div className="flex items-center justify-end gap-2">
          <button
            disabled={!replyText.trim() || isSending}
            onClick={async () => {
              if (!replyText.trim() || isSending) return
              if (onSendThroughAI) {
                await onSendThroughAI(replyText.trim(), selectedChannel)
                setReplyText('')
              } else {
                handleSend()
              }
            }}
            className="flex items-center gap-1.5 text-xs font-semibold px-4 py-2 rounded-xl text-black transition-opacity disabled:opacity-40"
            style={{ background: '#FDE68A', border: '1px solid #F59E0B' }}
          >
            <Sparkles size={12} />
            Send Through AI
          </button>
          <button
            disabled={!replyText.trim() || isSending}
            onClick={handleSend}
            className="flex items-center gap-1.5 text-xs font-semibold px-4 py-2 rounded-xl text-white transition-opacity disabled:opacity-40"
            style={{ background: isSending ? '#6B9FD4' : '#2C7BE5' }}
          >
            <Send size={12} />
            {isSending ? 'Sending...' : 'Send'}
          </button>
        </div>
      </div>
    </main>
  )
}
