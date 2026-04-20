'use client'

/**
 * Sprint 045 Gate 6 — BuildDisabled. Rendered when GET /api/build/tenant-state
 * returns 404 (ENABLE_BUILD_MODE is unset on the backend). The controller
 * mounts a 404 gate BEFORE auth so an unauthenticated probe can't even
 * tell the route exists; we render this screen when the typed
 * BuildModeDisabledError surfaces from the fetch layer.
 *
 * No 3-pane layout here — when build mode is off, showing the full
 * scaffold would misleadingly imply the surface is partially available.
 */
import { Lock } from 'lucide-react'
import { TUNING_COLORS } from '../studio/tokens'

export function BuildDisabled() {
  return (
    <div
      className="flex min-h-dvh items-center justify-center px-6"
      style={{ background: TUNING_COLORS.canvas }}
    >
      <div
        className="w-full max-w-md rounded-2xl border bg-white p-8 text-center shadow-sm"
        style={{ borderColor: TUNING_COLORS.hairline }}
      >
        <div
          aria-hidden
          className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-xl"
          style={{ background: TUNING_COLORS.surfaceSunken, color: TUNING_COLORS.inkMuted }}
        >
          <Lock size={20} strokeWidth={2} />
        </div>
        <h1 className="text-lg font-semibold" style={{ color: TUNING_COLORS.ink }}>
          Build mode is not enabled for this deployment.
        </h1>
        <p className="mt-2 text-sm" style={{ color: TUNING_COLORS.inkMuted }}>
          Contact your admin to turn it on. In the meantime, the /tuning surface
          remains available for day-to-day corrections.
        </p>
      </div>
    </div>
  )
}
