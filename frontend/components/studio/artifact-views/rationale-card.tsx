'use client'

/**
 * Sprint 054-A F2 — rationale card.
 *
 * Renders a history row's rationale in two surfaces:
 *   - the write-ledger rail (inline-expanded under the row)
 *   - the artifact drawer (header slot above the diff, history-view mode)
 *
 * Rationale text is rendered LITERALLY — never parsed as markdown. An
 * agent writing "# CRITICAL" or "**bold**" as a rationale stays as the
 * four literal characters. This is a sanity rail against formatting
 * prompt-injection into the ledger. See sprint-054-a spec §5 / F2 tests.
 *
 * When `rationale` is null/undefined/empty, renders the placeholder
 * "No rationale recorded" in the subtlest ink available. We keep the
 * card shape even for pre-F1 rows so the ledger doesn't visually
 * flicker when older entries come back from pagination.
 */
import { STUDIO_COLORS, attributedStyle } from '../tokens'

export interface RationaleCardProps {
  rationale: string | null | undefined
  /** 'rail' = ledger rail row expansion; 'drawer' = drawer header slot. */
  variant?: 'rail' | 'drawer'
  /** Sprint 055-A F4 — set when metadata.rationalePrefix === 'edited-by-operator'. */
  editedByOperator?: boolean
  /** Sprint 055-A F4 — operator's own free-text reason for the edit. */
  operatorRationale?: string | null
}

export function RationaleCard({
  rationale,
  variant = 'drawer',
  editedByOperator = false,
  operatorRationale,
}: RationaleCardProps) {
  const hasRationale =
    typeof rationale === 'string' && rationale.trim().length > 0
  const isRail = variant === 'rail'
  return (
    <div
      data-testid="rationale-card"
      data-variant={variant}
      data-has-rationale={hasRationale ? 'true' : 'false'}
      data-edited-by-operator={editedByOperator ? 'true' : 'false'}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: isRail ? '6px 4px 4px 20px' : '8px 10px',
        borderRadius: isRail ? 0 : 5,
        border: isRail
          ? 'none'
          : `1px solid ${STUDIO_COLORS.hairlineSoft}`,
        background: isRail ? 'transparent' : STUDIO_COLORS.surfaceRaised,
      }}
    >
      <span
        data-testid="rationale-card-headline"
        style={{
          fontSize: 10.5,
          fontStyle: 'italic',
          fontWeight: 500,
          color: STUDIO_COLORS.inkMuted,
          letterSpacing: 0.2,
        }}
      >
        Rationale{editedByOperator ? ' (edited by operator)' : ''}
      </span>
      {hasRationale ? (
        // Literal text — never parsed as markdown. Pre-wrap preserves the
        // agent's sentence but doesn't create block structure.
        <span
          data-testid="rationale-card-body"
          style={{
            fontSize: 11.5,
            ...attributedStyle('ai'),
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {rationale}
        </span>
      ) : (
        <span
          data-testid="rationale-card-placeholder"
          style={{
            fontSize: 11.5,
            color: STUDIO_COLORS.inkSubtle,
            fontStyle: 'italic',
          }}
        >
          No rationale recorded
        </span>
      )}
      {editedByOperator && operatorRationale ? (
        <span
          data-testid="rationale-card-operator-rationale"
          style={{
            fontSize: 11,
            ...attributedStyle('human'),
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            borderTop: `1px solid ${STUDIO_COLORS.hairlineSoft}`,
            paddingTop: 4,
            marginTop: 2,
          }}
        >
          Operator note: {operatorRationale}
        </span>
      ) : null}
    </div>
  )
}

/** Helper — extracts rationale from a history row's metadata JSON safely. */
export function extractRationale(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  if (!metadata || typeof metadata !== 'object') return null
  const r = (metadata as { rationale?: unknown }).rationale
  return typeof r === 'string' && r.trim().length > 0 ? r : null
}

/** Sprint 055-A F4 — extracts operator-edit provenance fields from metadata. */
export function extractEditProvenance(
  metadata: Record<string, unknown> | null | undefined,
): { editedByOperator: boolean; operatorRationale: string | null } {
  if (!metadata || typeof metadata !== 'object') {
    return { editedByOperator: false, operatorRationale: null }
  }
  const editedByOperator =
    (metadata as { rationalePrefix?: unknown }).rationalePrefix === 'edited-by-operator'
  const or = (metadata as { operatorRationale?: unknown }).operatorRationale
  const operatorRationale = typeof or === 'string' && or.trim().length > 0 ? or : null
  return { editedByOperator, operatorRationale }
}
