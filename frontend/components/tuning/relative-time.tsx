'use client'

import { useEffect, useState } from 'react'

function formatRelative(iso: string, now: number): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const delta = Math.max(0, now - then)
  const s = Math.floor(delta / 1000)
  if (s < 45) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  const w = Math.floor(d / 7)
  if (w < 5) return `${w}w ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function RelativeTime({ iso, className }: { iso: string | null; className?: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(t)
  }, [])
  if (!iso) return null
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()} className={className}>
      {formatRelative(iso, now)}
    </time>
  )
}
