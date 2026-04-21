'use client'

/**
 * Sprint 051 A B1 — system prompt variant viewer.
 *
 * Admin-gated — operator-tier still sees the variant exists (title +
 * meta) but the body collapses behind a "Full prompt body is admin-
 * only" notice. Admins with `rawPromptEditorEnabled` see the body.
 *
 * B2 deliberately doesn't ship diff for this artifact type (brief §0
 * non-goals): system_prompt + tool_definition current-only until
 * operator pressure surfaces.
 */
import type { BuildArtifactDetail } from '@/lib/build-api'
import { STUDIO_COLORS } from '../tokens'
import { ArtifactMetaGrid } from './meta-grid'
import { PreBody, SectionHeading } from './sop-view'
import { PendingBadge } from './pending-badge'

export interface SystemPromptViewProps {
  artifact: BuildArtifactDetail
  isAdmin: boolean
  rawPromptEditorEnabled: boolean
  isPending: boolean
}

export function SystemPromptView({
  artifact,
  isAdmin,
  rawPromptEditorEnabled,
  isPending,
}: SystemPromptViewProps) {
  const meta = artifact.meta as {
    variant?: string
    version?: number
    updatedAt?: string
  }
  const canSeeBody = isAdmin && rawPromptEditorEnabled
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {isPending && <PendingBadge />}
      <ArtifactMetaGrid
        rows={[
          { label: 'Variant', value: meta.variant ?? '—' },
          {
            label: 'Version',
            value: typeof meta.version === 'number' ? String(meta.version) : '—',
          },
          { label: 'Last updated', value: formatDate(meta.updatedAt) },
        ]}
      />
      <div>
        <SectionHeading>Body</SectionHeading>
        {canSeeBody ? (
          <PreBody body={artifact.body} isPending={isPending} />
        ) : (
          <div
            role="note"
            style={{
              fontSize: 12,
              color: STUDIO_COLORS.inkSubtle,
              padding: '8px 12px',
              background: STUDIO_COLORS.surfaceRaised,
              border: `1px dashed ${STUDIO_COLORS.hairline}`,
              borderRadius: 5,
            }}
          >
            Full system-prompt body is admin-only. Open the dedicated
            Tuning editor for authorised access.
          </div>
        )}
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
