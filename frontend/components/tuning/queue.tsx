'use client'

import { useMemo, useState } from 'react'
import type { TuningSuggestion, TuningTriggerType } from '@/lib/api'
import { CategoryPill } from './category-pill'
import { ConfidenceBar } from './confidence-bar'
import { RelativeTime } from './relative-time'
import { TUNING_COLORS, triggerLabel } from './tokens'

type Group = { key: TuningTriggerType | 'LEGACY'; label: string; items: TuningSuggestion[] }

function groupByTrigger(rows: TuningSuggestion[]): Group[] {
  const buckets = new Map<string, TuningSuggestion[]>()
  for (const s of rows) {
    const k = s.triggerType ?? 'LEGACY'
    const arr = buckets.get(k) ?? []
    arr.push(s)
    buckets.set(k, arr)
  }
  // Order: real triggers sorted by count desc, legacy last.
  const groups: Group[] = []
  for (const [key, items] of buckets.entries()) {
    if (key === 'LEGACY') continue
    groups.push({
      key: key as TuningTriggerType,
      label: triggerLabel(key as TuningTriggerType),
      items,
    })
  }
  groups.sort((a, b) => b.items.length - a.items.length)
  const legacy = buckets.get('LEGACY')
  if (legacy && legacy.length) {
    groups.push({ key: 'LEGACY', label: 'Legacy', items: legacy })
  }
  return groups
}

export function TuningQueue({
  suggestions,
  loading,
  selectedId,
  onSelect,
}: {
  suggestions: TuningSuggestion[]
  loading: boolean
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const groups = useMemo(() => groupByTrigger(suggestions), [suggestions])
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  if (loading) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-14 animate-pulse rounded-md"
            style={{ background: TUNING_COLORS.surfaceSunken }}
          />
        ))}
      </div>
    )
  }

  if (groups.length === 0) {
    return (
      <div className="px-4 py-8 text-center">
        <p className="font-[family-name:var(--font-playfair)] text-base italic text-[#57534E]">
          All caught up.
        </p>
        <p className="mt-1 text-xs text-[#A8A29E]">
          We&rsquo;ll surface the next suggestion when one&rsquo;s ready.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4 px-3 py-2">
      {groups.map((g) => {
        const isCollapsed = !!collapsed[g.key]
        return (
          <section key={g.key}>
            <button
              type="button"
              onClick={() => setCollapsed((c) => ({ ...c, [g.key]: !c[g.key] }))}
              className="flex w-full items-center justify-between px-1 py-1 text-left"
              aria-expanded={!isCollapsed}
            >
              <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-[#57534E]">
                {g.label}
              </span>
              <span className="flex items-center gap-2">
                <span className="font-mono text-[11px] text-[#A8A29E]">{g.items.length}</span>
                <span
                  className="text-[#A8A29E] transition-transform"
                  style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'none' }}
                >
                  ▾
                </span>
              </span>
            </button>
            {!isCollapsed ? (
              <ul className="mt-1 space-y-1">
                {g.items.map((s) => {
                  const active = s.id === selectedId
                  return (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => onSelect(s.id)}
                        className="w-full rounded-md px-2 py-2 text-left transition-colors"
                        style={{
                          background: active ? TUNING_COLORS.accentSoft : 'transparent',
                          borderLeft: `2px solid ${
                            active ? TUNING_COLORS.accent : 'transparent'
                          }`,
                          paddingLeft: 10,
                        }}
                        aria-current={active ? 'true' : undefined}
                      >
                        <div className="flex items-center gap-2">
                          <CategoryPill
                            category={s.diagnosticCategory}
                            subLabel={s.diagnosticSubLabel}
                          />
                          {s.confidence !== null ? (
                            <ConfidenceBar value={s.confidence} compact />
                          ) : null}
                        </div>
                        <div className="mt-1 line-clamp-2 text-[13px] leading-5 text-[#0C0A09]">
                          {s.rationale || s.proposedText || 'Suggestion'}
                        </div>
                        <div className="mt-1 text-[11px] text-[#A8A29E]">
                          <RelativeTime iso={s.createdAt} />
                        </div>
                      </button>
                    </li>
                  )
                })}
              </ul>
            ) : null}
          </section>
        )
      })}
    </div>
  )
}
