'use client'

/**
 * Sprint 053-A D4 — Write-ledger right-rail card.
 *
 * Shows up to 10 rows from the BuildArtifactHistory table, scoped to
 * the current conversation when available. Admin-only (parent decides
 * render; we render nothing under non-admin callers via the `visible`
 * prop — keeps the card consistent with the raw-prompt-editor / trace
 * view visibility rules).
 *
 * Each row: type icon + operation + artifact label + actor + relative
 * timestamp. Clicking a row opens the ArtifactDrawer in history-view
 * mode (displayed body = newBody, prev = prevBody). UPDATE rows expose
 * a Revert link; CREATE rows do NOT (revert-of-CREATE would be a
 * delete, parked for 054-A).
 */
import { useEffect, useState } from 'react'
import {
  BookOpen,
  FileText,
  MessageSquare,
  Settings,
  Home,
  RotateCcw,
  Plus,
  Pencil,
} from 'lucide-react'
import { STUDIO_COLORS } from './tokens'
import {
  apiListBuildArtifactHistory,
  type BuildArtifactHistoryRow,
  type BuildArtifactType,
} from '@/lib/build-api'

export interface WriteLedgerCardProps {
  visible: boolean
  conversationId: string | null
  /** Refresh token — bump to force a re-fetch (e.g. after Apply/Revert). */
  refreshKey?: number
  onOpenRow?: (row: BuildArtifactHistoryRow) => void
  onRevertRow?: (row: BuildArtifactHistoryRow) => void
}

const TYPE_ICON: Record<string, typeof BookOpen> = {
  sop: BookOpen,
  faq: MessageSquare,
  system_prompt: FileText,
  tool: Settings,
  tool_definition: Settings,
  property_override: Home,
}

const TYPE_LABEL: Record<string, string> = {
  sop: 'SOP',
  faq: 'FAQ',
  system_prompt: 'Prompt',
  tool: 'Tool',
  tool_definition: 'Tool',
  property_override: 'Property',
}

const OPERATION_ICON = {
  CREATE: Plus,
  UPDATE: Pencil,
  DELETE: RotateCcw,
  REVERT: RotateCcw,
} as const

export function WriteLedgerCard(props: WriteLedgerCardProps) {
  const { visible, conversationId, refreshKey, onOpenRow, onRevertRow } = props
  const [rows, setRows] = useState<BuildArtifactHistoryRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    setLoading(true)
    setError(null)
    apiListBuildArtifactHistory({
      conversationId: conversationId ?? undefined,
      limit: 10,
    })
      .then((page) => {
        if (cancelled) return
        setRows(page.rows)
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
  }, [visible, conversationId, refreshKey])

  if (!visible) return null

  return (
    <div
      data-testid="write-ledger-card"
      className="rounded-md border bg-white p-3"
      style={{ borderColor: STUDIO_COLORS.hairline }}
    >
      <div
        className="mb-2 text-[11px] font-semibold uppercase tracking-wide"
        style={{ color: STUDIO_COLORS.inkMuted }}
      >
        Recent writes
      </div>
      {loading && rows.length === 0 ? (
        <div style={{ fontSize: 11.5, color: STUDIO_COLORS.inkSubtle }}>
          Loading…
        </div>
      ) : null}
      {error ? (
        <div
          role="alert"
          style={{
            fontSize: 11.5,
            color: STUDIO_COLORS.dangerFg,
          }}
        >
          {error}
        </div>
      ) : null}
      {!loading && !error && rows.length === 0 ? (
        <div
          data-testid="write-ledger-empty"
          style={{ fontSize: 11.5, color: STUDIO_COLORS.inkSubtle }}
        >
          No writes yet this session.
        </div>
      ) : null}
      <ul
        role="list"
        style={{
          listStyle: 'none',
          padding: 0,
          margin: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        {rows.map((row) => (
          <LedgerRow
            key={row.id}
            row={row}
            onOpen={() => onOpenRow && onOpenRow(row)}
            onRevert={() => onRevertRow && onRevertRow(row)}
          />
        ))}
      </ul>
    </div>
  )
}

function LedgerRow({
  row,
  onOpen,
  onRevert,
}: {
  row: BuildArtifactHistoryRow
  onOpen: () => void
  onRevert: () => void
}) {
  const TypeIcon = TYPE_ICON[row.artifactType] ?? BookOpen
  const OpIcon = OPERATION_ICON[row.operation] ?? Pencil
  const typeLabel = TYPE_LABEL[row.artifactType] ?? row.artifactType
  const opColor =
    row.operation === 'REVERT'
      ? STUDIO_COLORS.accent
      : row.operation === 'CREATE'
      ? STUDIO_COLORS.successFg
      : STUDIO_COLORS.ink
  return (
    <li
      data-testid="write-ledger-row"
      data-artifact-type={row.artifactType}
      data-operation={row.operation}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: 6,
        borderRadius: 5,
        border: `1px solid ${STUDIO_COLORS.hairlineSoft}`,
        background: STUDIO_COLORS.surfaceRaised,
      }}
    >
      <button
        type="button"
        aria-label={`Open ${typeLabel} ${row.operation}`}
        onClick={onOpen}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          background: 'transparent',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          width: '100%',
          textAlign: 'left',
          color: STUDIO_COLORS.ink,
        }}
      >
        <TypeIcon size={12} color={STUDIO_COLORS.inkMuted} />
        <OpIcon size={11} color={opColor} />
        <span style={{ fontSize: 11.5, fontWeight: 500 }}>
          {row.operation} {typeLabel}
        </span>
        <span
          style={{
            fontSize: 11,
            color: STUDIO_COLORS.inkSubtle,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          — {row.artifactId}
        </span>
      </button>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 10.5,
          color: STUDIO_COLORS.inkSubtle,
          paddingLeft: 20,
        }}
      >
        <span>{row.actorEmail ?? 'unknown'}</span>
        <span>·</span>
        <span>{formatRelative(row.createdAt)}</span>
        {row.operation === 'UPDATE' ? (
          <>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              aria-label={`Revert ${typeLabel} ${row.artifactId}`}
              onClick={onRevert}
              style={{
                background: 'transparent',
                border: 'none',
                color: STUDIO_COLORS.accent,
                fontSize: 10.5,
                fontWeight: 500,
                cursor: 'pointer',
                padding: 0,
                textDecoration: 'underline',
              }}
            >
              Revert
            </button>
          </>
        ) : null}
      </div>
    </li>
  )
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return iso
  const secs = Math.max(0, (Date.now() - then) / 1000)
  if (secs < 60) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  return `${days}d ago`
}

/** Convenience helper exposed for callers that want to narrow the ledger-
 * row artifactType to the drawer's BuildArtifactType (tool_definition → tool). */
export function ledgerArtifactType(
  t: BuildArtifactHistoryRow['artifactType'],
): BuildArtifactType {
  if (t === 'tool_definition') return 'tool'
  return t as BuildArtifactType
}
