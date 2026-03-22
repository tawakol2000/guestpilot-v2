'use client'

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { BookOpen, RefreshCw, ChevronDown, Search, FileText, Plus, Trash2, X } from 'lucide-react'
import {
  apiGetSopDefinitions,
  apiUpdateSopDefinition,
  apiUpdateSopVariant,
  apiCreateSopVariant,
  apiDeleteSopVariant,
  apiGetSopPropertyOverrides,
  apiCreateSopPropertyOverride,
  apiUpdateSopPropertyOverride,
  apiDeleteSopPropertyOverride,
  type SopDefinitionData,
  type SopVariantData,
  type SopPropertyOverrideData,
} from '../lib/api'

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
@keyframes savedFade {
  0% { opacity: 1; }
  70% { opacity: 1; }
  100% { opacity: 0; }
}
.sop-scroll::-webkit-scrollbar { width: 5px; }
.sop-scroll::-webkit-scrollbar-track { background: transparent; }
.sop-scroll::-webkit-scrollbar-thumb { background: #E7E5E4; border-radius: 99px; }
.sop-scroll::-webkit-scrollbar-thumb:hover { background: #A8A29E; }
.sop-textarea { resize: vertical; }
.sop-textarea:focus { outline: none; border-color: ${T.accent} !important; box-shadow: 0 0 0 2px ${T.accent}20 !important; }
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

// ─── Status Tabs ──────────────────────────────────────────────────────────────
const STATUS_TABS = ['DEFAULT', 'INQUIRY', 'CONFIRMED', 'CHECKED_IN'] as const
type StatusTab = typeof STATUS_TABS[number]

// ─── Skeleton ──────────────────────────────────────────────────────────────────
function SkeletonTable(): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          style={{
            height: 80,
            background: `linear-gradient(90deg, ${T.bg.tertiary} 25%, ${T.bg.secondary} 50%, ${T.bg.tertiary} 75%)`,
            backgroundSize: '200% 100%',
            animation: 'shimmer 1.5s ease-in-out infinite',
            animationDelay: `${i * 0.05}s`,
            borderRadius: i === 0 ? `${T.radius.md}px ${T.radius.md}px 0 0` : i === 7 ? `0 0 ${T.radius.md}px ${T.radius.md}px` : 0,
          }}
        />
      ))}
    </div>
  )
}

// ─── Saved Indicator ──────────────────────────────────────────────────────────
function SavedIndicator({ show }: { show: boolean }): React.ReactElement | null {
  if (!show) return null
  return (
    <span style={{
      fontSize: 11,
      fontWeight: 700,
      color: T.status.green,
      fontFamily: T.font.sans,
      animation: 'savedFade 2s ease-out forwards',
      marginLeft: 8,
    }}>
      Saved!
    </span>
  )
}

// ─── Toggle Switch ────────────────────────────────────────────────────────────
function ToggleSwitch({ checked, onChange, disabled }: {
  checked: boolean
  onChange: (val: boolean) => void
  disabled?: boolean
}): React.ReactElement {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); if (!disabled) onChange(!checked) }}
      disabled={disabled}
      style={{
        width: 36,
        height: 20,
        borderRadius: 10,
        border: 'none',
        background: checked ? T.accent : T.bg.tertiary,
        cursor: disabled ? 'not-allowed' : 'pointer',
        position: 'relative' as const,
        transition: 'background 0.2s ease',
        flexShrink: 0,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <div style={{
        width: 16,
        height: 16,
        borderRadius: '50%',
        background: T.bg.card,
        position: 'absolute' as const,
        top: 2,
        left: checked ? 18 : 2,
        transition: 'left 0.2s ease',
        boxShadow: T.shadow.sm,
      }} />
    </button>
  )
}

