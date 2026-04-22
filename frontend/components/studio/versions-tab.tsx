'use client'

/**
 * Sprint 058-A F3 + F6 + F7 — Versions tab for the artifact drawer.
 *
 * Compound surface: lists BuildArtifactHistory rows for this artifact,
 * lets the operator revert to any version (F3), tag versions with
 * short labels (F6), and diff any two versions (F7).
 *
 * Each gate's UI is isolated in its own sub-component so a crash in
 * one (e.g. the diff viewer) doesn't take down the whole tab — spec
 * §1 non-negotiables on graceful degradation.
 *
 * Not mounted: this file exports the tab body only. The parent
 * (artifact-drawer.tsx) owns the tab switcher chrome + the API call
 * to refresh the artifact after a revert.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Tag as TagIcon, X, ChevronRight } from 'lucide-react'
import { STUDIO_COLORS } from './tokens'
import { DiffBody } from './artifact-views/diff-body'
import {
  apiListBuildArtifactHistory,
  apiRevertToVersion,
  apiTagHistoryRow,
  apiUntagHistoryRow,
  type BuildArtifactHistoryRow,
  type BuildArtifactType,
} from '@/lib/build-api'

// Reuse the tag-label validation rule the backend enforces (max 40
// chars, alphanum + dash + underscore). Kept in sync with the server
// handler's regex; mismatched rules would surface as a 400 on submit.
const TAG_LABEL_PATTERN = /^[A-Za-z0-9_-]{1,40}$/

export interface VersionsTabProps {
  artifact: BuildArtifactType
  artifactId: string
  conversationId?: string | null
  /** Fired after a successful revert — parent refreshes the preview. */
  onReverted?: () => void
}

/**
 * Extract a body string from the stored newBody/prevBody JSON. Mirrors
 * the per-type shape handled by the apply layer. Used by the F7 diff
 * viewer + row "body preview" hover-expand.
 */
function extractBody(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return ''
  const b = raw as Record<string, unknown>
  if (typeof b.content === 'string') return b.content
  if (typeof b.text === 'string') return b.text
  if (typeof b.answer === 'string') return b.answer
  if (typeof b.description === 'string') return b.description
  return ''
}

