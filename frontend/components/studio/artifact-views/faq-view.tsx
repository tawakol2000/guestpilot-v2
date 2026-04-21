'use client'

/**
 * Sprint 051 A B1 — FAQ entry viewer.
 *
 * Q is shown above the A so the scanning order matches how operators
 * remember FAQs ("the question about early check-in…"). B2 wires
 * token-level diff on the answer body. 052 A C1 replaces the monospace
 * answer block with markdown rendering when the diff toggle is off.
 */
import type { BuildArtifactDetail } from '@/lib/build-api'
import { STUDIO_COLORS } from '../tokens'
import { DiffBody } from './diff-body'
import { MarkdownBody } from './markdown-body'
import { ArtifactMetaGrid } from './meta-grid'
import { PendingBadge } from './pending-badge'
import { SectionHeading } from './sop-view'

export interface FaqViewProps {
  artifact: BuildArtifactDetail
  showDiff: boolean
  isPending: boolean
  /** 052-C1: heading slug to scroll to once the body is rendered. */
  scrollToSectionSlug?: string | null
}

export function FaqView({
  artifact,
  showDiff,
  isPending,
  scrollToSectionSlug,
}: FaqViewProps) {
  const meta = artifact.meta as {
    question?: string
    category?: string
    scope?: string
    status?: string
    source?: string
    usageCount?: number
    lastUsedAt?: string | null
    propertyId?: string | null
    propertyName?: string | null
    updatedAt?: string
    buildTransactionId?: string | null
  }
  const prev = typeof artifact.prevBody === 'string' ? artifact.prevBody : null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {isPending && <PendingBadge />}
      <div>
        <SectionHeading>Question</SectionHeading>
        <p
          style={{
            margin: 0,
            fontSize: 13,
            fontWeight: 500,
            color: STUDIO_COLORS.ink,
            lineHeight: 1.5,
          }}
        >
          {meta.question ?? artifact.title}
        </p>
      </div>
      <ArtifactMetaGrid
        rows={[
          { label: 'Category', value: meta.category ?? '—' },
          { label: 'Scope', value: meta.scope ?? '—' },
          { label: 'Status', value: meta.status ?? '—' },
          { label: 'Source', value: meta.source ?? '—' },
          {
            label: 'Property',
            value: meta.propertyName ?? meta.propertyId ?? '(global)',
          },
          {
            label: 'Usage',
            value:
              typeof meta.usageCount === 'number'
                ? `${meta.usageCount} hit${meta.usageCount === 1 ? '' : 's'}`
                : '—',
          },
          { label: 'Last updated', value: formatDate(meta.updatedAt) },
          meta.buildTransactionId
            ? { label: 'Source plan', value: meta.buildTransactionId }
            : null,
        ].filter(Boolean) as { label: string; value: string }[]}
      />
      <div>
        <SectionHeading>Answer</SectionHeading>
        {showDiff && prev != null ? (
          <DiffBody prev={prev} next={artifact.body} mode="token" />
        ) : (
          <MarkdownBody
            body={artifact.body}
            isPending={isPending}
            scrollToSectionSlug={scrollToSectionSlug}
          />
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
