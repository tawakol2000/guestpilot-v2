'use client'

import { useEffect, useState } from 'react'

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
    fetch(
      `${process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:3001'}/api/evidence-bundles/${bundleId}`,
      {
        headers: {
          Authorization: `Bearer ${typeof window !== 'undefined' ? localStorage.getItem('gp_token') : ''}`,
        },
      },
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

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/10">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Evidence bundle"
        className="flex h-full w-[min(560px,90vw)] flex-col border-l border-[#E7E5E4] bg-white shadow-xl"
      >
        <header className="flex items-center justify-between border-b border-[#E7E5E4] px-5 py-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.14em] text-[#57534E]">Evidence</div>
            <div className="font-[family-name:var(--font-playfair)] text-lg text-[#0C0A09]">
              Bundle
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-[#57534E] hover:bg-[#F5F4F1]"
          >
            Close
          </button>
        </header>
        <div className="flex-1 overflow-auto px-5 py-4 font-mono text-[12px] leading-6">
          {loading ? (
            <div className="text-[#A8A29E]">Loading…</div>
          ) : error ? (
            <div className="text-[#9F1239]">Failed to load bundle: {error}</div>
          ) : payload ? (
            <TreeNode value={payload} depth={0} path="$" />
          ) : (
            <div className="text-[#A8A29E]">No bundle attached to this suggestion.</div>
          )}
        </div>
      </div>
    </div>
  )
}

function TreeNode({ value, depth, path }: { value: unknown; depth: number; path: string }) {
  const [open, setOpen] = useState(depth < 1)
  if (value === null) return <span className="text-[#A8A29E]">null</span>
  if (typeof value !== 'object') {
    return (
      <span className="text-[#0C0A09]">
        {typeof value === 'string' ? JSON.stringify(value) : String(value)}
      </span>
    )
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
        className="inline-flex items-center gap-1 text-[#57534E] hover:text-[#0C0A09]"
      >
        <span>{open ? '▾' : '▸'}</span>
        <span className="font-mono text-[11px] uppercase tracking-[0.1em]">
          {isArr ? `Array(${entries.length})` : `Object (${entries.length})`}
        </span>
      </button>
      {open ? (
        <div>
          {entries.map(([k, v]) => (
            <div key={k} className="py-0.5">
              <span className="text-[#1E3A8A]">{JSON.stringify(k)}</span>
              <span className="text-[#A8A29E]">: </span>
              <TreeNode value={v} depth={depth + 1} path={`${path}.${k}`} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
