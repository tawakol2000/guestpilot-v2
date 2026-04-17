'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * ScrollShadows — wraps a scrollable child and renders top/bottom fade
 * gradients that toggle based on scroll position.
 *
 * Usage:
 *   <ScrollShadows className="flex-1 min-h-0">
 *     <div className="overflow-auto h-full" ref provided by ScrollShadows>
 *       {content}
 *     </div>
 *   </ScrollShadows>
 *
 * Or the simpler self-contained mode where ScrollShadows manages the scroller:
 *   <ScrollShadows className="flex-1 min-h-0 overflow-hidden">
 *     {longContent}
 *   </ScrollShadows>
 */
export function ScrollShadows({
  children,
  className = '',
  shadowSize = 32,
  color = 'rgba(249,250,251,1)', // matches TUNING_COLORS.canvas
}: {
  children: React.ReactNode
  className?: string
  shadowSize?: number
  color?: string
}) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [showTop, setShowTop] = useState(false)
  const [showBottom, setShowBottom] = useState(false)

  const update = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    setShowTop(el.scrollTop > 4)
    setShowBottom(el.scrollTop + el.clientHeight < el.scrollHeight - 4)
  }, [])

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    update()
    el.addEventListener('scroll', update, { passive: true })
    // Also recheck on resize (content may change height).
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [update])

  const transparent = color.replace(/,[^,)]*\)$/, ',0)')

  return (
    <div className={`relative ${className}`}>
      {/* The scroller */}
      <div ref={scrollerRef} className="h-full overflow-auto">
        {children}
      </div>

      {/* Top shadow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 transition-opacity duration-200"
        style={{
          height: shadowSize,
          background: `linear-gradient(to bottom, ${color}, ${transparent})`,
          opacity: showTop ? 1 : 0,
        }}
      />

      {/* Bottom shadow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 transition-opacity duration-200"
        style={{
          height: shadowSize,
          background: `linear-gradient(to top, ${color}, ${transparent})`,
          opacity: showBottom ? 1 : 0,
        }}
      />
    </div>
  )
}
