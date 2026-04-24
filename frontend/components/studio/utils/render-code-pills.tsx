// Sprint 046 — Studio design overhaul (plan T029 + FR-033).
//
// Renders backtick-wrapped tokens in the Preview tab's reply agent
// bubble as inline code pills: blue text on blue-soft background, mono
// 12.5px, 4px radius, 2×5 padding. Unbalanced backticks fall through
// as literal characters.

import React from 'react'
import { STUDIO_TOKENS_V2 } from '../tokens'

const CODE_RE = /`([^`\n]+)`/g

export function renderInlineCodePills(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let lastIdx = 0
  let hit: RegExpExecArray | null
  let n = 0
  while ((hit = CODE_RE.exec(text)) !== null) {
    const [full, inner] = hit
    const start = hit.index
    if (start > lastIdx) {
      nodes.push(text.slice(lastIdx, start))
    }
    nodes.push(
      <span
        key={`pill:${n++}`}
        style={{
          color: STUDIO_TOKENS_V2.blue,
          background: STUDIO_TOKENS_V2.blueSoft,
          fontFamily: 'var(--font-mono, JetBrains Mono, monospace)',
          fontSize: 12.5,
          padding: '2px 5px',
          borderRadius: 4,
          margin: '0 1px',
        }}
      >
        {inner}
      </span>,
    )
    lastIdx = start + full.length
  }
  if (lastIdx < text.length) {
    nodes.push(text.slice(lastIdx))
  }
  return nodes
}
