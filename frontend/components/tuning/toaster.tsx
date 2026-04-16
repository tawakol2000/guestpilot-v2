'use client'

/**
 * Feature 041 sprint 07 — tuning-scoped Sonner toaster.
 *
 * Mounted once in app/tuning/layout.tsx. Components call
 *   import { toast } from 'sonner'
 *   toast.success('Applied')
 * directly; no custom helpers. Styling sits on the cool-neutral palette
 * with a subtle shadow so toasts feel like they land on the same surface
 * as the rest of the /tuning chrome.
 */

import { Toaster } from 'sonner'
import { TUNING_COLORS } from './tokens'

export function TuningToaster() {
  return (
    <Toaster
      position="bottom-right"
      duration={3500}
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
        classNames: {
          success: 'tuning-toast-success',
          error: 'tuning-toast-error',
          info: 'tuning-toast-info',
        },
      }}
    />
  )
}
