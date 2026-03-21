'use client'

import { useState, useEffect } from 'react'
import { Wrench, Search, Clock, CheckCircle, RefreshCw, Activity } from 'lucide-react'
import { apiGetToolInvocations, type ToolInvocation } from '@/lib/api'

// ─── Design Tokens (matching classifier-v5) ─────────────────────────────────
const T = {
  bg: { primary: '#FAFAF9', secondary: '#F5F5F4', tertiary: '#E7E5E4' },
  text: { primary: '#0C0A09', secondary: '#57534E', tertiary: '#A8A29E' },
  accent: '#1D4ED8',
  status: { green: '#15803D', red: '#DC2626', amber: '#D97706' },
  border: { default: '#E7E5E4', strong: '#1C1917' },
  shadow: {
    sm: '0 1px 2px rgba(12,10,9,0.04)',
    md: '0 4px 6px -1px rgba(12,10,9,0.06), 0 2px 4px -2px rgba(12,10,9,0.04)',
    lg: '0 10px 25px -5px rgba(12,10,9,0.08), 0 4px 10px -5px rgba(12,10,9,0.03)',
  },
  font: {
    sans: "'Plus Jakarta Sans', system-ui, -apple-system, sans-serif",
    mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
  },
  radius: { sm: 8, md: 12, lg: 16 },
} as const

