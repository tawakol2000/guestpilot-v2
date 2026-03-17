'use client'

import React, { useState, useEffect, useCallback, useMemo } from 'react'
import {
  BookOpen, ChevronDown, RefreshCw, Check,
  FileText, Search, Layers,
} from 'lucide-react'

// ─── Design Tokens ────────────────────────────────────────────────────────────
const T = {
  bg: { primary: '#FAFAF9', secondary: '#F5F5F4', tertiary: '#E7E5E4', card: '#FFFFFF' },
  text: { primary: '#0C0A09', secondary: '#57534E', tertiary: '#A8A29E', inverse: '#FFFFFF' },
  accent: '#1D4ED8',
  status: { green: '#15803D', red: '#DC2626', amber: '#D97706', blue: '#2563EB' },
  border: { default: '#E7E5E4', strong: '#D6D3D1' },
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

// ─── Injected Styles ──────────────────────────────────────────────────────────
const injectedStyles = `
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap');
@keyframes spin { to { transform: rotate(360deg) } }
@keyframes fadeInUp {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes scaleIn {
  from { opacity: 0; transform: scale(0.96); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
@keyframes fadeOut {
  from { opacity: 1; }
  to { opacity: 0; }
}
.sop-scroll::-webkit-scrollbar { width: 5px; }
.sop-scroll::-webkit-scrollbar-track { background: transparent; }
.sop-scroll::-webkit-scrollbar-thumb { background: #E7E5E4; border-radius: 99px; }
.sop-scroll::-webkit-scrollbar-thumb:hover { background: #A8A29E; }
`

const STYLE_ID = 'sop-editor-v5-styles'
function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = injectedStyles
  document.head.appendChild(style)
}

// ─── API ──────────────────────────────────────────────────────────────────────
const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:3001'
const headers = () => ({
  Authorization: `Bearer ${typeof window !== 'undefined' ? localStorage.getItem('gp_token') : ''}`,
  'Content-Type': 'application/json',
})

// ─── Interfaces ───────────────────────────────────────────────────────────────
interface KnowledgeChunk {
  id: string
  propertyId: string | null
  content: string
  category: string
  sourceKey: string
  createdAt: string
  updatedAt?: string
}

interface Property {
  id: string
  name: string
  address: string
}

