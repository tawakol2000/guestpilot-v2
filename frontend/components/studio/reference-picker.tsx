'use client'

// Sprint 046 — Studio design overhaul (plan T014 + FR-025a).
//
// Popover picker opened from the composer's Reference chip. Segments
// over SOPs / FAQs / System prompt / Tools / Property overrides. On
// select, emits a `ReferenceTarget` which callers insert into the
// composer textarea as a citation marker.
//
// Data fetch is lazy per-segment on first open; cached for the popover
// lifetime. Endpoints used:
//   - SOPs: apiGetSopDefinitions()
//   - FAQs: apiGetFaqEntries()
//   - Tools: apiListToolDefinitions()
//   - System prompt / Property overrides: simple placeholder entries
//     that call through to existing drawers in a later follow-up (the
//     picker lists them so they are discoverable today).

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  apiGetFaqEntries,
  apiGetSopDefinitions,
  apiListToolDefinitions,
  type FaqEntry,
  type ToolDefinitionSummary,
} from '@/lib/api'
import { STUDIO_TOKENS_V2 } from './tokens'
import { CloseIcon, SearchIcon } from './icons'

export type ReferenceKind = 'sop' | 'faq' | 'system_prompt' | 'tool' | 'property_override'

export interface ReferenceTarget {
  kind: ReferenceKind
  id: string
  title: string
}

export interface ReferencePickerProps {
  open: boolean
  anchorEl: HTMLElement | null
  onClose: () => void
  onSelect: (ref: ReferenceTarget) => void
}

interface Row {
  kind: ReferenceKind
  id: string
  title: string
}

const SEGMENTS: { id: ReferenceKind; label: string }[] = [
  { id: 'sop', label: 'SOPs' },
  { id: 'faq', label: 'FAQs' },
  { id: 'system_prompt', label: 'Prompt' },
  { id: 'tool', label: 'Tools' },
  { id: 'property_override', label: 'Properties' },
]

