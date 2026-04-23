'use client'

/**
 * Sprint 046 Session B — Audit Report card.
 *
 * Renders a `data-audit-report` SSE part: compact status rows (one per
 * artifact checked, not one per finding), plus a "Fix" primary CTA on
 * the row that matches `topFindingId`. Status dots are pure colour,
 * never emoji (Response Contract rule 6).
 */
import { STUDIO_COLORS, STUDIO_STATUS_DOT, attributedStyle, type StudioStatus } from './tokens'

export interface AuditReportRowData {
  artifact: 'system_prompt' | 'sop' | 'faq' | 'tool_definition' | 'property'
  artifactId?: string
  label: string
  status: StudioStatus
  note: string
  findingId?: string
}

export interface AuditReportCardProps {
  rows: AuditReportRowData[]
  topFindingId: string | null
  summary?: string
  /** Scroll to / expand the paired suggested-fix card when the CTA fires. */
  onFixTopFinding?: (findingId: string) => void
  /** Drill-down into a single artifact's current state. */
  onViewRow?: (row: AuditReportRowData) => void
}

const STATUS_LABEL: Record<StudioStatus, string> = {
  ok: 'OK',
  warn: 'Warning',
  gap: 'Gap',
  danger: 'Danger',
  unknown: 'Unknown',
}

// Bugfix (2026-04-23): audit rows were rendering the raw enum value
// (`tool_definition`, `system_prompt`) in monospace, which reads as
// engineering slang to an operator scanning a report. Human-friendly
// labels aligned with the session-artifacts rail + the artifact-drawer.
const ARTIFACT_LABEL: Record<AuditReportRowData['artifact'], string> = {
  system_prompt: 'System prompt',
  sop: 'SOP',
  faq: 'FAQ',
  tool_definition: 'Tool',
  property: 'Property',
}

export function AuditReportCard(props: AuditReportCardProps) {
  return (
    <article
      data-studio-card="audit-report"
      style={{
        border: `1px solid ${STUDIO_COLORS.hairline}`,
        borderRadius: 8,
        background: STUDIO_COLORS.surfaceRaised,
        marginTop: 8,
        overflow: 'hidden',
      }}
    >
      <header
        style={{
          padding: '10px 14px',
          borderBottom: `1px solid ${STUDIO_COLORS.hairlineSoft}`,
          color: STUDIO_COLORS.ink,
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: 0.2,
          textTransform: 'uppercase',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span>Audit report</span>
        {props.summary && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 500,
              color: STUDIO_COLORS.inkMuted,
              textTransform: 'none',
              letterSpacing: 0,
            }}
          >
            {props.summary}
          </span>
        )}
      </header>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {props.rows.map((row, idx) => {
          const isTop =
            props.topFindingId !== null && row.findingId === props.topFindingId
          return (
            <li
              key={(row.findingId ?? row.artifactId ?? row.label) + ':' + idx}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 14px',
                borderTop:
                  idx === 0 ? 'none' : `1px solid ${STUDIO_COLORS.hairlineSoft}`,
              }}
            >
              <span
                title={STATUS_LABEL[row.status]}
                aria-label={STATUS_LABEL[row.status]}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: STUDIO_STATUS_DOT[row.status],
                  flexShrink: 0,
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    display: 'flex',
                    gap: 6,
                    alignItems: 'baseline',
                  }}
                >
                  <span
                    style={{
                      color: STUDIO_COLORS.ink,
                      fontSize: 13,
                      fontWeight: 600,
                    }}
                  >
                    {row.label}
                  </span>
                  <span
                    title={row.artifact}
                    style={{
                      color: STUDIO_COLORS.inkSubtle,
                      fontSize: 11,
                    }}
                  >
                    {ARTIFACT_LABEL[row.artifact] ?? row.artifact}
                  </span>
                </div>
                <div
                  style={{
                    ...attributedStyle('ai'),
                    fontSize: 12,
                    marginTop: 2,
                  }}
                >
                  {row.note}
                </div>
              </div>
              {isTop && props.topFindingId !== null && (
                <button
                  type="button"
                  onClick={() => props.onFixTopFinding?.(props.topFindingId!)}
                  style={{
                    padding: '5px 10px',
                    fontSize: 11,
                    fontWeight: 600,
                    border: '1px solid transparent',
                    background: STUDIO_COLORS.accent,
                    color: '#FFFFFF',
                    borderRadius: 5,
                    cursor: props.onFixTopFinding ? 'pointer' : 'default',
                  }}
                >
                  Fix
                </button>
              )}
              {!isTop && (
                <button
                  type="button"
                  onClick={() => props.onViewRow?.(row)}
                  style={{
                    padding: '5px 10px',
                    fontSize: 11,
                    fontWeight: 500,
                    border: `1px solid ${STUDIO_COLORS.hairline}`,
                    background: STUDIO_COLORS.surfaceRaised,
                    color: STUDIO_COLORS.inkMuted,
                    borderRadius: 5,
                    cursor: props.onViewRow ? 'pointer' : 'default',
                  }}
                >
                  View
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </article>
  )
}
