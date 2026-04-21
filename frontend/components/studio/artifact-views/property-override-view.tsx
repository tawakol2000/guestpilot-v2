'use client'

/**
 * Sprint 051 A B1 — SopPropertyOverride viewer.
 *
 * A property override is just a SopVariant content body scoped to a
 * specific property. Shares the SOP view's shape; no diff this sprint
 * (brief §0 non-goal — B2 covers SOP + FAQ only).
 */
import type { BuildArtifactDetail } from '@/lib/build-api'
import { ArtifactMetaGrid } from './meta-grid'
import { PendingBadge } from './pending-badge'
import { PreBody, SectionHeading } from './sop-view'

export interface PropertyOverrideViewProps {
  artifact: BuildArtifactDetail
  isPending: boolean
}

export function PropertyOverrideView({
  artifact,
  isPending,
}: PropertyOverrideViewProps) {
  const meta = artifact.meta as {
    category?: string
    status?: string
    enabled?: boolean
    propertyId?: string
    propertyName?: string | null
    updatedAt?: string
    buildTransactionId?: string | null
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {isPending && <PendingBadge />}
      <ArtifactMetaGrid
        rows={[
          { label: 'Category', value: meta.category ?? '—' },
          { label: 'Status scope', value: meta.status ?? '—' },
          {
            label: 'Property',
            value: meta.propertyName ?? meta.propertyId ?? '—',
          },
          { label: 'Enabled', value: meta.enabled === false ? 'no' : 'yes' },
          { label: 'Last updated', value: formatDate(meta.updatedAt) },
          meta.buildTransactionId
            ? { label: 'Source plan', value: meta.buildTransactionId }
            : null,
        ].filter(Boolean) as { label: string; value: string }[]}
      />
      <div>
        <SectionHeading>Overridden body</SectionHeading>
        <PreBody body={artifact.body} isPending={isPending} />
      </div>
    </div>
  )
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}
