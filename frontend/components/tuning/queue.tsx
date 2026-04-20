'use client'

import { useMemo, useState } from 'react'
import { CheckCircle2, ChevronDown } from 'lucide-react'
import type { TuningSuggestion, TuningTriggerType } from '@/lib/api'
import { CategoryPill } from './category-pill'
import { ConfidenceBar } from './confidence-bar'
import { RelativeTime } from './relative-time'
import { TUNING_COLORS, categoryAccent, triggerLabel } from '../studio/tokens'

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
      <div className="space-y-1.5 px-2 py-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-14 animate-pulse rounded-lg"
            style={{ background: TUNING_COLORS.surfaceSunken }}
          />
        ))}
      </div>
    )
  }

  if (groups.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 px-6 py-14 text-center">
        <span
          className="inline-flex h-10 w-10 items-center justify-center rounded-full text-[#6C5CE7]"
          style={{ background: TUNING_COLORS.accentSoft }}
        >
          <CheckCircle2 size={18} strokeWidth={2} aria-hidden />
        </span>
        <div>
          <h2 className="text-base font-semibold tracking-tight text-[#1A1A1A]">All caught up</h2>
          <p className="mt-1 text-xs text-[#9CA3AF]">
            We&rsquo;ll surface the next suggestion when one&rsquo;s ready.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4 px-2 py-2">
      {groups.map((g) => {
        const isCollapsed = !!collapsed[g.key]
        return (
          <section key={g.key}>
            <button
              type="button"
              onClick={() => setCollapsed((c) => ({ ...c, [g.key]: !c[g.key] }))}
              className="group flex w-full items-center justify-between rounded-md px-2 py-1 text-left transition-colors duration-150 hover:bg-[#F3F4F6]"
              aria-expanded={!isCollapsed}
            >
              <span className="text-xs font-semibold text-[#6B7280]">{g.label}</span>
              <span className="flex items-center gap-2">
                <span
                  className="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                  style={{
                    background: TUNING_COLORS.surfaceSunken,
                    color: TUNING_COLORS.inkMuted,
                  }}
                >
                  {g.items.length}
                </span>
                <ChevronDown
                  size={14}
                  strokeWidth={2}
                  className="text-[#9CA3AF] transition-transform duration-200"
                  style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
                />
              </span>
            </button>
            {!isCollapsed ? (
              <ul
                className="mt-1.5 overflow-hidden rounded-lg border"
                style={{
                  background: TUNING_COLORS.surfaceRaised,
                  borderColor: TUNING_COLORS.hairlineSoft,
                }}
              >
                {g.items.map((s) => {
                  const active = s.id === selectedId
                  const cat = s.diagnosticCategory
                  const leftBar = active ? TUNING_COLORS.accent : categoryAccent(cat)
                  const title =
                    s.rationale?.trim() || s.proposedText?.trim() || 'Proposed change'
                  const sub =
                    s.diagnosticSubLabel?.replace(/[-_]/g, ' ') ||
                    (s.sopCategory ?? null)?.replace(/^sop-/, '').replace(/-/g, ' ') ||
                    null
                  // Sprint 08 §5 — AUTO_SUPPRESSED rows render muted so the
                  // manager can see them but not confuse them with live
                  // pending suggestions.
                  const suppressed = s.status === 'AUTO_SUPPRESSED'
                  return (
                    <li
                      key={s.id}
                      className="border-t first:border-t-0"
                      style={{ borderColor: TUNING_COLORS.hairlineSoft }}
                    >
                      <button
                        type="button"
                        onClick={() => onSelect(s.id)}
                        className={
                          'relative flex w-full items-start gap-2.5 px-2.5 py-2 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A29BFE] ' +
                          (active ? '' : 'hover:bg-[#F9FAFB]')
                        }
                        style={{
                          background: active ? TUNING_COLORS.accentSoft : undefined,
                          opacity: suppressed ? 0.6 : 1,
                        }}
                        aria-current={active ? 'true' : undefined}
                      >
                        <span
                          aria-hidden
                          className="mt-0.5 h-7 w-[2px] shrink-0 rounded-full transition-colors duration-150"
                          style={{ background: leftBar }}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start gap-2">
                            <p
                              className="line-clamp-2 flex-1 text-[13px] font-medium leading-[1.35]"
                              style={{ color: TUNING_COLORS.ink }}
                            >
                              {title}
                            </p>
                            {s.confidence !== null ? (
                              <ConfidenceBar value={s.confidence} compact />
                            ) : null}
                          </div>
                          <div className="mt-1 flex items-center gap-1.5">
                            <CategoryPill
                              category={cat}
                              subLabel={null}
                            />
                            {suppressed ? (
                              <span
                                className="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                                style={{
                                  background: TUNING_COLORS.surfaceSunken,
                                  color: TUNING_COLORS.inkMuted,
                                }}
                                title="Auto-suppressed: category acceptance <30% and confidence below 0.75"
                              >
                                suppressed
                              </span>
                            ) : null}
                            {sub ? (
                              <span className="truncate text-[11px] text-[#9CA3AF]">{sub}</span>
                            ) : null}
                            <span className="ml-auto shrink-0 text-[11px] text-[#9CA3AF]">
                              <RelativeTime iso={s.createdAt} />
                            </span>
                          </div>
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