// ─── Styles ──────────────────────────────────────────────────────────────────
const STYLE_ID = 'tools-v5-styles'
function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap');
@keyframes spin { to { transform: rotate(360deg) } }
@keyframes fadeInUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
@keyframes scaleIn { from { opacity: 0; transform: scale(0.97); } to { opacity: 1; transform: scale(1); } }
.tools-scroll::-webkit-scrollbar { width: 5px; }
.tools-scroll::-webkit-scrollbar-track { background: transparent; }
.tools-scroll::-webkit-scrollbar-thumb { background: #E7E5E4; border-radius: 99px; }
.tools-scroll::-webkit-scrollbar-thumb:hover { background: #A8A29E; }
`
  document.head.appendChild(style)
}

// ─── Primitives ──────────────────────────────────────────────────────────────
function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: T.bg.primary, border: `1px solid ${T.border.default}`,
      borderRadius: T.radius.md, boxShadow: T.shadow.sm,
      overflow: 'visible',
      animation: 'scaleIn 0.3s ease-out both',
      ...style,
    }}>{children}</div>
  )
}

function CardHeader({ icon, title, sub, right }: {
  icon: React.ReactNode; title: string; sub?: string; right?: React.ReactNode
}) {
  return (
    <div style={{
      padding: '13px 20px', borderBottom: `1px solid ${T.border.default}`,
      display: 'flex', alignItems: 'center', gap: 8,
    }}>
      {icon}
      <span style={{ fontSize: 13, fontWeight: 700, color: T.text.primary, fontFamily: T.font.sans }}>{title}</span>
      {sub && <span style={{ fontSize: 11, color: T.text.tertiary, fontFamily: T.font.mono }}>{sub}</span>}
      {right && <div style={{ marginLeft: 'auto' }}>{right}</div>}
    </div>
  )
}

function RefreshBtn({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} disabled={loading} style={{
      height: 28, padding: '0 10px', display: 'flex', alignItems: 'center', gap: 5,
      fontSize: 11, fontWeight: 600, border: `1px solid ${T.border.default}`,
      borderRadius: T.radius.sm, background: T.bg.primary, color: T.text.secondary,
      cursor: loading ? 'default' : 'pointer', fontFamily: T.font.sans,
      opacity: loading ? 0.6 : 1, transition: 'opacity 0.15s',
    }}>
      <RefreshCw size={12} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} />
      Refresh
    </button>
  )
}

function fmtTime(iso: string) {
  const d = new Date(iso)
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// ─── Tool definitions ────────────────────────────────────────────────────────
const AVAILABLE_TOOLS = [
  {
    id: 'search_available_properties',
    name: 'Property Search',
    description: 'Search for alternative properties matching guest criteria',
    agentScope: 'Screening (Inquiry only)',
    enabled: true,
  },
] as const

// ─── Main Component ──────────────────────────────────────────────────────────
export default function ToolsV5() {
  const [invocations, setInvocations] = useState<ToolInvocation[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { ensureStyles() }, [])

  const loadInvocations = async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiGetToolInvocations()
      setInvocations(data)
    } catch (err: any) {
      setError(err.message || 'Failed to load tool invocations')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadInvocations() }, [])

  return (
    <div
      className="tools-scroll"
      style={{
        flex: 1,
        overflow: 'auto',
        background: T.bg.secondary,
        padding: 24,
        fontFamily: T.font.sans,
      }}
    >
      <div style={{ maxWidth: 960, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Page header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <div style={{
            width: 36, height: 36, borderRadius: T.radius.sm, background: T.bg.primary,
            border: `1px solid ${T.border.default}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Wrench size={18} color={T.text.primary} />
          </div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: T.text.primary, letterSpacing: '-0.02em' }}>
              Tools
            </div>
            <div style={{ fontSize: 12, color: T.text.tertiary }}>
              AI agent tool definitions and recent invocations
            </div>
          </div>
        </div>

        {/* Section 1: Available Tools */}
        <Card>
          <CardHeader
            icon={<Wrench size={14} color={T.accent} />}
            title="Available Tools"
            sub={`${AVAILABLE_TOOLS.length} registered`}
          />
          <div style={{ padding: 0 }}>
            {AVAILABLE_TOOLS.map((tool) => (
              <div
                key={tool.id}
                style={{
                  padding: '16px 20px',
                  borderBottom: `1px solid ${T.border.default}`,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  animation: 'fadeInUp 0.3s ease-out both',
                }}
              >
                <div style={{
                  width: 36, height: 36, borderRadius: T.radius.sm,
                  background: `${T.accent}0A`,
                  border: `1px solid ${T.accent}20`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  <Search size={16} color={T.accent} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                    <span style={{
                      fontSize: 13, fontWeight: 700, color: T.text.primary, fontFamily: T.font.sans,
                    }}>
                      {tool.name}
                    </span>
                    <span style={{
                      fontSize: 10, fontFamily: T.font.mono, fontWeight: 500,
                      color: T.text.tertiary, background: T.bg.tertiary,
                      padding: '1px 6px', borderRadius: 4,
                    }}>
                      {tool.id}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: T.text.secondary, marginBottom: 4 }}>
                    {tool.description}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ fontSize: 10, color: T.text.tertiary, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Agent Scope:
                    </span>
                    <span style={{
                      fontSize: 10, fontFamily: T.font.mono, fontWeight: 500,
                      color: T.accent, background: `${T.accent}0A`,
                      border: `1px solid ${T.accent}20`,
                      padding: '1px 8px', borderRadius: 999,
                    }}>
                      {tool.agentScope}
                    </span>
                  </div>
                </div>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '4px 10px', borderRadius: 999,
                  background: tool.enabled ? `${T.status.green}0A` : T.bg.tertiary,
                  border: `1px solid ${tool.enabled ? `${T.status.green}28` : T.border.default}`,
                }}>
                  <CheckCircle size={12} color={tool.enabled ? T.status.green : T.text.tertiary} />
                  <span style={{
                    fontSize: 11, fontWeight: 600, fontFamily: T.font.sans,
                    color: tool.enabled ? T.status.green : T.text.tertiary,
                  }}>
                    {tool.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* Section 2: Recent Invocations */}
        <Card>
          <CardHeader
            icon={<Activity size={14} color={T.accent} />}
            title="Recent Invocations"
            sub={invocations.length > 0 ? `${invocations.length} entries` : undefined}
            right={<RefreshBtn loading={loading} onClick={loadInvocations} />}
          />

          {error && (
            <div style={{
              padding: '12px 20px', fontSize: 12, color: T.status.red,
              fontFamily: T.font.sans, background: `${T.status.red}08`,
              borderBottom: `1px solid ${T.border.default}`,
            }}>
              {error}
            </div>
          )}

          {!loading && !error && invocations.length === 0 && (
            <div style={{
              padding: '40px 20px', textAlign: 'center',
            }}>
              <div style={{
                width: 48, height: 48, borderRadius: T.radius.md,
                background: T.bg.tertiary, margin: '0 auto 12px',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Wrench size={20} color={T.text.tertiary} />
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: T.text.secondary, marginBottom: 4 }}>
                No tool invocations yet
              </div>
              <div style={{ fontSize: 11, color: T.text.tertiary }}>
                Tool calls will appear here when the AI agent uses registered tools during conversations.
              </div>
            </div>
          )}

          {loading && invocations.length === 0 && (
            <div style={{
              padding: '40px 20px', textAlign: 'center',
              fontSize: 12, color: T.text.tertiary,
            }}>
              <RefreshCw size={16} style={{ animation: 'spin 1s linear infinite', marginBottom: 8 }} />
              <div>Loading invocations...</div>
            </div>
          )}

          {invocations.length > 0 && (
            <div style={{ overflow: 'auto' }}>
              {/* Table header */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: '140px 130px 1fr 80px 80px',
                padding: '8px 20px',
                borderBottom: `1px solid ${T.border.default}`,
                background: T.bg.secondary,
                gap: 12,
              }}>
                {['Timestamp', 'Tool', 'Search Criteria', 'Results', 'Duration'].map((h) => (
                  <div key={h} style={{
                    fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                    letterSpacing: '0.07em', color: T.text.tertiary, fontFamily: T.font.sans,
                  }}>
                    {h}
                  </div>
                ))}
              </div>

              {/* Table rows */}
              {invocations.map((inv, i) => {
                const input = inv.toolInput as Record<string, unknown> | null
                const results = inv.toolResults as any

                // Extract search criteria from toolInput
                let criteria = ''
                if (input) {
                  const parts: string[] = []
                  if (input.amenities && Array.isArray(input.amenities)) {
                    parts.push(`amenities: ${(input.amenities as string[]).join(', ')}`)
                  }
                  if (input.guests) parts.push(`guests: ${input.guests}`)
                  if (input.location) parts.push(`location: ${input.location}`)
                  if (input.checkIn) parts.push(`check-in: ${input.checkIn}`)
                  if (input.checkOut) parts.push(`check-out: ${input.checkOut}`)
                  criteria = parts.length > 0 ? parts.join(' | ') : JSON.stringify(input)
                }

                // Extract results count
                let resultCount = '--'
                if (results) {
                  if (Array.isArray(results)) {
                    resultCount = String(results.length)
                  } else if (typeof results === 'object' && results.count != null) {
                    resultCount = String(results.count)
                  } else if (typeof results === 'object' && results.properties && Array.isArray(results.properties)) {
                    resultCount = String(results.properties.length)
                  }
                }

                return (
                  <div
                    key={inv.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '140px 130px 1fr 80px 80px',
                      padding: '10px 20px',
                      borderBottom: i < invocations.length - 1 ? `1px solid ${T.border.default}` : 'none',
                      gap: 12,
                      alignItems: 'center',
                      animation: `fadeInUp 0.2s ease-out ${i * 0.03}s both`,
                    }}
                  >
                    {/* Timestamp */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <Clock size={11} color={T.text.tertiary} />
                      <span style={{ fontSize: 11, fontFamily: T.font.mono, color: T.text.secondary }}>
                        {fmtTime(inv.createdAt)}
                      </span>
                    </div>

                    {/* Tool name */}
                    <div>
                      <span style={{
                        fontSize: 11, fontFamily: T.font.mono, fontWeight: 600,
                        color: T.accent, background: `${T.accent}0A`,
                        border: `1px solid ${T.accent}20`,
                        padding: '2px 8px', borderRadius: 4,
                      }}>
                        {inv.toolName || 'unknown'}
                      </span>
                    </div>

                    {/* Search criteria */}
                    <div style={{
                      fontSize: 11, fontFamily: T.font.mono, color: T.text.secondary,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {criteria || '--'}
                    </div>

                    {/* Results count */}
                    <div style={{
                      fontSize: 12, fontWeight: 700, fontFamily: T.font.sans,
                      color: resultCount !== '--' ? T.text.primary : T.text.tertiary,
                    }}>
                      {resultCount}
                    </div>

                    {/* Duration */}
                    <div style={{
                      fontSize: 11, fontFamily: T.font.mono, color: T.text.secondary,
                    }}>
                      {inv.toolDurationMs != null ? `${inv.toolDurationMs}ms` : '--'}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