export function ReferencePicker({ open, anchorEl, onClose, onSelect }: ReferencePickerProps) {
  const popoverRef = useRef<HTMLDivElement>(null)
  const [segment, setSegment] = useState<ReferenceKind>('sop')
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cacheRef = useRef<Map<ReferenceKind, Row[]>>(new Map())

  const loadSegment = useCallback(async (kind: ReferenceKind) => {
    if (cacheRef.current.has(kind)) {
      setRows(cacheRef.current.get(kind) ?? [])
      return
    }
    setLoading(true)
    setError(null)
    try {
      let next: Row[] = []
      if (kind === 'sop') {
        const data = await apiGetSopDefinitions()
        next = (data.definitions ?? []).map((s) => ({
          kind: 'sop' as const,
          id: s.id,
          title: s.category || s.toolDescription?.slice(0, 60) || s.id,
        }))
      } else if (kind === 'faq') {
        const data = await apiGetFaqEntries({ status: 'ACTIVE' })
        next = data.entries.slice(0, 50).map((f: FaqEntry) => ({
          kind: 'faq' as const,
          id: f.id,
          title: f.question.length > 80 ? `${f.question.slice(0, 78)}…` : f.question,
        }))
      } else if (kind === 'tool') {
        const data = await apiListToolDefinitions()
        next = data.map((t: ToolDefinitionSummary) => ({
          kind: 'tool' as const,
          id: t.id,
          title: t.displayName || t.name,
        }))
      } else if (kind === 'system_prompt') {
        next = [{ kind: 'system_prompt', id: 'tenant:main', title: 'Tenant system prompt' }]
      } else if (kind === 'property_override') {
        // Discoverable placeholder — live picker lands in a follow-up
        // once the list endpoint is wired in.
        next = [{ kind: 'property_override', id: 'default', title: 'Property override…' }]
      }
      cacheRef.current.set(kind, next)
      setRows(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    loadSegment(segment)
  }, [open, segment, loadSegment])

  // Close on Escape or outside click
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onClick = (e: MouseEvent) => {
      if (!popoverRef.current) return
      const target = e.target as Node
      if (popoverRef.current.contains(target)) return
      if (anchorEl && anchorEl.contains(target)) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClick)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
    }
  }, [open, onClose, anchorEl])

  if (!open) return null

  const rect = anchorEl?.getBoundingClientRect()
  const top = rect ? rect.top - 12 : 120
  const left = rect ? rect.left : 120
  const filtered = query.trim()
    ? rows.filter((r) => r.title.toLowerCase().includes(query.toLowerCase()))
    : rows

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Reference artifact"
      style={{
        position: 'fixed',
        top,
        left,
        transform: 'translateY(-100%)',
        width: 360,
        maxHeight: 380,
        background: STUDIO_TOKENS_V2.bg,
        border: `1px solid ${STUDIO_TOKENS_V2.border}`,
        borderRadius: STUDIO_TOKENS_V2.radiusLg,
        boxShadow: STUDIO_TOKENS_V2.shadowMd,
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          borderBottom: `1px solid ${STUDIO_TOKENS_V2.border}`,
        }}
      >
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: STUDIO_TOKENS_V2.muted2,
            flex: 1,
          }}
        >
          Reference
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close reference picker"
          style={{
            width: 22,
            height: 22,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            background: 'transparent',
            color: STUDIO_TOKENS_V2.muted,
            cursor: 'pointer',
            borderRadius: STUDIO_TOKENS_V2.radiusSm,
          }}
        >
          <CloseIcon size={14} />
        </button>
      </header>

      <div
        role="tablist"
        aria-label="Artifact type"
        style={{
          display: 'flex',
          gap: 4,
          padding: 8,
          borderBottom: `1px solid ${STUDIO_TOKENS_V2.border}`,
        }}
      >
        {SEGMENTS.map((s) => {
          const active = s.id === segment
          return (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setSegment(s.id)}
              style={{
                padding: '4px 8px',
                fontSize: 12,
                fontWeight: active ? 500 : 400,
                color: active ? STUDIO_TOKENS_V2.ink : STUDIO_TOKENS_V2.muted,
                background: active ? STUDIO_TOKENS_V2.surface2 : 'transparent',
                border: 'none',
                borderRadius: STUDIO_TOKENS_V2.radiusSm,
                cursor: 'pointer',
              }}
            >
              {s.label}
            </button>
          )
        })}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          borderBottom: `1px solid ${STUDIO_TOKENS_V2.border}`,
        }}
      >
        <SearchIcon size={14} style={{ color: STUDIO_TOKENS_V2.muted2, flexShrink: 0 }} />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter…"
          aria-label="Filter references"
          style={{
            flex: 1,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            fontSize: 13,
            color: STUDIO_TOKENS_V2.ink,
          }}
        />
      </div>

      <ul
        role="listbox"
        style={{
          flex: 1,
          overflowY: 'auto',
          margin: 0,
          padding: 6,
          listStyle: 'none',
        }}
      >
        {loading ? (
          <li style={{ padding: 10, fontSize: 12, color: STUDIO_TOKENS_V2.muted }}>Loading…</li>
        ) : error ? (
          <li style={{ padding: 10, fontSize: 12, color: STUDIO_TOKENS_V2.red }}>{error}</li>
        ) : filtered.length === 0 ? (
          <li style={{ padding: 10, fontSize: 12, color: STUDIO_TOKENS_V2.muted }}>
            No matches.
          </li>
        ) : (
          filtered.map((r) => (
            <li key={`${r.kind}:${r.id}`}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => {
                  onSelect({ kind: r.kind, id: r.id, title: r.title })
                  onClose()
                }}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 10px',
                  fontSize: 13,
                  color: STUDIO_TOKENS_V2.ink2,
                  background: 'transparent',
                  border: 'none',
                  borderRadius: STUDIO_TOKENS_V2.radiusSm,
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = STUDIO_TOKENS_V2.surface
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                {r.title}
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  )
}