// ─── Category Colors ──────────────────────────────────────────────────────────
function categoryColor(cat: string): { bg: string; fg: string; accent: string } {
  if (cat.startsWith('sop-'))      return { bg: '#EFF6FF', fg: '#1D4ED8', accent: '#3B82F6' }
  if (cat.startsWith('property-')) return { bg: '#F0FDF4', fg: '#15803D', accent: '#22C55E' }
  if (cat.startsWith('pricing-') || cat.startsWith('payment-') || cat.startsWith('post-stay'))
    return { bg: '#FFFBEB', fg: '#D97706', accent: '#F59E0B' }
  if (cat === 'non-actionable')    return { bg: '#F3F4F6', fg: '#6B7280', accent: '#9CA3AF' }
  return { bg: '#F5F3FF', fg: '#7C3AED', accent: '#8B5CF6' }
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// ─── Skeleton Components ──────────────────────────────────────────────────────
function SkeletonCard({ delay = 0 }: { delay?: number }): React.ReactElement {
  return (
    <div style={{
      height: 320,
      borderRadius: T.radius.md,
      border: `1px solid ${T.border.default}`,
      background: `linear-gradient(90deg, ${T.bg.tertiary} 25%, ${T.bg.secondary} 50%, ${T.bg.tertiary} 75%)`,
      backgroundSize: '200% 100%',
      animation: 'shimmer 1.5s ease-in-out infinite',
      animationDelay: `${delay}s`,
      boxShadow: T.shadow.sm,
    }} />
  )
}

function SkeletonStats(): React.ReactElement {
  return (
    <div style={{
      height: 36,
      borderRadius: T.radius.sm,
      background: `linear-gradient(90deg, ${T.bg.tertiary} 25%, ${T.bg.secondary} 50%, ${T.bg.tertiary} 75%)`,
      backgroundSize: '200% 100%',
      animation: 'shimmer 1.5s ease-in-out infinite',
      maxWidth: 400,
    }} />
  )
}

// ─── SOP Card Sub-Component ──────────────────────────────────────────────────
function SopCard({ chunk, index }: {
  chunk: KnowledgeChunk
  index: number
}): React.ReactElement {
  const [localContent, setLocalContent] = useState(chunk.content)
  const [originalContent] = useState(chunk.content)
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<'saved' | 'failed' | null>(null)
  const [hovered, setHovered] = useState(false)

  const isDirty = localContent !== originalContent
  const colors = categoryColor(chunk.category)
  const animDelay = Math.min(index * 0.03, 0.5)

  const handleSave = useCallback(async () => {
    setSaving(true)
    setFeedback(null)
    try {
      const res = await fetch(`${API_BASE}/api/knowledge/chunks/${chunk.id}`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ content: localContent }),
      })
      if (!res.ok) throw new Error('Save failed')
      setFeedback('saved')
    } catch {
      setFeedback('failed')
    } finally {
      setSaving(false)
      setTimeout(() => setFeedback(null), 2200)
    }
  }, [chunk.id, localContent])

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: T.bg.card,
        borderRadius: T.radius.md,
        border: `1px solid ${isDirty ? '#EAB308' : T.border.default}`,
        boxShadow: hovered ? T.shadow.md : T.shadow.sm,
        transition: 'box-shadow 0.2s ease, border-color 0.2s ease',
        animation: 'fadeInUp 0.4s ease-out both',
        animationDelay: `${animDelay}s`,
        display: 'flex',
        flexDirection: 'column' as const,
        overflow: 'hidden',
      }}
    >
      {/* Card Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '14px 16px',
        borderBottom: `1px solid ${T.border.default}`,
      }}>
        {/* Accent bar */}
        <div style={{
          width: 4,
          height: 32,
          borderRadius: 2,
          background: colors.accent,
          flexShrink: 0,
        }} />

        {/* Category badge */}
        <span style={{
          display: 'inline-block',
          background: colors.bg,
          color: colors.fg,
          border: `1px solid ${colors.fg}28`,
          borderRadius: 999,
          fontSize: 11,
          padding: '3px 10px',
          fontFamily: T.font.sans,
          fontWeight: 600,
          whiteSpace: 'nowrap' as const,
        }}>
          {chunk.category}
        </span>

        {/* Source key */}
        <span style={{
          fontFamily: T.font.mono,
          fontSize: 10,
          color: T.text.tertiary,
          marginLeft: 'auto',
          whiteSpace: 'nowrap' as const,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          maxWidth: 200,
        }}>
          {chunk.sourceKey}
        </span>
      </div>

      {/* Card Body — textarea */}
      <div style={{ padding: '12px 16px', flex: 1 }}>
        <textarea
          className="sop-scroll"
          value={localContent}
          onChange={(e) => setLocalContent(e.target.value)}
          style={{
            width: '100%',
            minHeight: 180,
            resize: 'vertical' as const,
            fontFamily: T.font.mono,
            fontSize: 12,
            lineHeight: 1.6,
            color: T.text.primary,
            background: T.bg.primary,
            border: `1px solid ${isDirty ? '#EAB308' : T.border.default}`,
            borderRadius: T.radius.sm,
            padding: 12,
            outline: 'none',
            transition: 'border-color 0.2s ease',
            boxSizing: 'border-box' as const,
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = isDirty ? '#EAB308' : T.accent
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = isDirty ? '#EAB308' : T.border.default
          }}
        />
      </div>

      {/* Card Footer */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 16px',
        borderTop: `1px solid ${T.border.default}`,
        background: T.bg.primary,
      }}>
        <span style={{
          fontSize: 11,
          color: T.text.tertiary,
          fontFamily: T.font.sans,
        }}>
          Updated: {fmtDate(chunk.updatedAt || chunk.createdAt)}
        </span>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Save feedback */}
          {feedback === 'saved' && (
            <span style={{
              fontSize: 11,
              fontWeight: 600,
              color: T.status.green,
              fontFamily: T.font.sans,
              animation: 'fadeInUp 0.2s ease-out both',
            }}>
              Saved!
            </span>
          )}
          {feedback === 'failed' && (
            <span style={{
              fontSize: 11,
              fontWeight: 600,
              color: T.status.red,
              fontFamily: T.font.sans,
              animation: 'fadeInUp 0.2s ease-out both',
            }}>
              Failed
            </span>
          )}

          {/* Save button — only visible when dirty */}
          {isDirty && (
            <button
              onClick={handleSave}
              disabled={saving}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                height: 30,
                padding: '0 14px',
                background: saving ? T.text.tertiary : T.accent,
                color: T.text.inverse,
                border: 'none',
                borderRadius: T.radius.sm,
                fontSize: 12,
                fontWeight: 600,
                fontFamily: T.font.sans,
                cursor: saving ? 'not-allowed' : 'pointer',
                transition: 'background 0.15s ease',
                animation: 'fadeInUp 0.2s ease-out both',
              }}
              onMouseEnter={(e) => {
                if (!saving) e.currentTarget.style.background = '#1E40AF'
              }}
              onMouseLeave={(e) => {
                if (!saving) e.currentTarget.style.background = T.accent
              }}
            >
              {saving ? (
                <RefreshCw size={13} style={{ animation: 'spin 1s linear infinite' }} />
              ) : (
                <Check size={13} />
              )}
              {saving ? 'Saving...' : 'Save'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function SopEditorV5() {
  const [chunks, setChunks] = useState<KnowledgeChunk[]>([])
  const [properties, setProperties] = useState<Property[]>([])
  const [selectedScope, setSelectedScope] = useState<string>('global')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  // Inject keyframe styles
  useEffect(() => { ensureStyles() }, [])

  // Fetch properties on mount
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/properties`, { headers: headers() })
        if (res.ok) {
          const data = await res.json()
          setProperties(Array.isArray(data) ? data : data.properties || [])
        }
      } catch {
        // silent
      }
    })()
  }, [])

  // Fetch chunks when scope changes
  const fetchChunks = useCallback(async (scope: string, isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)

    try {
      const url = `${API_BASE}/api/knowledge/chunks?propertyId=${encodeURIComponent(scope)}`
      const res = await fetch(url, { headers: headers() })
      if (!res.ok) throw new Error('Fetch failed')
      const data = await res.json()
      setChunks(Array.isArray(data) ? data : data.chunks || [])
    } catch {
      setChunks([])
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    fetchChunks(selectedScope)
  }, [selectedScope, fetchChunks])

  // Filtered chunks (search)
  const filteredChunks = useMemo(() => {
    if (!searchQuery.trim()) return chunks
    const q = searchQuery.toLowerCase()
    return chunks.filter(c =>
      c.content.toLowerCase().includes(q) ||
      c.category.toLowerCase().includes(q) ||
      c.sourceKey.toLowerCase().includes(q)
    )
  }, [chunks, searchQuery])

  // Stats breakdown
  const stats = useMemo(() => {
    const cats: Record<string, number> = {}
    for (const c of chunks) {
      const type = c.category.startsWith('sop-') ? 'SOPs'
        : c.category.startsWith('property-') ? 'Property'
        : c.category.startsWith('pricing-') || c.category.startsWith('payment-') || c.category.startsWith('post-stay') ? 'Pricing'
        : 'Other'
      cats[type] = (cats[type] || 0) + 1
    }
    return cats
  }, [chunks])

  const scopeLabel = selectedScope === 'global'
    ? 'Global SOPs'
    : properties.find(p => p.id === selectedScope)?.name || selectedScope

  return (
    <div style={{
      fontFamily: T.font.sans,
      color: T.text.primary,
      minHeight: '100vh',
      background: T.bg.primary,
    }}>
      {/* ─── Header ──────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap' as const,
        gap: 16,
        marginBottom: 24,
        animation: 'fadeInUp 0.3s ease-out both',
      }}>
        {/* Left side: title */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 40,
            height: 40,
            borderRadius: T.radius.md,
            background: '#EFF6FF',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <BookOpen size={20} color={T.accent} />
          </div>
          <div>
            <h1 style={{
              fontSize: 22,
              fontWeight: 800,
              margin: 0,
              letterSpacing: '-0.02em',
              color: T.text.primary,
            }}>
              SOP Knowledge Base
            </h1>
            <p style={{
              fontSize: 13,
              color: T.text.secondary,
              margin: 0,
              marginTop: 2,
            }}>
              View and edit Standard Operating Procedures
            </p>
          </div>
        </div>

        {/* Right side: dropdown + refresh */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {/* Search */}
          <div style={{ position: 'relative' as const }}>
            <Search size={14} color={T.text.tertiary} style={{
              position: 'absolute' as const,
              left: 10,
              top: '50%',
              transform: 'translateY(-50%)',
              pointerEvents: 'none' as const,
            }} />
            <input
              type="text"
              placeholder="Search SOPs..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                height: 36,
                width: 200,
                paddingLeft: 32,
                paddingRight: 12,
                fontSize: 13,
                fontFamily: T.font.sans,
                border: `1px solid ${T.border.default}`,
                borderRadius: T.radius.sm,
                background: T.bg.card,
                color: T.text.primary,
                outline: 'none',
                transition: 'border-color 0.15s ease',
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = T.accent }}
              onBlur={(e) => { e.currentTarget.style.borderColor = T.border.default }}
            />
          </div>

          {/* Scope dropdown */}
          <div style={{ position: 'relative' as const }}>
            <button
              onClick={() => setDropdownOpen(!dropdownOpen)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                height: 36,
                padding: '0 14px',
                background: T.bg.card,
                border: `1px solid ${T.border.default}`,
                borderRadius: T.radius.sm,
                fontSize: 13,
                fontWeight: 600,
                fontFamily: T.font.sans,
                color: T.text.primary,
                cursor: 'pointer',
                transition: 'border-color 0.15s ease',
                minWidth: 160,
                justifyContent: 'space-between',
                boxShadow: T.shadow.sm,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = T.accent }}
              onMouseLeave={(e) => {
                if (!dropdownOpen) e.currentTarget.style.borderColor = T.border.default
              }}
            >
              <span style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap' as const,
              }}>
                {scopeLabel}
              </span>
              <ChevronDown
                size={14}
                color={T.text.tertiary}
                style={{
                  transition: 'transform 0.2s ease',
                  transform: dropdownOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                  flexShrink: 0,
                }}
              />
            </button>

            {/* Dropdown menu */}
            {dropdownOpen && (
              <div style={{
                position: 'absolute' as const,
                top: 'calc(100% + 4px)',
                right: 0,
                minWidth: 220,
                background: T.bg.card,
                border: `1px solid ${T.border.default}`,
                borderRadius: T.radius.sm,
                boxShadow: T.shadow.lg,
                zIndex: 50,
                overflow: 'hidden',
                animation: 'scaleIn 0.15s ease-out both',
              }}>
                {/* Global option */}
                <button
                  onClick={() => {
                    setSelectedScope('global')
                    setDropdownOpen(false)
                  }}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left' as const,
                    padding: '10px 14px',
                    fontSize: 13,
                    fontWeight: selectedScope === 'global' ? 700 : 500,
                    fontFamily: T.font.sans,
                    color: selectedScope === 'global' ? T.accent : T.text.primary,
                    background: selectedScope === 'global' ? '#EFF6FF' : 'transparent',
                    border: 'none',
                    borderBottom: `1px solid ${T.border.default}`,
                    cursor: 'pointer',
                    transition: 'background 0.1s ease',
                  }}
                  onMouseEnter={(e) => {
                    if (selectedScope !== 'global') e.currentTarget.style.background = T.bg.secondary
                  }}
                  onMouseLeave={(e) => {
                    if (selectedScope !== 'global') e.currentTarget.style.background = 'transparent'
                  }}
                >
                  Global SOPs
                </button>

                {/* Property options */}
                {properties.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => {
                      setSelectedScope(p.id)
                      setDropdownOpen(false)
                    }}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left' as const,
                      padding: '10px 14px',
                      fontSize: 13,
                      fontWeight: selectedScope === p.id ? 700 : 500,
                      fontFamily: T.font.sans,
                      color: selectedScope === p.id ? T.accent : T.text.primary,
                      background: selectedScope === p.id ? '#EFF6FF' : 'transparent',
                      border: 'none',
                      borderBottom: `1px solid ${T.border.default}`,
                      cursor: 'pointer',
                      transition: 'background 0.1s ease',
                    }}
                    onMouseEnter={(e) => {
                      if (selectedScope !== p.id) e.currentTarget.style.background = T.bg.secondary
                    }}
                    onMouseLeave={(e) => {
                      if (selectedScope !== p.id) e.currentTarget.style.background = 'transparent'
                    }}
                  >
                    {p.name}
                  </button>
                ))}

                {properties.length === 0 && (
                  <div style={{
                    padding: '10px 14px',
                    fontSize: 12,
                    color: T.text.tertiary,
                    fontStyle: 'italic' as const,
                  }}>
                    No properties loaded
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Refresh button */}
          <button
            onClick={() => fetchChunks(selectedScope, true)}
            disabled={refreshing}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 36,
              height: 36,
              background: T.bg.card,
              border: `1px solid ${T.border.default}`,
              borderRadius: T.radius.sm,
              cursor: refreshing ? 'not-allowed' : 'pointer',
              transition: 'border-color 0.15s ease',
              boxShadow: T.shadow.sm,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = T.accent }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.border.default }}
          >
            <RefreshCw
              size={15}
              color={refreshing ? T.text.tertiary : T.text.secondary}
              style={refreshing ? { animation: 'spin 1s linear infinite' } : undefined}
            />
          </button>
        </div>
      </div>

      {/* Close dropdown on outside click */}
      {dropdownOpen && (
        <div
          onClick={() => setDropdownOpen(false)}
          style={{
            position: 'fixed' as const,
            inset: 0,
            zIndex: 40,
          }}
        />
      )}

      {/* ─── Stats Bar ───────────────────────────────────────────────────── */}
      <div style={{
        marginBottom: 20,
        animation: 'fadeInUp 0.3s ease-out both',
        animationDelay: '0.05s',
      }}>
        {loading ? (
          <SkeletonStats />
        ) : (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            flexWrap: 'wrap' as const,
          }}>
            {/* Total count */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}>
              <Layers size={14} color={T.text.tertiary} />
              <span style={{
                fontSize: 13,
                fontWeight: 700,
                color: T.text.primary,
                fontFamily: T.font.sans,
              }}>
                {chunks.length} chunk{chunks.length !== 1 ? 's' : ''}
              </span>
            </div>

            {/* Breakdown */}
            {Object.keys(stats).length > 0 && (
              <span style={{
                fontSize: 12,
                color: T.text.tertiary,
                fontFamily: T.font.sans,
              }}>
                {Object.entries(stats).map(([type, count], i) => (
                  <span key={type}>
                    {i > 0 && <span style={{ margin: '0 6px', color: T.border.strong }}>&middot;</span>}
                    <span style={{ fontWeight: 600, color: T.text.secondary }}>{count}</span>
                    {' '}{type}
                  </span>
                ))}
              </span>
            )}

            {/* Filtered indicator */}
            {searchQuery.trim() && (
              <span style={{
                fontSize: 11,
                fontWeight: 600,
                color: T.status.amber,
                background: '#FFFBEB',
                border: '1px solid #FDE68A',
                borderRadius: 999,
                padding: '2px 10px',
                fontFamily: T.font.sans,
              }}>
                Showing {filteredChunks.length} of {chunks.length}
              </span>
            )}
          </div>
        )}
      </div>

      {/* ─── Content Grid ────────────────────────────────────────────────── */}
      {loading ? (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(500px, 1fr))',
          gap: 16,
        }}>
          <SkeletonCard delay={0} />
          <SkeletonCard delay={0.05} />
          <SkeletonCard delay={0.1} />
          <SkeletonCard delay={0.15} />
          <SkeletonCard delay={0.2} />
          <SkeletonCard delay={0.25} />
        </div>
      ) : filteredChunks.length === 0 ? (
        /* Empty state */
        <div style={{
          display: 'flex',
          flexDirection: 'column' as const,
          alignItems: 'center',
          justifyContent: 'center',
          padding: '80px 20px',
          animation: 'fadeInUp 0.3s ease-out both',
        }}>
          <div style={{
            width: 64,
            height: 64,
            borderRadius: T.radius.lg,
            background: T.bg.secondary,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 16,
          }}>
            <FileText size={28} color={T.text.tertiary} />
          </div>
          <p style={{
            fontSize: 16,
            fontWeight: 700,
            color: T.text.primary,
            margin: 0,
            marginBottom: 6,
          }}>
            No SOPs found
          </p>
          <p style={{
            fontSize: 13,
            color: T.text.tertiary,
            margin: 0,
          }}>
            {searchQuery.trim()
              ? `No results matching "${searchQuery}" in this scope`
              : `No knowledge chunks exist for "${scopeLabel}"`
            }
          </p>
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(500px, 1fr))',
          gap: 16,
        }}>
          {filteredChunks.map((chunk, i) => (
            <SopCard key={chunk.id} chunk={chunk} index={i} />
          ))}
        </div>
      )}
    </div>
  )
}
