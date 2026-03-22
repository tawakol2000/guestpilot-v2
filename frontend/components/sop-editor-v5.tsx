'use client'

import React, { useState, useEffect, useMemo } from 'react'
import { BookOpen, RefreshCw, ChevronDown, ChevronRight, Layers, FileText } from 'lucide-react'
import { apiGetSopData } from '../lib/api'

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
@keyframes shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
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

// ─── Interfaces ───────────────────────────────────────────────────────────────
interface SopEntry {
  category: string
  toolDescription: string
  content: string
  isGlobal: boolean
}

interface Property {
  id: string
  name: string
  address: string
}

interface PropertyChunk {
  id: string
  propertyId: string
  content: string
  category: string
  sourceKey: string
}

// ─── Category Colors ──────────────────────────────────────────────────────────
function categoryColor(cat: string): { bg: string; fg: string } {
  if (cat.startsWith('sop-'))      return { bg: '#EFF6FF', fg: '#1D4ED8' }
  if (cat.startsWith('property-')) return { bg: '#F0FDF4', fg: '#15803D' }
  if (cat.startsWith('pricing-') || cat.startsWith('payment-') || cat.startsWith('post-stay'))
    return { bg: '#FFFBEB', fg: '#D97706' }
  if (cat === 'non-actionable' || cat === 'none')
    return { bg: '#F3F4F6', fg: '#6B7280' }
  if (cat === 'escalate')
    return { bg: '#FEF2F2', fg: '#DC2626' }
  if (cat === 'pre-arrival-logistics')
    return { bg: '#F0FDF4', fg: '#15803D' }
  return { bg: '#F5F3FF', fg: '#7C3AED' }
}

// ─── Skeleton ──────────────────────────────────────────────────────────────────
function SkeletonTable(): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          style={{
            height: 48,
            background: `linear-gradient(90deg, ${T.bg.tertiary} 25%, ${T.bg.secondary} 50%, ${T.bg.tertiary} 75%)`,
            backgroundSize: '200% 100%',
            animation: 'shimmer 1.5s ease-in-out infinite',
            animationDelay: `${i * 0.05}s`,
          }}
        />
      ))}
    </div>
  )
}

