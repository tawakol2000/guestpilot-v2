'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { ConversationList } from '@/components/conversation-list'
import { ChatPanel } from '@/components/chat-panel'
import { BookingPanel } from '@/components/booking-panel'
import { OverviewPage } from '@/components/overview-page'
import { SettingsPage } from '@/components/settings-page'
import { ConfigureAIPage } from '@/components/configure-ai-page'
import { AiLogsPage } from '@/components/ai-logs-page'
import AnalyticsPage from '@/components/analytics-page'
import TasksPage from '@/components/tasks-page'
import { LayoutList, MessageSquare, Settings, Brain, ScrollText, LogOut, BarChart2, CheckSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Conversation, Message } from '@/lib/inbox-data'
import {
  apiGetConversations,
  apiGetConversation,
  apiToggleAI,
  apiSendMessage,
  apiSendThroughAI,
  apiCancelPendingAi,
  apiSendAiNow,
  apiSetAiMode,
  apiApproveSuggestion,
  mapChannel,
  mapReservationStatus,
  mapMessageSender,
  formatTimestamp,
  formatDate,
  clearToken,
  type ApiConversationSummary,
  type ApiConversationDetail,
} from '@/lib/api'
import { useRouter } from 'next/navigation'

type ActiveTab = 'overview' | 'inbox' | 'analytics' | 'tasks' | 'settings' | 'configure-ai' | 'ai-logs'

// ─── Transform API summary → Conversation ─────────────────────────────────────
function summaryToConversation(s: ApiConversationSummary): Conversation {
  const checkInDate = new Date(s.checkIn)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const checkInDay = new Date(checkInDate)
  checkInDay.setHours(0, 0, 0, 0)

  let checkInStatus: Conversation['checkInStatus']
  if (s.reservationStatus === 'INQUIRY') checkInStatus = 'inquiry'
  else if (s.reservationStatus === 'CANCELLED') checkInStatus = 'cancelled'
  else if (s.reservationStatus === 'CHECKED_IN') checkInStatus = 'checked-in'
  else if (s.reservationStatus === 'CHECKED_OUT') checkInStatus = 'checked-out'
  else if (checkInDay.getTime() === today.getTime()) checkInStatus = 'checking-in-today'
  else checkInStatus = 'confirmed'

  return {
    id: s.id,
    guestName: s.guestName,
    unitName: s.propertyName,
    channel: mapChannel(s.channel) as import('@/lib/inbox-data').Channel,
    bookingType: s.reservationStatus === 'INQUIRY' ? 'Inquiry' : 'Booking',
    lastMessage: s.lastMessage,
    lastMessageSender: s.lastMessageRole ? mapMessageSender(s.lastMessageRole) : '',
    timestamp: formatTimestamp(s.lastMessageAt),
    aiOn: s.aiEnabled,
    aiMode: s.aiMode ?? 'autopilot',
    aiStatus: s.aiEnabled ? 'on' : 'off',
    unreadCount: s.unreadCount,
    reservationStatus: mapReservationStatus(s.reservationStatus),
    checkInStatus,
    messages: [],
    guest: { name: s.guestName, email: '', phone: '', nationality: '', language: '', totalStays: 0, profileUrl: '' },
    booking: {
      property: s.propertyName,
      checkIn: formatDate(s.checkIn),
      checkOut: formatDate(s.checkOut),
      guests: 1,
      source: mapChannel(s.channel) as import('@/lib/inbox-data').Channel,
      hostawayUrl: '#',
    },
    property: { address: '', floor: '', doorCode: '', wifiName: '', wifiPassword: '', checkInTime: '', checkOutTime: '', parkingInfo: '', notes: '', houseRules: '', keyPickup: '', specialInstruction: '' },
    aiSummary: 'Loading conversation details...',
    aiSummaryShort: '',
  }
}

