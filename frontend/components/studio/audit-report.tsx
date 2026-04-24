'use client'

/**
 * Sprint 046 Session B — Audit Report card.
 *
 * Renders a `data-audit-report` SSE part: compact status rows (one per
 * artifact checked, not one per finding), plus a "Fix" primary CTA on
 * the row that matches `topFindingId`. Status dots are pure colour,
 * never emoji (Response Contract rule 6).
 */
import { STUDIO_COLORS, STUDIO_STATUS_DOT, STUDIO_TOKENS_V2, attributedStyle, type StudioStatus } from './tokens'

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
        border: `1px solid ${STUDIO_TOKENS_V2.border}`,
        borderRadius: STUDIO_TOKENS_V2.radiusLg,
        background: STUDIO_TOKENS_V2.bg,
        marginTop: 8,
        overflow: 'hidden',
        boxShadow: STUDIO_TOKENS_V2.shadowSm,
      }}
    >
      {/* Sprint 046 — audit report restyle per operator screenshot:
         more generous padding, larger headings and description type,
         taller View / Fix buttons with v2 tokens. */}
      <header
        style={{
          padding: '16px 20px',
          borderBottom: `1px solid ${STUDIO_TOKENS_V2.border}`,
          display: 'flex',
          alignItems: 'center',
          gap: 20,
        }}
      >
        <span
          style={{
            color: STUDIO_TOKENS_V2.ink,
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            flexShrink: 0,
          }}
        >
          Audit report
        </span>
        {props.summary && (
          <span
            style={{
              fontSize: 14,
              fontWeight: 400,
              color: STUDIO_TOKENS_V2.ink2,
              lineHeight: 1.4,
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
                alignItems: 'flex-start',
                gap: 14,
                padding: '18px 20px',
                borderTop: `1px solid ${STUDIO_TOKENS_V2.border}`,
              }}
            >
              <span
                title={STATUS_LABEL[row.status]}
                aria-label={STATUS_LABEL[row.status]}
                style={{
                  width: 10,
                  height: 10,
                  marginTop: 6,
                  borderRadius: '50%',
                  background: STUDIO_STATUS_DOT[row.status],
                  flexShrink: 0,
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'baseline',
                    flexWrap: 'wrap',
                  }}
                >
                  <span
                    style={{
                      color: STUDIO_TOKENS_V2.ink,
                      fontSize: 15,
                      fontWeight: 600,
                      letterSpacing: '-0.005em',
                    }}
                  >
                    {row.label}
                  </span>
                  <span
                    title={row.artifact}
                    style={{
                      color: STUDIO_TOKENS_V2.muted2,
                      fontSize: 13,
                      fontWeight: 400,
                    }}
                  >
                    {ARTIFACT_LABEL[row.artifact] ?? row.artifact}
                  </span>
                </div>
                <div
                  style={{
                    color: STUDIO_TOKENS_V2.ink2,
                    fontSize: 14,
                    lineHeight: 1.5,
                    marginTop: 4,
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
                    padding: '9px 18px',
                    fontSize: 13,
                    fontWeight: 500,
                    border: '1px solid transparent',
                    background: STUDIO_TOKENS_V2.blue,
                    color: '#FFFFFF',
                    borderRadius: STUDIO_TOKENS_V2.radiusMd,
                    cursor: props.onFixTopFinding ? 'pointer' : 'default',
                    flexShrink: 0,
                    marginTop: 2,
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
                    padding: '9px 18px',
                    fontSize: 13,
                    fontWeight: 500,
                    border: `1px solid ${STUDIO_TOKENS_V2.border}`,
                    background: STUDIO_TOKENS_V2.bg,
                    color: STUDIO_TOKENS_V2.ink2,
                    borderRadius: STUDIO_TOKENS_V2.radiusMd,
                    cursor: props.onViewRow ? 'pointer' : 'default',
                    flexShrink: 0,
                    marginTop: 2,
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
