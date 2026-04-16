'use client'

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { getToken } from '@/lib/api'
import { TUNING_COLORS } from './tokens'

export function EvidencePane({
  open,
  onClose,
  bundleId,
}: {
  open: boolean
  onClose: () => void
  bundleId: string | null
}) {
  // Lazy-loaded payload. Null = not loaded / not available.
  const [payload, setPayload] = useState<unknown | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !bundleId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    // Bug fix — previously this template-literaled localStorage.getItem which
    // returns null if the key is missing, producing an invalid
    // "Authorization: Bearer null" header and a 401 instead of a clean
    // "not authenticated" error. Use the getToken helper and only attach
    // the header when we actually have a token.
    const token = getToken()
    const headers: Record<string, string> = {}
    if (token) headers.Authorization = `Bearer ${token}`
    fetch(
      `${process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:3001'}/api/evidence-bundles/${bundleId}`,
      { headers },
    )
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}`)
        return r.json()
      })
      .then((data) => {
        if (!cancelled) setPayload(data?.payload ?? data)
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [open, bundleId])

  // Close on Escape.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/20 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Evidence bundle"
        className="flex h-full w-[min(600px,90vw)] flex-col bg-white shadow-2xl animate-in slide-in-from-right duration-300"
        onClick={(e) => e.stopPropagation()}
      >
        <header
          className="flex items-start justify-between border-b px-5 py-4"
          style={{ borderColor: TUNING_COLORS.hairline }}
        >
          <div>
            <div className="text-xs font-medium text-[#6B7280]">Evidence</div>
            <div className="mt-0.5 text-lg font-semibold tracking-tight text-[#1A1A1A]">
              Bundle
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close evidence pane"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[#6B7280] transition-colors duration-150 hover:bg-[#F3F4F6] hover:text-[#1A1A1A] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A29BFE]"
          >
            <X size={16} strokeWidth={2} aria-hidden />
          </button>
        </header>
        <div className="flex-1 overflow-auto px-5 py-4 font-mono text-[12px] leading-6">
          {loading ? (
            <div className="text-[#9CA3AF]">Loading…</div>
          ) : error ? (
            <div style={{ color: TUNING_COLORS.dangerFg }}>
              Failed to load bundle: {error}
            </div>
          ) : payload ? (
            <TreeNode value={payload} depth={0} path="$" />
          ) : (
            <div className="text-[#9CA3AF]">No bundle attached to this suggestion.</div>
          )}
        </div>
      </div>
    </div>
  )
}

function TreeNode({ value, depth, path }: { value: unknown; depth: number; path: string }) {
  const [open, setOpen] = useState(depth < 1)
  if (value === null) return <span className="text-[#9CA3AF]">null</span>
  if (typeof value !== 'object') {
    if (typeof value === 'string') {
      return (
        <span style={{ color: TUNING_COLORS.diffAddFg }}>
          {JSON.stringify(value)}
        </span>
      )
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return <span style={{ color: TUNING_COLORS.ink }}>{String(value)}</span>
    }
    return <span style={{ color: TUNING_COLORS.ink }}>{String(value)}</span>
  }
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as [string, unknown])
    : Object.entries(value as Record<string, unknown>)
  const isArr = Array.isArray(value)
  return (
    <div style={{ marginLeft: depth === 0 ? 0 : 12 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 text-[#6B7280] transition-colors duration-150 hover:text-[#1A1A1A]"
      >
        <span className="inline-block w-3 text-center font-mono text-[10px]">
          {open ? '▾' : '▸'}
        </span>
        <span className="font-mono text-[11px]">
          {isArr ? `Array(${entries.length})` : `Object { ${entries.length} }`}
        </span>
      </button>
      {open ? (
        <div>
          {entries.map(([k, v]) => (
            <div key={k} className="py-0.5">
              <span className="text-[#6B7280]">{JSON.stringify(k)}</span>
              <span className="text-[#9CA3AF]">: </span>
              <TreeNode value={v} depth={depth + 1} path={`${path}.${k}`} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
