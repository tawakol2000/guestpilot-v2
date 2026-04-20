'use client'

/**
 * Sprint 045 Gate 6 — tenant-state banner.
 *
 * Top-of-page banner that opens the BUILD conversation. Two variants:
 * GREENFIELD ("let's set up from scratch") and BROWNFIELD ("here's what
 * you have, what do you want to change?"). Fed by GET /api/build/tenant-state.
 */
import { Sparkles, Wrench } from 'lucide-react'
import { TUNING_COLORS } from '../tuning/tokens'
import type { BuildTenantState } from '@/lib/build-api'

export function TenantStateBanner({ state }: { state: BuildTenantState }) {
  const isGreenfield = state.isGreenfield
  const total =
    state.sopCount + state.faqCounts.global + state.customToolCount
  return (
    <div
      className="flex items-center gap-3 border-b px-5 py-3"
      style={{
        borderColor: TUNING_COLORS.hairlineSoft,
        background: isGreenfield
          ? TUNING_COLORS.accentSoft
          : TUNING_COLORS.surfaceRaised,
      }}
    >
      <span
        aria-hidden
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
        style={{
          background: isGreenfield ? TUNING_COLORS.accent : TUNING_COLORS.surfaceSunken,
          color: isGreenfield ? '#FFFFFF' : TUNING_COLORS.inkMuted,
        }}
      >
        {isGreenfield ? <Sparkles size={15} strokeWidth={2} /> : <Wrench size={15} strokeWidth={2} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold" style={{ color: TUNING_COLORS.ink }}>
          {isGreenfield
            ? "Let's set up your AI from scratch."
            : `You have ${state.sopCount} SOPs, ${state.faqCounts.global} FAQs, ${state.customToolCount} custom tools.`}
        </div>
        <div className="mt-0.5 text-xs" style={{ color: TUNING_COLORS.inkMuted }}>
          {isGreenfield
            ? 'I\u2019ll ask a few questions about how your properties run, then draft a plan before writing anything.'
            : 'What do you want to build or change?'}
        </div>
      </div>
      {!isGreenfield ? (
        <div
          className="hidden shrink-0 rounded-md border px-2.5 py-1 font-mono text-[11px] md:block"
          style={{
            borderColor: TUNING_COLORS.hairline,
            color: TUNING_COLORS.inkSubtle,
            background: TUNING_COLORS.surfaceSunken,
          }}
        >
          {total} artifacts · {state.propertyCount} properties
        </div>
      ) : null}
    </div>
  )
}
