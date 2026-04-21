'use client'

/**
 * Sprint 051 A B1 — system prompt variant viewer.
 *
 * Admin-gated — operator-tier still sees the variant exists (title +
 * meta) but the body collapses behind a "Full prompt body is admin-
 * only" notice. Admins with `rawPromptEditorEnabled` see the body.
 *
 * Sprint 052 A:
 *  - C1 — rendered body flows through `MarkdownBody` (headings →
 *    slug anchors so B3 citations scroll). Diff mode renders raw text
 *    through `DiffBody`.
 *  - C2 — `showDiff` + `prevBody` wired. Line-level diff (paragraph-
 *    grained reads better than token-grained for prompts). Toggle only
 *    appears for admins who can see the body; the footer toggle in
 *    `artifact-drawer.tsx` is gated on the same condition.
 */
import type { BuildArtifactDetail } from '@/lib/build-api'
import { STUDIO_COLORS } from '../tokens'
import { DiffBody } from './diff-body'
import { MarkdownBody } from './markdown-body'
import { ArtifactMetaGrid } from './meta-grid'
import { PendingBadge } from './pending-badge'
import { SectionHeading } from './sop-view'

export interface SystemPromptViewProps {
  artifact: BuildArtifactDetail
  isAdmin: boolean
  rawPromptEditorEnabled: boolean
  isPending: boolean
  /** 052-C2: when true, render line-level diff against `prevBody`. */
  showDiff: boolean
  /** 052-C1: heading slug to scroll to once the body is rendered. */
  scrollToSectionSlug?: string | null
}

export function SystemPromptView({
  artifact,
  isAdmin,
  rawPromptEditorEnabled,
  isPending,
  showDiff,
  scrollToSectionSlug,
}: SystemPromptViewProps) {
  const meta = artifact.meta as {
    variant?: string
    version?: number
    updatedAt?: string
  }
  const canSeeBody = isAdmin && rawPromptEditorEnabled
  const prev = typeof artifact.prevBody === 'string' ? artifact.prevBody : null
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
          showDiff && prev != null ? (
            <DiffBody prev={prev} next={artifact.body} mode="line" />
          ) : (
            <MarkdownBody
              body={artifact.body}
              isPending={isPending}
              scrollToSectionSlug={scrollToSectionSlug}
            />
          )
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