// ─── Merge full detail into Conversation ──────────────────────────────────────
function mergeDetail(conv: Conversation, detail: ApiConversationDetail): Conversation {
  const kb = (detail.property.customKnowledgeBase || {}) as Record<string, string>
  return {
    ...conv,
    messages: detail.messages.map(m => ({
      id: m.id,
      sender: mapMessageSender(m.role),
      text: m.content,
      time: formatTimestamp(m.sentAt),
      channel: mapChannel(m.channel) as import('@/lib/inbox-data').Channel | undefined,
      imageUrls: m.imageUrls,
    })),
    guest: {
      name: detail.guest.name,
      email: detail.guest.email || '',
      phone: detail.guest.phone || '',
      nationality: detail.guest.nationality || '',
      language: '',
      totalStays: 0,
      profileUrl: '',
    },
    booking: {
      property: detail.property.name,
      checkIn: formatDate(detail.reservation.checkIn),
      checkOut: formatDate(detail.reservation.checkOut),
      guests: detail.reservation.guestCount,
      source: mapChannel(detail.reservation.channel) as import('@/lib/inbox-data').Channel,
      hostawayUrl: '#',
    },
    property: {
      address: detail.property.address || '',
      floor: kb.floor || '',
      doorCode: kb.doorCode || kb.door_code || '',
      wifiName: kb.wifiName || kb.wifi_name || '',
      wifiPassword: kb.wifiPassword || kb.wifi_password || '',
      checkInTime: kb.checkInTime || kb.check_in_time || '',
      checkOutTime: kb.checkOutTime || kb.check_out_time || '',
      parkingInfo: '',
      notes: kb.notes || '',
      houseRules: kb.houseRules || '',
      keyPickup: kb.keyPickup || '',
      specialInstruction: kb.specialInstruction || '',
    },
    aiSummary: detail.messages.length > 0
      ? `Conversation with ${detail.guest.name}. ${detail.messages.length} message${detail.messages.length !== 1 ? 's' : ''}. Last message: "${detail.messages[detail.messages.length - 1]?.content?.substring(0, 120) ?? ''}"`
      : `New conversation with ${detail.guest.name}.`,
    aiSummaryShort: detail.reservation.status === 'INQUIRY' ? 'Inquiry pending' : 'Active booking',
    aiMode: detail.reservation.aiMode ?? conv.aiMode ?? 'autopilot',
  }
}

// ─── Empty conversation placeholder ───────────────────────────────────────────
const EMPTY_CONV: Conversation = {
  id: '',
  guestName: '',
  unitName: '',
  channel: 'Airbnb',
  bookingType: 'Booking',
  lastMessage: '',
  lastMessageSender: '',
  timestamp: '',
  aiOn: false,
  aiMode: 'autopilot',
  aiStatus: 'off',
  unreadCount: 0,
  reservationStatus: 'confirmed',
  checkInStatus: 'confirmed',
  messages: [],
  guest: { name: '', email: '', phone: '', nationality: '', language: '', totalStays: 0, profileUrl: '' },
  booking: { property: '', checkIn: '', checkOut: '', guests: 1, source: 'Airbnb', hostawayUrl: '#' },
  property: { address: '', floor: '', doorCode: '', wifiName: '', wifiPassword: '', checkInTime: '', checkOutTime: '', parkingInfo: '', notes: '', houseRules: '', keyPickup: '', specialInstruction: '' },
  aiSummary: '',
  aiSummaryShort: '',
}

