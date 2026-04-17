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

/**
 * Threshold for the heuristic auto-detection in mode 'auto'. If proposedText
 * is at least this fraction of the current prompt's length, we treat it as a
 * complete-revised-prompt replacement. Below the threshold we fall back to
 * append-with-marker as a safety net for pre-hotfix suggestions still in the
 * queue (those returned a small free-floating clause). 0.5 is intentionally
 * generous — a real revision rarely cuts more than half the prompt.
 */
const AUTO_REPLACE_LENGTH_RATIO = 0.5

export type SystemPromptApplyMode = 'append' | 'replace' | 'auto'

export interface MergeOptions {
  /**
   * 'auto' (recommended default) — pick replace vs append based on the
   * proposedText length relative to the current prompt. The diagnostic was
   * updated to produce a complete revised prompt, so most new proposals will
   * trigger replace; old fragment-style proposals still in the queue will
   * fall through to append so they don't wipe the prompt.
   *
   * 'append' — wrap the clause in marker comments and append to the end of
   * the current prompt. Re-applying the same suggestion replaces the prior
   * clause in-place rather than stacking.
   *
   * 'replace' — write the text verbatim, overwriting the entire prompt.
   * Use when the caller has positive confirmation that proposedText is a
   * complete prompt (e.g. manager hand-edited it in the UI).
   */
  mode?: SystemPromptApplyMode
}

export function mergeSystemPromptClause(
  currentPrompt: string,
  proposedText: string,
  suggestionId: string,
  options: MergeOptions = {}
): string {
  const requestedMode: SystemPromptApplyMode = options.mode ?? 'auto'
  const clause = (proposedText ?? '').trim()
  if (!clause) return currentPrompt

  const current = currentPrompt ?? ''
  // Resolve 'auto' to a concrete mode using the length heuristic.
  let mode: 'append' | 'replace'
  if (requestedMode === 'auto') {
    const ratio = current.length === 0 ? 1 : clause.length / current.length
    mode = ratio >= AUTO_REPLACE_LENGTH_RATIO ? 'replace' : 'append'
  } else {
    mode = requestedMode
  }

  if (mode === 'replace') return clause

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
