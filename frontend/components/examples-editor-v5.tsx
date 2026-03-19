'use client'

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  GripVertical, Plus, Search, RefreshCw, Lock, Check, X,
  Layers, Tag, Trash2, ChevronDown, Sparkles, ThumbsUp, ThumbsDown, Zap,
} from 'lucide-react'
import {
  apiRunGapAnalysis, apiApproveExample, apiRejectExample,
  apiGetClassifierExamples, apiReinitializeClassifier,
  type ClassifierExampleItem, type GapAnalysisResult,
} from '@/lib/api'

// ─── Design Tokens ────────────────────────────────────────────────────────────
const T = {
  bg: { primary: '#FAFAF9', secondary: '#F5F5F4', tertiary: '#E7E5E4', card: '#FFFFFF' },
  text: { primary: '#0C0A09', secondary: '#57534E', tertiary: '#A8A29E', inverse: '#FFFFFF' },
  accent: '#1D4ED8',
  status: { green: '#15803D', red: '#DC2626', amber: '#D97706', blue: '#2563EB' },
  border: { default: '#E7E5E4', strong: '#D6D3D1' },
  shadow: {
    sm: '0 1px 2px rgba(12,10,9,0.04)',
    md: '0 4px 6px -1px rgba(12,10,9,0.06), 0 2px 4px -2px rgba(12,10,9,0.04)',
    lg: '0 10px 25px -5px rgba(12,10,9,0.08), 0 4px 10px -5px rgba(12,10,9,0.03)',
  },
  font: {
    sans: "'Plus Jakarta Sans', system-ui, -apple-system, sans-serif",
    mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
  },
  radius: { sm: 8, md: 12, lg: 16 },
} as const

