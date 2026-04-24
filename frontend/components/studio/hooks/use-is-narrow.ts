// Sprint 046 — Studio design overhaul (plan T005 + research.md R8).
//
// `useIsNarrow()` returns whether the viewport is below the narrow-mode
// breakpoint (default 900px, per FR-016 + SC-007). Used by StudioShell
// to default-collapse the right panel and mount the left rail as an
// off-canvas drawer below the threshold.
//
// SSR-safe: the initial render returns `isNarrow: false` (the desktop-
// first default) so server HTML matches client's first paint; the
// matchMedia listener then flips state on mount if the actual viewport
// is narrow. This prevents a hydration mismatch at the cost of a single
// extra render on narrow devices.

import { useEffect, useState } from 'react'

const DEFAULT_MAX_PX = 899 // matches FR-016 "Below 900px viewport width"

export interface UseIsNarrowResult {
  isNarrow: boolean
  width: number | null
}

export function useIsNarrow(maxPx: number = DEFAULT_MAX_PX): UseIsNarrowResult {
  const [state, setState] = useState<UseIsNarrowResult>({ isNarrow: false, width: null })

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }

    const mql = window.matchMedia(`(max-width: ${maxPx}px)`)
    const read = () => {
      setState({ isNarrow: mql.matches, width: window.innerWidth })
    }

    read()

    // Some older Safari versions expose addListener / removeListener
    // instead of the modern addEventListener / removeEventListener
    // pair. Use the modern API when available and fall back otherwise.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', read)
    } else if (typeof (mql as unknown as { addListener?: (cb: () => void) => void }).addListener === 'function') {
      ;(mql as unknown as { addListener: (cb: () => void) => void }).addListener(read)
    }

    window.addEventListener('resize', read)

    return () => {
      if (typeof mql.removeEventListener === 'function') {
        mql.removeEventListener('change', read)
      } else if (typeof (mql as unknown as { removeListener?: (cb: () => void) => void }).removeListener === 'function') {
        ;(mql as unknown as { removeListener: (cb: () => void) => void }).removeListener(read)
      }
      window.removeEventListener('resize', read)
    }
  }, [maxPx])

  return state
}
