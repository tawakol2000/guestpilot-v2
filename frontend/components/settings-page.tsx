'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Copy, Check, RefreshCw, ChevronDown, ChevronUp, Trash2, AlertTriangle } from 'lucide-react'
import {
  getTenantMeta,
  apiGetProperties,
  apiUpdateKnowledgeBase,
  apiRunImport,
  apiGetImportProgress,
  apiDeleteAllData,
  apiToggleAIAll,
  apiGetTemplates,
  apiUpdateTemplate,
  apiEnhanceTemplate,
  apiGetKnowledgeSuggestions,
  apiUpdateKnowledgeSuggestion,
  apiCreateKnowledgeSuggestion,
  apiDeleteKnowledgeSuggestion,
  type ApiProperty,
  type ImportProgress,
  type ApiMessageTemplate,
  type ApiKnowledgeSuggestion,
} from '@/lib/api'

const PHASE_LABEL: Record<ImportProgress['phase'], string> = {
  idle:         'Ready',
  deleting:     'Clearing previous data…',
  listings:     'Fetching properties…',
  reservations: 'Fetching reservations…',
  messages:     'Importing conversations…',
  done:         'Sync complete',
  error:        'Error',
}

export function SettingsPage({ onImportComplete, onAIToggled }: { onImportComplete: () => void; onAIToggled?: () => void }) {
  const meta = getTenantMeta()
  const [copied, setCopied] = useState(false)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [properties, setProperties] = useState<ApiProperty[]>([])
  const [expandedProp, setExpandedProp] = useState<string | null>(null)
  const [kbDraft, setKbDraft] = useState<Record<string, string>>({})
  const [savingKb, setSavingKb] = useState<string | null>(null)
  const [savedKb, setSavedKb] = useState<string | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [togglingAI, setTogglingAI] = useState<'on' | 'off' | null>(null)
  const [aiToggleDone, setAiToggleDone] = useState<'on' | 'off' | null>(null)
  const [templates, setTemplates] = useState<ApiMessageTemplate[]>([])
  const [kbSuggestions, setKbSuggestions] = useState<ApiKnowledgeSuggestion[]>([])
  const [kbTab, setKbTab] = useState<'pending' | 'approved'>('pending')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const startPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      try {
        const p = await apiGetImportProgress()
        setProgress(p)
        if (p.phase === 'done' || p.phase === 'error' || p.phase === 'idle') {
          clearInterval(pollRef.current!)
          pollRef.current = null
          setSyncing(false)
          if (p.phase === 'done') {
            const props = await apiGetProperties()
            setProperties(props)
            onImportComplete()
          }
        }
      } catch { /* silent */ }
    }, 800)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onImportComplete])

  // Load initial progress + properties; resume polling if sync already active
  useEffect(() => {
    apiGetImportProgress().then(p => {
      setProgress(p)
      if (p.phase !== 'idle' && p.phase !== 'done' && p.phase !== 'error') {
        setSyncing(true)
        startPolling()
      }
    }).catch(console.error)
    apiGetProperties().then(setProperties).catch(console.error)
    apiGetTemplates().then(setTemplates).catch(() => {})
    apiGetKnowledgeSuggestions().then(setKbSuggestions).catch(() => {})
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function runSync(listingsOnly: boolean) {
    setSyncing(true)
    setProgress({ phase: 'deleting', total: 0, completed: 0, message: 'Starting…', lastSyncedAt: progress?.lastSyncedAt ?? null })
    try {
      await apiRunImport(listingsOnly)
      startPolling()
    } catch (err) {
      setSyncing(false)
      setProgress(prev => ({ ...prev!, phase: 'error', message: err instanceof Error ? err.message : 'Failed to start' }))
    }
  }

  async function handleDelete() {
    setDeleting(true)
    try {
      await apiDeleteAllData()
      setProperties([])
      setProgress(null)
      setShowDeleteConfirm(false)
      onImportComplete()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setDeleting(false)
    }
  }

  async function handleAIToggleAll(enabled: boolean) {
    setTogglingAI(enabled ? 'on' : 'off')
    setAiToggleDone(null)
    try {
      await apiToggleAIAll(enabled)
      setAiToggleDone(enabled ? 'on' : 'off')
      onAIToggled?.()
      setTimeout(() => setAiToggleDone(null), 2500)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed')
    } finally {
      setTogglingAI(null)
    }
  }

  function copyWebhook() {
    if (!meta?.webhookUrl) return
    navigator.clipboard.writeText(meta.webhookUrl).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  function toggleProp(id: string, prop: ApiProperty) {
    if (expandedProp === id) {
      setExpandedProp(null)
    } else {
      setExpandedProp(id)
      const kb = (prop.customKnowledgeBase || {}) as Record<string, string>
      setKbDraft(prev => ({ ...prev, [id]: JSON.stringify(kb, null, 2) }))
    }
  }

  async function saveKb(id: string) {
    setSavingKb(id)
    try {
      const parsed = JSON.parse(kbDraft[id] || '{}')
      await apiUpdateKnowledgeBase(id, parsed)
      setSavedKb(id)
      setTimeout(() => setSavedKb(null), 2000)
      const props = await apiGetProperties()
      setProperties(props)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSavingKb(null)
    }
  }

  function handleKbUpdate(updated: ApiKnowledgeSuggestion) {
    setKbSuggestions(prev => prev.map(s => s.id === updated.id ? updated : s))
  }

  function handleKbDelete(id: string) {
    setKbSuggestions(prev => prev.filter(s => s.id !== id))
  }

  async function handleAddManual() {
    const newEntry = await apiCreateKnowledgeSuggestion({ question: '', answer: '' })
    setKbSuggestions(prev => [...prev, newEntry])
  }

  const isRunning = syncing || (progress && progress.phase !== 'idle' && progress.phase !== 'done' && progress.phase !== 'error')
  const pct = progress && progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0
  const planColor: Record<string, string> = { FREE: '#6B7280', PRO: '#2563EB', SCALE: '#7C3AED' }

  function formatSyncTime(iso: string | null | undefined) {
    if (!iso) return null
    const d = new Date(iso)
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: '#fff' }}>
      {/* Header */}
      <div
        className="flex items-center px-6 shrink-0"
        style={{ height: 44, borderBottom: '1px solid var(--border)' }}
      >
        <span className="text-[13px] font-semibold" style={{ color: 'var(--brown-dark)' }}>
          Settings
        </span>
      </div>

      <div className="flex flex-col gap-6 px-6 py-5">

        {/* Account */}
        <Section title="Account">
          <Row label="Email" value={meta?.email ?? '—'} />
          <Row
            label="Plan"
            value={
              <span
                className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider"
                style={{ background: `${planColor[meta?.plan ?? 'FREE']}18`, color: planColor[meta?.plan ?? 'FREE'] }}
              >
                {meta?.plan ?? 'FREE'}
              </span>
            }
          />
          <Row label="Tenant ID" value={<code className="text-[11px]">{meta?.tenantId ?? '—'}</code>} />
        </Section>

        {/* Webhook */}
        <Section title="Hostaway Webhook">
          <p className="text-[11px] mb-3" style={{ color: 'var(--muted-foreground)' }}>
            Paste this URL in Hostaway → Settings → Webhooks to receive real-time message events.
          </p>
          <div
            className="flex items-center gap-2 rounded-lg px-3 py-2"
            style={{ background: 'var(--muted)', border: '1px solid var(--border)' }}
          >
            <code className="flex-1 text-[11px] truncate" style={{ color: 'var(--brown-dark)' }}>
              {meta?.webhookUrl ?? 'Not available'}
            </code>
            <button
              onClick={copyWebhook}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors"
              style={{ background: copied ? '#F0FDF4' : '#fff', color: copied ? '#15803D' : 'var(--muted-foreground)', border: '1px solid var(--border)' }}
            >
              {copied ? <Check size={11} /> : <Copy size={11} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </Section>

        {/* Data Sync */}
        <Section title="Data Sync">
          {/* Last synced */}
          {progress?.lastSyncedAt && (
            <p className="text-[11px] mb-3" style={{ color: 'var(--muted-foreground)' }}>
              Last synced: <span style={{ color: 'var(--brown-dark)', fontWeight: 500 }}>{formatSyncTime(progress.lastSyncedAt)}</span>
            </p>
          )}

          <p className="text-[11px] mb-3" style={{ color: 'var(--muted-foreground)' }}>
            Full sync clears all data and re-imports everything. Listings sync updates property info only.
          </p>

          {/* Buttons */}
          <div className="flex gap-2 mb-4">
            <button
              onClick={() => runSync(false)}
              disabled={!!isRunning}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-[12px] font-medium transition-opacity"
              style={{ background: 'var(--terracotta)', color: '#fff', opacity: isRunning ? 0.6 : 1 }}
            >
              <RefreshCw size={13} className={isRunning && !syncing ? '' : syncing ? 'animate-spin' : ''} />
              {syncing && progress?.phase !== 'idle' ? 'Syncing…' : 'Full Sync'}
            </button>
            <button
              onClick={() => runSync(true)}
              disabled={!!isRunning}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-[12px] font-medium transition-opacity"
              style={{ background: 'var(--muted)', color: 'var(--brown-dark)', border: '1px solid var(--border)', opacity: isRunning ? 0.6 : 1 }}
            >
              <RefreshCw size={13} />
              Sync Listings Only
            </button>
          </div>

          {/* Progress */}
          {progress && progress.phase !== 'idle' && (
            <div className="flex flex-col gap-2">
              {/* Phase label + count */}
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium" style={{ color: progress.phase === 'error' ? '#DC2626' : 'var(--brown-dark)' }}>
                  {PHASE_LABEL[progress.phase]}
                </span>
                {progress.total > 0 && (
                  <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                    {progress.completed} / {progress.total}
                  </span>
                )}
              </div>

              {/* Progress bar */}
              {progress.phase !== 'error' && (
                <div className="w-full rounded-full overflow-hidden" style={{ height: 6, background: 'var(--muted)' }}>
                  <div
                    className="h-full rounded-full transition-all duration-300"
                    style={{
                      width: progress.phase === 'done' ? '100%'
                        : progress.phase === 'deleting' || progress.phase === 'listings' || progress.phase === 'reservations' ? '15%'
                        : `${Math.max(5, pct)}%`,
                      background: progress.phase === 'done' ? '#22C55E' : 'var(--terracotta)',
                    }}
                  />
                </div>
              )}

              {/* Message */}
              <p className="text-[10px]" style={{ color: progress.phase === 'error' ? '#DC2626' : 'var(--muted-foreground)' }}>
                {progress.message}
              </p>
            </div>
          )}
        </Section>

        {/* AI Autopilot */}
        <Section title="AI Autopilot">
          <p className="text-[11px] mb-3" style={{ color: 'var(--muted-foreground)' }}>
            Enable or disable AI autopilot for all active reservations at once.
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => handleAIToggleAll(true)}
              disabled={!!togglingAI}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-[12px] font-medium transition-opacity"
              style={{ background: '#DCFCE7', color: '#15803D', opacity: togglingAI ? 0.6 : 1 }}
            >
              {togglingAI === 'on' ? 'Enabling…' : aiToggleDone === 'on' ? '✓ All AI Enabled' : 'Enable All AI'}
            </button>
            <button
              onClick={() => handleAIToggleAll(false)}
              disabled={!!togglingAI}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-[12px] font-medium transition-opacity"
              style={{ background: '#FEE2E2', color: '#DC2626', opacity: togglingAI ? 0.6 : 1 }}
            >
              {togglingAI === 'off' ? 'Disabling…' : aiToggleDone === 'off' ? '✓ All AI Disabled' : 'Disable All AI'}
            </button>
          </div>
        </Section>

        {/* Danger zone */}
        <Section title="Danger Zone">
          <p className="text-[11px] mb-3" style={{ color: 'var(--muted-foreground)' }}>
            Permanently delete all conversations, messages, reservations, and properties from GuestPilot.
          </p>
          {!showDeleteConfirm ? (
            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-[12px] font-medium"
              style={{ background: '#FEF2F2', color: '#DC2626', border: '1px solid #FECACA' }}
            >
              <Trash2 size={13} />
              Delete Everything
            </button>
          ) : (
            <div className="flex flex-col gap-2 p-3 rounded-lg" style={{ background: '#FEF2F2', border: '1px solid #FECACA' }}>
              <div className="flex items-center gap-2">
                <AlertTriangle size={13} style={{ color: '#DC2626' }} />
                <span className="text-[11px] font-semibold" style={{ color: '#DC2626' }}>
                  This will delete all your data. Are you sure?
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  className="px-3 py-1.5 rounded-lg text-[11px] font-semibold text-white transition-opacity"
                  style={{ background: '#DC2626', opacity: deleting ? 0.6 : 1 }}
                >
                  {deleting ? 'Deleting…' : 'Yes, delete everything'}
                </button>
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  className="px-3 py-1.5 rounded-lg text-[11px] font-medium"
                  style={{ background: '#fff', color: 'var(--brown-dark)', border: '1px solid var(--border)' }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </Section>

        {/* Message Templates */}
        <Section title="Message Templates">
          <p className="text-[11px] mb-3" style={{ color: 'var(--muted-foreground)' }}>
            Automated messages synced from Hostaway. Edit here to customize, or enhance with AI.
          </p>
          {templates.length === 0 ? (
            <p className="text-[11px]" style={{ color: 'var(--muted-foreground)', fontStyle: 'italic' }}>
              No templates yet. Run a sync to import automated messages from Hostaway.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {templates.map(t => (
                <TemplateCard
                  key={t.id}
                  template={t}
                  onUpdate={(updated) => setTemplates(prev => prev.map(x => x.id === updated.id ? updated : x))}
                />
              ))}
            </div>
          )}
        </Section>

        {/* Knowledge Base */}
        <Section title="Knowledge Base">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <p className="text-[11px]" style={{ color: 'var(--muted-foreground)', margin: 0 }}>
              Q&amp;A pairs injected into AI context to improve responses.
            </p>
            {kbTab === 'approved' && (
              <button
                onClick={handleAddManual}
                style={{ fontSize: 12, padding: '5px 12px', borderRadius: 6, border: 'none', background: 'var(--terracotta)', color: '#fff', cursor: 'pointer' }}
              >
                + Add Q&amp;A
              </button>
            )}
          </div>
          {/* Tab bar */}
          <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)', marginBottom: 16 }}>
            {(['pending', 'approved'] as const).map(tab => {
              const count = kbSuggestions.filter(s => s.status === tab).length
              return (
                <button
                  key={tab}
                  onClick={() => setKbTab(tab)}
                  style={{
                    padding: '6px 14px', fontSize: 13, fontWeight: kbTab === tab ? 600 : 400,
                    border: 'none', background: 'none', cursor: 'pointer',
                    color: kbTab === tab ? 'var(--terracotta)' : 'var(--muted-foreground)',
                    borderBottom: kbTab === tab ? '2px solid var(--terracotta)' : '2px solid transparent',
                    marginBottom: -1,
                  }}
                >
                  {tab.charAt(0).toUpperCase() + tab.slice(1)}{count > 0 ? ` (${count})` : ''}
                </button>
              )
            })}
          </div>
          {/* Content */}
          {kbTab === 'pending' && (
            <KbPendingList
              suggestions={kbSuggestions.filter(s => s.status === 'pending')}
              onUpdate={handleKbUpdate}
            />
          )}
          {kbTab === 'approved' && (
            <KbApprovedList
              suggestions={kbSuggestions.filter(s => s.status === 'approved')}
              onUpdate={handleKbUpdate}
              onDelete={handleKbDelete}
            />
          )}
        </Section>

        {/* Properties */}
        <Section title="Properties">
          {properties.length === 0 ? (
            <p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              No properties yet. Run a sync first.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {properties.map(prop => (
                <div key={prop.id} className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--border)' }}>
                  <button
                    className="w-full flex items-center justify-between px-4 py-2.5 text-left transition-colors hover:bg-[var(--muted)]"
                    onClick={() => toggleProp(prop.id, prop)}
                  >
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[12px] font-semibold" style={{ color: 'var(--brown-dark)' }}>{prop.name}</span>
                      {prop.address && (
                        <span className="text-[10px]" style={{ color: 'var(--muted-foreground)' }}>{prop.address}</span>
                      )}
                    </div>
                    {expandedProp === prop.id ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  </button>

                  {expandedProp === prop.id && (
                    <div className="px-4 pb-4 pt-1" style={{ borderTop: '1px solid var(--border)', background: 'var(--muted)' }}>
                      <p className="text-[10px] mb-2 mt-2" style={{ color: 'var(--muted-foreground)' }}>
                        Knowledge base (JSON) — the AI uses this when answering guest questions.
                      </p>
                      <textarea
                        value={kbDraft[prop.id] ?? '{}'}
                        onChange={e => setKbDraft(prev => ({ ...prev, [prop.id]: e.target.value }))}
                        rows={10}
                        className="w-full rounded-lg px-3 py-2 text-[11px] font-mono outline-none resize-y"
                        style={{ background: '#fff', border: '1px solid var(--border)', color: 'var(--brown-dark)', lineHeight: 1.6 }}
                      />
                      <div className="flex justify-end mt-2">
                        <button
                          onClick={() => saveKb(prop.id)}
                          disabled={savingKb === prop.id}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium transition-opacity"
                          style={{ background: savedKb === prop.id ? '#22C55E' : 'var(--terracotta)', color: '#fff', opacity: savingKb === prop.id ? 0.6 : 1 }}
                        >
                          {savedKb === prop.id ? <Check size={11} /> : null}
                          {savingKb === prop.id ? 'Saving…' : savedKb === prop.id ? 'Saved' : 'Save'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-[10px] font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--muted-foreground)' }}>
        {title}
      </h3>
      {children}
    </div>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-2" style={{ borderBottom: '1px solid var(--border)' }}>
      <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{label}</span>
      <span className="text-[11px] font-medium" style={{ color: 'var(--brown-dark)' }}>{value}</span>
    </div>
  )
}

// ── Template Card ─────────────────────────────────────────────────────────────
function TemplateCard({ template, onUpdate }: { template: ApiMessageTemplate; onUpdate: (t: ApiMessageTemplate) => void }) {
  const [editing, setEditing] = useState(false)
  const [editBody, setEditBody] = useState(template.enhancedBody || template.body)
  const [enhancing, setEnhancing] = useState(false)
  const [saving, setSaving] = useState(false)

  const triggerLabel = template.triggerOffset !== undefined && template.triggerOffset !== null && template.triggerType
    ? `${Math.abs(template.triggerOffset)}h ${template.triggerOffset < 0 ? 'before' : 'after'} ${template.triggerType.replace(/_/g, ' ')}`
    : template.triggerType?.replace(/_/g, ' ') || 'Manual'

  const handleSave = async () => {
    setSaving(true)
    const updated = await apiUpdateTemplate(template.id, { enhancedBody: editBody })
    onUpdate(updated)
    setSaving(false)
    setEditing(false)
  }

  const handleEnhance = async () => {
    setEnhancing(true)
    const updated = await apiEnhanceTemplate(template.id)
    onUpdate(updated)
    setEditBody(updated.enhancedBody || updated.body)
    setEnhancing(false)
  }

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <div>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--brown-dark)' }}>{template.name}</span>
          <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--muted-foreground)', background: 'var(--muted)', borderRadius: 4, padding: '2px 6px' }}>{triggerLabel}</span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {!editing && (
            <button onClick={() => setEditing(true)} style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--card)', cursor: 'pointer', color: 'var(--brown-dark)' }}>Edit</button>
          )}
          <button
            onClick={handleEnhance}
            disabled={enhancing}
            style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6, border: 'none', background: 'var(--terracotta)', color: '#fff', cursor: 'pointer', opacity: enhancing ? 0.6 : 1 }}
          >
            {enhancing ? '…' : '✨ Enhance'}
          </button>
        </div>
      </div>
      {editing ? (
        <>
          <textarea
            value={editBody}
            onChange={e => setEditBody(e.target.value)}
            rows={5}
            style={{ width: '100%', fontSize: 12, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6, fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box', background: 'var(--background)', color: 'var(--foreground)' }}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 6, justifyContent: 'flex-end' }}>
            <button onClick={() => { setEditing(false); setEditBody(template.enhancedBody || template.body) }} style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--card)', cursor: 'pointer', color: 'var(--muted-foreground)' }}>Cancel</button>
            <button onClick={handleSave} disabled={saving} style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6, border: 'none', background: 'var(--terracotta)', color: '#fff', cursor: 'pointer', opacity: saving ? 0.6 : 1 }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </>
      ) : (
        <p style={{ fontSize: 12, color: 'var(--muted-foreground)', margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
          {template.enhancedBody || template.body}
        </p>
      )}
      {template.enhancedBody && (
        <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 10, color: '#16a34a', fontWeight: 600 }}>✓ AI Enhanced</span>
          <button
            onClick={() => { setEditBody(template.body); apiUpdateTemplate(template.id, { enhancedBody: '' }).then(onUpdate) }}
            style={{ fontSize: 10, color: 'var(--muted-foreground)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
          >Reset to original</button>
        </div>
      )}
    </div>
  )
}

// ── Knowledge Base sub-components ─────────────────────────────────────────────
function KbPendingList({ suggestions, onUpdate }: { suggestions: ApiKnowledgeSuggestion[]; onUpdate: (s: ApiKnowledgeSuggestion) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>(() => Object.fromEntries(suggestions.map(s => [s.id, s.answer])))
  const [loading, setLoading] = useState<Record<string, 'approve' | 'reject' | null>>({})

  if (suggestions.length === 0) {
    return <p style={{ fontSize: 12, color: 'var(--muted-foreground)', fontStyle: 'italic' }}>No pending suggestions.</p>
  }

  async function handleAction(id: string, action: 'approve' | 'reject') {
    setLoading(l => ({ ...l, [id]: action }))
    const status = action === 'approve' ? 'approved' : 'rejected'
    const updated = await apiUpdateKnowledgeSuggestion(id, { status, answer: answers[id] ?? '' })
    onUpdate(updated)
    setLoading(l => ({ ...l, [id]: null }))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {suggestions.map(s => (
        <div key={s.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
          <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--brown-dark)', marginBottom: 6, marginTop: 0 }}>{s.question}</p>
          <textarea
            value={answers[s.id] ?? s.answer}
            onChange={e => setAnswers(prev => ({ ...prev, [s.id]: e.target.value }))}
            rows={3}
            style={{ width: '100%', fontSize: 12, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6, fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box', background: 'var(--background)', color: 'var(--foreground)', marginBottom: 8 }}
          />
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button
              onClick={() => handleAction(s.id, 'reject')}
              disabled={!!loading[s.id]}
              style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--muted-foreground)', cursor: 'pointer', opacity: loading[s.id] ? 0.6 : 1 }}
            >
              {loading[s.id] === 'reject' ? 'Rejecting…' : 'Reject'}
            </button>
            <button
              onClick={() => handleAction(s.id, 'approve')}
              disabled={!!loading[s.id]}
              style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6, border: 'none', background: 'var(--terracotta)', color: '#fff', cursor: 'pointer', opacity: loading[s.id] ? 0.6 : 1 }}
            >
              {loading[s.id] === 'approve' ? 'Approving…' : 'Approve'}
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

function KbApprovedList({ suggestions, onUpdate, onDelete }: { suggestions: ApiKnowledgeSuggestion[]; onUpdate: (s: ApiKnowledgeSuggestion) => void; onDelete: (id: string) => void }) {
  const [editAnswers, setEditAnswers] = useState<Record<string, string>>(() => Object.fromEntries(suggestions.map(s => [s.id, s.answer])))
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [deleting, setDeleting] = useState<Record<string, boolean>>({})

  if (suggestions.length === 0) {
    return <p style={{ fontSize: 12, color: 'var(--muted-foreground)', fontStyle: 'italic' }}>No approved entries. Add Q&amp;A pairs or approve pending suggestions.</p>
  }

  async function handleSave(id: string) {
    setSaving(s => ({ ...s, [id]: true }))
    const updated = await apiUpdateKnowledgeSuggestion(id, { answer: editAnswers[id] ?? '' })
    onUpdate(updated)
    setSaving(s => ({ ...s, [id]: false }))
  }

  async function handleDelete(id: string) {
    setDeleting(d => ({ ...d, [id]: true }))
    await apiDeleteKnowledgeSuggestion(id)
    onDelete(id)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {suggestions.map(s => (
        <div key={s.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
            <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--brown-dark)', margin: 0 }}>{s.question || '(no question)'}</p>
            <button
              onClick={() => handleDelete(s.id)}
              disabled={deleting[s.id]}
              style={{ fontSize: 11, padding: '2px 8px', borderRadius: 5, border: '1px solid #FECACA', background: '#FEF2F2', color: '#DC2626', cursor: 'pointer', opacity: deleting[s.id] ? 0.6 : 1 }}
            >
              Delete
            </button>
          </div>
          <textarea
            value={editAnswers[s.id] ?? s.answer}
            onChange={e => setEditAnswers(prev => ({ ...prev, [s.id]: e.target.value }))}
            rows={3}
            style={{ width: '100%', fontSize: 12, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6, fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box', background: 'var(--background)', color: 'var(--foreground)', marginBottom: 6 }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button
              onClick={() => handleSave(s.id)}
              disabled={saving[s.id]}
              style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6, border: 'none', background: 'var(--terracotta)', color: '#fff', cursor: 'pointer', opacity: saving[s.id] ? 0.6 : 1 }}
            >
              {saving[s.id] ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
