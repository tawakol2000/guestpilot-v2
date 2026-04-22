'use client'

/**
 * Sprint 046 Session B — State Snapshot card (right rail).
 *
 * Renders the Session-A forced-first-turn `data-state-snapshot`
 * payload. Shape matches what `buildCurrentStatePayload(scope:'summary')`
 * returns — the server-side shape lives in
 * `backend/src/services/tenant-state.service.ts#TenantStateSummary`.
 */
import { STUDIO_COLORS } from './tokens'

export interface StateSnapshotSummary {
  posture: 'GREENFIELD' | 'BROWNFIELD'
  systemPromptStatus: 'EMPTY' | 'DEFAULT' | 'CUSTOMISED'
  systemPromptEditCount: number
  sopsDefined: number
  sopsDefaulted: number
  faqsGlobal: number
  faqsPropertyScoped: number
  customToolsDefined: number
  propertiesImported: number
  lastBuildSessionAt: string | null
}

export interface StateSnapshotData {
  scope: 'summary'
  summary: StateSnapshotSummary
}

export interface StateSnapshotCardProps {
  data: StateSnapshotData
  /** Deep-link into the pending-suggestions queue (Session C). */
  onOpenPending?: () => void
}

function formatRelativeDay(iso: string | null): string {
  if (!iso) return 'never'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return iso
  const hours = Math.max(0, (Date.now() - then) / 3_600_000)
  if (hours < 1) return 'just now'
  if (hours < 24) return `${Math.round(hours)}h ago`
  const days = Math.round(hours / 24)
  if (days < 14) return `${days}d ago`
  const weeks = Math.round(days / 7)
  return `${weeks}w ago`
}

export function StateSnapshotCard(props: StateSnapshotCardProps) {
  const s = props.data.summary
  const faqTotal = s.faqsGlobal + s.faqsPropertyScoped
  const promptBadge =
    s.systemPromptStatus === 'CUSTOMISED'
      ? { label: 'Customised', fg: STUDIO_COLORS.successFg }
      : s.systemPromptStatus === 'DEFAULT'
        ? { label: 'Default', fg: STUDIO_COLORS.inkMuted }
        : { label: 'Empty', fg: STUDIO_COLORS.dangerFg }

  return (
    <aside
      data-studio-card="state-snapshot"
      style={{
        border: `1px solid ${STUDIO_COLORS.hairline}`,
        borderRadius: 8,
        background: STUDIO_COLORS.surfaceRaised,
        padding: 14,
        minWidth: 260,
      }}
    >
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 10,
        }}
      >
        <span
          style={{
            color: STUDIO_COLORS.ink,
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0.3,
            textTransform: 'uppercase',
          }}
        >
          Current state
        </span>
        <span
          style={{
            padding: '1px 7px',
            fontSize: 10,
            fontWeight: 600,
            borderRadius: 3,
            letterSpacing: 0.2,
            background: STUDIO_COLORS.surfaceSunken,
            color: STUDIO_COLORS.inkMuted,
          }}
        >
          {s.posture === 'GREENFIELD' ? 'SETUP' : 'LIVE'}
        </span>
      </header>

      <Row
        label="System prompt"
        value={promptBadge.label}
        valueColor={promptBadge.fg}
        sub={s.systemPromptEditCount > 0 ? `${s.systemPromptEditCount} edits` : undefined}
      />
      <Row
        label="SOPs"
        value={String(s.sopsDefined)}
        sub={s.sopsDefaulted > 0 ? `${s.sopsDefaulted} defaulted` : undefined}
      />
      <Row
        label="FAQs"
        value={String(faqTotal)}
        sub={`${s.faqsGlobal} global, ${s.faqsPropertyScoped} property-scoped`}
      />
      <Row label="Custom tools" value={String(s.customToolsDefined)} />
      <Row label="Properties" value={String(s.propertiesImported)} />
      <Row label="Last session" value={formatRelativeDay(s.lastBuildSessionAt)} />

      {props.onOpenPending && (
        <button
          type="button"
          onClick={props.onOpenPending}
          style={{
            marginTop: 12,
            width: '100%',
            padding: '7px 10px',
            fontSize: 12,
            fontWeight: 500,
            border: `1px solid ${STUDIO_COLORS.hairline}`,
            borderRadius: 6,
            background: STUDIO_COLORS.surfaceRaised,
            color: STUDIO_COLORS.ink,
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          Open pending suggestions →
        </button>
      )}
    </aside>
  )
}

function Row({
  label,
  value,
  valueColor,
  sub,
}: {
  label: string
  value: string
  valueColor?: string
  sub?: string
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        padding: '5px 0',
        borderBottom: `1px solid ${STUDIO_COLORS.hairlineSoft}`,
      }}
    >
      <span style={{ color: STUDIO_COLORS.inkMuted, fontSize: 12 }}>{label}</span>
      <span style={{ textAlign: 'right' }}>
        <span
          style={{
            color: valueColor ?? STUDIO_COLORS.ink,
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {value}
        </span>
        {sub && (
          <span
            style={{
              display: 'block',
              color: STUDIO_COLORS.inkSubtle,
              fontSize: 11,
              marginTop: 1,
            }}
          >
            {sub}
          </span>
        )}
      </span>
    </div>
  )
}
