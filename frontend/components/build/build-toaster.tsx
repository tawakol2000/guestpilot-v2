'use client'

/**
 * Sprint 045 refinement — /build-scoped Sonner toaster. Mounted once in
 * app/build/layout.tsx. Components dispatch toasts via `import { toast }
 * from 'sonner'`. Styling mirrors TuningToaster so /build and /tuning
 * feel like the same surface; palette pulls from tuning tokens.
 */
import { Toaster } from 'sonner'
import { TUNING_COLORS } from '../tuning/tokens'

export function BuildToaster() {
  return (
    <Toaster
      position="bottom-right"
      duration={4500}
      gap={12}
      expand={false}
      visibleToasts={4}
      toastOptions={{
        style: {
          background: TUNING_COLORS.surfaceRaised,
          color: TUNING_COLORS.ink,
          border: `1px solid ${TUNING_COLORS.hairline}`,
          borderRadius: 12,
          boxShadow:
            '0 10px 25px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04)',
          fontSize: 14,
          padding: '12px 14px',
        },
      }}
    />
  )
}