export function VersionsTab({
  artifact,
  artifactId,
  onReverted,
}: VersionsTabProps) {
  const [rows, setRows] = useState<BuildArtifactHistoryRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Refresh key bumped after any mutation (revert / tag / untag) so the
  // list re-fetches without a manual reload.
  const [refreshKey, setRefreshKey] = useState(0)
  // F7 — two-row selection for A/B diff. Values are history ids. Third
  // click replaces the oldest entry (A overwrites, B slides to A).
  const [selected, setSelected] = useState<[string | null, string | null]>([null, null])
  const [diffOpen, setDiffOpen] = useState(false)
  // F6 — "Jump to tag" dropdown state. Stores the label we last jumped
  // to so the dropdown keeps its selection legible after the effect.
  const [jumpToTag, setJumpToTag] = useState<string>('')

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    // Pull a wide page so we can filter client-side — the rail already
    // pages on artifactId which the server does not, so this is a
    // forward-compat hook for a later server-side filter.
    apiListBuildArtifactHistory({ limit: 50 })
      .then((page) => {
        if (cancelled) return
        const filtered = page.rows.filter(
          (r) =>
            r.artifactId === artifactId &&
            // Map tool_definition → tool for the drawer's single view.
            (r.artifactType === artifact ||
              (artifact === 'tool' && r.artifactType === 'tool_definition')),
        )
        setRows(filtered)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [artifact, artifactId, refreshKey])

  // F7 — toggle a row in the selection pair. Third pick replaces the
  // oldest (shift A into a slot, B becomes new A, incoming becomes B).
  const toggleSelect = useCallback((id: string) => {
    setSelected(([a, b]) => {
      if (a === id) return [null, b]
      if (b === id) return [a, null]
      if (a === null) return [id, b]
      if (b === null) return [a, id]
      // Both slots full — B replaces A, incoming becomes new B.
      return [b, id]
    })
  }, [])

  const availableTags = useMemo(() => {
    const s = new Set<string>()
    for (const r of rows) {
      if (r.versionLabel) s.add(r.versionLabel)
    }
    return Array.from(s).sort()
  }, [rows])

  const onJumpToTag = useCallback(
    (label: string) => {
      setJumpToTag(label)
      if (!label) return
      const row = rows.find((r) => r.versionLabel === label)
      if (!row) return
      const el = document.querySelector<HTMLElement>(
        `[data-testid="versions-row"][data-history-id="${row.id}"]`,
      )
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    },
    [rows],
  )

  if (loading && rows.length === 0) {
    return (
      <div
        data-testid="versions-tab-loading"
        style={{ fontSize: 12, color: STUDIO_COLORS.inkSubtle, padding: 8 }}
      >
        Loading versions…
      </div>
    )
  }
  if (error) {
    return (
      <div
        data-testid="versions-tab-error"
        role="alert"
        style={{
          fontSize: 12,
          color: STUDIO_COLORS.dangerFg,
          background: STUDIO_COLORS.dangerBg,
          borderLeft: `2px solid ${STUDIO_COLORS.dangerFg}`,
          borderRadius: 5,
          padding: 8,
        }}
      >
        Failed to load versions: {error}
      </div>
    )
  }
  if (rows.length === 0) {
    return (
      <div
        data-testid="versions-tab-empty"
        style={{
          fontSize: 12,
          color: STUDIO_COLORS.inkSubtle,
          padding: 8,
          fontStyle: 'italic',
        }}
      >
        No prior versions for this artifact.
      </div>
    )
  }

  const [selA, selB] = selected
  const canDiff = Boolean(selA && selB && selA !== selB)

  return (
    <div
      data-testid="versions-tab"
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      {/* F7 — top action bar: jump-to-tag + diff button */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        {availableTags.length > 0 ? (
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 11,
              color: STUDIO_COLORS.inkMuted,
            }}
          >
            <span>Jump to tag:</span>
            <select
              data-testid="versions-jump-to-tag"
              value={jumpToTag}
              onChange={(e) => onJumpToTag(e.currentTarget.value)}
              style={{
                fontSize: 11.5,
                padding: '2px 4px',
                border: `1px solid ${STUDIO_COLORS.hairline}`,
                borderRadius: 4,
                background: STUDIO_COLORS.canvas,
              }}
            >
              <option value="">—</option>
              {availableTags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div style={{ flex: 1 }} />
        <button
          type="button"
          data-testid="versions-diff-button"
          disabled={!canDiff}
          onClick={() => canDiff && setDiffOpen(true)}
          style={{
            fontSize: 11.5,
            padding: '4px 10px',
            borderRadius: 5,
            border: `1px solid ${canDiff ? STUDIO_COLORS.accent : STUDIO_COLORS.hairline}`,
            background: canDiff ? STUDIO_COLORS.accent : 'transparent',
            color: canDiff ? '#fff' : STUDIO_COLORS.inkSubtle,
            cursor: canDiff ? 'pointer' : 'not-allowed',
          }}
        >
          Diff A → B
        </button>
      </div>

      {/* F3 — row list. Newest first: the API already orders desc. */}
      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        {rows.map((row, idx) => (
          <VersionRow
            key={row.id}
            row={row}
            isCurrent={idx === 0}
            selectedAs={selA === row.id ? 'A' : selB === row.id ? 'B' : null}
            onToggleSelect={() => toggleSelect(row.id)}
            onReverted={() => {
              refresh()
              onReverted?.()
            }}
            onTagged={refresh}
          />
        ))}
      </ul>

      {diffOpen && canDiff ? (
        <VersionDiffModal
          rowA={rows.find((r) => r.id === selA) ?? null}
          rowB={rows.find((r) => r.id === selB) ?? null}
          onClose={() => setDiffOpen(false)}
          onReverted={() => {
            setDiffOpen(false)
            refresh()
            onReverted?.()
          }}
          artifact={artifact}
        />
      ) : null}
    </div>
  )
}

/**
 * F3 + F6 — one version row. Timestamp, operation badge, rationale
 * excerpt, tag chip (click to remove), Tag button (click for inline
 * input), "Revert to this" button, and A/B checkboxes for F7.
 */
function VersionRow({
  row,
  isCurrent,
  selectedAs,
  onToggleSelect,
  onReverted,
  onTagged,
}: {
  row: BuildArtifactHistoryRow
  isCurrent: boolean
  selectedAs: 'A' | 'B' | null
  onToggleSelect: () => void
  onReverted: () => void
  onTagged: () => void
}) {
  const [reverting, setReverting] = useState(false)
  const [tagEditing, setTagEditing] = useState(false)
  const [tagDraft, setTagDraft] = useState<string>(row.versionLabel ?? '')
  const [tagError, setTagError] = useState<string | null>(null)
  const [tagSaving, setTagSaving] = useState(false)

  const rationale = extractRationaleExcerpt(row.metadata)

  async function handleRevertClick() {
    const proceed = window.confirm(
      `Revert to this version from ${formatTimestamp(row.createdAt)}? A new REVERT row will be written to the ledger.`,
    )
    if (!proceed) return
    setReverting(true)
    try {
      const res = await apiRevertToVersion(row.id, { dryRun: false })
      if (!res.ok) {
        alert(`Revert failed: ${res.error ?? 'unknown'}`)
        return
      }
      onReverted()
    } catch (err) {
      alert(`Revert error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setReverting(false)
    }
  }

  async function handleTagSave() {
    const label = tagDraft.trim()
    if (!label) {
      setTagError('Label required.')
      return
    }
    if (!TAG_LABEL_PATTERN.test(label)) {
      setTagError('Letters, numbers, _ and - only. Max 40.')
      return
    }
    setTagError(null)
    setTagSaving(true)
    try {
      await apiTagHistoryRow(row.id, label)
      setTagEditing(false)
      onTagged()
    } catch (err) {
      setTagError(err instanceof Error ? err.message : String(err))
    } finally {
      setTagSaving(false)
    }
  }

  async function handleRemoveTag() {
    try {
      await apiUntagHistoryRow(row.id)
      onTagged()
    } catch {
      /* silent — tag chip stays, operator can retry */
    }
  }

  return (
    <li
      data-testid="versions-row"
      data-history-id={row.id}
      data-operation={row.operation}
      data-selected-as={selectedAs ?? ''}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: 8,
        borderRadius: 5,
        border: `1px solid ${
          selectedAs ? STUDIO_COLORS.accent : STUDIO_COLORS.hairlineSoft
        }`,
        background: STUDIO_COLORS.surfaceRaised,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="checkbox"
          data-testid="versions-row-select"
          aria-label={`Select this version for diff`}
          checked={selectedAs !== null}
          onChange={onToggleSelect}
        />
        {selectedAs ? (
          <span
            data-testid="versions-row-slot"
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: STUDIO_COLORS.accent,
              border: `1px solid ${STUDIO_COLORS.accent}`,
              borderRadius: 3,
              padding: '0 4px',
              letterSpacing: 0.3,
            }}
          >
            {selectedAs}
          </span>
        ) : null}
        <span
          data-testid="versions-row-timestamp"
          style={{
            fontSize: 11,
            color: STUDIO_COLORS.inkMuted,
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          }}
          title={row.createdAt}
        >
          {formatTimestamp(row.createdAt)}
        </span>
        <span
          data-testid="versions-row-operation"
          style={{
            fontSize: 10,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.3,
            padding: '1px 6px',
            borderRadius: 3,
            background: opBg(row.operation),
            color: opFg(row.operation),
          }}
        >
          {row.operation}
        </span>
        {row.versionLabel ? (
          <TagChip
            label={row.versionLabel}
            onRemove={handleRemoveTag}
          />
        ) : null}
        {isCurrent ? (
          <span
            data-testid="versions-row-current"
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: STUDIO_COLORS.successFg,
              background: STUDIO_COLORS.successBg,
              borderRadius: 3,
              padding: '1px 6px',
              textTransform: 'uppercase',
              letterSpacing: 0.3,
            }}
          >
            Current
          </span>
        ) : null}
      </div>
      <div
        style={{
          fontSize: 11,
          color: STUDIO_COLORS.inkSubtle,
          paddingLeft: 22,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={rationale || undefined}
      >
        {rationale || <em>No rationale recorded.</em>}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          paddingLeft: 22,
        }}
      >
        {!tagEditing ? (
          <button
            type="button"
            data-testid="versions-row-tag-button"
            aria-label="Tag this version"
            onClick={() => {
              setTagDraft(row.versionLabel ?? '')
              setTagError(null)
              setTagEditing(true)
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              background: 'transparent',
              border: 'none',
              color: STUDIO_COLORS.inkSubtle,
              fontSize: 11,
              cursor: 'pointer',
              padding: 0,
            }}
          >
            <TagIcon size={11} />
            {row.versionLabel ? 'Retag' : 'Tag'}
          </button>
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <input
              type="text"
              data-testid="versions-row-tag-input"
              value={tagDraft}
              onChange={(e) => setTagDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void handleTagSave()
                } else if (e.key === 'Escape') {
                  setTagEditing(false)
                  setTagError(null)
                }
              }}
              maxLength={40}
              placeholder="stable"
              style={{
                fontSize: 11.5,
                padding: '2px 6px',
                border: `1px solid ${tagError ? STUDIO_COLORS.dangerFg : STUDIO_COLORS.hairline}`,
                borderRadius: 4,
                width: 140,
              }}
              autoFocus
            />
            <button
              type="button"
              data-testid="versions-row-tag-save"
              onClick={() => void handleTagSave()}
              disabled={tagSaving}
              style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 4,
                background: STUDIO_COLORS.accent,
                color: '#fff',
                border: 'none',
                cursor: tagSaving ? 'progress' : 'pointer',
              }}
            >
              Save
            </button>
            <button
              type="button"
              aria-label="Cancel tag edit"
              onClick={() => {
                setTagEditing(false)
                setTagError(null)
              }}
              style={{
                background: 'transparent',
                border: 'none',
                color: STUDIO_COLORS.inkSubtle,
                cursor: 'pointer',
                padding: 2,
              }}
            >
              <X size={11} />
            </button>
            {tagError ? (
              <span
                data-testid="versions-row-tag-error"
                style={{
                  fontSize: 10.5,
                  color: STUDIO_COLORS.dangerFg,
                }}
              >
                {tagError}
              </span>
            ) : null}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          data-testid="versions-row-revert"
          disabled={isCurrent || reverting}
          onClick={handleRevertClick}
          style={{
            fontSize: 11,
            padding: '3px 10px',
            borderRadius: 4,
            border: `1px solid ${STUDIO_COLORS.hairline}`,
            background: 'transparent',
            color: isCurrent ? STUDIO_COLORS.inkSubtle : STUDIO_COLORS.accent,
            cursor: isCurrent || reverting ? 'not-allowed' : 'pointer',
          }}
        >
          {reverting ? 'Reverting…' : 'Revert to this'}
        </button>
      </div>
    </li>
  )
}

function TagChip({
  label,
  onRemove,
}: {
  label: string
  onRemove: () => void
}) {
  return (
    <span
      data-testid="versions-row-tag-chip"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        fontSize: 10,
        fontWeight: 600,
        padding: '1px 6px',
        borderRadius: 3,
        background: '#EEF2FF',
        color: '#4338CA',
        letterSpacing: 0.2,
      }}
    >
      <TagIcon size={9} />
      {label}
      <button
        type="button"
        aria-label={`Remove tag ${label}`}
        onClick={onRemove}
        style={{
          background: 'transparent',
          border: 'none',
          color: '#4338CA',
          cursor: 'pointer',
          padding: 0,
          marginLeft: 2,
          display: 'inline-flex',
          alignItems: 'center',
        }}
      >
        <X size={9} />
      </button>
    </span>
  )
}

function VersionDiffModal({
  rowA,
  rowB,
  onClose,
  onReverted,
  artifact,
}: {
  rowA: BuildArtifactHistoryRow | null
  rowB: BuildArtifactHistoryRow | null
  onClose: () => void
  onReverted: () => void
  artifact: BuildArtifactType
}) {
  if (!rowA || !rowB) return null
  const bodyA = extractBody(rowA.newBody)
  const bodyB = extractBody(rowB.newBody)
  const mode = artifact === 'faq' ? 'token' : 'line'

  async function handleRevertTo(row: BuildArtifactHistoryRow) {
    const proceed = window.confirm(
      `Revert to version from ${formatTimestamp(row.createdAt)}?`,
    )
    if (!proceed) return
    try {
      const res = await apiRevertToVersion(row.id, { dryRun: false })
      if (!res.ok) {
        alert(`Revert failed: ${res.error ?? 'unknown'}`)
        return
      }
      onReverted()
    } catch (err) {
      alert(`Revert error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <div
      data-testid="versions-diff-modal"
      role="dialog"
      aria-label="Version diff"
      style={{
        position: 'absolute',
        inset: 0,
        background: STUDIO_COLORS.canvas,
        display: 'flex',
        flexDirection: 'column',
        zIndex: 10,
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          borderBottom: `1px solid ${STUDIO_COLORS.hairline}`,
        }}
      >
        <ChevronRight
          size={12}
          style={{ transform: 'rotate(180deg)', color: STUDIO_COLORS.inkMuted }}
          aria-hidden
        />
        <button
          type="button"
          data-testid="versions-diff-close"
          aria-label="Back to Versions tab"
          onClick={onClose}
          style={{
            fontSize: 12,
            background: 'transparent',
            border: 'none',
            color: STUDIO_COLORS.ink,
            cursor: 'pointer',
            padding: 0,
          }}
        >
          Back
        </button>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: STUDIO_COLORS.inkMuted }}>
          A {formatTimestamp(rowA.createdAt)} → B {formatTimestamp(rowB.createdAt)}
        </span>
      </header>
      <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        <DiffBody prev={bodyA} next={bodyB} mode={mode} />
      </div>
      <footer
        style={{
          display: 'flex',
          gap: 10,
          padding: 10,
          borderTop: `1px solid ${STUDIO_COLORS.hairline}`,
          background: STUDIO_COLORS.surfaceRaised,
          justifyContent: 'flex-end',
        }}
      >
        <button
          type="button"
          data-testid="versions-diff-revert-a"
          onClick={() => void handleRevertTo(rowA)}
          style={{
            fontSize: 12,
            padding: '5px 10px',
            borderRadius: 5,
            border: `1px solid ${STUDIO_COLORS.hairline}`,
            background: 'transparent',
            color: STUDIO_COLORS.accent,
            cursor: 'pointer',
          }}
        >
          Revert to A
        </button>
        <button
          type="button"
          data-testid="versions-diff-revert-b"
          onClick={() => void handleRevertTo(rowB)}
          style={{
            fontSize: 12,
            padding: '5px 10px',
            borderRadius: 5,
            border: `1px solid ${STUDIO_COLORS.hairline}`,
            background: 'transparent',
            color: STUDIO_COLORS.accent,
            cursor: 'pointer',
          }}
        >
          Revert to B
        </button>
      </footer>
    </div>
  )
}

// ─── helpers ────────────────────────────────────────────────────────────

function extractRationaleExcerpt(
  metadata: Record<string, unknown> | null | undefined,
): string {
  if (!metadata || typeof metadata !== 'object') return ''
  const m = metadata as Record<string, unknown>
  const raw =
    typeof m.rationale === 'string'
      ? m.rationale
      : typeof m.operatorRationale === 'string'
      ? m.operatorRationale
      : ''
  if (!raw) return ''
  if (raw.length <= 120) return raw
  return raw.slice(0, 117) + '…'
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const now = Date.now()
  const delta = Math.max(0, now - d.getTime())
  const mins = Math.round(delta / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  if (days < 14) return `${days}d ago`
  return d.toLocaleDateString()
}

function opBg(op: string): string {
  if (op === 'CREATE') return STUDIO_COLORS.successBg
  if (op === 'REVERT') return STUDIO_COLORS.warnBg
  if (op === 'DELETE') return STUDIO_COLORS.dangerBg
  return STUDIO_COLORS.surfaceSunken
}
function opFg(op: string): string {
  if (op === 'CREATE') return STUDIO_COLORS.successFg
  if (op === 'REVERT') return STUDIO_COLORS.warnFg
  if (op === 'DELETE') return STUDIO_COLORS.dangerFg
  return STUDIO_COLORS.inkMuted
}
