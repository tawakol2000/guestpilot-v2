'use client'

import { useState, useEffect } from 'react'
import { BarChart3, RefreshCw, Clock, Filter, ChevronRight, ExternalLink } from 'lucide-react'
import {
  apiGetSopClassifications,
  apiGetSopStats,
  type SopClassification,
  type SopStatsResponse,
} from '@/lib/api'

// ── Design Tokens ──────────────────────────────────────────────────────────
const T = {
  bg: { primary: '#FAFAF9', secondary: '#F5F5F4', tertiary: '#E7E5E4' },
  text: { primary: '#0C0A09', secondary: '#57534E', tertiary: '#A8A29E' },
  accent: '#1D4ED8',
  status: { green: '#15803D', red: '#DC2626', amber: '#D97706' },
  border: { default: '#E7E5E4', strong: '#1C1917' },
  shadow: {
    sm: '0 1px 2px rgba(12,10,9,0.04)',
    md: '0 4px 6px -1px rgba(12,10,9,0.06), 0 2px 4px -2px rgba(12,10,9,0.04)',
  },
  font: {
    sans: "'Plus Jakarta Sans', system-ui, -apple-system, sans-serif",
    mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
  },
  radius: { sm: 8, md: 12, lg: 16 },
} as const

const PURPLE = '#7C3AED'

