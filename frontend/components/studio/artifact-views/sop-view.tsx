'use client'

/**
 * Sprint 051 A B1 — SOP artifact viewer (SopVariant).
 *
 * Sprint 052 A C1 — markdown-rendered body via `MarkdownBody`. Diff mode
 * (toggle ON) still renders raw text through `DiffBody` per
 * brief §2 (markdown-AST diff deferred). Heading anchors power B3
 * citation scroll.
 */
import type { BuildArtifactDetail } from '@/lib/build-api'
import { STUDIO_COLORS } from '../tokens'
import { DiffBody } from './diff-body'
import { MarkdownBody } from './markdown-body'
import { ArtifactMetaGrid } from './meta-grid'
import { PendingBadge } from './pending-badge'

export interface SopViewProps {
  artifact: BuildArtifactDetail
  /** B2: when true, render with diff against `artifact.prevBody`. */
  showDiff: boolean
  /** A1 origin grammar: session-touched-but-not-approved artifacts. */
  isPending: boolean
  /** 052-C1: heading slug to scroll to once the body is rendered. */
  scrollToSectionSlug?: string | null
}

export function SopView({
  artifact,
  showDiff,
  isPending,
  scrollToSectionSlug,
}: SopViewProps) {
  const meta = artifact.meta as {
    category?: string
    status?: string
    enabled?: boolean
    toolDescription?: string
    updatedAt?: string
    buildTransactionId?: string | null
  }
  const prev = typeof artifact.prevBody === 'string' ? artifact.prevBody : null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {isPending && <PendingBadge />}
      <ArtifactMetaGrid
        rows={[
          { label: 'Category', value: meta.category ?? '—' },
          { label: 'Status scope', value: meta.status ?? '—' },
          { label: 'Enabled', value: meta.enabled === false ? 'no' : 'yes' },
          { label: 'Last updated', value: formatDate(meta.updatedAt) },
          meta.buildTransactionId
            ? { label: 'Source plan', value: meta.buildTransactionId }
            : null,
        ].filter(Boolean) as { label: string; value: string }[]}
      />
      {meta.toolDescription ? (
        <div>
          <SectionHeading>Tool description</SectionHeading>
          <p
            style={{
              margin: 0,
              fontSize: 12,
              color: STUDIO_COLORS.inkMuted,
              lineHeight: 1.55,
            }}
          >
            {meta.toolDescription}
          </p>
        </div>
      ) : null}
      <div>
        <SectionHeading>Body</SectionHeading>
        {showDiff && prev != null ? (
          <DiffBody prev={prev} next={artifact.body} mode="line" />
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

export function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10.5,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: 0.3,
        color: STUDIO_COLORS.inkSubtle,
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  )
}

export function PreBody({
  body,
  isPending,
}: {
  body: string
  isPending: boolean
}) {
  return (
    <pre
      data-origin={isPending ? 'pending' : 'agent'}
      style={{
        margin: 0,
        padding: 12,
        background: STUDIO_COLORS.surfaceSunken,
        border: `1px solid ${STUDIO_COLORS.hairlineSoft}`,
        borderRadius: 5,
        fontSize: 12,
        lineHeight: 1.55,
        color: isPending ? STUDIO_COLORS.inkMuted : STUDIO_COLORS.ink,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        fontStyle: isPending ? 'italic' : 'normal',
      }}
    >
      {body}
    </pre>
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