// ─── Variant Tab Bar ──────────────────────────────────────────────────────────
function VariantTabBar({ activeTab, onTabChange, variants, overrides, isPropertyView }: {
  activeTab: StatusTab
  onTabChange: (tab: StatusTab) => void
  variants: SopVariantData[]
  overrides?: SopPropertyOverrideData[]
  isPropertyView: boolean
}): React.ReactElement {
  return (
    <div style={{
      display: 'flex',
      gap: 0,
      borderBottom: `1px solid ${T.border.default}`,
      marginBottom: 12,
    }}>
      {STATUS_TABS.map(tab => {
        const isActive = activeTab === tab
        const hasVariant = variants.some(v => v.status === tab)
        const hasOverride = isPropertyView && overrides?.some(o => o.status === tab)

        return (
          <button
            key={tab}
            onClick={() => onTabChange(tab)}
            style={{
              padding: '6px 14px',
              fontSize: 11,
              fontWeight: isActive ? 700 : 500,
              fontFamily: T.font.sans,
              color: isActive ? T.accent : hasVariant || hasOverride ? T.text.primary : T.text.tertiary,
              background: isActive ? `${T.accent}08` : 'transparent',
              border: 'none',
              borderBottom: isActive ? `2px solid ${T.accent}` : '2px solid transparent',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
              position: 'relative' as const,
              whiteSpace: 'nowrap' as const,
            }}
          >
            {tab}
            {hasOverride && (
              <span style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: T.status.amber,
                display: 'inline-block',
                marginLeft: 4,
                verticalAlign: 'super',
              }} />
            )}
          </button>
        )
      })}
    </div>
  )
}

