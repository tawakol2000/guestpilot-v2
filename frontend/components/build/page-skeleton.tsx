'use client'

/**
 * Sprint 045 refinement — page-mount skeleton for /build. Rendered while
 * GET /api/build/tenant-state is in flight. Mirrors the three-pane grid
 * of the settled page so there's no layout shift on data arrival; dissolves
 * into the real UI via Tailwind's animate-pulse.
 */
import { TUNING_COLORS } from '../tuning/tokens'

export function BuildPageSkeleton() {
  return (
    <div
      className="h-dvh min-h-0 w-full"
      style={{
        background: TUNING_COLORS.canvas,
        display: 'grid',
        gridTemplateColumns: '56px 288px 1fr 440px',
      }}
    >
      {/* Activity bar */}
      <div
        className="flex flex-col items-center gap-2 border-r py-3"
        style={{ borderColor: TUNING_COLORS.hairline, background: TUNING_COLORS.surfaceSunken }}
      >
        {[0, 1, 2, 3, 4].map((i) => (
          <ShimmerBlock key={i} className="h-10 w-10 rounded-lg" />
        ))}
      </div>

      {/* Left rail */}
      <aside
        className="flex min-h-0 flex-col gap-3 border-r px-3 py-3"
        style={{ borderColor: TUNING_COLORS.hairline, background: TUNING_COLORS.surfaceRaised }}
      >
        <ShimmerBlock className="h-6 w-24 rounded" />
        <ShimmerBlock className="h-24 w-full rounded-lg" />
        <ShimmerBlock className="h-20 w-full rounded-lg" />
      </aside>

      {/* Chat column */}
      <main
        className="flex min-h-0 flex-col"
        style={{ background: TUNING_COLORS.canvas }}
      >
        <div
          className="flex h-[52px] items-center border-b px-5"
          style={{ borderColor: TUNING_COLORS.hairline, background: TUNING_COLORS.surfaceRaised }}
        >
          <ShimmerBlock className="h-5 w-40 rounded" />
        </div>
        <div
          className="flex flex-wrap items-center gap-2 border-b px-5 py-3"
          style={{ borderColor: TUNING_COLORS.hairline, background: TUNING_COLORS.surfaceRaised }}
        >
          <ShimmerBlock className="h-4 w-3/4 rounded" />
        </div>
        <div className="flex flex-1 items-center justify-center px-6 py-8">
          <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-4">
            <ShimmerBlock className="h-14 w-14 rounded-2xl" />
            <ShimmerBlock className="h-6 w-64 rounded" />
            <ShimmerBlock className="h-4 w-80 rounded" />
            <div className="mt-4 grid w-full grid-cols-2 gap-2">
              <ShimmerBlock className="h-16 rounded-xl" />
              <ShimmerBlock className="h-16 rounded-xl" />
              <ShimmerBlock className="h-16 rounded-xl" />
              <ShimmerBlock className="h-16 rounded-xl" />
            </div>
          </div>
        </div>
      </main>

      {/* Preview pane */}
      <aside
        className="flex min-h-0 flex-col border-l"
        style={{ borderColor: TUNING_COLORS.hairline, background: TUNING_COLORS.surfaceRaised }}
      >
        <div
          className="flex h-[52px] items-center border-b px-4"
          style={{ borderColor: TUNING_COLORS.hairline }}
        >
          <ShimmerBlock className="h-5 w-32 rounded" />
        </div>
        <div className="flex flex-col gap-3 px-4 py-4">
          <ShimmerBlock className="h-28 w-full rounded-lg" />
          <ShimmerBlock className="h-20 w-full rounded-lg" />
        </div>
      </aside>
    </div>
  )
}

function ShimmerBlock({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`animate-pulse ${className ?? ''}`}
      style={{
        background: TUNING_COLORS.surfaceSunken,
        border: `1px solid ${TUNING_COLORS.hairlineSoft}`,
      }}
    />
  )
}
