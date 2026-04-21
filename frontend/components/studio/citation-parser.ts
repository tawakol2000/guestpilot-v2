/**
 * Sprint 051 A B3 — citation marker parser.
 *
 * Marker format (sentinel-in-text — see brief §1.3 decision):
 *   [[cite:<type>:<id>]]
 *   [[cite:<type>:<id>#<section>]]
 *
 * Malformed markers (unknown type, unterminated) pass through as
 * plain text — a parse failure must not hide the agent's claim.
 * Returns a flat list of text + citation tokens in document order.
 */

export type CitationArtifactType =
  | 'sop'
  | 'faq'
  | 'system_prompt'
  | 'tool'
  | 'property_override'

const VALID_TYPES: readonly CitationArtifactType[] = [
  'sop',
  'faq',
  'system_prompt',
  'tool',
  'property_override',
] as const

export interface CitationToken {
  kind: 'citation'
  artifact: CitationArtifactType
  artifactId: string
  section: string | null
  /** Raw marker text — used for keys + hover debugging. */
  raw: string
}

export interface TextToken {
  kind: 'text'
  text: string
}

export type ParsedToken = CitationToken | TextToken

export const CITATION_MARKER_REGEX =
  /\[\[cite:([a-z_]+):([^\]#]+?)(?:#([^\]]+))?\]\]/g

export function parseCitations(input: string): ParsedToken[] {
  if (!input) return []
  const out: ParsedToken[] = []
  let lastIndex = 0
  // Regex with the /g flag carries state — fresh instance per call so
  // concurrent callers don't interfere.
  const scanner = new RegExp(CITATION_MARKER_REGEX.source, 'g')
  let match: RegExpExecArray | null
  while ((match = scanner.exec(input)) !== null) {
    const [raw, rawType, rawId, rawSection] = match
    const type = rawType as CitationArtifactType
    if (!VALID_TYPES.includes(type)) {
      // Unknown type — skip past the marker rather than surfacing a
      // malformed chip. The underlying text stays visible.
      continue
    }
    if (match.index > lastIndex) {
      out.push({ kind: 'text', text: input.slice(lastIndex, match.index) })
    }
    out.push({
      kind: 'citation',
      artifact: type,
      artifactId: rawId!.trim(),
      section: rawSection ? rawSection.trim() : null,
      raw: raw!,
    })
    lastIndex = match.index + raw!.length
  }
  if (lastIndex < input.length) {
    out.push({ kind: 'text', text: input.slice(lastIndex) })
  }
  return out
}