export function InboxDashboard() {
  const router = useRouter()
  const [convList, setConvList] = useState<Conversation[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [searchQuery, setSearchQuery] = useState('')
  const [activeTab, setActiveTab] = useState<ActiveTab>('inbox')
  const [loadingList, setLoadingList] = useState(true)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [sendingMessage, setSendingMessage] = useState(false)
  // pendingAiReplies: keyed by conversationId, value = expectedAt ISO string (when AI will fire)
  const [pendingAiReplies, setPendingAiReplies] = useState<Record<string, string>>({})
  const [copilotSuggestions, setCopilotSuggestions] = useState<Record<string, string>>({})
  // useRef so it's always current inside callbacks/intervals (no stale closure)
  const fetchedDetails = useRef<Set<string>>(new Set())
  const selectedIdRef = useRef<string>('')  // mirrors selectedId, always current in async callbacks
  const audioCtxRef = useRef<AudioContext | null>(null)  // initialized on first user click

  // Keep selectedIdRef in sync so SSE/interval callbacks always see current value
  selectedIdRef.current = selectedId

  const selected = convList.find(c => c.id === selectedId) ?? EMPTY_CONV

  // ── Fetch conversation list ──────────────────────────────────────────────────
  const loadConversations = useCallback(async () => {
    try {
      const data = await apiGetConversations()
      const mapped = data.map(summaryToConversation)
      setConvList(prev => {
        return mapped.map(newConv => {
          const existing = prev.find(p => p.id === newConv.id)
          // Only preserve existing data if we've already fetched full detail
          if (existing && fetchedDetails.current.has(newConv.id)) {
            return { ...existing, aiOn: newConv.aiOn, aiMode: newConv.aiMode, aiStatus: newConv.aiStatus, lastMessage: newConv.lastMessage, lastMessageSender: newConv.lastMessageSender, timestamp: newConv.timestamp, unreadCount: newConv.unreadCount }
          }
          return newConv
        })
      })
      setSelectedId(prev => (prev || (mapped.length > 0 ? mapped[0].id : '')))

      // If the currently selected conversation has new messages (detected via lastMessageAt),
      // reload its full message list so the chat panel stays current even when SSE is down.
      const curId = selectedIdRef.current
      if (curId && fetchedDetails.current.has(curId)) {
        const fresh = mapped.find(c => c.id === curId)
        if (fresh) {
          // Always refresh the open conversation when polling — cheap insurance against SSE gaps
          apiGetConversation(curId)
            .then(detail => {
              setConvList(prev => prev.map(c => c.id === curId ? mergeDetail(c, detail) : c))
            })
            .catch(() => {})
        }
      }

      // Background pre-fetch first 10 conversations for instant click
      const toPreFetch = mapped.slice(0, 10).filter(c => !fetchedDetails.current.has(c.id))
      toPreFetch.forEach(conv => {
        apiGetConversation(conv.id)
          .then(detail => {
            fetchedDetails.current.add(conv.id)
            setConvList(prev => prev.map(c => c.id === conv.id ? mergeDetail(c, detail) : c))
          })
          .catch(() => {/* silent — will retry on click */})
      })
    } catch (err) {
      console.error('Failed to load conversations:', err)
    } finally {
      setLoadingList(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    loadConversations()
    // Poll for new messages every 30s as fallback
    const interval = setInterval(loadConversations, 30000)
    return () => clearInterval(interval)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Initialize AudioContext on first user interaction (browser autoplay policy) ──
  useEffect(() => {
    const init = () => {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContext()
      }
    }
    window.addEventListener('pointerdown', init, { once: true })
    return () => window.removeEventListener('pointerdown', init)
  }, [])

  // ── SSE: real-time push from server ─────────────────────────────────────────
  useEffect(() => {
    const token = (typeof window !== 'undefined' ? localStorage.getItem('gp_token') : null)
    if (!token) return
    const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:3001'

    let es: EventSource | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let destroyed = false

    function connect() {
      if (destroyed) return
      es = new EventSource(`${API_URL}/api/events?token=${encodeURIComponent(token!)}`)

      es.addEventListener('message', (e: MessageEvent) => {
        const data = JSON.parse(e.data) as {
          conversationId?: string
          message?: { role: string; content: string; sentAt: string; imageUrls?: string[]; channel?: string }
          lastMessageRole?: string
          lastMessageAt?: string
        }
        const convId = data.conversationId
        if (!convId) return

        // Play sound using pre-initialized AudioContext
        const ctx = audioCtxRef.current
        const isAiMessage = data.message?.role === 'AI'
        if (ctx) {
          try {
            if (ctx.state === 'suspended') ctx.resume()
            if (isAiMessage) {
              // AI sent — soft two-tap marimba: warm thump (D4) then bright sparkle (A5)
              const t = ctx.currentTime
              const play = (freq: number, start: number, vol: number, decay: number) => {
                const osc = ctx.createOscillator()
                const g = ctx.createGain()
                osc.connect(g); g.connect(ctx.destination)
                osc.type = 'triangle'
                osc.frequency.value = freq
                g.gain.setValueAtTime(0, t + start)
                g.gain.linearRampToValueAtTime(vol, t + start + 0.008)
                g.gain.exponentialRampToValueAtTime(0.001, t + start + decay)
                osc.start(t + start)
                osc.stop(t + start + decay + 0.01)
              }
              play(294, 0,    0.20, 0.18)  // D4 — warm thump
              play(880, 0.06, 0.12, 0.28)  // A5 — bright sparkle
            } else {
              // Guest incoming ding: ascending C6 → E6
              const osc = ctx.createOscillator()
              const gain = ctx.createGain()
              osc.connect(gain)
              gain.connect(ctx.destination)
              osc.type = 'sine'
              osc.frequency.setValueAtTime(1046, ctx.currentTime)        // C6
              osc.frequency.setValueAtTime(1318, ctx.currentTime + 0.08) // E6
              gain.gain.setValueAtTime(0, ctx.currentTime)
              gain.gain.linearRampToValueAtTime(0.18, ctx.currentTime + 0.01)
              gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45)
              osc.start(ctx.currentTime)
              osc.stop(ctx.currentTime + 0.45)
            }
          } catch { /* silent */ }
        }

        // Update conversation list preview immediately from SSE payload (no round-trip)
        if (data.message) {
          const msg = data.message
          const senderRole = (data.lastMessageRole || msg.role) as string
          setConvList(prev => prev.map(c => {
            if (c.id !== convId) return c
            return {
              ...c,
              lastMessage: msg.content,
              lastMessageSender: mapMessageSender(senderRole) as Conversation['lastMessageSender'],
              timestamp: formatTimestamp(data.lastMessageAt || msg.sentAt),
              unreadCount: selectedIdRef.current === convId ? 0 : c.unreadCount + 1,
            }
          }))

          // If this conversation is open, push message directly into its list
          if (selectedIdRef.current === convId) {
            setConvList(prev => prev.map(c => {
              if (c.id !== convId) return c
              const newMsg = {
                id: `sse-${Date.now()}`,
                sender: mapMessageSender(msg.role) as Message['sender'],
                text: msg.content,
                time: formatTimestamp(msg.sentAt),
                channel: (msg.channel ? mapChannel(msg.channel) : c.channel) as import('@/lib/inbox-data').Channel | undefined,
                imageUrls: msg.imageUrls || [],
              }
              return { ...c, messages: [...c.messages, newMsg] }
            }))
          }

          // Clear typing indicator and copilot suggestion when AI message arrives
          if (msg.role === 'AI') {
            setPendingAiReplies(prev => {
              if (!prev[convId]) return prev
              const next = { ...prev }
              delete next[convId]
              return next
            })
            setCopilotSuggestions(prev => {
              if (!prev[convId]) return prev
              const next = { ...prev }
              delete next[convId]
              return next
            })
          }
        } else {
          // Fallback: full reload if SSE payload has no message data
          loadConversations()
          if (selectedIdRef.current === convId) {
            apiGetConversation(convId)
              .then(detail => {
                setConvList(p => p.map(c => c.id === convId ? mergeDetail(c, detail) : c))
              })
              .catch(() => {})
          }
        }
      })

      // Forward new_task events to window so TasksBox can listen
      es.addEventListener('new_task', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data)
          window.dispatchEvent(new CustomEvent('sse:new_task', { detail: data }))
        } catch { /* silent */ }
      })

      // Typing indicator: AI is pending a reply
      es.addEventListener('ai_typing', (e: MessageEvent) => {
        try {
          const d = JSON.parse(e.data) as { conversationId: string; expectedAt: string }
          setPendingAiReplies(prev => ({ ...prev, [d.conversationId]: d.expectedAt }))
        } catch { /* silent */ }
      })

      // Typing indicator cleared (host cancelled or reply fired)
      es.addEventListener('ai_typing_clear', (e: MessageEvent) => {
        try {
          const d = JSON.parse(e.data) as { conversationId: string }
          setPendingAiReplies(prev => {
            if (!prev[d.conversationId]) return prev
            const next = { ...prev }
            delete next[d.conversationId]
            return next
          })
        } catch { /* silent */ }
      })

      // Copilot suggestion from AI (when aiMode = 'copilot')
      es.addEventListener('ai_suggestion', (e: MessageEvent) => {
        try {
          const d = JSON.parse(e.data) as { conversationId: string; suggestion: string }
          setCopilotSuggestions(prev => ({ ...prev, [d.conversationId]: d.suggestion }))
          // Clear typing bubble — suggestion replaces it
          setPendingAiReplies(prev => { const n = { ...prev }; delete n[d.conversationId]; return n })
        } catch { /* silent */ }
      })

      // On error: the browser will auto-retry, but if the backend was restarted the
      // connection may be in a broken state. Close the current instance and schedule
      // a manual reconnect so we always regain the connection after backend restarts.
      es.onerror = () => {
        if (destroyed) return
        es?.close()
        es = null
        // Reconnect after 3 seconds
        reconnectTimer = setTimeout(connect, 3000)
      }
    }

    connect()

    return () => {
      destroyed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      es?.close()
      es = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Fetch full conversation detail on selection ──────────────────────────────
  useEffect(() => {
    if (!selectedId || fetchedDetails.current.has(selectedId)) return
    setLoadingDetail(true)
    apiGetConversation(selectedId)
      .then(detail => {
        fetchedDetails.current.add(selectedId)
        setConvList(prev => prev.map(c => c.id === selectedId ? mergeDetail(c, detail) : c))
      })
      .catch(err => console.error('Failed to load conversation detail:', err))
      .finally(() => setLoadingDetail(false))
  }, [selectedId])

  // ── AI toggle ────────────────────────────────────────────────────────────────
  async function toggleAI() {
    if (!selectedId) return
    const current = convList.find(c => c.id === selectedId)
    if (!current) return
    const newValue = !current.aiOn
    // Optimistic update
    setConvList(prev => prev.map(c =>
      c.id === selectedId ? { ...c, aiOn: newValue, aiStatus: newValue ? 'on' : 'off' } : c
    ))
    try {
      await apiToggleAI(selectedId, newValue)
    } catch {
      // Revert on error
      setConvList(prev => prev.map(c =>
        c.id === selectedId ? { ...c, aiOn: !newValue, aiStatus: !newValue ? 'on' : 'off' } : c
      ))
    }
  }

  // ── Send message ─────────────────────────────────────────────────────────────
  async function handleSend(content: string, channel: string) {
    if (!selectedId || !content.trim()) return
    setSendingMessage(true)
    try {
      const msg = await apiSendMessage(selectedId, content, channel)
      // Append message to conversation
      setConvList(prev => prev.map(c => {
        if (c.id !== selectedId) return c
        return {
          ...c,
          messages: [...c.messages, {
            id: msg.id,
            sender: 'host' as const,
            text: content,
            time: formatTimestamp(msg.sentAt),
            channel: c.channel,
          }],
          lastMessage: content,
          lastMessageSender: 'host' as const,
          timestamp: formatTimestamp(msg.sentAt),
        }
      }))
    } catch (err) {
      console.error('Failed to send message:', err)
    } finally {
      setSendingMessage(false)
    }
  }

  async function handleSendThroughAI(text: string, channel: string) {
    if (!selectedId) return
    setSendingMessage(true)
    try {
      const msg = await apiSendThroughAI(selectedId, text, channel)
      setConvList(prev => prev.map(c => {
        if (c.id !== selectedId) return c
        return {
          ...c,
          messages: [...c.messages, {
            id: msg.id,
            sender: 'host' as const,
            text: msg.content,
            time: formatTimestamp(msg.sentAt),
            channel: c.channel,
          }],
          lastMessage: msg.content,
          lastMessageSender: 'host' as const,
          timestamp: formatTimestamp(msg.sentAt),
        }
      }))
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to send through AI')
    } finally {
      setSendingMessage(false)
    }
  }

  const handleApproveSuggestion = useCallback(async (editedText: string) => {
    if (!selectedId) return
    await apiApproveSuggestion(selectedId, editedText)
    setCopilotSuggestions(prev => {
      const next = { ...prev }
      delete next[selectedId]
      return next
    })
  }, [selectedId])

  const handleAiModeChange = useCallback(async (mode: 'autopilot' | 'copilot' | 'off') => {
    if (!selectedId) return
    // Optimistic update so pill switches immediately
    setConvList(prev => prev.map(c => c.id === selectedId ? { ...c, aiMode: mode, aiOn: mode !== 'off' } : c))
    await apiSetAiMode(selectedId, mode)
  }, [selectedId])

  function openConversation(id: string) {
    setSelectedId(id)
    setActiveTab('inbox')
    setConvList(prev => prev.map(c => c.id === id ? { ...c, unreadCount: 0 } : c))
  }

  function handleImportComplete() {
    fetchedDetails.current = new Set()  // clear stale IDs
    setSelectedId('')
    loadConversations()
  }

  function handleLogout() {
    clearToken()
    router.replace('/login')
  }

  const panelStyle = {
    background: '#FFFFFF',
    borderRadius: 12,
    boxShadow: '0 2px 12px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.04)',
    overflow: 'hidden' as const,
  }

  const tabs = [
    { key: 'overview'      as const, icon: LayoutList,    label: 'Overview'     },
    { key: 'inbox'         as const, icon: MessageSquare, label: 'Inbox'        },
    { key: 'analytics'     as const, icon: BarChart2,     label: 'Analytics'    },
    { key: 'tasks'         as const, icon: CheckSquare,   label: 'Tasks'        },
    { key: 'settings'      as const, icon: Settings,      label: 'Settings'     },
    { key: 'configure-ai'  as const, icon: Brain,         label: 'Configure AI' },
    { key: 'ai-logs'       as const, icon: ScrollText,    label: 'AI Logs'      },
  ]

  // overview = page 0, inbox/settings = page 1 (settings overlays inbox column)
  const translateX = activeTab === 'overview' ? '0%' : '-50%'

  return (
    <div className="w-screen overflow-hidden flex flex-col" style={{ height: '100dvh', background: '#E8E8ED' }}>

      {/* ── Top nav bar ── */}
      <header
        className="flex items-center justify-between px-5 shrink-0"
        style={{
          height: 52,
          background: 'rgba(232,232,237,0.92)',
          backdropFilter: 'blur(20px)',
          borderBottom: '1px solid rgba(0,0,0,0.07)',
          zIndex: 10,
          position: 'relative',
        }}
      >
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg flex items-center justify-center" style={{ background: 'var(--terracotta)' }}>
            <span className="text-white text-[10px] font-bold" style={{ fontFamily: "'Playfair Display', Georgia, serif" }}>G</span>
          </div>
          <span className="font-bold text-sm" style={{ fontFamily: "'Playfair Display', Georgia, serif", color: 'var(--brown-dark)' }}>
            GuestPilot
          </span>
        </div>

        <div className="flex items-center gap-0.5 p-1 rounded-lg" style={{ background: 'rgba(0,0,0,0.07)' }}>
          {tabs.map(({ key, icon: Icon, label }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={cn(
                'flex items-center gap-1.5 px-4 py-1 rounded-md text-xs font-medium transition-all duration-200',
                activeTab === key
                  ? 'bg-white text-[var(--brown-dark)] shadow-sm'
                  : 'text-[var(--muted-foreground)] hover:text-[var(--brown-dark)]'
              )}
            >
              <Icon size={12} />
              {label}
            </button>
          ))}
        </div>

        <button
          onClick={handleLogout}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors hover:bg-black/5"
          style={{ color: 'var(--muted-foreground)' }}
          title="Sign out"
        >
          <LogOut size={13} />
        </button>
      </header>

      {/* ── Sliding page container ── */}
      <div className="flex-1 min-h-0 overflow-hidden relative">
        <div
          className="flex h-full"
          style={{
            width: '200%',
            transform: `translateX(${translateX})`,
            transition: 'transform 0.38s cubic-bezier(0.42, 0, 0.18, 1)',
            willChange: 'transform',
          }}
        >
          {/* Page 0: Overview */}
          <div className="h-full p-2" style={{ width: '50%', minWidth: '50%', display: 'flex', flexDirection: 'column' }}>
            <div style={{ ...panelStyle, flex: 1, display: 'flex', flexDirection: 'column' }}>
              <OverviewPage conversations={convList} onOpenConversation={openConversation} />
            </div>
          </div>

          {/* Page 1: Inbox / Analytics / Tasks / Settings / Configure AI / AI Logs */}
          <div className="h-full p-2" style={{ width: '50%', minWidth: '50%', display: 'flex', gap: 8 }}>
            {activeTab === 'analytics' ? (
              <div style={{ ...panelStyle, flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <AnalyticsPage />
              </div>
            ) : activeTab === 'tasks' ? (
              <div style={{ ...panelStyle, flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <TasksPage />
              </div>
            ) : activeTab === 'settings' ? (
              <div style={{ ...panelStyle, flex: 1, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
                <SettingsPage onImportComplete={handleImportComplete} onAIToggled={loadConversations} />
              </div>
            ) : activeTab === 'configure-ai' ? (
              <div style={{ ...panelStyle, flex: 1, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
                <ConfigureAIPage />
              </div>
            ) : activeTab === 'ai-logs' ? (
              <div style={{ ...panelStyle, flex: 1, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
                <AiLogsPage />
              </div>
            ) : (
              <>
                {/* Left: Conversation list */}
                <div style={{ ...panelStyle, width: 296, minWidth: 296, display: 'flex', flexDirection: 'column' }}>
                  {loadingList ? (
                    <div className="flex-1 flex items-center justify-center" style={{ color: 'var(--muted-foreground)' }}>
                      <p className="text-xs">Loading...</p>
                    </div>
                  ) : (
                    <ConversationList
                      conversations={convList}
                      selectedId={selectedId}
                      onSelect={id => { setSelectedId(id); setActiveTab('inbox'); setConvList(prev => prev.map(c => c.id === id ? { ...c, unreadCount: 0 } : c)) }}
                      searchQuery={searchQuery}
                      onSearchChange={setSearchQuery}
                    />
                  )}
                </div>

                {/* Center: Chat */}
                <div style={{ ...panelStyle, flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  {selected.id ? (
                    <ChatPanel
                      conversation={selected}
                      aiEnabled={selected.aiOn}
                      onToggleAI={toggleAI}
                      onSend={handleSend}
                      onSendThroughAI={handleSendThroughAI}
                      isSending={sendingMessage}
                      isLoadingDetail={loadingDetail}
                      pendingAiReply={pendingAiReplies[selectedId] ?? null}
                      copilotSuggestion={copilotSuggestions[selectedId ?? ''] ?? null}
                      onApproveSuggestion={handleApproveSuggestion}
                      onCancelAi={async () => {
                        try {
                          await apiCancelPendingAi(selectedId)
                          setPendingAiReplies(prev => { const n = { ...prev }; delete n[selectedId]; return n })
                        } catch (err) {
                          console.error('Failed to cancel AI reply:', err)
                        }
                      }}
                      onSendAiNow={async () => {
                        try {
                          await apiSendAiNow(selectedId)
                          setPendingAiReplies(prev => { const n = { ...prev }; delete n[selectedId]; return n })
                        } catch (err) {
                          console.error('Failed to send AI now:', err)
                        }
                      }}
                    />
                  ) : (
                    <div className="flex-1 flex items-center justify-center" style={{ color: 'var(--muted-foreground)' }}>
                      <p className="text-xs">Select a conversation</p>
                    </div>
                  )}
                </div>

                {/* Right: Booking panel */}
                <div style={{ ...panelStyle, width: 284, minWidth: 284, display: 'flex', flexDirection: 'column' }}>
                  {selected.id && (
                    <BookingPanel key={selected.id} conversation={selected} aiEnabled={selected.aiOn} onToggleAI={toggleAI} aiMode={selected.aiMode ?? 'autopilot'} onAiModeChange={handleAiModeChange} onInquiryActioned={() => loadConversations()} />
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
