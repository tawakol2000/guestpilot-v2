/**
 * Sprint 058-A F9f — session auto-naming helpers.
 *
 * The session list sidebar was cluttered with identical "Studio session"
 * rows because conversations are auto-created on bootstrap and never
 * renamed unless the operator does it manually. These helpers generate
 * a meaningful title from the operator's first user message or, when
 * that fails, from the first artifact touched in the session.
 *
 * Kept as a pure module (no React, no DOM) so the logic is unit-tested
 * in isolation. studio-surface.tsx imports these and wires them into
 * the bootstrap effect.
 */

const DEFAULT_TITLES = new Set<string>([
  'Studio session',
  'Studio — initial setup',
  'Studio - initial setup',
  'Untitled session',
  '',
])

const MAX_LEN = 50

/** True if the title is still one of the generic defaults we create on
 *  bootstrap — i.e. we're free to overwrite it on first user intent. */
export function isDefaultTitle(title: string | null | undefined): boolean {
  if (title == null) return true
  const trimmed = title.trim()
  return DEFAULT_TITLES.has(trimmed)
}

/** Guard — messages this short are almost always "hi" / "test" / "ok"
 *  and make a bad title. Caller falls back to the first artifact touched. */
const MIN_FIRST_MESSAGE_LEN = 15

export function isFirstMessageTooShortForTitle(text: string | null | undefined): boolean {
  if (!text) return true
  return text.trim().length < MIN_FIRST_MESSAGE_LEN
}

/**
 * Derive a session title from the operator's first user message.
 *
 *   - collapses whitespace to single spaces
 *   - truncates to 50 chars (with ellipsis if cut)
 *   - strips trailing punctuation so the title reads as a phrase
 *   - capitalises the first letter
 *
 * Returns null if the input is empty after trimming.
 */
export function autoTitleFromFirstMessage(text: string | null | undefined): string | null {
  if (!text) return null
  let s = text.replace(/\s+/g, ' ').trim()
  if (!s) return null

  let truncated = false
  if (s.length > MAX_LEN) {
    s = s.slice(0, MAX_LEN).trimEnd()
    truncated = true
  }

  // Strip trailing punctuation only when we didn't truncate — a truncated
  // title gets an ellipsis instead.
  if (!truncated) {
    s = s.replace(/[.!?,;:…]+$/, '')
  }

  if (!s) return null

  // Capitalise first letter. Keep rest as-is so URLs / code references
  // preserve casing.
  s = s.charAt(0).toUpperCase() + s.slice(1)

  if (truncated) {
    // Reserve one char for the ellipsis so the final length is <= MAX_LEN.
    if (s.length + 1 > MAX_LEN) {
      s = s.slice(0, MAX_LEN - 1).trimEnd()
    }
    s = `${s}…`
  }

  return s
}

/**
 * Fallback title from the first artifact touched in a session. Returns
 * null if the artifact fields are too thin to form a meaningful title.
 */
export function autoTitleFromFirstArtifact(input: {
  operation?: string | null
  artifactType?: string | null
  artifactName?: string | null
}): string | null {
  const op = (input.operation ?? '').trim()
  const type = (input.artifactType ?? '').trim()
  const name = (input.artifactName ?? '').trim()

  if (!type && !name) return null

  const verb = op
    ? op.charAt(0).toUpperCase() + op.slice(1).toLowerCase()
    : 'Edit'

  const parts: string[] = [verb]
  if (type) parts.push(type.toLowerCase())
  if (name) parts.push(`· ${name}`)

  let s = parts.join(' ').replace(/\s+/g, ' ').trim()
  if (s.length > MAX_LEN) {
    s = `${s.slice(0, MAX_LEN - 1).trimEnd()}…`
  }
  return s || null
}
