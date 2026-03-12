'use client'

import { useState, useEffect, useCallback } from 'react'
import { Check, Trash2, AlertCircle, Clock, Info } from 'lucide-react'
import { apiGetAllTasks, apiUpdateTask, apiDeleteTask, type ApiTask } from '@/lib/api'

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

const URGENCY_CONFIG: Record<string, { label: string; bg: string; text: string; icon: React.ComponentType<{ size?: number }> }> = {
  immediate:    { label: 'Immediate',    bg: '#FEE2E2', text: '#DC2626', icon: AlertCircle },
  scheduled:    { label: 'Scheduled',   bg: '#FEF3C7', text: '#D97706', icon: Clock },
  info_request: { label: 'Info Request', bg: '#DBEAFE', text: '#2563EB', icon: Info },
}

function UrgencyBadge({ urgency }: { urgency: string }) {
  const cfg = URGENCY_CONFIG[urgency]
  if (!cfg) return (
    <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 600, background: 'var(--muted)', color: 'var(--muted-foreground)' }}>
      {urgency}
    </span>
  )
  const Icon = cfg.icon
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 700, background: cfg.bg, color: cfg.text }}>
      <Icon size={10} />
      {cfg.label}
    </span>
  )
}

function SourceBadge({ source }: { source: string }) {
  const isAi = source === 'AI' || source === 'ai'
  return (
    <span style={{
      padding: '1px 6px',
      borderRadius: 4,
      fontSize: 9,
      fontWeight: 700,
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      background: isAi ? '#F0FDF4' : 'var(--muted)',
      color: isAi ? '#15803D' : 'var(--muted-foreground)',
      border: `1px solid ${isAi ? '#86EFAC' : 'var(--border)'}`,
    }}>
      {isAi ? 'AI' : 'Manual'}
    </span>
  )
}

function Spinner() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200 }}>
      <div
        style={{
          width: 28,
          height: 28,
          border: '3px solid var(--border)',
          borderTopColor: 'var(--terracotta)',
          borderRadius: '50%',
          animation: 'spin 0.7s linear infinite',
        }}
      />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}

function TaskCard({
  task,
  onComplete,
  onDelete,
}: {
  task: ApiTask
  onComplete: (id: string) => void
  onDelete: (id: string) => void
}) {
  const isCompleted = task.status === 'completed' || task.status === 'COMPLETED'

  return (
    <div
      style={{
        background: 'var(--card)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: '12px 14px',
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        opacity: isCompleted ? 0.6 : 1,
        transition: 'opacity 0.2s',
      }}
    >
      {/* Left: urgency indicator stripe */}
      <div style={{
        width: 3,
        borderRadius: 2,
        alignSelf: 'stretch',
        background: isCompleted
          ? 'var(--border)'
          : (URGENCY_CONFIG[task.urgency]?.text ?? 'var(--muted-foreground)'),
        flexShrink: 0,
      }} />

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
          <UrgencyBadge urgency={task.urgency} />
          <SourceBadge source={task.source} />
          {isCompleted && (
            <span style={{ fontSize: 10, fontWeight: 600, color: '#15803D', background: '#F0FDF4', padding: '1px 6px', borderRadius: 4 }}>
              Completed
            </span>
          )}
        </div>

        <p style={{ fontSize: 13, fontWeight: 600, color: isCompleted ? 'var(--muted-foreground)' : 'var(--brown-dark)', margin: 0, textDecoration: isCompleted ? 'line-through' : 'none' }}>
          {task.title}
        </p>

        {task.note && (
          <p style={{
            fontSize: 12,
            color: 'var(--muted-foreground)',
            margin: '3px 0 0',
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
          }}>
            {task.note}
          </p>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6, flexWrap: 'wrap' }}>
          {task.propertyName && (
            <span style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>
              &#9632; {task.propertyName}
            </span>
          )}
          {task.guestName && (
            <span style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>
              &middot; {task.guestName}
            </span>
          )}
          <span style={{ fontSize: 11, color: 'var(--muted-foreground)', marginLeft: 'auto' }}>
            {timeAgo(task.createdAt)}
          </span>
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
        {!isCompleted && (
          <button
            onClick={() => onComplete(task.id)}
            title="Mark complete"
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              border: '1px solid var(--border)',
              background: 'var(--muted)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#22C55E',
              transition: 'background 0.15s',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = '#F0FDF4')}
            onMouseLeave={e => (e.currentTarget.style.background = 'var(--muted)')}
          >
            <Check size={13} />
          </button>
        )}
        <button
          onClick={() => onDelete(task.id)}
          title="Delete task"
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'var(--muted)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--muted-foreground)',
            transition: 'background 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = '#FEE2E2'; e.currentTarget.style.color = '#DC2626' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'var(--muted)'; e.currentTarget.style.color = 'var(--muted-foreground)' }}
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  )
}

const URGENCY_ORDER: Record<string, number> = { immediate: 0, scheduled: 1, info_request: 2 }