// ── Styles ──────────────────────────────────────────────────────────────────
const STYLE_ID = 'sop-monitor-v5-styles'
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
.sop-mon-scroll::-webkit-scrollbar { width: 5px; }
.sop-mon-scroll::-webkit-scrollbar-track { background: transparent; }
.sop-mon-scroll::-webkit-scrollbar-thumb { background: #E7E5E4; border-radius: 99px; }
.sop-mon-scroll::-webkit-scrollbar-thumb:hover { background: #A8A29E; }
`
  document.head.appendChild(style)
}

// ── Primitives ──────────────────────────────────────────────────────────────
function Card({ children, style: s }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: '#FFFFFF', border: `1px solid ${T.border.default}`,
      borderRadius: T.radius.md, boxShadow: T.shadow.sm,
      overflow: 'visible',
      animation: 'scaleIn 0.3s ease-out both',
      ...s,
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
      borderRadius: T.radius.sm, background: '#FFFFFF', color: T.text.secondary,
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

function sopBadgeColor(category: string): { bg: string; fg: string } {
  if (category.startsWith('sop')) return { bg: '#DBEAFE', fg: '#2563EB' }
  if (category.startsWith('property')) return { bg: '#DCFCE7', fg: '#15803D' }
  if (category.startsWith('pricing') || category.startsWith('payment') || category.startsWith('post-stay'))
    return { bg: '#FEF3C7', fg: '#D97706' }
  if (category === 'non-actionable') return { bg: '#F3F4F6', fg: '#6B7280' }
  return { bg: '#F3E8FF', fg: PURPLE }
}

function confidenceBadge(conf: string): { bg: string; fg: string; border: string } {
  if (conf === 'high') return { bg: '#DCFCE7', fg: '#15803D', border: 'rgba(21,128,61,0.2)' }
  if (conf === 'medium') return { bg: '#FEF3C7', fg: '#D97706', border: 'rgba(217,119,6,0.2)' }
  return { bg: '#FEE2E2', fg: '#DC2626', border: 'rgba(220,38,38,0.2)' }
}

// ── Main Component ──────────────────────────────────────────────────────────
export default function SopMonitorV5() {
  const [classifications, setClassifications] = useState<SopClassification[]>([])
  const [total, setTotal] = useState(0)
  const [stats, setStats] = useState<SopStatsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [statsLoading, setStatsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confidenceFilter, setConfidenceFilter] = useState<string>('all')
  const [offset, setOffset] = useState(0)
  const PAGE_SIZE = 25

  useEffect(() => { ensureStyles() }, [])

  const loadStats = async () => {
    setStatsLoading(true)
    try {
      const data = await apiGetSopStats()
      setStats(data)
    } catch (err: any) {
      // stats load failure is non-critical
    } finally {
      setStatsLoading(false)
    }
  }

  const loadClassifications = async (newOffset = 0, conf?: string) => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiGetSopClassifications({
        limit: PAGE_SIZE,
        offset: newOffset,
        confidence: conf && conf !== 'all' ? conf : undefined,
      })
      setClassifications(data.classifications)
      setTotal(data.total)
      setOffset(newOffset)
    } catch (err: any) {
      setError(err.message || 'Failed to load classifications')
    } finally {
      setLoading(false)
    }
  }

  const loadAll = async () => {
    await Promise.all([loadStats(), loadClassifications(0, confidenceFilter)])
  }

  useEffect(() => { loadAll() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleFilterChange = (conf: string) => {
    setConfidenceFilter(conf)
    loadClassifications(0, conf)
  }

  const handleLoadMore = () => {
    const nextOffset = offset + PAGE_SIZE
    if (nextOffset < total) {
      loadClassifications(nextOffset, confidenceFilter)
    }
  }

  return (
    <div
      className="sop-mon-scroll"
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
            width: 36, height: 36, borderRadius: T.radius.sm, background: '#FFFFFF',
            border: `1px solid ${T.border.default}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <BarChart3 size={18} color={T.text.primary} />
          </div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: T.text.primary, letterSpacing: '-0.02em' }}>
              SOP Monitor
            </div>
            <div style={{ fontSize: 12, color: T.text.tertiary }}>
              SOP classification accuracy and distribution tracking
            </div>
          </div>
        </div>

        {/* Stats bar */}
        <Card>
          <CardHeader
            icon={<BarChart3 size={14} color={T.accent} />}
            title="Classification Overview"
            sub={stats ? `${stats.totalClassifications} total` : undefined}
            right={<RefreshBtn loading={statsLoading} onClick={loadAll} />}
          />
          <div style={{ padding: '16px 20px', display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            {statsLoading && !stats ? (
              <div style={{ fontSize: 12, color: T.text.tertiary }}>Loading stats...</div>
            ) : stats ? (
              <>
                {/* Total */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '6px 14px', borderRadius: T.radius.sm,
                  background: T.bg.secondary, border: `1px solid ${T.border.default}`,
                }}>
                  <span style={{ fontSize: 18, fontWeight: 800, color: T.text.primary, fontFamily: T.font.sans }}>
                    {stats.totalClassifications}
                  </span>
                  <span style={{ fontSize: 11, color: T.text.tertiary, fontWeight: 500 }}>total</span>
                </div>
                {/* High confidence */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '6px 14px', borderRadius: T.radius.sm,
                  background: 'rgba(21,128,61,0.06)', border: '1px solid rgba(21,128,61,0.15)',
                }}>
                  <span style={{ fontSize: 18, fontWeight: 800, color: T.status.green, fontFamily: T.font.sans }}>
                    {stats.byConfidence.high}
                  </span>
                  <span style={{ fontSize: 11, color: T.status.green, fontWeight: 600 }}>high</span>
                </div>
                {/* Medium confidence */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '6px 14px', borderRadius: T.radius.sm,
                  background: 'rgba(217,119,6,0.06)', border: '1px solid rgba(217,119,6,0.15)',
                }}>
                  <span style={{ fontSize: 18, fontWeight: 800, color: T.status.amber, fontFamily: T.font.sans }}>
                    {stats.byConfidence.medium}
                  </span>
                  <span style={{ fontSize: 11, color: T.status.amber, fontWeight: 600 }}>medium</span>
                </div>
                {/* Low confidence */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '6px 14px', borderRadius: T.radius.sm,
                  background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.15)',
                }}>
                  <span style={{ fontSize: 18, fontWeight: 800, color: T.status.red, fontFamily: T.font.sans }}>
                    {stats.byConfidence.low}
                  </span>
                  <span style={{ fontSize: 11, color: T.status.red, fontWeight: 600 }}>low</span>
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12, color: T.text.tertiary }}>No stats available</div>
            )}
          </div>
        </Card>

        {/* Category distribution table */}
        {stats && stats.byCategory.length > 0 && (
          <Card>
            <CardHeader
              icon={<BarChart3 size={14} color={PURPLE} />}
              title="Category Distribution"
              sub={`${stats.byCategory.length} categories`}
            />
            <div style={{ overflow: 'auto' }}>
              {/* Table header */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: '1fr 80px 100px',
                padding: '8px 20px',
                borderBottom: `1px solid ${T.border.default}`,
                background: T.bg.secondary,
                gap: 12,
              }}>
                {['Category', 'Count', 'Percentage'].map((h) => (
                  <div key={h} style={{
                    fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                    letterSpacing: '0.07em', color: T.text.tertiary, fontFamily: T.font.sans,
                  }}>
                    {h}
                  </div>
                ))}
              </div>

              {/* Table rows */}
              {stats.byCategory.map((cat, i) => {
                const sc = sopBadgeColor(cat.category)
                return (
                  <div
                    key={cat.category}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 80px 100px',
                      padding: '10px 20px',
                      borderBottom: i < stats.byCategory.length - 1 ? `1px solid ${T.border.default}` : 'none',
                      gap: 12,
                      alignItems: 'center',
                      animation: `fadeInUp 0.2s ease-out ${i * 0.03}s both`,
                    }}
                  >
                    {/* Category badge */}
                    <div>
                      <span style={{
                        background: sc.bg, color: sc.fg,
                        fontSize: 11, fontWeight: 600, fontFamily: T.font.sans,
                        padding: '2px 10px', borderRadius: 999,
                        border: `1px solid ${sc.fg}20`,
                      }}>
                        {cat.category}
                      </span>
                    </div>
                    {/* Count */}
                    <div style={{
                      fontSize: 13, fontWeight: 700, fontFamily: T.font.sans, color: T.text.primary,
                    }}>
                      {cat.count}
                    </div>
                    {/* Percentage bar + value */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{
                        width: 50, height: 5, background: T.bg.tertiary,
                        borderRadius: 3, overflow: 'hidden', flexShrink: 0,
                      }}>
                        <div style={{
                          width: `${Math.min(100, cat.percentage)}%`,
                          height: '100%', borderRadius: 3,
                          background: sc.fg, transition: 'width 0.3s ease',
                        }} />
                      </div>
                      <span style={{
                        fontSize: 11, fontFamily: T.font.mono, fontWeight: 600, color: T.text.secondary,
                      }}>
                        {cat.percentage.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          </Card>
        )}

        {/* Recent classifications table */}
        <Card>
          <CardHeader
            icon={<Clock size={14} color={T.accent} />}
            title="Recent Classifications"
            sub={total > 0 ? `${total} total` : undefined}
            right={
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {/* Confidence filter */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Filter size={11} color={T.text.tertiary} />
                  <select
                    value={confidenceFilter}
                    onChange={(e) => handleFilterChange(e.target.value)}
                    style={{
                      height: 28, padding: '0 8px', fontSize: 11, fontWeight: 600,
                      border: `1px solid ${T.border.default}`, borderRadius: T.radius.sm,
                      background: '#FFFFFF', color: T.text.secondary,
                      fontFamily: T.font.sans, cursor: 'pointer',
                      appearance: 'auto',
                    }}
                  >
                    <option value="all">All confidence</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </div>
                <RefreshBtn loading={loading} onClick={() => loadClassifications(0, confidenceFilter)} />
              </div>
            }
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

          {!loading && !error && classifications.length === 0 && (
            <div style={{ padding: '40px 20px', textAlign: 'center' }}>
              <div style={{
                width: 48, height: 48, borderRadius: T.radius.md,
                background: T.bg.tertiary, margin: '0 auto 12px',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <BarChart3 size={20} color={T.text.tertiary} />
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: T.text.secondary, marginBottom: 4 }}>
                No classifications yet
              </div>
              <div style={{ fontSize: 11, color: T.text.tertiary }}>
                SOP classifications will appear here as the AI processes guest messages.
              </div>
            </div>
          )}

          {loading && classifications.length === 0 && (
            <div style={{
              padding: '40px 20px', textAlign: 'center',
              fontSize: 12, color: T.text.tertiary,
            }}>
              <RefreshCw size={16} style={{ animation: 'spin 1s linear infinite', marginBottom: 8 }} />
              <div>Loading classifications...</div>
            </div>
          )}

          {classifications.length > 0 && (
            <div style={{ overflow: 'auto' }}>
              {/* Table header */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: '140px 1fr 90px 1fr 40px',
                padding: '8px 20px',
                borderBottom: `1px solid ${T.border.default}`,
                background: T.bg.secondary,
                gap: 12,
              }}>
                {['Timestamp', 'Categories', 'Confidence', 'Reasoning', ''].map((h) => (
                  <div key={h || 'link'} style={{
                    fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                    letterSpacing: '0.07em', color: T.text.tertiary, fontFamily: T.font.sans,
                  }}>
                    {h}
                  </div>
                ))}
              </div>

              {/* Table rows */}
              {classifications.map((cls, i) => {
                const cb = confidenceBadge(cls.confidence)
                return (
                  <div
                    key={cls.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '140px 1fr 90px 1fr 40px',
                      padding: '10px 20px',
                      borderBottom: i < classifications.length - 1 ? `1px solid ${T.border.default}` : 'none',
                      gap: 12,
                      alignItems: 'center',
                      animation: `fadeInUp 0.2s ease-out ${i * 0.03}s both`,
                    }}
                  >
                    {/* Timestamp */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <Clock size={11} color={T.text.tertiary} />
                      <span style={{ fontSize: 11, fontFamily: T.font.mono, color: T.text.secondary }}>
                        {fmtTime(cls.createdAt)}
                      </span>
                    </div>

                    {/* Categories */}
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {cls.categories.map((cat, ci) => {
                        const sc = sopBadgeColor(cat)
                        return (
                          <span key={ci} style={{
                            background: sc.bg, color: sc.fg,
                            fontSize: 10, fontWeight: 600, fontFamily: T.font.sans,
                            padding: '2px 8px', borderRadius: 999,
                            border: `1px solid ${sc.fg}20`,
                          }}>
                            {cat}
                          </span>
                        )
                      })}
                    </div>

                    {/* Confidence badge */}
                    <div>
                      <span style={{
                        background: cb.bg, color: cb.fg,
                        fontSize: 10, fontWeight: 600, fontFamily: T.font.sans,
                        padding: '2px 8px', borderRadius: 999,
                        border: `1px solid ${cb.border}`,
                      }}>
                        {cls.confidence}
                      </span>
                    </div>

                    {/* Reasoning */}
                    <div style={{
                      fontSize: 11, fontFamily: T.font.mono, color: T.text.secondary,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {cls.reasoning || '--'}
                    </div>

                    {/* Conversation link */}
                    <div>
                      {cls.conversationId && (
                        <button
                          onClick={() => {
                            // Navigate to conversation — in inbox v5 this is handled by URL state
                            if (typeof window !== 'undefined') {
                              window.dispatchEvent(new CustomEvent('gp:navigate', {
                                detail: { tab: 'inbox', conversationId: cls.conversationId },
                              }))
                            }
                          }}
                          style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            width: 28, height: 28, borderRadius: T.radius.sm,
                            border: `1px solid ${T.border.default}`,
                            background: '#FFFFFF', cursor: 'pointer',
                            color: T.accent,
                          }}
                          title="View conversation"
                        >
                          <ExternalLink size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Load more button */}
          {classifications.length > 0 && offset + PAGE_SIZE < total && (
            <div style={{
              padding: '12px 20px',
              borderTop: `1px solid ${T.border.default}`,
              display: 'flex', justifyContent: 'center',
            }}>
              <button
                onClick={handleLoadMore}
                disabled={loading}
                style={{
                  height: 32, padding: '0 20px',
                  fontSize: 11, fontWeight: 600,
                  border: `1px solid ${T.border.default}`,
                  borderRadius: T.radius.sm,
                  background: '#FFFFFF', color: T.text.secondary,
                  cursor: loading ? 'default' : 'pointer',
                  fontFamily: T.font.sans,
                  opacity: loading ? 0.6 : 1,
                  transition: 'opacity 0.15s',
                  display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                {loading ? (
                  <RefreshCw size={12} style={{ animation: 'spin 1s linear infinite' }} />
                ) : (
                  <ChevronRight size={12} />
                )}
                Load more ({total - offset - PAGE_SIZE > 0 ? Math.min(PAGE_SIZE, total - offset - PAGE_SIZE) : 0} remaining)
              </button>
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
