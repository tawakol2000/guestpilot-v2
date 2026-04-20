'use client'

/**
 * Sprint 045 Gate 6 — PropagationBanner. Shown briefly after a plan is
 * approved (and therefore about to start writing artifacts). Informs the
 * manager that the tenant-config cache has a 60s TTL so newly-written
 * prompts and tools take up to a minute to appear in the live
 * guest-reply pipeline.
 *
 * Auto-dismisses after 60s so it disappears by the time the propagation
 * window is over. The component is idempotent on remount — the parent
 * controls whether it's present in the tree.
 */
import { useEffect, useState } from 'react'
import { Zap, X } from 'lucide-react'
import { TUNING_COLORS } from '../studio/tokens'

export function PropagationBanner({
  onDismiss,
  autoDismissMs = 60_000,
}: {
  onDismiss?: () => void
  autoDismissMs?: number
}) {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    if (!visible) return
    const t = window.setTimeout(() => {
      setVisible(false)
      onDismiss?.()
    }, autoDismissMs)
    return () => window.clearTimeout(t)
  }, [visible, autoDismissMs, onDismiss])

  if (!visible) return null

  return (
    <div
      className="flex items-start gap-2 rounded-lg border px-3 py-2 text-xs"
      style={{
        borderColor: 'rgba(108,92,231,0.25)',
        background: TUNING_COLORS.accentSoft,
        color: TUNING_COLORS.ink,
      }}
      role="status"
    >
      <Zap size={13} strokeWidth={2} className="mt-[2px] shrink-0" style={{ color: TUNING_COLORS.accent }} />
      <div className="min-w-0 flex-1">
        <div className="font-medium">Applying changes…</div>
        <div className="mt-0.5" style={{ color: TUNING_COLORS.inkMuted }}>
          The main pipeline picks these up in up to 60 seconds. Tests run against
          the latest version immediately.
        </div>
      </div>
      <button
        type="button"
        onClick={() => {
          setVisible(false)
          onDismiss?.()
        }}
        className="shrink-0 rounded-md p-1 hover:bg-white/60"
        aria-label="Dismiss"
      >
        <X size={12} strokeWidth={2.25} style={{ color: TUNING_COLORS.inkMuted }} />
      </button>
    </div>
  )
}