// ─── Inject Keyframes ─────────────────────────────────────────────────────────
const STYLE_ID = 'examples-editor-v5-styles'
function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap');
@keyframes spin { to { transform: rotate(360deg) } }
@keyframes fadeInUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
@keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
@keyframes pulseGreen { 0%,100% { box-shadow: 0 0 0 0 rgba(21,128,61,0.2); } 50% { box-shadow: 0 0 0 6px rgba(21,128,61,0); } }
@keyframes scaleIn { from { opacity: 0; transform: scale(0.97); } to { opacity: 1; transform: scale(1); } }
.ee-scroll::-webkit-scrollbar { width: 5px; }
.ee-scroll::-webkit-scrollbar-track { background: transparent; }
.ee-scroll::-webkit-scrollbar-thumb { background: #E7E5E4; border-radius: 99px; }
.ee-scroll::-webkit-scrollbar-thumb:hover { background: #A8A29E; }
`
  document.head.appendChild(style)
}

// ─── API ──────────────────────────────────────────────────────────────────────
const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:3001'
const headers = () => ({
  Authorization: `Bearer ${typeof window !== 'undefined' ? localStorage.getItem('gp_token') : ''}`,
  'Content-Type': 'application/json',
})

// ─── Types ────────────────────────────────────────────────────────────────────
interface Example {
  id: string
  text: string
  labels: string[]
  source: string
  editable: boolean
  createdAt: string | null
}

interface AllExamplesResponse {
  examples: Example[]
  baseCount: number
  dbCount: number
}

// ─── Color Helpers ────────────────────────────────────────────────────────────
function sopBadgeColor(category: string): { bg: string; fg: string } {
  if (category.startsWith('sop')) return { bg: '#DBEAFE', fg: '#2563EB' }
  if (category.startsWith('property')) return { bg: '#DCFCE7', fg: '#15803D' }
  if (category.startsWith('pricing') || category.startsWith('payment') || category.startsWith('post-stay'))
    return { bg: '#FEF3C7', fg: '#D97706' }
  if (category === 'non-actionable') return { bg: '#F3F4F6', fg: '#6B7280' }
  return { bg: '#F3E8FF', fg: '#7C3AED' }
}

const SOURCE_COLORS: Record<string, { bg: string; fg: string }> = {
  base: { bg: '#F3F4F6', fg: '#6B7280' },
  'llm-judge': { bg: '#F3E8FF', fg: '#7C3AED' },
  manual: { bg: '#DBEAFE', fg: '#2563EB' },
  'tier2-feedback': { bg: '#FEF3C7', fg: '#D97706' },
  'low-sim-reinforce': { bg: '#DCFCE7', fg: '#15803D' },
  'gap-analysis': { bg: '#FFF7ED', fg: '#EA580C' },
}

function sourceColor(src: string) {
  return SOURCE_COLORS[src] || { bg: '#F3F4F6', fg: '#6B7280' }
}

function sourceLabel(src: string) {
  if (src === 'llm-judge') return 'judge'
  if (src === 'tier2-feedback') return 'tier2'
  if (src === 'low-sim-reinforce') return 'reinforce'
  if (src === 'gap-analysis') return 'gap-analysis'
  return src
}

// Sidebar dot color for a SOP category
function sopDotColor(category: string): string {
  const c = sopBadgeColor(category)
  return c.fg
}

// ─── Shimmer Skeleton ─────────────────────────────────────────────────────────
function Shimmer({ width, height }: { width: string | number; height: string | number }) {
  return (
    <div style={{
      width, height,
      borderRadius: T.radius.sm,
      background: `linear-gradient(90deg, ${T.bg.tertiary} 25%, ${T.bg.secondary} 50%, ${T.bg.tertiary} 75%)`,
      backgroundSize: '200% 100%',
      animation: 'shimmer 1.5s infinite ease-in-out',
    }} />
  )
}

function SkeletonCards() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8, padding: 12 }}>
      {Array.from({ length: 12 }).map((_, i) => (
        <div key={i} style={{
          background: T.bg.card,
          borderRadius: T.radius.sm,
          border: `1px solid ${T.border.default}`,
          padding: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          animation: 'fadeInUp 0.3s ease both',
          animationDelay: `${i * 30}ms`,
        }}>
          <Shimmer width="100%" height={14} />
          <Shimmer width="70%" height={14} />
          <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
            <Shimmer width={50} height={16} />
            <Shimmer width={40} height={16} />
          </div>
        </div>
      ))}
    </div>
  )
}

function SkeletonSidebar() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 0' }}>
      {Array.from({ length: 10 }).map((_, i) => (
        <div key={i} style={{ padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Shimmer width={8} height={8} />
          <Shimmer width={100 + Math.random() * 60} height={14} />
        </div>
      ))}
    </div>
  )
}

// ─── Toast ────────────────────────────────────────────────────────────────────
interface Toast {
  id: number
  message: string
  type: 'success' | 'error' | 'info'
}

function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null
  return (
    <div style={{
      position: 'fixed', bottom: 24, right: 24, zIndex: 9999,
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      {toasts.map(t => (
        <div
          key={t.id}
          style={{
            background: t.type === 'success' ? '#15803D' : t.type === 'error' ? '#DC2626' : '#2563EB',
            color: '#fff',
            padding: '10px 16px',
            borderRadius: T.radius.sm,
            fontFamily: T.font.sans,
            fontSize: 13,
            fontWeight: 500,
            boxShadow: T.shadow.lg,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            animation: 'fadeInUp 0.25s ease both',
            cursor: 'pointer',
            maxWidth: 340,
          }}
          onClick={() => onDismiss(t.id)}
        >
          {t.type === 'success' && <Check size={14} />}
          {t.type === 'error' && <X size={14} />}
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function ExamplesEditorV5() {
  // -- State
  const [examples, setExamples] = useState<Example[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [selectedFilter, setSelectedFilter] = useState<string>('__all__')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [lastClickedId, setLastClickedId] = useState<string | null>(null)
  const [dragOverSop, setDragOverSop] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newText, setNewText] = useState('')
  const [newLabels, setNewLabels] = useState<Set<string>>(new Set())
  const [addingExample, setAddingExample] = useState(false)
  const [reinitializing, setReinitializing] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [dropSuccessSop, setDropSuccessSop] = useState<string | null>(null)

  // Suggested tab state
  const [activeTab, setActiveTab] = useState<'active' | 'suggested'>('active')
  const [suggestedExamples, setSuggestedExamples] = useState<ClassifierExampleItem[]>([])
  const [suggestedLoading, setSuggestedLoading] = useState(false)
  const [gapAnalysisRunning, setGapAnalysisRunning] = useState(false)
  const [gapAnalysisResult, setGapAnalysisResult] = useState<GapAnalysisResult | null>(null)
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set())

  const toastIdRef = useRef(0)
  const mainGridRef = useRef<HTMLDivElement>(null)

  // -- Init styles
  useEffect(() => { ensureStyles() }, [])

  // -- Toast helpers
  const addToast = useCallback((message: string, type: Toast['type'] = 'info') => {
    const id = ++toastIdRef.current
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3500)
  }, [])

  const dismissToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  // -- Fetch examples
  const fetchExamples = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/knowledge/all-examples`, { headers: headers() })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: AllExamplesResponse = await res.json()
      setExamples(data.examples)
    } catch (err) {
      console.error('[ExamplesEditor] fetch failed:', err)
      addToast('Failed to load examples', 'error')
    } finally {
      setLoading(false)
    }
  }, [addToast])

  useEffect(() => { fetchExamples() }, [fetchExamples])

  // -- Fetch suggested examples (inactive, gap-analysis source)
  const fetchSuggestedExamples = useCallback(async () => {
    setSuggestedLoading(true)
    try {
      const data = await apiGetClassifierExamples({ source: 'gap-analysis', limit: 500 })
      // Filter to only inactive (suggested) ones
      const suggested = data.examples.filter(e => !e.active)
      setSuggestedExamples(suggested)
    } catch (err) {
      console.error('[ExamplesEditor] fetch suggested failed:', err)
    } finally {
      setSuggestedLoading(false)
    }
  }, [])

  // Fetch suggested examples when switching to the tab or on mount
  useEffect(() => {
    if (activeTab === 'suggested') {
      fetchSuggestedExamples()
    }
  }, [activeTab, fetchSuggestedExamples])

  // -- Approve suggested example
  const handleApproveExample = useCallback(async (id: string) => {
    setProcessingIds(prev => new Set(prev).add(id))
    try {
      await apiApproveExample(id)
      setSuggestedExamples(prev => prev.filter(e => e.id !== id))
      addToast('Example approved and activated', 'success')
      // Reinitialize classifier since a new example is now active
      try {
        setReinitializing(true)
        await apiReinitializeClassifier()
      } catch {} finally {
        setReinitializing(false)
      }
    } catch (err) {
      addToast('Failed to approve example', 'error')
    } finally {
      setProcessingIds(prev => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }, [addToast])

  // -- Reject suggested example
  const handleRejectExample = useCallback(async (id: string) => {
    setProcessingIds(prev => new Set(prev).add(id))
    try {
      await apiRejectExample(id)
      setSuggestedExamples(prev => prev.filter(e => e.id !== id))
      addToast('Example rejected and removed', 'success')
    } catch (err) {
      addToast('Failed to reject example', 'error')
    } finally {
      setProcessingIds(prev => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }, [addToast])

  // -- Run Gap Analysis
  const handleRunGapAnalysis = useCallback(async () => {
    setGapAnalysisRunning(true)
    setGapAnalysisResult(null)
    try {
      const result = await apiRunGapAnalysis()
      setGapAnalysisResult(result)
      addToast(`Gap analysis complete: ${result.suggestedExamples} examples suggested`, 'success')
      // Refresh suggested examples list
      await fetchSuggestedExamples()
    } catch (err) {
      addToast('Gap analysis failed', 'error')
    } finally {
      setGapAnalysisRunning(false)
    }
  }, [addToast, fetchSuggestedExamples])

  // -- Derived: all unique SOP labels, sorted by count desc
  const sopCategories = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const ex of examples) {
      for (const label of ex.labels) {
        counts[label] = (counts[label] || 0) + 1
      }
    }
    // Also count "no label" (contextual)
    const noLabelCount = examples.filter(e => e.labels.length === 0).length
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
    return { sorted, counts, noLabelCount }
  }, [examples])

  // All known label names (for add form)
  const allLabelNames = useMemo(() => {
    const s = new Set<string>()
    for (const ex of examples) {
      for (const l of ex.labels) s.add(l)
    }
    return Array.from(s).sort()
  }, [examples])

  // -- Filtered examples
  const filteredExamples = useMemo(() => {
    let list = examples

    // Filter by sidebar selection
    if (selectedFilter === '__contextual__') {
      list = list.filter(e => e.labels.length === 0)
    } else if (selectedFilter !== '__all__') {
      list = list.filter(e => e.labels.includes(selectedFilter))
    }

    // Filter by search
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(e => e.text.toLowerCase().includes(q))
    }

    return list
  }, [examples, selectedFilter, search])

  // -- Selection handlers
  const handleCardClick = useCallback((e: React.MouseEvent, id: string) => {
    const isCtrlCmd = e.metaKey || e.ctrlKey
    const isShift = e.shiftKey

    if (isShift && lastClickedId) {
      // Range select
      const ids = filteredExamples.map(ex => ex.id)
      const startIdx = ids.indexOf(lastClickedId)
      const endIdx = ids.indexOf(id)
      if (startIdx !== -1 && endIdx !== -1) {
        const from = Math.min(startIdx, endIdx)
        const to = Math.max(startIdx, endIdx)
        const rangeIds = ids.slice(from, to + 1)
        setSelectedIds(prev => {
          const next = new Set(prev)
          for (const rid of rangeIds) next.add(rid)
          return next
        })
      }
    } else if (isCtrlCmd) {
      // Toggle
      setSelectedIds(prev => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    } else {
      // Single select
      setSelectedIds(new Set([id]))
    }

    setLastClickedId(id)
  }, [lastClickedId, filteredExamples])

  // -- Drag handlers
  const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
    // If dragging a non-selected card, select only it
    let dragIds: string[]
    if (!selectedIds.has(id)) {
      setSelectedIds(new Set([id]))
      dragIds = [id]
    } else {
      dragIds = Array.from(selectedIds)
    }
    e.dataTransfer.setData('text/plain', JSON.stringify(dragIds))
    e.dataTransfer.effectAllowed = 'move'
    setIsDragging(true)

    // Custom drag image
    const ghost = document.createElement('div')
    ghost.style.cssText = `
      position: absolute; top: -1000px; left: -1000px;
      background: ${T.accent}; color: #fff;
      padding: 6px 14px; border-radius: 8px;
      font-family: ${T.font.sans}; font-size: 13px; font-weight: 600;
      box-shadow: ${T.shadow.lg};
      white-space: nowrap;
    `
    ghost.textContent = `Moving ${dragIds.length} example${dragIds.length > 1 ? 's' : ''}`
    document.body.appendChild(ghost)
    e.dataTransfer.setDragImage(ghost, 0, 0)
    setTimeout(() => document.body.removeChild(ghost), 0)
  }, [selectedIds])

  const handleDragEnd = useCallback(() => {
    setIsDragging(false)
    setDragOverSop(null)
  }, [])

  const handleSidebarDragOver = useCallback((e: React.DragEvent, sop: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverSop(sop)
  }, [])

  const handleSidebarDragLeave = useCallback(() => {
    setDragOverSop(null)
  }, [])

  // -- Drop handler
  const handleSidebarDrop = useCallback(async (e: React.DragEvent, targetSop: string) => {
    e.preventDefault()
    setDragOverSop(null)
    setIsDragging(false)

    const raw = e.dataTransfer.getData('text/plain')
    let dragIds: string[]
    try { dragIds = JSON.parse(raw) } catch { return }

    const draggedExamples = examples.filter(ex => dragIds.includes(ex.id))
    const editableExamples = draggedExamples.filter(ex => ex.editable)
    const baseExamples = draggedExamples.filter(ex => !ex.editable)

    if (baseExamples.length > 0) {
      addToast(`${baseExamples.length} base example${baseExamples.length > 1 ? 's' : ''} cannot be modified`, 'error')
    }

    if (editableExamples.length === 0) return

    // Determine label changes
    const currentViewSop = selectedFilter !== '__all__' && selectedFilter !== '__contextual__'
      ? selectedFilter : null

    let successCount = 0
    const patchPromises = editableExamples.map(async (ex) => {
      let newLabels = [...ex.labels]

      if (targetSop === '__contextual__') {
        // Drop onto "Contextual" = remove all labels
        newLabels = []
      } else {
        // If viewing a specific SOP, remove that label first (move semantics)
        if (currentViewSop && newLabels.includes(currentViewSop)) {
          newLabels = newLabels.filter(l => l !== currentViewSop)
        }
        // Add target label if not already present
        if (!newLabels.includes(targetSop)) {
          newLabels.push(targetSop)
        }
      }

      try {
        const res = await fetch(`${API_BASE}/api/knowledge/classifier-examples/${ex.id}`, {
          method: 'PATCH',
          headers: headers(),
          body: JSON.stringify({ labels: newLabels }),
        })
        if (res.ok) {
          successCount++
          // Update local state
          setExamples(prev => prev.map(e => e.id === ex.id ? { ...e, labels: newLabels } : e))
        }
      } catch (err) {
        console.error('[ExamplesEditor] patch failed:', err)
      }
    })

    await Promise.all(patchPromises)

    if (successCount > 0) {
      const targetLabel = targetSop === '__contextual__' ? 'Contextual' : targetSop
      addToast(`Moved ${successCount} example${successCount > 1 ? 's' : ''} to ${targetLabel}`, 'success')
      setDropSuccessSop(targetSop)
      setTimeout(() => setDropSuccessSop(null), 1200)

      // Reinitialize classifier
      try {
        setReinitializing(true)
        await fetch(`${API_BASE}/api/knowledge/classifier-reinitialize`, {
          method: 'POST',
          headers: headers(),
        })
      } catch {} finally {
        setReinitializing(false)
      }
    }

    setSelectedIds(new Set())
  }, [examples, selectedFilter, addToast])

  // -- Add example
  const handleAddExample = useCallback(async () => {
    if (!newText.trim()) return
    setAddingExample(true)
    try {
      const res = await fetch(`${API_BASE}/api/knowledge/classifier-examples`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ text: newText.trim(), labels: Array.from(newLabels) }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      addToast('Example added successfully', 'success')
      setNewText('')
      setNewLabels(new Set())
      setShowAddForm(false)
      await fetchExamples()
      // Reinitialize
      try {
        setReinitializing(true)
        await fetch(`${API_BASE}/api/knowledge/classifier-reinitialize`, {
          method: 'POST',
          headers: headers(),
        })
      } catch {} finally {
        setReinitializing(false)
      }
    } catch (err) {
      addToast('Failed to add example', 'error')
    } finally {
      setAddingExample(false)
    }
  }, [newText, newLabels, addToast, fetchExamples])

  // -- Delete selected
  const handleDeleteSelected = useCallback(async () => {
    const toDelete = Array.from(selectedIds).filter(id => {
      const ex = examples.find(e => e.id === id)
      return ex?.editable
    })
    if (toDelete.length === 0) {
      addToast('No editable examples selected', 'error')
      return
    }
    const confirmed = window.confirm(`Delete ${toDelete.length} example${toDelete.length > 1 ? 's' : ''}?`)
    if (!confirmed) return

    let deleted = 0
    await Promise.all(toDelete.map(async id => {
      try {
        const res = await fetch(`${API_BASE}/api/knowledge/classifier-examples/${id}`, {
          method: 'DELETE',
          headers: headers(),
        })
        if (res.ok) deleted++
      } catch {}
    }))

    if (deleted > 0) {
      addToast(`Deleted ${deleted} example${deleted > 1 ? 's' : ''}`, 'success')
      setSelectedIds(new Set())
      await fetchExamples()
      try {
        setReinitializing(true)
        await fetch(`${API_BASE}/api/knowledge/classifier-reinitialize`, {
          method: 'POST',
          headers: headers(),
        })
      } catch {} finally {
        setReinitializing(false)
      }
    }
  }, [selectedIds, examples, addToast, fetchExamples])

  // -- Toggle label in add form
  const toggleNewLabel = useCallback((label: string) => {
    setNewLabels(prev => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }, [])

  // -- Sidebar items data
  const sidebarItems = useMemo(() => {
    const items: { key: string; label: string; count: number; isSpecial?: boolean }[] = [
      { key: '__all__', label: 'All Examples', count: examples.length, isSpecial: true },
      { key: '__contextual__', label: 'Contextual', count: sopCategories.noLabelCount, isSpecial: true },
    ]
    for (const [sop, count] of sopCategories.sorted) {
      items.push({ key: sop, label: sop, count })
    }
    return items
  }, [examples.length, sopCategories])

  // -- Render
  return (
    <div style={{
      height: '100%',
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: T.font.sans,
      color: T.text.primary,
      background: T.bg.primary,
    }}>
      <div className="ee-scroll" style={{
        flex: 1,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
      }}>
        {/* ─── Header ─────────────────────────────────────────────────────── */}
        <div style={{
          padding: '16px 20px',
          borderBottom: `1px solid ${T.border.default}`,
          background: T.bg.card,
          flexShrink: 0,
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}>
            {/* Left: title + counts */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Layers size={20} style={{ color: T.accent }} />
              <h2 style={{
                fontSize: 18,
                fontWeight: 700,
                margin: 0,
                letterSpacing: '-0.01em',
              }}>
                Training Examples
              </h2>
              {!loading && (
                <span style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: T.text.tertiary,
                  background: T.bg.secondary,
                  padding: '2px 8px',
                  borderRadius: 99,
                }}>
                  {examples.length} total
                </span>
              )}
              {reinitializing && (
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 11,
                  color: T.status.blue,
                  fontWeight: 500,
                }}>
                  <RefreshCw size={12} style={{ animation: 'spin 1s linear infinite' }} />
                  Re-embedding...
                </span>
              )}
            </div>

            {/* Right: search + actions */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {/* Search */}
              <div style={{
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
              }}>
                <Search size={14} style={{
                  position: 'absolute',
                  left: 10,
                  color: T.text.tertiary,
                  pointerEvents: 'none',
                }} />
                <input
                  type="text"
                  placeholder="Search examples..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  style={{
                    width: 220,
                    padding: '7px 10px 7px 30px',
                    borderRadius: T.radius.sm,
                    border: `1px solid ${T.border.default}`,
                    background: T.bg.primary,
                    fontFamily: T.font.sans,
                    fontSize: 13,
                    color: T.text.primary,
                    outline: 'none',
                    transition: 'border-color 0.15s',
                  }}
                  onFocus={e => { e.currentTarget.style.borderColor = T.accent }}
                  onBlur={e => { e.currentTarget.style.borderColor = T.border.default }}
                />
                {search && (
                  <button
                    onClick={() => setSearch('')}
                    style={{
                      position: 'absolute',
                      right: 8,
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: T.text.tertiary,
                      padding: 2,
                      display: 'flex',
                    }}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>

              {/* Refresh */}
              <button
                onClick={() => { setLoading(true); fetchExamples() }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 34,
                  height: 34,
                  borderRadius: T.radius.sm,
                  border: `1px solid ${T.border.default}`,
                  background: T.bg.card,
                  cursor: 'pointer',
                  color: T.text.secondary,
                  transition: 'all 0.15s',
                }}
                title="Refresh"
                onMouseEnter={e => { e.currentTarget.style.background = T.bg.secondary }}
                onMouseLeave={e => { e.currentTarget.style.background = T.bg.card }}
              >
                <RefreshCw size={14} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} />
              </button>

              {/* Delete selected */}
              {selectedIds.size > 0 && (
                <button
                  onClick={handleDeleteSelected}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    padding: '7px 12px',
                    borderRadius: T.radius.sm,
                    border: `1px solid ${T.status.red}30`,
                    background: `${T.status.red}08`,
                    cursor: 'pointer',
                    color: T.status.red,
                    fontFamily: T.font.sans,
                    fontSize: 12,
                    fontWeight: 600,
                    transition: 'all 0.15s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = `${T.status.red}15` }}
                  onMouseLeave={e => { e.currentTarget.style.background = `${T.status.red}08` }}
                >
                  <Trash2 size={13} />
                  Delete
                </button>
              )}

              {/* Add Example */}
              <button
                onClick={() => setShowAddForm(prev => !prev)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '7px 14px',
                  borderRadius: T.radius.sm,
                  border: 'none',
                  background: T.accent,
                  cursor: 'pointer',
                  color: T.text.inverse,
                  fontFamily: T.font.sans,
                  fontSize: 13,
                  fontWeight: 600,
                  transition: 'all 0.15s',
                  boxShadow: T.shadow.sm,
                }}
                onMouseEnter={e => { e.currentTarget.style.opacity = '0.9' }}
                onMouseLeave={e => { e.currentTarget.style.opacity = '1' }}
              >
                {showAddForm ? <X size={14} /> : <Plus size={14} />}
                {showAddForm ? 'Cancel' : 'Add Example'}
              </button>
            </div>
          </div>

          {/* ─── Add Example Form (inline, below header) ──────────────── */}
          {showAddForm && (
            <div style={{
              marginTop: 12,
              padding: 14,
              background: T.bg.primary,
              borderRadius: T.radius.md,
              border: `1px solid ${T.border.default}`,
              animation: 'scaleIn 0.2s ease both',
            }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                {/* Text area */}
                <div style={{ flex: 1 }}>
                  <label style={{
                    display: 'block',
                    fontSize: 11,
                    fontWeight: 600,
                    color: T.text.secondary,
                    marginBottom: 4,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}>
                    Example text
                  </label>
                  <textarea
                    value={newText}
                    onChange={e => setNewText(e.target.value)}
                    placeholder="Enter a training example message..."
                    rows={2}
                    style={{
                      width: '100%',
                      padding: '8px 10px',
                      borderRadius: T.radius.sm,
                      border: `1px solid ${T.border.default}`,
                      background: T.bg.card,
                      fontFamily: T.font.mono,
                      fontSize: 13,
                      color: T.text.primary,
                      outline: 'none',
                      resize: 'vertical',
                      lineHeight: 1.5,
                      boxSizing: 'border-box',
                    }}
                    onFocus={e => { e.currentTarget.style.borderColor = T.accent }}
                    onBlur={e => { e.currentTarget.style.borderColor = T.border.default }}
                  />
                </div>

                {/* Labels picker */}
                <div style={{ width: 280, flexShrink: 0 }}>
                  <label style={{
                    display: 'block',
                    fontSize: 11,
                    fontWeight: 600,
                    color: T.text.secondary,
                    marginBottom: 4,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}>
                    Labels
                  </label>
                  <div style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 4,
                    maxHeight: 80,
                    overflowY: 'auto',
                    padding: 2,
                  }}>
                    {allLabelNames.map(label => {
                      const active = newLabels.has(label)
                      const colors = sopBadgeColor(label)
                      return (
                        <button
                          key={label}
                          onClick={() => toggleNewLabel(label)}
                          style={{
                            padding: '2px 8px',
                            borderRadius: 4,
                            border: active ? `1.5px solid ${colors.fg}` : `1px solid ${T.border.default}`,
                            background: active ? colors.bg : T.bg.card,
                            color: active ? colors.fg : T.text.secondary,
                            fontFamily: T.font.sans,
                            fontSize: 10,
                            fontWeight: active ? 600 : 400,
                            cursor: 'pointer',
                            transition: 'all 0.1s',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {active && <Check size={9} style={{ marginRight: 3, verticalAlign: '-1px' }} />}
                          {label}
                        </button>
                      )
                    })}
                  </div>
                </div>

                {/* Submit */}
                <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 2 }}>
                  <button
                    onClick={handleAddExample}
                    disabled={addingExample || !newText.trim()}
                    style={{
                      padding: '8px 18px',
                      borderRadius: T.radius.sm,
                      border: 'none',
                      background: !newText.trim() ? T.bg.tertiary : T.status.green,
                      color: !newText.trim() ? T.text.tertiary : '#fff',
                      fontFamily: T.font.sans,
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: !newText.trim() ? 'not-allowed' : 'pointer',
                      transition: 'all 0.15s',
                      whiteSpace: 'nowrap',
                      opacity: addingExample ? 0.7 : 1,
                    }}
                  >
                    {addingExample ? 'Adding...' : 'Add'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ─── Tab Bar ─────────────────────────────────────────────────── */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 0,
          borderBottom: `1px solid ${T.border.default}`,
          background: T.bg.card,
          flexShrink: 0,
          paddingLeft: 20,
        }}>
          {(['active', 'suggested'] as const).map(tab => {
            const isActive = activeTab === tab
            return (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: '10px 18px',
                  fontSize: 13,
                  fontWeight: isActive ? 700 : 500,
                  fontFamily: T.font.sans,
                  color: isActive ? T.accent : T.text.secondary,
                  background: 'transparent',
                  border: 'none',
                  borderBottom: isActive ? `2px solid ${T.accent}` : '2px solid transparent',
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
                onMouseEnter={e => { if (!isActive) e.currentTarget.style.color = T.text.primary }}
                onMouseLeave={e => { if (!isActive) e.currentTarget.style.color = T.text.secondary }}
              >
                {tab === 'active' ? (
                  <>
                    <Layers size={14} />
                    Active
                  </>
                ) : (
                  <>
                    <Sparkles size={14} />
                    Suggested
                    {suggestedExamples.length > 0 && (
                      <span style={{
                        fontSize: 10,
                        fontWeight: 700,
                        color: T.text.inverse,
                        background: T.status.amber,
                        padding: '1px 6px',
                        borderRadius: 99,
                        lineHeight: '16px',
                        minWidth: 18,
                        textAlign: 'center',
                      }}>
                        {suggestedExamples.length}
                      </span>
                    )}
                  </>
                )}
              </button>
            )
          })}
        </div>

        {/* ─── Two-Panel Layout (Active tab) ─────────────────────────────── */}
        {activeTab === 'active' && (
        <div style={{
          flex: 1,
          display: 'flex',
          minHeight: 0,
        }}>
          {/* ─── Left Sidebar ──────────────────────────────────────────── */}
          <div className="ee-scroll" style={{
            width: 240,
            flexShrink: 0,
            borderRight: `1px solid ${T.border.default}`,
            background: T.bg.card,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
          }}>
            <div style={{
              padding: '8px 0',
              fontSize: 10,
              fontWeight: 700,
              color: T.text.tertiary,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              paddingLeft: 14,
              paddingTop: 12,
            }}>
              Categories
            </div>

            {loading ? <SkeletonSidebar /> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1, paddingBottom: 12 }}>
                {sidebarItems.map((item, idx) => {
                  const isSelected = selectedFilter === item.key
                  const isDropTarget = dragOverSop === item.key
                  const isDropSuccess = dropSuccessSop === item.key
                  const isDroppable = item.key !== '__all__'

                  return (
                    <div
                      key={item.key}
                      onClick={() => { setSelectedFilter(item.key); setSelectedIds(new Set()) }}
                      onDragOver={isDroppable ? (e) => handleSidebarDragOver(e, item.key) : undefined}
                      onDragLeave={isDroppable ? handleSidebarDragLeave : undefined}
                      onDrop={isDroppable ? (e) => handleSidebarDrop(e, item.key) : undefined}
                      style={{
                        padding: '7px 12px 7px 14px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        cursor: 'pointer',
                        background: isDropTarget
                          ? '#EFF6FF'
                          : isDropSuccess
                            ? '#F0FDF4'
                            : isSelected
                              ? '#EFF6FF'
                              : 'transparent',
                        ...(isDropTarget ? {
                          borderTop: `2px dashed ${T.accent}`,
                          borderRight: `2px dashed ${T.accent}`,
                          borderBottom: `2px dashed ${T.accent}`,
                          borderLeft: `3px solid ${T.accent}`,
                        } : {
                          borderTop: '2px solid transparent',
                          borderRight: '2px solid transparent',
                          borderBottom: '2px solid transparent',
                          borderLeft: (isSelected || isDropTarget)
                            ? `3px solid ${T.accent}`
                            : '3px solid transparent',
                        }),
                        transition: 'all 0.15s ease',
                        transform: isDropTarget ? 'scale(1.02)' : 'scale(1)',
                        borderRadius: isDropTarget ? 4 : 0,
                        animation: isDropSuccess ? 'pulseGreen 0.6s ease' : idx < 15 ? `fadeInUp 0.3s ease both` : undefined,
                        animationDelay: !isDropSuccess && idx < 15 ? `${idx * 20}ms` : undefined,
                      }}
                      onMouseEnter={e => {
                        if (!isSelected && !isDropTarget) {
                          e.currentTarget.style.background = T.bg.secondary
                        }
                      }}
                      onMouseLeave={e => {
                        if (!isSelected && !isDropTarget && !isDropSuccess) {
                          e.currentTarget.style.background = 'transparent'
                        }
                      }}
                    >
                      {/* Dot or icon */}
                      {item.isSpecial ? (
                        <div style={{
                          width: 8, height: 8, borderRadius: '50%',
                          background: item.key === '__all__' ? T.text.tertiary : T.status.amber,
                          flexShrink: 0,
                        }} />
                      ) : (
                        <div style={{
                          width: 8, height: 8, borderRadius: '50%',
                          background: sopDotColor(item.label),
                          flexShrink: 0,
                        }} />
                      )}

                      {/* Label */}
                      <span style={{
                        flex: 1,
                        fontSize: 12,
                        fontWeight: isSelected ? 600 : 500,
                        color: isSelected ? T.accent : T.text.primary,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {item.label}
                      </span>

                      {/* Count */}
                      <span style={{
                        fontSize: 11,
                        fontWeight: 500,
                        color: T.text.tertiary,
                        fontFamily: T.font.mono,
                        flexShrink: 0,
                      }}>
                        {item.count}
                      </span>

                      {/* Drop success check */}
                      {isDropSuccess && (
                        <Check size={12} style={{ color: T.status.green, flexShrink: 0 }} />
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* ─── Main Grid Area ────────────────────────────────────────── */}
          <div className="ee-scroll" ref={mainGridRef} style={{
            flex: 1,
            overflowY: 'auto',
            background: T.bg.primary,
            position: 'relative',
          }}>
            {loading ? <SkeletonCards /> : filteredExamples.length === 0 ? (
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                minHeight: 300,
                gap: 8,
                color: T.text.tertiary,
              }}>
                <Layers size={32} style={{ opacity: 0.3 }} />
                <p style={{ fontSize: 14, fontWeight: 500, margin: 0 }}>
                  {search ? 'No examples match your search' : 'No examples in this category'}
                </p>
                {search && (
                  <button
                    onClick={() => setSearch('')}
                    style={{
                      padding: '5px 12px',
                      border: `1px solid ${T.border.default}`,
                      borderRadius: T.radius.sm,
                      background: T.bg.card,
                      color: T.text.secondary,
                      fontSize: 12,
                      cursor: 'pointer',
                      fontFamily: T.font.sans,
                    }}
                  >
                    Clear search
                  </button>
                )}
              </div>
            ) : (
              <>
                {/* Filter info bar */}
                <div style={{
                  padding: '8px 12px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  borderBottom: `1px solid ${T.border.default}`,
                  background: T.bg.card,
                  flexShrink: 0,
                }}>
                  <span style={{ fontSize: 12, color: T.text.secondary, fontWeight: 500 }}>
                    {filteredExamples.length} example{filteredExamples.length !== 1 ? 's' : ''}
                    {selectedFilter !== '__all__' && (
                      <span style={{ color: T.text.tertiary }}>
                        {' '}in <strong style={{ color: T.accent }}>{selectedFilter === '__contextual__' ? 'Contextual' : selectedFilter}</strong>
                      </span>
                    )}
                    {search && (
                      <span style={{ color: T.text.tertiary }}>
                        {' '}matching &ldquo;{search}&rdquo;
                      </span>
                    )}
                  </span>
                  {selectedIds.size > 0 && (
                    <span style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: T.accent,
                      background: '#EFF6FF',
                      padding: '2px 8px',
                      borderRadius: 99,
                    }}>
                      {selectedIds.size} selected
                    </span>
                  )}
                </div>

                {/* Grid of cards */}
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                  gap: 8,
                  padding: 12,
                }}>
                  {filteredExamples.map((ex, idx) => (
                    <ExampleCard
                      key={ex.id}
                      example={ex}
                      isSelected={selectedIds.has(ex.id)}
                      isDragging={isDragging && selectedIds.has(ex.id)}
                      onClick={(e) => handleCardClick(e, ex.id)}
                      onDragStart={(e) => handleDragStart(e, ex.id)}
                      onDragEnd={handleDragEnd}
                      animationDelay={idx < 40 ? idx * 15 : 0}
                    />
                  ))}
                </div>
              </>
            )}

            {/* ─── Selection Float Bar ──────────────────────────────────── */}
            {selectedIds.size > 0 && !isDragging && (
              <div style={{
                position: 'sticky',
                bottom: 16,
                left: '50%',
                display: 'flex',
                justifyContent: 'center',
                pointerEvents: 'none',
                zIndex: 100,
              }}>
                <div style={{
                  pointerEvents: 'auto',
                  background: T.text.primary,
                  color: T.text.inverse,
                  padding: '10px 20px',
                  borderRadius: 99,
                  fontFamily: T.font.sans,
                  fontSize: 13,
                  fontWeight: 600,
                  boxShadow: T.shadow.lg,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  animation: 'fadeInUp 0.2s ease both',
                }}>
                  <GripVertical size={14} style={{ opacity: 0.5 }} />
                  <span>{selectedIds.size} selected</span>
                  <span style={{ opacity: 0.4, fontSize: 11 }}>Drag to move</span>
                  <button
                    onClick={() => setSelectedIds(new Set())}
                    style={{
                      background: 'rgba(255,255,255,0.15)',
                      border: 'none',
                      borderRadius: '50%',
                      width: 22,
                      height: 22,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      color: T.text.inverse,
                      marginLeft: 4,
                    }}
                  >
                    <X size={12} />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
        )}

        {/* ─── Suggested Tab ───────────────────────────────────────────── */}
        {activeTab === 'suggested' && (
          <div className="ee-scroll" style={{
            flex: 1,
            overflowY: 'auto',
            background: T.bg.primary,
          }}>
            {/* Toolbar */}
            <div style={{
              padding: '12px 20px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              borderBottom: `1px solid ${T.border.default}`,
              background: T.bg.card,
              flexShrink: 0,
              gap: 12,
              flexWrap: 'wrap',
            }}>
              <span style={{ fontSize: 13, color: T.text.secondary, fontWeight: 500 }}>
                {suggestedLoading ? 'Loading...' : (
                  <>
                    <strong style={{ color: T.text.primary }}>{suggestedExamples.length}</strong>
                    {' '}suggested example{suggestedExamples.length !== 1 ? 's' : ''} pending review
                  </>
                )}
              </span>

              <button
                onClick={handleRunGapAnalysis}
                disabled={gapAnalysisRunning}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '8px 16px',
                  borderRadius: T.radius.sm,
                  border: 'none',
                  background: gapAnalysisRunning ? T.bg.tertiary : '#EA580C',
                  color: gapAnalysisRunning ? T.text.secondary : T.text.inverse,
                  fontFamily: T.font.sans,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: gapAnalysisRunning ? 'not-allowed' : 'pointer',
                  transition: 'all 0.15s',
                  boxShadow: T.shadow.sm,
                  opacity: gapAnalysisRunning ? 0.8 : 1,
                }}
                onMouseEnter={e => { if (!gapAnalysisRunning) e.currentTarget.style.opacity = '0.9' }}
                onMouseLeave={e => { if (!gapAnalysisRunning) e.currentTarget.style.opacity = '1' }}
              >
                {gapAnalysisRunning ? (
                  <RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} />
                ) : (
                  <Zap size={14} />
                )}
                {gapAnalysisRunning ? 'Analyzing...' : 'Run Gap Analysis'}
              </button>
            </div>

            {/* Gap Analysis Result Summary */}
            {gapAnalysisResult && (
              <div style={{
                margin: '12px 20px 0',
                padding: 14,
                background: '#FFF7ED',
                borderRadius: T.radius.md,
                border: '1px solid #FDBA7440',
                animation: 'scaleIn 0.2s ease both',
              }}>
                <div style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: '#EA580C',
                  marginBottom: 8,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}>
                  <Sparkles size={14} />
                  Gap Analysis Results
                  <button
                    onClick={() => setGapAnalysisResult(null)}
                    style={{
                      marginLeft: 'auto',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: '#EA580C',
                      opacity: 0.6,
                      padding: 2,
                      display: 'flex',
                    }}
                  >
                    <X size={12} />
                  </button>
                </div>
                <div style={{
                  display: 'flex',
                  gap: 16,
                  flexWrap: 'wrap',
                  fontSize: 12,
                  color: T.text.secondary,
                }}>
                  <div>
                    <span style={{ fontWeight: 600, color: T.text.primary }}>
                      {gapAnalysisResult.emptyLabelMessages}
                    </span>
                    {' '}empty-label messages found
                  </div>
                  <div>
                    <span style={{ fontWeight: 600, color: T.text.primary }}>
                      {gapAnalysisResult.suggestedExamples}
                    </span>
                    {' '}examples suggested
                  </div>
                  {Object.keys(gapAnalysisResult.languageDistribution).length > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      Languages:{' '}
                      {Object.entries(gapAnalysisResult.languageDistribution).map(([lang, count]) => (
                        <span
                          key={lang}
                          style={{
                            padding: '1px 6px',
                            borderRadius: 3,
                            background: '#FEF3C7',
                            color: '#D97706',
                            fontSize: 10,
                            fontWeight: 600,
                            fontFamily: T.font.sans,
                          }}
                        >
                          {lang}: {count}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Suggested examples list */}
            {suggestedLoading ? (
              <SkeletonCards />
            ) : suggestedExamples.length === 0 ? (
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                minHeight: 300,
                gap: 10,
                color: T.text.tertiary,
                padding: 40,
              }}>
                <Sparkles size={32} style={{ opacity: 0.3 }} />
                <p style={{ fontSize: 14, fontWeight: 500, margin: 0, textAlign: 'center' }}>
                  No suggested examples pending review
                </p>
                <p style={{ fontSize: 12, margin: 0, textAlign: 'center', maxWidth: 360 }}>
                  Run Gap Analysis to scan recent messages and generate training example suggestions.
                </p>
              </div>
            ) : (
              <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {suggestedExamples.map((ex, idx) => (
                  <SuggestedExampleRow
                    key={ex.id}
                    example={ex}
                    processing={processingIds.has(ex.id)}
                    onApprove={() => handleApproveExample(ex.id)}
                    onReject={() => handleRejectExample(ex.id)}
                    animationDelay={idx < 30 ? idx * 25 : 0}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ─── Toasts ──────────────────────────────────────────────────────── */}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}

// ─── Example Card (memoized) ─────────────────────────────────────────────────
const ExampleCard = React.memo(function ExampleCard({
  example,
  isSelected,
  isDragging,
  onClick,
  onDragStart,
  onDragEnd,
  animationDelay,
}: {
  example: Example
  isSelected: boolean
  isDragging: boolean
  onClick: (e: React.MouseEvent) => void
  onDragStart: (e: React.DragEvent) => void
  onDragEnd: () => void
  animationDelay: number
}) {
  const [hovered, setHovered] = useState(false)
  const sc = sourceColor(example.source)

  return (
    <div
      draggable={true}
      onClick={onClick}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: isSelected ? '#EFF6FF' : T.bg.card,
        borderRadius: T.radius.sm,
        border: isSelected
          ? `2px solid ${T.accent}`
          : `1px solid ${T.border.default}`,
        padding: isSelected ? 9 : 10,  // compensate for 2px border
        cursor: isDragging ? 'grabbing' : 'grab',
        opacity: isDragging ? 0.5 : 1,
        transition: 'all 0.15s ease',
        boxShadow: hovered && !isDragging ? T.shadow.md : T.shadow.sm,
        transform: hovered && !isDragging ? 'translateY(-1px)' : 'translateY(0)',
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        position: 'relative',
        animation: animationDelay > 0 ? `fadeInUp 0.3s ease both` : undefined,
        animationDelay: animationDelay > 0 ? `${animationDelay}ms` : undefined,
        userSelect: 'none',
        minHeight: 60,
      }}
    >
      {/* Lock icon for non-editable */}
      {!example.editable && (
        <div style={{
          position: 'absolute',
          top: 6,
          right: 6,
          color: T.text.tertiary,
          opacity: 0.5,
        }}>
          <Lock size={10} />
        </div>
      )}

      {/* Text content */}
      <p style={{
        margin: 0,
        fontSize: 13,
        fontFamily: T.font.mono,
        color: T.text.primary,
        lineHeight: 1.45,
        overflow: 'hidden',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        paddingRight: !example.editable ? 16 : 0,
      }}>
        {example.text}
      </p>

      {/* Bottom row: labels + source */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 3,
        flexWrap: 'wrap',
        marginTop: 'auto',
      }}>
        {/* SOP label badges */}
        {example.labels.map(label => {
          const colors = sopBadgeColor(label)
          return (
            <span key={label} style={{
              display: 'inline-block',
              padding: '1px 5px',
              borderRadius: 3,
              background: colors.bg,
              color: colors.fg,
              fontSize: 8,
              fontWeight: 600,
              fontFamily: T.font.sans,
              letterSpacing: '0.01em',
              whiteSpace: 'nowrap',
              lineHeight: '14px',
            }}>
              {label}
            </span>
          )
        })}

        {example.labels.length === 0 && (
          <span style={{
            display: 'inline-block',
            padding: '1px 5px',
            borderRadius: 3,
            background: '#FEF3C7',
            color: '#D97706',
            fontSize: 8,
            fontWeight: 600,
            fontFamily: T.font.sans,
            lineHeight: '14px',
          }}>
            contextual
          </span>
        )}

        {/* Spacer */}
        <span style={{ flex: 1 }} />

        {/* Source badge */}
        <span style={{
          display: 'inline-block',
          padding: '1px 5px',
          borderRadius: 3,
          background: sc.bg,
          color: sc.fg,
          fontSize: 8,
          fontWeight: 600,
          fontFamily: T.font.sans,
          lineHeight: '14px',
          whiteSpace: 'nowrap',
        }}>
          {sourceLabel(example.source)}
        </span>
      </div>
    </div>
  )
})

// ─── Suggested Example Row (memoized) ────────────────────────────────────────
const SuggestedExampleRow = React.memo(function SuggestedExampleRow({
  example,
  processing,
  onApprove,
  onReject,
  animationDelay,
}: {
  example: ClassifierExampleItem
  processing: boolean
  onApprove: () => void
  onReject: () => void
  animationDelay: number
}) {
  const [hovered, setHovered] = useState(false)
  const sc = sourceColor(example.source)

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: T.bg.card,
        borderRadius: T.radius.sm,
        border: `1px solid ${T.border.default}`,
        padding: '10px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        transition: 'all 0.15s ease',
        boxShadow: hovered ? T.shadow.md : T.shadow.sm,
        animation: animationDelay > 0 ? `fadeInUp 0.3s ease both` : undefined,
        animationDelay: animationDelay > 0 ? `${animationDelay}ms` : undefined,
        opacity: processing ? 0.5 : 1,
        pointerEvents: processing ? 'none' : 'auto',
      }}
    >
      {/* Text content */}
      <p
        dir="auto"
        style={{
          margin: 0,
          fontSize: 13,
          fontFamily: T.font.mono,
          color: T.text.primary,
          lineHeight: 1.45,
          flex: 1,
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          minWidth: 0,
        }}
      >
        {example.text}
      </p>

      {/* Labels */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 3,
        flexWrap: 'wrap',
        flexShrink: 0,
        maxWidth: 200,
      }}>
        {example.labels.map(label => {
          const colors = sopBadgeColor(label)
          return (
            <span key={label} style={{
              display: 'inline-block',
              padding: '1px 5px',
              borderRadius: 3,
              background: colors.bg,
              color: colors.fg,
              fontSize: 9,
              fontWeight: 600,
              fontFamily: T.font.sans,
              letterSpacing: '0.01em',
              whiteSpace: 'nowrap',
              lineHeight: '16px',
            }}>
              {label}
            </span>
          )
        })}
        {example.labels.length === 0 && (
          <span style={{
            display: 'inline-block',
            padding: '1px 5px',
            borderRadius: 3,
            background: '#FEF3C7',
            color: '#D97706',
            fontSize: 9,
            fontWeight: 600,
            fontFamily: T.font.sans,
            lineHeight: '16px',
          }}>
            contextual
          </span>
        )}
      </div>

      {/* Source badge */}
      <span style={{
        display: 'inline-block',
        padding: '2px 6px',
        borderRadius: 3,
        background: sc.bg,
        color: sc.fg,
        fontSize: 9,
        fontWeight: 600,
        fontFamily: T.font.sans,
        lineHeight: '16px',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}>
        {sourceLabel(example.source)}
      </span>

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        <button
          onClick={onApprove}
          disabled={processing}
          title="Approve — activate this example"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '5px 10px',
            borderRadius: T.radius.sm,
            border: `1px solid ${T.status.green}40`,
            background: `${T.status.green}0A`,
            color: T.status.green,
            fontFamily: T.font.sans,
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'all 0.15s',
            whiteSpace: 'nowrap',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = `${T.status.green}18` }}
          onMouseLeave={e => { e.currentTarget.style.background = `${T.status.green}0A` }}
        >
          <ThumbsUp size={12} />
          Approve
        </button>
        <button
          onClick={onReject}
          disabled={processing}
          title="Reject — delete this suggestion"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '5px 10px',
            borderRadius: T.radius.sm,
            border: `1px solid ${T.status.red}40`,
            background: `${T.status.red}0A`,
            color: T.status.red,
            fontFamily: T.font.sans,
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'all 0.15s',
            whiteSpace: 'nowrap',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = `${T.status.red}18` }}
          onMouseLeave={e => { e.currentTarget.style.background = `${T.status.red}0A` }}
        >
          <ThumbsDown size={12} />
          Reject
        </button>
      </div>
    </div>
  )
})
