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
          // 2026-05-15 polish: friendlier copy + lock icon so the gate
          // feels like a sensible permission instead of a hard wall.
          // "Open the dedicated Tuning editor" mentions a thing the
          // operator can't actually navigate to from here, so it's
          // dropped in favour of a one-line explanation.
          <div
            role="note"
            aria-label="Body hidden — admin access required"
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              fontSize: 12.5,
              color: STUDIO_COLORS.inkMuted,
              padding: '10px 14px',
              background: STUDIO_COLORS.surfaceRaised,
              border: `1px dashed ${STUDIO_COLORS.hairline}`,
              borderRadius: 6,
              lineHeight: 1.5,
            }}
          >
            <span aria-hidden style={{ fontSize: 14, lineHeight: 1, marginTop: 1 }}>🔒</span>
            <span>
              Body hidden — system-prompt contents are admin-only. Ask an
              admin to enable raw-prompt access if you need to inspect it.
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '—'
  // 2026-05-15 polish: relative time ("today 5:38 PM", "yesterday",
  // "3 days ago") reads better than the locale-default
  // "5/15/2026, 5:38:06 PM" string. Falls back to the absolute form for
  // older edits.
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    const now = new Date()
    const diffMs = now.getTime() - d.getTime()
    const diffMin = Math.round(diffMs / 60_000)
    const diffH = Math.round(diffMs / 3_600_000)
    const diffD = Math.round(diffMs / 86_400_000)
    const timeStr = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    if (diffMin < 1) return 'just now'
    if (diffMin < 60) return `${diffMin} min ago`
    if (diffH < 12) return `${diffH}h ago`
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    if (sameDay) return `today, ${timeStr}`
    const yesterday = new Date(now)
    yesterday.setDate(now.getDate() - 1)
    const isYesterday =
      d.getFullYear() === yesterday.getFullYear() &&
      d.getMonth() === yesterday.getMonth() &&
      d.getDate() === yesterday.getDate()
    if (isYesterday) return `yesterday, ${timeStr}`
    if (diffD < 7) return `${diffD} days ago`
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return iso
  }
}