// ─── Expandable Content Cell ──────────────────────────────────────────────────
function ExpandableContent({ text, maxHeight = 80 }: { text: string; maxHeight?: number }): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const isLong = text.length > 200

  return (
    <div>
      <div
        className="sop-scroll"
        style={{
          maxHeight: expanded ? 'none' : maxHeight,
          overflow: expanded ? 'visible' : 'hidden',
          fontFamily: T.font.mono,
          fontSize: 11.5,
          lineHeight: 1.6,
          color: T.text.primary,
          whiteSpace: 'pre-wrap' as const,
          wordBreak: 'break-word' as const,
        }}
      >
        {text}
      </div>
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 3,
            marginTop: 4,
            padding: 0,
            border: 'none',
            background: 'none',
            color: T.accent,
            fontSize: 11,
            fontWeight: 600,
            fontFamily: T.font.sans,
            cursor: 'pointer',
          }}
        >
          {expanded ? 'Show less' : 'Show more'}
          <ChevronDown
            size={12}
            style={{
              transition: 'transform 0.15s ease',
              transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
            }}
          />
        </button>
      )}
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function SopEditorV5() {
  const [sops, setSops] = useState<SopEntry[]>([])
  const [properties, setProperties] = useState<Property[]>([])
  const [propertyChunks, setPropertyChunks] = useState<PropertyChunk[]>([])
  const [selectedScope, setSelectedScope] = useState<string>('global')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [expandedRow, setExpandedRow] = useState<string | null>(null)

  useEffect(() => { ensureStyles() }, [])

  const fetchData = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    try {
      const data = await apiGetSopData()
      setSops(data.sops || [])
      setProperties(data.properties || [])
      setPropertyChunks(data.propertyChunks || [])
    } catch {
      // silent
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => { fetchData() }, [])

  const isGlobal = selectedScope === 'global'

  // Filtered property chunks for selected property
  const filteredChunks = useMemo(() => {
    if (isGlobal) return []
    return propertyChunks.filter(c => c.propertyId === selectedScope)
  }, [isGlobal, selectedScope, propertyChunks])

  const scopeLabel = isGlobal
    ? 'Global SOPs'
    : properties.find(p => p.id === selectedScope)?.name || selectedScope

  const rowCount = isGlobal ? sops.length : filteredChunks.length

  return (
    <div style={{
      fontFamily: T.font.sans,
      color: T.text.primary,
      height: '100%',
      background: T.bg.primary,
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column' as const,
    }}>
      <div style={{ flex: 1, overflowY: 'auto' as const, padding: 20 }}>
        {/* ─── Header ──────────────────────────────────────────────────────── */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap' as const,
          gap: 16,
          marginBottom: 20,
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
                Standard Operating Procedures and property knowledge
              </p>
            </div>
          </div>

          {/* Right side: dropdown + refresh */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* Property selector */}
            <div style={{ position: 'relative' as const }}>
              <select
                value={selectedScope}
                onChange={(e) => setSelectedScope(e.target.value)}
                style={{
                  height: 36,
                  minWidth: 200,
                  padding: '0 32px 0 12px',
                  fontSize: 13,
                  fontWeight: 600,
                  fontFamily: T.font.sans,
                  color: T.text.primary,
                  background: T.bg.card,
                  border: `1px solid ${T.border.default}`,
                  borderRadius: T.radius.sm,
                  boxShadow: T.shadow.sm,
                  cursor: 'pointer',
                  appearance: 'none' as const,
                  WebkitAppearance: 'none' as const,
                  outline: 'none',
                }}
                onFocus={(e) => { e.currentTarget.style.borderColor = T.accent }}
                onBlur={(e) => { e.currentTarget.style.borderColor = T.border.default }}
              >
                <option value="global">Global SOPs</option>
                {properties.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              {/* Custom chevron */}
              <ChevronDown
                size={14}
                color={T.text.tertiary}
                style={{
                  position: 'absolute' as const,
                  right: 10,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  pointerEvents: 'none' as const,
                }}
              />
            </div>

            {/* Refresh button */}
            <button
              onClick={() => fetchData(true)}
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

        {/* ─── Stats Bar ───────────────────────────────────────────────────── */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 16,
          animation: 'fadeInUp 0.3s ease-out both',
          animationDelay: '0.05s',
        }}>
          <Layers size={14} color={T.text.tertiary} />
          <span style={{
            fontSize: 13,
            fontWeight: 700,
            color: T.text.primary,
            fontFamily: T.font.sans,
          }}>
            {loading ? '...' : `${rowCount} ${isGlobal ? 'SOP categor' + (rowCount !== 1 ? 'ies' : 'y') : 'chunk' + (rowCount !== 1 ? 's' : '')}`}
          </span>
          <span style={{
            fontSize: 12,
            color: T.text.tertiary,
            fontFamily: T.font.sans,
          }}>
            {scopeLabel}
          </span>
        </div>

        {/* ─── Table ───────────────────────────────────────────────────────── */}
        {loading ? (
          <SkeletonTable />
        ) : rowCount === 0 ? (
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
            <p style={{ fontSize: 16, fontWeight: 700, color: T.text.primary, margin: 0, marginBottom: 6 }}>
              No knowledge found
            </p>
            <p style={{ fontSize: 13, color: T.text.tertiary, margin: 0 }}>
              {isGlobal
                ? 'No SOP categories loaded'
                : `No knowledge chunks for "${scopeLabel}"`}
            </p>
          </div>
        ) : isGlobal ? (
          /* ─── Global SOPs Table ──────────────────────────────────────── */
          <div style={{
            background: T.bg.card,
            border: `1px solid ${T.border.default}`,
            borderRadius: T.radius.md,
            boxShadow: T.shadow.sm,
            overflow: 'hidden',
            animation: 'fadeInUp 0.3s ease-out both',
            animationDelay: '0.1s',
          }}>
            {/* Table header */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '200px 1fr 1fr',
              gap: 0,
              background: T.bg.secondary,
              borderBottom: `1px solid ${T.border.default}`,
              padding: '10px 16px',
            }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: T.text.secondary, textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>
                SOP Name
              </span>
              <span style={{ fontSize: 11, fontWeight: 700, color: T.text.secondary, textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>
                Tool Description
              </span>
              <span style={{ fontSize: 11, fontWeight: 700, color: T.text.secondary, textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>
                SOP Content
              </span>
            </div>

            {/* Table rows */}
            {sops.map((sop, i) => {
              const colors = categoryColor(sop.category)
              const isExpanded = expandedRow === sop.category
              const hasContent = sop.content.length > 0

              return (
                <div key={sop.category}>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '200px 1fr 1fr',
                      gap: 0,
                      padding: '12px 16px',
                      borderBottom: i < sops.length - 1 ? `1px solid ${T.border.default}` : 'none',
                      alignItems: 'start',
                      transition: 'background 0.1s ease',
                      cursor: hasContent ? 'pointer' : 'default',
                    }}
                    onClick={() => {
                      if (hasContent) setExpandedRow(isExpanded ? null : sop.category)
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = T.bg.primary }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                  >
                    {/* SOP Name badge */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {hasContent && (
                        <ChevronRight
                          size={13}
                          color={T.text.tertiary}
                          style={{
                            transition: 'transform 0.15s ease',
                            transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                            flexShrink: 0,
                          }}
                        />
                      )}
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
                        {sop.category}
                      </span>
                    </div>

                    {/* Tool Description */}
                    <div style={{
                      fontSize: 12,
                      lineHeight: 1.5,
                      color: T.text.secondary,
                      fontFamily: T.font.sans,
                      paddingRight: 16,
                    }}>
                      {sop.toolDescription || <span style={{ color: T.text.tertiary, fontStyle: 'italic' as const }}>No description</span>}
                    </div>

                    {/* SOP Content preview / expanded */}
                    <div style={{
                      fontSize: 12,
                      lineHeight: 1.5,
                      color: T.text.primary,
                    }}>
                      {hasContent ? (
                        isExpanded ? (
                          <ExpandableContent text={sop.content} maxHeight={999} />
                        ) : (
                          <span style={{
                            fontFamily: T.font.mono,
                            fontSize: 11.5,
                            color: T.text.secondary,
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical' as const,
                            overflow: 'hidden',
                            wordBreak: 'break-word' as const,
                          }}>
                            {sop.content.substring(0, 150)}{sop.content.length > 150 ? '...' : ''}
                          </span>
                        )
                      ) : (
                        <span style={{ color: T.text.tertiary, fontStyle: 'italic' as const, fontSize: 12 }}>
                          No static SOP content
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          /* ─── Property Chunks Table ──────────────────────────────────── */
          <div style={{
            background: T.bg.card,
            border: `1px solid ${T.border.default}`,
            borderRadius: T.radius.md,
            boxShadow: T.shadow.sm,
            overflow: 'hidden',
            animation: 'fadeInUp 0.3s ease-out both',
            animationDelay: '0.1s',
          }}>
            {/* Table header */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '180px 160px 1fr',
              gap: 0,
              background: T.bg.secondary,
              borderBottom: `1px solid ${T.border.default}`,
              padding: '10px 16px',
            }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: T.text.secondary, textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>
                Category
              </span>
              <span style={{ fontSize: 11, fontWeight: 700, color: T.text.secondary, textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>
                Source Key
              </span>
              <span style={{ fontSize: 11, fontWeight: 700, color: T.text.secondary, textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>
                Content
              </span>
            </div>

            {/* Table rows */}
            {filteredChunks.map((chunk, i) => {
              const colors = categoryColor(chunk.category)
              const isExpanded = expandedRow === chunk.id

              return (
                <div key={chunk.id}>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '180px 160px 1fr',
                      gap: 0,
                      padding: '12px 16px',
                      borderBottom: i < filteredChunks.length - 1 ? `1px solid ${T.border.default}` : 'none',
                      alignItems: 'start',
                      transition: 'background 0.1s ease',
                      cursor: 'pointer',
                    }}
                    onClick={() => setExpandedRow(isExpanded ? null : chunk.id)}
                    onMouseEnter={(e) => { e.currentTarget.style.background = T.bg.primary }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                  >
                    {/* Category badge */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <ChevronRight
                        size={13}
                        color={T.text.tertiary}
                        style={{
                          transition: 'transform 0.15s ease',
                          transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                          flexShrink: 0,
                        }}
                      />
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
                    </div>

                    {/* Source Key */}
                    <span style={{
                      fontFamily: T.font.mono,
                      fontSize: 11,
                      color: T.text.tertiary,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap' as const,
                    }}>
                      {chunk.sourceKey}
                    </span>

                    {/* Content */}
                    <div style={{
                      fontSize: 12,
                      lineHeight: 1.5,
                      color: T.text.primary,
                    }}>
                      {isExpanded ? (
                        <ExpandableContent text={chunk.content} maxHeight={999} />
                      ) : (
                        <span style={{
                          fontFamily: T.font.mono,
                          fontSize: 11.5,
                          color: T.text.secondary,
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical' as const,
                          overflow: 'hidden',
                          wordBreak: 'break-word' as const,
                        }}>
                          {chunk.content.substring(0, 150)}{chunk.content.length > 150 ? '...' : ''}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