// ─── SOP Row Component ────────────────────────────────────────────────────────
function SopRow({ def, isPropertyView, propertyId, overrides, onOverridesChange, onDefinitionChange }: {
  def: SopDefinitionData
  isPropertyView: boolean
  propertyId: string | null
  overrides: SopPropertyOverrideData[]
  onOverridesChange: () => void
  onDefinitionChange: () => void
}): React.ReactElement {
  const colors = categoryColor(def.category)
  const [activeTab, setActiveTab] = useState<StatusTab>('DEFAULT')
  const [descDraft, setDescDraft] = useState(def.toolDescription)
  const [descDirty, setDescDirty] = useState(false)
  const [variantDrafts, setVariantDrafts] = useState<Record<string, string>>({})
  const [overrideDrafts, setOverrideDrafts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [saved, setSaved] = useState<Record<string, boolean>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const savedTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  // Reset drafts when def changes
  useEffect(() => {
    setDescDraft(def.toolDescription)
    setDescDirty(false)
    setVariantDrafts({})
    setOverrideDrafts({})
  }, [def.id, def.toolDescription])

  const showSaved = useCallback((key: string) => {
    setSaved(p => ({ ...p, [key]: true }))
    if (savedTimers.current[key]) clearTimeout(savedTimers.current[key])
    savedTimers.current[key] = setTimeout(() => {
      setSaved(p => ({ ...p, [key]: false }))
    }, 2000)
  }, [])

  const clearError = useCallback((key: string) => {
    setErrors(p => { const n = { ...p }; delete n[key]; return n })
  }, [])

  const activeVariant = def.variants.find(v => v.status === activeTab)
  const activeOverride = overrides.find(o => o.sopDefinitionId === def.id && o.status === activeTab)
  const variantCount = def.variants.length

  // ── Save description ──
  const saveDescription = async () => {
    setSaving(p => ({ ...p, desc: true }))
    clearError('desc')
    try {
      await apiUpdateSopDefinition(def.id, { toolDescription: descDraft })
      setDescDirty(false)
      showSaved('desc')
      onDefinitionChange()
    } catch (e: unknown) {
      setErrors(p => ({ ...p, desc: e instanceof Error ? e.message : 'Failed to save' }))
    } finally {
      setSaving(p => ({ ...p, desc: false }))
    }
  }

  // ── Toggle definition enabled ──
  const toggleDefinition = async (enabled: boolean) => {
    clearError('toggle')
    try {
      await apiUpdateSopDefinition(def.id, { enabled })
      onDefinitionChange()
    } catch (e: unknown) {
      setErrors(p => ({ ...p, toggle: e instanceof Error ? e.message : 'Failed to toggle' }))
    }
  }

  // ── Save variant content ──
  const saveVariant = async (variant: SopVariantData) => {
    const key = `var-${variant.id}`
    setSaving(p => ({ ...p, [key]: true }))
    clearError(key)
    try {
      const content = variantDrafts[variant.id] ?? variant.content
      await apiUpdateSopVariant(variant.id, { content })
      setVariantDrafts(p => { const n = { ...p }; delete n[variant.id]; return n })
      showSaved(key)
      onDefinitionChange()
    } catch (e: unknown) {
      setErrors(p => ({ ...p, [key]: e instanceof Error ? e.message : 'Failed to save' }))
    } finally {
      setSaving(p => ({ ...p, [key]: false }))
    }
  }

  // ── Toggle variant enabled ──
  const toggleVariant = async (variant: SopVariantData, enabled: boolean) => {
    clearError(`var-${variant.id}`)
    try {
      await apiUpdateSopVariant(variant.id, { enabled })
      onDefinitionChange()
    } catch (e: unknown) {
      setErrors(p => ({ ...p, [`var-${variant.id}`]: e instanceof Error ? e.message : 'Failed to toggle' }))
    }
  }

  // ── Create variant ──
  const createVariant = async () => {
    const key = `create-${activeTab}`
    setSaving(p => ({ ...p, [key]: true }))
    clearError(key)
    try {
      await apiCreateSopVariant({ sopDefinitionId: def.id, status: activeTab, content: '' })
      showSaved(key)
      onDefinitionChange()
    } catch (e: unknown) {
      setErrors(p => ({ ...p, [key]: e instanceof Error ? e.message : 'Failed to create variant' }))
    } finally {
      setSaving(p => ({ ...p, [key]: false }))
    }
  }

  // ── Delete variant ──
  const deleteVariant = async (variant: SopVariantData) => {
    const key = `del-${variant.id}`
    clearError(key)
    try {
      await apiDeleteSopVariant(variant.id)
      showSaved(key)
      onDefinitionChange()
    } catch (e: unknown) {
      setErrors(p => ({ ...p, [key]: e instanceof Error ? e.message : 'Failed to delete variant' }))
    }
  }

  // ── Save property override ──
  const saveOverride = async (override: SopPropertyOverrideData) => {
    const key = `ovr-${override.id}`
    setSaving(p => ({ ...p, [key]: true }))
    clearError(key)
    try {
      const content = overrideDrafts[override.id] ?? override.content
      await apiUpdateSopPropertyOverride(override.id, { content })
      setOverrideDrafts(p => { const n = { ...p }; delete n[override.id]; return n })
      showSaved(key)
      onOverridesChange()
    } catch (e: unknown) {
      setErrors(p => ({ ...p, [key]: e instanceof Error ? e.message : 'Failed to save override' }))
    } finally {
      setSaving(p => ({ ...p, [key]: false }))
    }
  }

  // ── Create property override ──
  const createOverride = async () => {
    if (!propertyId) return
    const key = `create-ovr-${activeTab}`
    setSaving(p => ({ ...p, [key]: true }))
    clearError(key)
    try {
      await apiCreateSopPropertyOverride({
        sopDefinitionId: def.id,
        propertyId,
        status: activeTab,
        content: '',
      })
      showSaved(key)
      onOverridesChange()
    } catch (e: unknown) {
      setErrors(p => ({ ...p, [key]: e instanceof Error ? e.message : 'Failed to create override' }))
    } finally {
      setSaving(p => ({ ...p, [key]: false }))
    }
  }

  // ── Delete property override ──
  const removeOverride = async (override: SopPropertyOverrideData) => {
    const key = `del-ovr-${override.id}`
    clearError(key)
    try {
      await apiDeleteSopPropertyOverride(override.id)
      showSaved(key)
      onOverridesChange()
    } catch (e: unknown) {
      setErrors(p => ({ ...p, [key]: e instanceof Error ? e.message : 'Failed to remove override' }))
    }
  }

  // ── Toggle property override enabled ──
  const toggleOverride = async (override: SopPropertyOverrideData, enabled: boolean) => {
    clearError(`ovr-${override.id}`)
    try {
      await apiUpdateSopPropertyOverride(override.id, { enabled })
      onOverridesChange()
    } catch (e: unknown) {
      setErrors(p => ({ ...p, [`ovr-${override.id}`]: e instanceof Error ? e.message : 'Failed to toggle' }))
    }
  }

  return (
    <div style={{
      background: T.bg.card,
      border: `1px solid ${T.border.default}`,
      borderRadius: T.radius.md,
      boxShadow: T.shadow.sm,
      overflow: 'hidden',
      animation: 'fadeInUp 0.3s ease-out both',
      opacity: def.enabled ? 1 : 0.55,
    }}>
      {/* ── Row Header ── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 16px',
        background: T.bg.secondary,
        borderBottom: `1px solid ${T.border.default}`,
      }}>
        {/* Badge */}
        <span style={{
          display: 'inline-block',
          background: colors.bg,
          color: colors.fg,
          border: `1px solid ${colors.fg}28`,
          borderRadius: 999,
          fontSize: 12,
          padding: '4px 12px',
          fontFamily: T.font.sans,
          fontWeight: 700,
          whiteSpace: 'nowrap' as const,
        }}>
          {def.category}
        </span>

        {/* Enable/Disable toggle */}
        <ToggleSwitch checked={def.enabled} onChange={toggleDefinition} />
        <span style={{ fontSize: 11, color: def.enabled ? T.status.green : T.text.tertiary, fontWeight: 600, fontFamily: T.font.sans }}>
          {def.enabled ? 'Enabled' : 'Disabled'}
        </span>
        {errors.toggle && <span style={{ fontSize: 11, color: T.status.red, fontFamily: T.font.sans }}>{errors.toggle}</span>}

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Variant count badge */}
        <span style={{
          fontSize: 11,
          fontWeight: 600,
          fontFamily: T.font.sans,
          color: T.text.tertiary,
          background: T.bg.primary,
          borderRadius: 999,
          padding: '2px 10px',
          border: `1px solid ${T.border.default}`,
        }}>
          {variantCount === 1 ? 'default only' : `${variantCount} variants`}
        </span>
      </div>

      {/* ── Body: two columns ── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1.6fr',
        minHeight: 120,
      }}>
        {/* ── Left: Tool Description ── */}
        <div style={{
          padding: 16,
          borderRight: `1px solid ${T.border.default}`,
          display: 'flex',
          flexDirection: 'column' as const,
          gap: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              fontSize: 11,
              fontWeight: 700,
              color: T.text.secondary,
              textTransform: 'uppercase' as const,
              letterSpacing: '0.05em',
              fontFamily: T.font.sans,
            }}>
              Tool Description
            </span>
            <SavedIndicator show={!!saved.desc} />
          </div>
          <textarea
            className="sop-textarea"
            value={descDraft}
            onChange={e => {
              setDescDraft(e.target.value)
              setDescDirty(e.target.value !== def.toolDescription)
              clearError('desc')
            }}
            rows={4}
            style={{
              width: '100%',
              padding: 10,
              fontSize: 12,
              lineHeight: 1.6,
              fontFamily: T.font.sans,
              color: T.text.primary,
              background: T.bg.primary,
              border: `1px solid ${T.border.default}`,
              borderRadius: T.radius.sm,
              boxSizing: 'border-box' as const,
              transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 10, color: T.text.tertiary, fontFamily: T.font.mono }}>
              {descDraft.length} chars
            </span>
            {descDirty && (
              <button
                onClick={saveDescription}
                disabled={!!saving.desc}
                style={{
                  padding: '4px 14px',
                  fontSize: 11,
                  fontWeight: 700,
                  fontFamily: T.font.sans,
                  color: T.text.inverse,
                  background: T.accent,
                  border: 'none',
                  borderRadius: T.radius.sm,
                  cursor: saving.desc ? 'not-allowed' : 'pointer',
                  opacity: saving.desc ? 0.6 : 1,
                  transition: 'opacity 0.15s ease',
                }}
              >
                {saving.desc ? 'Saving...' : 'Save'}
              </button>
            )}
          </div>
          {errors.desc && (
            <span style={{ fontSize: 11, color: T.status.red, fontFamily: T.font.sans }}>{errors.desc}</span>
          )}
        </div>

        {/* ── Right: Content Variants ── */}
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column' as const, gap: 4 }}>
          <span style={{
            fontSize: 11,
            fontWeight: 700,
            color: T.text.secondary,
            textTransform: 'uppercase' as const,
            letterSpacing: '0.05em',
            fontFamily: T.font.sans,
            marginBottom: 4,
          }}>
            Content Variants {isPropertyView ? '(Property)' : ''}
          </span>

          <VariantTabBar
            activeTab={activeTab}
            onTabChange={setActiveTab}
            variants={def.variants}
            overrides={isPropertyView ? overrides.filter(o => o.sopDefinitionId === def.id) : undefined}
            isPropertyView={isPropertyView}
          />

          {/* ── Property view: override content ── */}
          {isPropertyView ? (
            activeOverride ? (
              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{
                    fontSize: 10,
                    fontWeight: 700,
                    fontFamily: T.font.sans,
                    color: T.status.amber,
                    background: '#FFFBEB',
                    borderRadius: 999,
                    padding: '2px 8px',
                    border: '1px solid #D9770628',
                  }}>
                    Property Override
                  </span>
                  <ToggleSwitch checked={activeOverride.enabled} onChange={(v) => toggleOverride(activeOverride, v)} />
                  <span style={{ fontSize: 10, color: activeOverride.enabled ? T.status.green : T.text.tertiary, fontWeight: 600, fontFamily: T.font.sans }}>
                    {activeOverride.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                  <SavedIndicator show={!!saved[`ovr-${activeOverride.id}`]} />
                  <div style={{ flex: 1 }} />
                  <button
                    onClick={() => removeOverride(activeOverride)}
                    title="Remove override (revert to global)"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '3px 10px',
                      fontSize: 10,
                      fontWeight: 600,
                      fontFamily: T.font.sans,
                      color: T.status.red,
                      background: '#FEF2F2',
                      border: `1px solid ${T.status.red}28`,
                      borderRadius: T.radius.sm,
                      cursor: 'pointer',
                    }}
                  >
                    <X size={10} /> Remove Override
                  </button>
                </div>
                <textarea
                  className="sop-textarea sop-scroll"
                  value={overrideDrafts[activeOverride.id] ?? activeOverride.content}
                  onChange={e => {
                    setOverrideDrafts(p => ({ ...p, [activeOverride.id]: e.target.value }))
                    clearError(`ovr-${activeOverride.id}`)
                  }}
                  rows={6}
                  style={{
                    width: '100%',
                    padding: 10,
                    fontSize: 12,
                    lineHeight: 1.6,
                    fontFamily: T.font.mono,
                    color: T.text.primary,
                    background: T.bg.primary,
                    border: `1px solid ${T.border.default}`,
                    borderRadius: T.radius.sm,
                    boxSizing: 'border-box' as const,
                    transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
                  }}
                />
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 10, color: T.text.tertiary, fontFamily: T.font.mono }}>
                    {(overrideDrafts[activeOverride.id] ?? activeOverride.content).length} chars
                  </span>
                  {(overrideDrafts[activeOverride.id] !== undefined && overrideDrafts[activeOverride.id] !== activeOverride.content) && (
                    <button
                      onClick={() => saveOverride(activeOverride)}
                      disabled={!!saving[`ovr-${activeOverride.id}`]}
                      style={{
                        padding: '4px 14px',
                        fontSize: 11,
                        fontWeight: 700,
                        fontFamily: T.font.sans,
                        color: T.text.inverse,
                        background: T.accent,
                        border: 'none',
                        borderRadius: T.radius.sm,
                        cursor: saving[`ovr-${activeOverride.id}`] ? 'not-allowed' : 'pointer',
                        opacity: saving[`ovr-${activeOverride.id}`] ? 0.6 : 1,
                      }}
                    >
                      {saving[`ovr-${activeOverride.id}`] ? 'Saving...' : 'Save'}
                    </button>
                  )}
                </div>
                {errors[`ovr-${activeOverride.id}`] && (
                  <span style={{ fontSize: 11, color: T.status.red, fontFamily: T.font.sans }}>{errors[`ovr-${activeOverride.id}`]}</span>
                )}
              </div>
            ) : (
              // No override exists for this tab in property view
              <div style={{
                display: 'flex',
                flexDirection: 'column' as const,
                alignItems: 'center',
                gap: 10,
                padding: '20px 0',
              }}>
                <span style={{
                  fontSize: 12,
                  color: T.text.tertiary,
                  fontStyle: 'italic' as const,
                  fontFamily: T.font.sans,
                }}>
                  (Global) — using global SOP for {activeTab}
                </span>
                {/* Show global content preview */}
                {activeVariant ? (
                  <div style={{
                    width: '100%',
                    padding: 10,
                    fontSize: 11.5,
                    lineHeight: 1.6,
                    fontFamily: T.font.mono,
                    color: T.text.tertiary,
                    background: T.bg.secondary,
                    borderRadius: T.radius.sm,
                    maxHeight: 100,
                    overflow: 'auto',
                    whiteSpace: 'pre-wrap' as const,
                    wordBreak: 'break-word' as const,
                  }}>
                    {activeVariant.content || '(empty)'}
                  </div>
                ) : (
                  <span style={{ fontSize: 11, color: T.text.tertiary, fontFamily: T.font.sans }}>
                    No global variant for {activeTab} either
                  </span>
                )}
                <button
                  onClick={createOverride}
                  disabled={!!saving[`create-ovr-${activeTab}`]}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    padding: '5px 14px',
                    fontSize: 11,
                    fontWeight: 700,
                    fontFamily: T.font.sans,
                    color: T.accent,
                    background: `${T.accent}08`,
                    border: `1px solid ${T.accent}30`,
                    borderRadius: T.radius.sm,
                    cursor: saving[`create-ovr-${activeTab}`] ? 'not-allowed' : 'pointer',
                  }}
                >
                  <Plus size={12} /> Add Override
                </button>
                {errors[`create-ovr-${activeTab}`] && (
                  <span style={{ fontSize: 11, color: T.status.red, fontFamily: T.font.sans }}>{errors[`create-ovr-${activeTab}`]}</span>
                )}
              </div>
            )
          ) : (
            // ── Global view: variant content ──
            activeVariant ? (
              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <ToggleSwitch checked={activeVariant.enabled} onChange={(v) => toggleVariant(activeVariant, v)} />
                  <span style={{ fontSize: 10, color: activeVariant.enabled ? T.status.green : T.text.tertiary, fontWeight: 600, fontFamily: T.font.sans }}>
                    {activeVariant.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                  <SavedIndicator show={!!saved[`var-${activeVariant.id}`]} />
                  <div style={{ flex: 1 }} />
                  {activeTab !== 'DEFAULT' && (
                    <button
                      onClick={() => deleteVariant(activeVariant)}
                      title="Delete this variant"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        padding: '3px 10px',
                        fontSize: 10,
                        fontWeight: 600,
                        fontFamily: T.font.sans,
                        color: T.status.red,
                        background: '#FEF2F2',
                        border: `1px solid ${T.status.red}28`,
                        borderRadius: T.radius.sm,
                        cursor: 'pointer',
                      }}
                    >
                      <Trash2 size={10} /> Delete Variant
                    </button>
                  )}
                </div>
                <textarea
                  className="sop-textarea sop-scroll"
                  value={variantDrafts[activeVariant.id] ?? activeVariant.content}
                  onChange={e => {
                    setVariantDrafts(p => ({ ...p, [activeVariant.id]: e.target.value }))
                    clearError(`var-${activeVariant.id}`)
                  }}
                  rows={6}
                  style={{
                    width: '100%',
                    padding: 10,
                    fontSize: 12,
                    lineHeight: 1.6,
                    fontFamily: T.font.mono,
                    color: T.text.primary,
                    background: T.bg.primary,
                    border: `1px solid ${T.border.default}`,
                    borderRadius: T.radius.sm,
                    boxSizing: 'border-box' as const,
                    transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
                  }}
                />
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 10, color: T.text.tertiary, fontFamily: T.font.mono }}>
                    {(variantDrafts[activeVariant.id] ?? activeVariant.content).length} chars
                  </span>
                  {(variantDrafts[activeVariant.id] !== undefined && variantDrafts[activeVariant.id] !== activeVariant.content) && (
                    <button
                      onClick={() => saveVariant(activeVariant)}
                      disabled={!!saving[`var-${activeVariant.id}`]}
                      style={{
                        padding: '4px 14px',
                        fontSize: 11,
                        fontWeight: 700,
                        fontFamily: T.font.sans,
                        color: T.text.inverse,
                        background: T.accent,
                        border: 'none',
                        borderRadius: T.radius.sm,
                        cursor: saving[`var-${activeVariant.id}`] ? 'not-allowed' : 'pointer',
                        opacity: saving[`var-${activeVariant.id}`] ? 0.6 : 1,
                      }}
                    >
                      {saving[`var-${activeVariant.id}`] ? 'Saving...' : 'Save'}
                    </button>
                  )}
                </div>
                {errors[`var-${activeVariant.id}`] && (
                  <span style={{ fontSize: 11, color: T.status.red, fontFamily: T.font.sans }}>{errors[`var-${activeVariant.id}`]}</span>
                )}
              </div>
            ) : (
              // No variant for this tab
              <div style={{
                display: 'flex',
                flexDirection: 'column' as const,
                alignItems: 'center',
                gap: 10,
                padding: '20px 0',
              }}>
                <span style={{
                  fontSize: 12,
                  color: T.text.tertiary,
                  fontStyle: 'italic' as const,
                  fontFamily: T.font.sans,
                }}>
                  No variant — using DEFAULT
                </span>
                <button
                  onClick={createVariant}
                  disabled={!!saving[`create-${activeTab}`]}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    padding: '5px 14px',
                    fontSize: 11,
                    fontWeight: 700,
                    fontFamily: T.font.sans,
                    color: T.accent,
                    background: `${T.accent}08`,
                    border: `1px solid ${T.accent}30`,
                    borderRadius: T.radius.sm,
                    cursor: saving[`create-${activeTab}`] ? 'not-allowed' : 'pointer',
                  }}
                >
                  <Plus size={12} /> Add Variant
                </button>
                {errors[`create-${activeTab}`] && (
                  <span style={{ fontSize: 11, color: T.status.red, fontFamily: T.font.sans }}>{errors[`create-${activeTab}`]}</span>
                )}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function SopEditorV5() {
  const [definitions, setDefinitions] = useState<SopDefinitionData[]>([])
  const [properties, setProperties] = useState<Array<{ id: string; name: string; address: string }>>([])
  const [overrides, setOverrides] = useState<SopPropertyOverrideData[]>([])
  const [selectedScope, setSelectedScope] = useState<string>('global')
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [overridesLoading, setOverridesLoading] = useState(false)

  useEffect(() => { ensureStyles() }, [])

  // ── Fetch definitions ──
  const fetchDefinitions = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    try {
      const data = await apiGetSopDefinitions()
      setDefinitions(data.definitions || [])
      setProperties(data.properties || [])
    } catch {
      // silent
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => { fetchDefinitions() }, [fetchDefinitions])

  // ── Fetch overrides when property changes ──
  const fetchOverrides = useCallback(async (propertyId: string) => {
    setOverridesLoading(true)
    try {
      const data = await apiGetSopPropertyOverrides(propertyId)
      setOverrides(data || [])
    } catch {
      setOverrides([])
    } finally {
      setOverridesLoading(false)
    }
  }, [])

  useEffect(() => {
    if (selectedScope !== 'global') {
      fetchOverrides(selectedScope)
    } else {
      setOverrides([])
    }
  }, [selectedScope, fetchOverrides])

  const isPropertyView = selectedScope !== 'global'

  // ── Filter definitions by search ──
  const filteredDefinitions = useMemo(() => {
    if (!searchQuery.trim()) return definitions
    const q = searchQuery.toLowerCase()
    return definitions.filter(d =>
      d.category.toLowerCase().includes(q) ||
      d.toolDescription.toLowerCase().includes(q)
    )
  }, [definitions, searchQuery])

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
      <div className="sop-scroll" style={{ flex: 1, overflowY: 'auto' as const, padding: 20 }}>

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
          {/* Left: title */}
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
                SOP Management
              </h1>
              <p style={{
                fontSize: 13,
                color: T.text.secondary,
                margin: 0,
                marginTop: 2,
              }}>
                Manage procedures, tool descriptions, and status-based variants
              </p>
            </div>
          </div>

          {/* Right: search + property dropdown + refresh */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' as const }}>
            {/* Search */}
            <div style={{ position: 'relative' as const }}>
              <Search
                size={14}
                color={T.text.tertiary}
                style={{
                  position: 'absolute' as const,
                  left: 10,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  pointerEvents: 'none' as const,
                }}
              />
              <input
                type="text"
                placeholder="Filter SOPs..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                style={{
                  height: 36,
                  width: 200,
                  padding: '0 12px 0 30px',
                  fontSize: 13,
                  fontFamily: T.font.sans,
                  color: T.text.primary,
                  background: T.bg.card,
                  border: `1px solid ${T.border.default}`,
                  borderRadius: T.radius.sm,
                  boxShadow: T.shadow.sm,
                  outline: 'none',
                  transition: 'border-color 0.15s ease',
                }}
                onFocus={(e) => { e.currentTarget.style.borderColor = T.accent }}
                onBlur={(e) => { e.currentTarget.style.borderColor = T.border.default }}
              />
            </div>

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
              onClick={() => {
                fetchDefinitions(true)
                if (isPropertyView) fetchOverrides(selectedScope)
              }}
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
          <span style={{
            fontSize: 13,
            fontWeight: 700,
            color: T.text.primary,
            fontFamily: T.font.sans,
          }}>
            {loading ? '...' : `${filteredDefinitions.length} SOP${filteredDefinitions.length !== 1 ? 's' : ''}`}
          </span>
          <span style={{ fontSize: 12, color: T.text.tertiary, fontFamily: T.font.sans }}>
            {isPropertyView ? properties.find(p => p.id === selectedScope)?.name || selectedScope : 'Global'}
          </span>
          {overridesLoading && (
            <span style={{ fontSize: 11, color: T.text.tertiary, fontFamily: T.font.sans, fontStyle: 'italic' as const }}>
              Loading overrides...
            </span>
          )}
        </div>

        {/* ─── SOP List ────────────────────────────────────────────────────── */}
        {loading ? (
          <SkeletonTable />
        ) : filteredDefinitions.length === 0 ? (
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
              {searchQuery ? 'No matching SOPs' : 'No SOP definitions found'}
            </p>
            <p style={{ fontSize: 13, color: T.text.tertiary, margin: 0 }}>
              {searchQuery ? `No SOPs match "${searchQuery}"` : 'SOP definitions will appear here once configured'}
            </p>
          </div>
        ) : (
          <div style={{
            display: 'flex',
            flexDirection: 'column' as const,
            gap: 12,
          }}>
            {filteredDefinitions.map((def, i) => (
              <div key={def.id} style={{ animationDelay: `${0.1 + i * 0.03}s` }}>
                <SopRow
                  def={def}
                  isPropertyView={isPropertyView}
                  propertyId={isPropertyView ? selectedScope : null}
                  overrides={overrides}
                  onOverridesChange={() => { if (isPropertyView) fetchOverrides(selectedScope) }}
                  onDefinitionChange={() => fetchDefinitions(true)}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
