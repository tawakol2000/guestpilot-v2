'use client'

/**
 * Sprint 051 A B1 — shared metadata grid for artifact views.
 *
 * Two-column, label-left, value-right. Small type, subtle rules between
 * rows. Handles long values via wrapping — no truncation (the drawer
 * is the audit surface, not the summary).
 */
import { STUDIO_COLORS } from '../tokens'

export interface ArtifactMetaGridRow {
  label: string
  value: string
}

export function ArtifactMetaGrid({ rows }: { rows: ArtifactMetaGridRow[] }) {
  if (rows.length === 0) return null
  return (
    <dl
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(100px, max-content) 1fr',
        columnGap: 12,
        rowGap: 0,
        margin: 0,
        border: `1px solid ${STUDIO_COLORS.hairlineSoft}`,
        borderRadius: 5,
        background: STUDIO_COLORS.surfaceRaised,
        padding: '2px 10px',
      }}
    >
      {rows.map((row, i) => (
        <Row key={row.label} row={row} first={i === 0} />
      ))}
    </dl>
  )
}

function Row({
  row,
  first,
}: {
  row: ArtifactMetaGridRow
  first: boolean
}) {
  const borderTop = first ? 'none' : `1px solid ${STUDIO_COLORS.hairlineSoft}`
  return (
    <>
      <dt
        style={{
          margin: 0,
          padding: '6px 0',
          fontSize: 10.5,
          color: STUDIO_COLORS.inkSubtle,
          textTransform: 'uppercase',
          letterSpacing: 0.2,
          fontWeight: 600,
          borderTop,
        }}
      >
        {row.label}
      </dt>
      <dd
        style={{
          margin: 0,
          padding: '6px 0',
          fontSize: 12,
          color: STUDIO_COLORS.ink,
          wordBreak: 'break-word',
          borderTop,
        }}
      >
        {row.value}
      </dd>
    </>
  )
}