function sortTasks(tasks: ApiTask[]): ApiTask[] {
  const open = tasks.filter(t => t.status !== 'completed' && t.status !== 'COMPLETED')
  const done = tasks.filter(t => t.status === 'completed' || t.status === 'COMPLETED')
  open.sort((a, b) => (URGENCY_ORDER[a.urgency] ?? 99) - (URGENCY_ORDER[b.urgency] ?? 99))
  done.sort((a, b) => new Date(b.completedAt || b.createdAt).getTime() - new Date(a.completedAt || a.createdAt).getTime())
  return [...open, ...done]
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<ApiTask[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'completed'>('all')
  const [urgencyFilter, setUrgencyFilter] = useState<string>('all')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiGetAllTasks()
      setTasks(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load tasks')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Listen for SSE new_task events
  useEffect(() => {
    const handler = () => load()
    window.addEventListener('sse:new_task', handler)
    return () => window.removeEventListener('sse:new_task', handler)
  }, [load])

  async function handleComplete(id: string) {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, status: 'completed', completedAt: new Date().toISOString() } : t))
    try {
      await apiUpdateTask(id, { status: 'completed' })
    } catch {
      // Revert
      setTasks(prev => prev.map(t => t.id === id ? { ...t, status: 'open', completedAt: undefined } : t))
    }
  }

  async function handleDelete(id: string) {
    setTasks(prev => prev.filter(t => t.id !== id))
    try {
      await apiDeleteTask(id)
    } catch {
      load() // Reload to restore if delete failed
    }
  }

  const filtered = tasks.filter(t => {
    const matchStatus =
      statusFilter === 'all' ? true :
      statusFilter === 'open' ? (t.status !== 'completed' && t.status !== 'COMPLETED') :
      (t.status === 'completed' || t.status === 'COMPLETED')
    const matchUrgency = urgencyFilter === 'all' || t.urgency === urgencyFilter
    return matchStatus && matchUrgency
  })

  const sorted = sortTasks(filtered)

  // Stats
  const immediate = tasks.filter(t => t.urgency === 'immediate' && t.status !== 'completed' && t.status !== 'COMPLETED').length
  const scheduled = tasks.filter(t => t.urgency === 'scheduled' && t.status !== 'completed' && t.status !== 'COMPLETED').length
  const completed = tasks.filter(t => t.status === 'completed' || t.status === 'COMPLETED').length

  const pill = (active: boolean): React.CSSProperties => ({
    padding: '4px 12px',
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 600,
    border: 'none',
    cursor: 'pointer',
    background: active ? 'white' : 'transparent',
    color: active ? 'var(--brown-dark)' : 'var(--muted-foreground)',
    boxShadow: active ? '0 1px 4px rgba(0,0,0,0.1)' : 'none',
    transition: 'all 0.15s',
  })

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--brown-dark)', margin: 0 }}>Tasks</h2>
        <button
          onClick={load}
          style={{ fontSize: 12, color: 'var(--muted-foreground)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 8px', borderRadius: 6 }}
          onMouseEnter={e => e.currentTarget.style.background = 'var(--muted)'}
          onMouseLeave={e => e.currentTarget.style.background = 'none'}
        >
          Refresh
        </button>
      </div>

      {/* Stats bar */}
      <div style={{ display: 'flex', gap: 10 }}>
        {[
          { label: 'Immediate', count: immediate, bg: '#FEE2E2', text: '#DC2626' },
          { label: 'Scheduled', count: scheduled, bg: '#FEF3C7', text: '#D97706' },
          { label: 'Completed', count: completed, bg: '#F0FDF4', text: '#15803D' },
        ].map(({ label, count, bg, text }) => (
          <div
            key={label}
            style={{
              background: bg,
              borderRadius: 10,
              padding: '10px 16px',
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            <span style={{ fontSize: 22, fontWeight: 700, color: text }}>{count}</span>
            <span style={{ fontSize: 11, fontWeight: 600, color: text, opacity: 0.75 }}>{label}</span>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ display: 'flex', gap: 3, background: 'rgba(0,0,0,0.06)', borderRadius: 8, padding: 3 }}>
          {(['all', 'open', 'completed'] as const).map(s => (
            <button key={s} onClick={() => setStatusFilter(s)} style={pill(statusFilter === s)}>
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>

        <select
          value={urgencyFilter}
          onChange={e => setUrgencyFilter(e.target.value)}
          style={{
            padding: '5px 10px',
            borderRadius: 7,
            border: '1px solid var(--border)',
            background: 'var(--card)',
            color: 'var(--brown-dark)',
            fontSize: 12,
            fontWeight: 500,
            cursor: 'pointer',
            outline: 'none',
          }}
        >
          <option value="all">All urgencies</option>
          <option value="immediate">Immediate</option>
          <option value="scheduled">Scheduled</option>
          <option value="info_request">Info Request</option>
        </select>

        <span style={{ fontSize: 12, color: 'var(--muted-foreground)', marginLeft: 'auto' }}>
          {sorted.length} task{sorted.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Content */}
      {loading && <Spinner />}

      {error && (
        <div style={{ background: '#FEE2E2', border: '1px solid #FECACA', borderRadius: 10, padding: 14, fontSize: 13, color: '#DC2626' }}>
          {error}
        </div>
      )}

      {!loading && !error && sorted.length === 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 180, gap: 10 }}>
          <Check size={32} style={{ color: 'var(--border)' }} />
          <p style={{ fontSize: 14, color: 'var(--muted-foreground)', margin: 0 }}>No tasks found</p>
        </div>
      )}

      {!loading && !error && sorted.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sorted.map(task => (
            <TaskCard
              key={task.id}
              task={task}
              onComplete={handleComplete}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  )
}
