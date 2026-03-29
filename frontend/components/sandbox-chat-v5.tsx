'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Send, RotateCcw, Loader2, AlertTriangle, Wrench, ChevronDown,
  Clock, Cpu, MessageSquare, Settings2,
} from 'lucide-react'
import {
  apiGetProperties,
  apiSandboxChat,
  apiSandboxChatStream,
  type ApiProperty,
  type SandboxChatRequest,
  type SandboxChatResponse,
} from '@/lib/api'

// ─── Design Tokens (matching inbox-v5) ───────────────────────────────────────
const T = {
  bg: { primary: '#FFFFFF', secondary: '#F2F2F2', tertiary: '#E8E8E8' },
  text: { primary: '#0A0A0A', secondary: '#666666', tertiary: '#999999' },
  accent: '#0070F3',
  status: { green: '#30A46C', red: '#E5484D', amber: '#FFB224' },
  border: { default: '#E5E5E5', strong: '#0A0A0A' },
  font: {
    sans: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  },
} as const

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDateForInput(date: Date): string {
  return date.toISOString().split('T')[0]
}

function defaultCheckIn(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return formatDateForInput(d)
}

function defaultCheckOut(): string {
  const d = new Date()
  d.setDate(d.getDate() + 4)
  return formatDateForInput(d)
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChatMessage {
  id: string
  role: 'guest' | 'host'
  content: string
  timestamp: Date
  meta?: {
    escalation?: { title: string; note: string; urgency: string } | null
    manager?: { needed: boolean; title: string; note: string } | null
    toolUsed?: boolean
    toolName?: string
    toolInput?: any
    toolResults?: any
    toolDurationMs?: number
    inputTokens?: number
    outputTokens?: number
    durationMs?: number
    model?: string
    ragContext?: {
      chunks: Array<{ category: string; similarity: number; sourceKey: string }>
      tier: string
      confidenceTier: string | null
      topCandidates: Array<{ label: string; confidence: number }> | null
      tier2Output: { topic: string; status: string; urgency: string; sops: string[] } | null
      escalationSignals: string[]
    } | null
  }
}

const RESERVATION_STATUSES = ['INQUIRY', 'CONFIRMED', 'CHECKED_IN'] as const
const CHANNELS = ['AIRBNB', 'BOOKING', 'WHATSAPP', 'DIRECT'] as const

// ─── Component ────────────────────────────────────────────────────────────────

export default function SandboxChatV5() {
  // Config state
  const [properties, setProperties] = useState<ApiProperty[]>([])
  const [propertyId, setPropertyId] = useState('')
  const [reservationStatus, setReservationStatus] = useState<string>('CONFIRMED')
  const [channel, setChannel] = useState<string>('AIRBNB')
  const [guestName, setGuestName] = useState('Test Guest')
  const [checkIn, setCheckIn] = useState(defaultCheckIn)
  const [checkOut, setCheckOut] = useState(defaultCheckOut)
  const [guestCount, setGuestCount] = useState(2)

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Streaming text accumulator — shows progressive AI response
  const [streamingText, setStreamingText] = useState('')

  // UI state
  const [configCollapsed, setConfigCollapsed] = useState(false)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // ── Load properties ──────────────────────────────────────────────────────
  useEffect(() => {
    apiGetProperties()
      .then(props => {
        setProperties(props)
        if (props.length > 0 && !propertyId) setPropertyId(props[0].id)
      })
      .catch(err => console.error('Failed to load properties:', err))
  }, [])

  // ── Auto-scroll to bottom ───────────────────────────────────────────────
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingText])

  // ── Auto-resize textarea ────────────────────────────────────────────────
  const handleInputChange = useCallback((val: string) => {
    setInput(val)
    if (inputRef.current) {
      inputRef.current.style.height = 'auto'
      inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 120) + 'px'
    }
  }, [])

  // ── Send message (with streaming support) ───────────────────────────────
  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || loading || !propertyId) return

    setError(null)
    setStreamingText('')
    const guestMsg: ChatMessage = {
      id: `msg-${Date.now()}-g`,
      role: 'guest',
      content: text,
      timestamp: new Date(),
    }
    const updatedMessages = [...messages, guestMsg]
    setMessages(updatedMessages)
    setInput('')
    if (inputRef.current) inputRef.current.style.height = 'auto'
    setLoading(true)

    try {
      const req: SandboxChatRequest = {
        propertyId,
        reservationStatus,
        channel,
        guestName,
        checkIn,
        checkOut,
        guestCount,
        messages: updatedMessages.map(m => ({ role: m.role, content: m.content })),
      }

      // Try streaming first, fall back to non-streaming on error
      let resp: SandboxChatResponse
      try {
        resp = await apiSandboxChatStream(req, (delta) => {
          setStreamingText(prev => prev + delta)
        })
      } catch {
        // Streaming not available — fall back to non-streaming
        // (backend endpoint may not support ?stream=1 yet)
        setStreamingText('')
        resp = await apiSandboxChat(req)
      }

      setStreamingText('')
      const aiMsg: ChatMessage = {
        id: `msg-${Date.now()}-a`,
        role: 'host',
        content: resp.response,
        timestamp: new Date(),
        meta: {
          escalation: resp.escalation,
          manager: resp.manager,
          toolUsed: resp.toolUsed,
          toolName: resp.toolName,
          toolInput: resp.toolInput,
          toolResults: resp.toolResults,
          toolDurationMs: resp.toolDurationMs,
          inputTokens: resp.inputTokens,
          outputTokens: resp.outputTokens,
          durationMs: resp.durationMs,
          model: resp.model,
          ragContext: (resp as any).ragContext ?? null,
        },
      }
      setMessages(prev => [...prev, aiMsg])
    } catch (err: any) {
      setStreamingText('')
      setError(err.message || 'Failed to get AI response')
    } finally {
      setLoading(false)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [input, loading, propertyId, reservationStatus, channel, guestName, checkIn, checkOut, guestCount, messages])

  // ── Reset chat ──────────────────────────────────────────────────────────
  const handleReset = useCallback(() => {
    setMessages([])
    setError(null)
    setStreamingText('')
    setInput('')
    if (inputRef.current) inputRef.current.style.height = 'auto'
  }, [])

  // ── Key handler ─────────────────────────────────────────────────────────
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  const selectedProperty = properties.find(p => p.id === propertyId)

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div style={{
      display: 'flex',
      height: '100%',
      fontFamily: T.font.sans,
      color: T.text.primary,
      background: T.bg.primary,
      overflow: 'hidden',
    }}>

      {/* ── Config Sidebar ──────────────────────────────────────────────── */}
      <div style={{
        width: configCollapsed ? 48 : 300,
        minWidth: configCollapsed ? 48 : 300,
        borderRight: `1px solid ${T.border.default}`,
        background: T.bg.secondary,
        display: 'flex',
        flexDirection: 'column',
        transition: 'width 0.2s ease, min-width 0.2s ease',
        overflow: 'hidden',
      }}>
        {/* Sidebar header */}
        <div style={{
          height: 48,
          padding: '0 12px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: configCollapsed ? 'center' : 'space-between',
          borderBottom: `1px solid ${T.border.default}`,
          flexShrink: 0,
        }}>
          {!configCollapsed && (
            <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em' }}>
              Sandbox Config
            </span>
          )}
          <button
            onClick={() => setConfigCollapsed(!configCollapsed)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: 4,
              color: T.text.secondary, display: 'flex', alignItems: 'center',
            }}
            title={configCollapsed ? 'Expand config' : 'Collapse config'}
          >
            <Settings2 size={16} />
          </button>
        </div>

        {/* Config fields */}
        {!configCollapsed && (
          <div style={{
            flex: 1,
            overflow: 'auto',
            padding: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}>
            {/* Property */}
            <FieldGroup label="Property">
              <select
                value={propertyId}
                onChange={e => setPropertyId(e.target.value)}
                style={selectStyle}
              >
                {properties.length === 0 && <option value="">Loading...</option>}
                {properties.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </FieldGroup>

            {/* Reservation Status */}
            <FieldGroup label="Reservation Status">
              <div style={{ display: 'flex', gap: 6 }}>
                {RESERVATION_STATUSES.map(s => (
                  <button
                    key={s}
                    onClick={() => setReservationStatus(s)}
                    style={{
                      flex: 1,
                      padding: '5px 0',
                      fontSize: 11,
                      fontWeight: 600,
                      fontFamily: T.font.sans,
                      borderRadius: 6,
                      border: `1px solid ${reservationStatus === s ? T.accent : T.border.default}`,
                      background: reservationStatus === s ? T.accent : T.bg.primary,
                      color: reservationStatus === s ? '#FFFFFF' : T.text.secondary,
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    {s === 'CHECKED_IN' ? 'CHECKED IN' : s}
                  </button>
                ))}
              </div>
            </FieldGroup>

            {/* Channel */}
            <FieldGroup label="Channel">
              <select
                value={channel}
                onChange={e => setChannel(e.target.value)}
                style={selectStyle}
              >
                {CHANNELS.map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </FieldGroup>

            {/* Guest Name */}
            <FieldGroup label="Guest Name">
              <input
                type="text"
                value={guestName}
                onChange={e => setGuestName(e.target.value)}
                style={inputStyle}
                placeholder="Test Guest"
              />
            </FieldGroup>

            {/* Dates */}
            <div style={{ display: 'flex', gap: 8 }}>
              <FieldGroup label="Check-in" style={{ flex: 1 }}>
                <input
                  type="date"
                  value={checkIn}
                  onChange={e => setCheckIn(e.target.value)}
                  style={inputStyle}
                />
              </FieldGroup>
              <FieldGroup label="Check-out" style={{ flex: 1 }}>
                <input
                  type="date"
                  value={checkOut}
                  onChange={e => setCheckOut(e.target.value)}
                  style={inputStyle}
                />
              </FieldGroup>
            </div>

            {/* Guest Count */}
            <FieldGroup label="Guest Count">
              <input
                type="number"
                value={guestCount}
                min={1}
                max={20}
                onChange={e => setGuestCount(parseInt(e.target.value) || 1)}
                style={inputStyle}
              />
            </FieldGroup>

            {/* Reset */}
            <button
              onClick={handleReset}
              style={{
                marginTop: 8,
                padding: '8px 0',
                fontSize: 12,
                fontWeight: 600,
                fontFamily: T.font.sans,
                borderRadius: 8,
                border: `1px solid ${T.border.default}`,
                background: T.bg.primary,
                color: T.text.secondary,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                transition: 'all 0.15s ease',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.borderColor = T.status.red
                e.currentTarget.style.color = T.status.red
              }}
              onMouseLeave={e => {
                e.currentTarget.style.borderColor = T.border.default
                e.currentTarget.style.color = T.text.secondary
              }}
            >
              <RotateCcw size={13} />
              Reset Chat
            </button>

            {/* Property info hint */}
            {selectedProperty && (
              <div style={{
                marginTop: 4,
                padding: 10,
                background: T.bg.primary,
                borderRadius: 8,
                border: `1px solid ${T.border.default}`,
                fontSize: 11,
                color: T.text.tertiary,
                lineHeight: 1.5,
              }}>
                <div style={{ fontWeight: 600, color: T.text.secondary, marginBottom: 4 }}>
                  {selectedProperty.name}
                </div>
                {selectedProperty.address && (
                  <div>{selectedProperty.address}</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Chat Area ───────────────────────────────────────────────────── */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* Chat header */}
        <div style={{
          height: 48,
          padding: '0 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: `1px solid ${T.border.default}`,
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <MessageSquare size={16} color={T.accent} />
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              Sandbox Chat
            </span>
            <span style={{
              fontSize: 11,
              color: T.text.tertiary,
              background: T.bg.secondary,
              padding: '2px 8px',
              borderRadius: 4,
            }}>
              {reservationStatus} / {channel}
            </span>
          </div>
          <div style={{ fontSize: 11, color: T.text.tertiary }}>
            {messages.length} message{messages.length !== 1 ? 's' : ''}
          </div>
        </div>

        {/* Messages area */}
        <div style={{
          flex: 1,
          overflow: 'auto',
          padding: '20px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}>
          {/* Empty state */}
          {messages.length === 0 && !loading && (
            <div style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 12,
              color: T.text.tertiary,
            }}>
              <MessageSquare size={40} strokeWidth={1.2} />
              <div style={{ fontSize: 14, fontWeight: 500 }}>
                Start a conversation
              </div>
              <div style={{ fontSize: 12, textAlign: 'center', maxWidth: 320, lineHeight: 1.6 }}>
                Type a message as if you were a guest. The AI will respond using the selected property&apos;s knowledge base and the full pipeline.
              </div>
            </div>
          )}

          {/* Messages */}
          {messages.map(msg => (
            <div
              key={msg.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: msg.role === 'guest' ? 'flex-end' : 'flex-start',
                maxWidth: '80%',
                alignSelf: msg.role === 'guest' ? 'flex-end' : 'flex-start',
              }}
            >
              {/* Bubble */}
              <div style={{
                padding: '10px 14px',
                borderRadius: msg.role === 'guest' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                background: msg.role === 'guest' ? T.accent : T.bg.secondary,
                color: msg.role === 'guest' ? '#FFFFFF' : T.text.primary,
                fontSize: 13,
                lineHeight: 1.55,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}>
                {msg.content}
              </div>

              {/* Meta badges for AI messages */}
              {msg.role === 'host' && msg.meta && (
                <div style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 6,
                  marginTop: 6,
                  alignItems: 'center',
                }}>
                  {/* Escalation badge */}
                  {msg.meta.escalation && (
                    <Badge
                      icon={<AlertTriangle size={10} />}
                      color={msg.meta.escalation.urgency === 'immediate' ? T.status.red : T.status.amber}
                      text={`Escalation: ${msg.meta.escalation.title}`}
                      tooltip={msg.meta.escalation.note}
                    />
                  )}

                  {/* Manager badge (INQUIRY) */}
                  {msg.meta.manager?.needed && (
                    <Badge
                      icon={<AlertTriangle size={10} />}
                      color={T.status.amber}
                      text={`Manager: ${msg.meta.manager.title}`}
                      tooltip={msg.meta.manager.note}
                    />
                  )}

                  {/* Tool badge */}
                  {msg.meta.toolUsed && (
                    <Badge
                      icon={<Wrench size={10} />}
                      color="#7C3AED"
                      text={`Tool: ${msg.meta.toolName || 'unknown'}${msg.meta.toolDurationMs ? ` (${msg.meta.toolDurationMs}ms)` : ''}`}
                      tooltip={msg.meta.toolResults
                        ? `Input: ${JSON.stringify(msg.meta.toolInput, null, 1)}\nResults: ${typeof msg.meta.toolResults === 'string' ? msg.meta.toolResults : JSON.stringify(msg.meta.toolResults, null, 1).substring(0, 300)}`
                        : undefined}
                    />
                  )}

                  {/* Token / timing info */}
                  <span style={{
                    fontSize: 10,
                    color: T.text.tertiary,
                    fontFamily: T.font.mono,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                      <Cpu size={9} />
                      {msg.meta.inputTokens?.toLocaleString()}in / {msg.meta.outputTokens?.toLocaleString()}out
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                      <Clock size={9} />
                      {msg.meta.durationMs ? `${(msg.meta.durationMs / 1000).toFixed(1)}s` : '--'}
                    </span>
                    {msg.meta.model && (
                      <span>{msg.meta.model}</span>
                    )}
                  </span>

                  {/* SOP classification + RAG context */}
                  {msg.meta.ragContext && (
                    <div style={{
                      width: '100%',
                      marginTop: 4,
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 4,
                      alignItems: 'center',
                    }}>
                      {/* SOP tool classification (new architecture) */}
                      {msg.meta.ragContext.sopCategories && msg.meta.ragContext.sopCategories.length > 0 && (
                        <>
                          {msg.meta.ragContext.sopCategories.filter((c: string) => c !== 'none').length > 0 ? (
                            <>
                              <span style={{ fontSize: 10, color: T.text.tertiary }}>
                                SOPs:
                              </span>
                              {msg.meta.ragContext.sopCategories.filter((c: string) => c !== 'none').map((cat: string, i: number) => (
                                <span
                                  key={i}
                                  title={msg.meta.ragContext?.sopReasoning || ''}
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    padding: '1px 6px',
                                    borderRadius: 4,
                                    background: '#30A46C14',
                                    border: '1px solid #30A46C30',
                                    color: '#30A46C',
                                    fontSize: 10,
                                    fontWeight: 600,
                                    fontFamily: T.font.mono,
                                    cursor: 'help',
                                  }}
                                >
                                  {cat}
                                </span>
                              ))}
                              {msg.meta.ragContext.sopConfidence && (
                                <span style={{
                                  fontSize: 10,
                                  fontFamily: T.font.mono,
                                  color: msg.meta.ragContext.sopConfidence === 'high' ? '#30A46C'
                                    : msg.meta.ragContext.sopConfidence === 'medium' ? '#FFB224'
                                    : '#F87171',
                                }}>
                                  {msg.meta.ragContext.sopConfidence}
                                </span>
                              )}
                            </>
                          ) : (
                            <span style={{ fontSize: 10, color: T.text.tertiary, fontFamily: T.font.mono }}>
                              no SOPs (none)
                            </span>
                          )}
                        </>
                      )}

                      {/* Legacy: old-style chunks (backward compat) */}
                      {(!msg.meta.ragContext.sopCategories) && msg.meta.ragContext.chunks?.length > 0 && (
                        <>
                          <span style={{ fontSize: 10, color: T.text.tertiary }}>
                            SOPs:
                          </span>
                          {msg.meta.ragContext.chunks.map((chunk: any, i: number) => (
                            <span
                              key={i}
                              title={`similarity: ${chunk.similarity?.toFixed?.(2) || '?'}`}
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                padding: '1px 6px',
                                borderRadius: 4,
                                background: '#30A46C14',
                                border: '1px solid #30A46C30',
                                color: '#30A46C',
                                fontSize: 10,
                                fontWeight: 600,
                                fontFamily: T.font.mono,
                                cursor: 'help',
                              }}
                            >
                              {chunk.category}
                            </span>
                          ))}
                        </>
                      )}

                      {/* No SOPs at all */}
                      {!msg.meta.ragContext.sopCategories && (!msg.meta.ragContext.chunks || msg.meta.ragContext.chunks.length === 0) && (
                        <span style={{ fontSize: 10, color: T.text.tertiary, fontFamily: T.font.mono }}>
                          no SOPs injected
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}

          {/* Loading / streaming indicator */}
          {loading && (
            <div style={{
              display: 'flex',
              alignItems: 'flex-start',
              maxWidth: '80%',
              alignSelf: 'flex-start',
            }}>
              {streamingText ? (
                /* Show progressive streaming text in an AI-style bubble */
                <div style={{
                  padding: '10px 14px',
                  borderRadius: '16px 16px 16px 4px',
                  background: T.bg.secondary,
                  color: T.text.primary,
                  fontSize: 13,
                  lineHeight: 1.55,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}>
                  {streamingText}
                  <span style={{
                    display: 'inline-block',
                    width: 5,
                    height: 14,
                    background: T.accent,
                    marginLeft: 1,
                    borderRadius: 1,
                    animation: 'cursor-blink 0.8s step-end infinite',
                    verticalAlign: 'text-bottom',
                  }} />
                </div>
              ) : (
                /* No streaming text yet — show thinking spinner */
                <div style={{
                  padding: '10px 14px',
                  borderRadius: '16px 16px 16px 4px',
                  background: T.bg.secondary,
                  color: T.text.tertiary,
                  fontSize: 13,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}>
                  <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
                  <span>Thinking...</span>
                </div>
              )}
            </div>
          )}

          {/* Error display */}
          {error && (
            <div style={{
              alignSelf: 'center',
              padding: '8px 14px',
              borderRadius: 8,
              background: `${T.status.red}10`,
              border: `1px solid ${T.status.red}30`,
              color: T.status.red,
              fontSize: 12,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}>
              <AlertTriangle size={13} />
              {error}
            </div>
          )}

          <div ref={chatEndRef} />
        </div>

        {/* Input area */}
        <div style={{
          padding: '12px 20px 16px',
          borderTop: `1px solid ${T.border.default}`,
          background: T.bg.primary,
          flexShrink: 0,
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: 10,
            background: T.bg.secondary,
            borderRadius: 12,
            padding: '8px 8px 8px 14px',
            border: `1px solid ${T.border.default}`,
            transition: 'border-color 0.15s ease',
          }}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => handleInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={propertyId ? 'Type a guest message...' : 'Select a property first'}
              disabled={!propertyId || loading}
              rows={1}
              style={{
                flex: 1,
                border: 'none',
                outline: 'none',
                background: 'transparent',
                fontSize: 13,
                fontFamily: T.font.sans,
                color: T.text.primary,
                resize: 'none',
                lineHeight: 1.5,
                minHeight: 20,
                maxHeight: 120,
              }}
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || loading || !propertyId}
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                border: 'none',
                background: input.trim() && !loading && propertyId ? T.accent : T.bg.tertiary,
                color: input.trim() && !loading && propertyId ? '#FFFFFF' : T.text.tertiary,
                cursor: input.trim() && !loading && propertyId ? 'pointer' : 'not-allowed',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                transition: 'all 0.15s ease',
              }}
            >
              {loading ? (
                <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} />
              ) : (
                <Send size={15} />
              )}
            </button>
          </div>
          <div style={{
            marginTop: 6,
            fontSize: 10,
            color: T.text.tertiary,
            textAlign: 'center',
          }}>
            Shift+Enter for new line. Messages are not saved.
          </div>
        </div>
      </div>

      {/* Keyframe animations */}
      <style>{`
        @keyframes spin { to { transform: rotate(360deg) } }
        @keyframes cursor-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
      `}</style>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function FieldGroup({
  label,
  children,
  style,
}: {
  label: string
  children: React.ReactNode
  style?: React.CSSProperties
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, ...style }}>
      <label style={{
        fontSize: 11,
        fontWeight: 600,
        color: T.text.secondary,
        letterSpacing: '0.02em',
      }}>
        {label}
      </label>
      {children}
    </div>
  )
}

function Badge({
  icon,
  color,
  text,
  tooltip,
}: {
  icon: React.ReactNode
  color: string
  text: string
  tooltip?: string
}) {
  return (
    <span
      title={tooltip}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 7px',
        borderRadius: 4,
        background: `${color}14`,
        border: `1px solid ${color}30`,
        color,
        fontSize: 10,
        fontWeight: 600,
        cursor: tooltip ? 'help' : 'default',
        whiteSpace: 'nowrap',
        maxWidth: 280,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {icon}
      {text}
    </span>
  )
}

// ─── Shared input styles ──────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '7px 10px',
  fontSize: 12,
  fontFamily: T.font.sans,
  border: `1px solid ${T.border.default}`,
  borderRadius: 6,
  background: T.bg.primary,
  color: T.text.primary,
  outline: 'none',
  boxSizing: 'border-box',
  transition: 'border-color 0.15s ease',
}

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  appearance: 'none',
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 8px center',
  paddingRight: 28,
  cursor: 'pointer',
}
