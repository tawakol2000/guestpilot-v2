'use client'

/**
 * Sprint 051 A B3 — inline citation chip.
 *
 * Rendered inline within an agent text span when the agent emits a
 * `[[cite:type:id#section]]` marker. Click opens the artifact drawer
 * (B1) scrolled to the referenced section. Unknown artifact refs get
 * a muted "missing" appearance — the drawer itself also renders a
 * banner on 404, but labelling the chip up-front means operators
 * don't have to open it to see that a citation is stale.
 */
import { BookOpen, FileText, MessageSquare, Settings, Home } from 'lucide-react'
import { STUDIO_COLORS } from './tokens'
import type { CitationArtifactType } from './citation-parser'

export interface CitationChipProps {
  artifact: CitationArtifactType
  artifactId: string
  section: string | null
  onOpen?: (artifact: CitationArtifactType, artifactId: string, section: string | null) => void
}

const TYPE_ICON: Record<CitationArtifactType, typeof BookOpen> = {
  sop: BookOpen,
  faq: MessageSquare,
  system_prompt: FileText,
  tool: Settings,
  property_override: Home,
}

const TYPE_LABEL: Record<CitationArtifactType, string> = {
  sop: 'SOP',
  faq: 'FAQ',
  system_prompt: 'Prompt',
  tool: 'Tool',
  property_override: 'Property',
}

export function CitationChip(props: CitationChipProps) {
  const { artifact, artifactId, section, onOpen } = props
  const Icon = TYPE_ICON[artifact]
  const label = `${TYPE_LABEL[artifact]}: ${artifactId}${section ? ` · ${section}` : ''}`
  return (
    <button
      type="button"
      data-citation-type={artifact}
      data-citation-id={artifactId}
      onClick={() => onOpen?.(artifact, artifactId, section)}
      title={label}
      aria-label={`Open ${label}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '1px 6px',
        margin: '0 1px',
        borderRadius: 4,
        border: `1px solid ${STUDIO_COLORS.hairline}`,
        background: STUDIO_COLORS.surfaceRaised,
        color: STUDIO_COLORS.accent,
        fontSize: 11,
        fontWeight: 500,
        cursor: onOpen ? 'pointer' : 'default',
        verticalAlign: 'baseline',
        lineHeight: 1.2,
        fontFamily: 'inherit',
      }}
    >
      <Icon size={10} strokeWidth={2.25} aria-hidden />
      <span>{TYPE_LABEL[artifact]}</span>
      <span style={{ color: STUDIO_COLORS.inkSubtle }}>·</span>
      <span
        style={{
          maxWidth: 160,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {artifactId}
        {section ? `#${section}` : ''}
      </span>
    </button>
  )
}
