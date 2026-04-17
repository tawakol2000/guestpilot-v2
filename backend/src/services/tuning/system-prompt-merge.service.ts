/**
 * Feature 041 hotfix — system-prompt clause merging.
 *
 * The diagnostic produces `proposedText` as a *clause* (e.g. "When a guest
 * is replying to a screening question, keep the response strictly focused…")
 * — NOT a full system-prompt replacement. The previous apply path wrote the
 * clause directly into the variant field, wiping the entire prompt and
 * leaving a 5,107-char prompt as 800 chars of just the new rule. Real bug,
 * real damage, real production tenants.
 *
 * This module owns the safe merge: append the clause to the existing prompt
 * inside marker comments tagged with the suggestion id. The marker lets us
 *   (a) re-apply the SAME suggestion later without stacking duplicates, and
 *   (b) eventually graduate to a smarter "find the right section" insertion
 *       without changing the apply contract.
 *
 * If the apply needs full-replacement semantics (e.g. a manager hand-edits
 * the proposed text into a complete new prompt), pass `mode: 'replace'`.
 */

const MARKER_PREFIX = '<!-- tuning:'
const MARKER_SUFFIX = ' -->'

export type SystemPromptApplyMode = 'append' | 'replace'

export interface MergeOptions {
  /**
   * 'append' (default) — wrap the clause in marker comments and append to
   * the end of the current prompt. Re-applying the same suggestion replaces
   * the prior clause in-place rather than stacking.
   *
   * 'replace' — write the clause verbatim, overwriting the entire prompt.
   * Only safe when the caller has confirmed the text IS a complete prompt.
   */
  mode?: SystemPromptApplyMode
}

export function mergeSystemPromptClause(
  currentPrompt: string,
  proposedText: string,
  suggestionId: string,
  options: MergeOptions = {}
): string {
  const mode: SystemPromptApplyMode = options.mode ?? 'append'
  const clause = (proposedText ?? '').trim()
  if (!clause) return currentPrompt

  if (mode === 'replace') return clause

  const current = currentPrompt ?? ''
  const marker = `${MARKER_PREFIX}${suggestionId}${MARKER_SUFFIX}`
  const block = `${marker}\n${clause}\n${marker}`

  // If this exact suggestion was previously applied (re-apply scenario),
  // replace the prior block in-place to avoid duplicates.
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const reExisting = new RegExp(`${escaped}[\\s\\S]*?${escaped}`, 'g')
  if (reExisting.test(current)) {
    return current.replace(reExisting, block)
  }

  // First-time apply — append with breathing room. Defensive trim of any
  // trailing whitespace on the existing prompt so the block lands on a
  // clean separator.
  const tail = current.trimEnd()
  return tail ? `${tail}\n\n${block}\n` : `${block}\n`
}
