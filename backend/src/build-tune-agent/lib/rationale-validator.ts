/**
 * Sprint 054-A F1 — rationale validator for BUILD write tools.
 *
 * Every write tool (create_faq, create_sop, create_tool_definition,
 * write_system_prompt) must carry a human-readable `rationale` string
 * explaining *why* the edit is being made. This validator is the single
 * source of truth for what a "real" rationale looks like.
 *
 * Rules:
 *   - Required string, 15–280 characters.
 *   - Not whitespace-only.
 *   - Not a bare lazy placeholder (blocklist). The blocklist catches
 *     bare words or trivially short placeholders; a longer sentence
 *     starting with "updating…" still passes. This is a prompt-engineering
 *     dial, not a security control — see spec §5.
 *
 * Version stamp: RATIONALE_PROMPT_VERSION is embedded in the BUILD
 * system prompt's <write_rationale> block. If a later sprint mutates
 * the prompt block, bump the version here; a regression test asserts
 * both halves stay in lockstep.
 */
export const RATIONALE_PROMPT_VERSION = '054-a.1';

export const RATIONALE_MIN_CHARS = 15;
export const RATIONALE_MAX_CHARS = 280;

/**
 * Bare lazy placeholders rejected by the validator. Case-insensitive,
 * matched only as the *entire* (trimmed) rationale string — a sentence
 * starting with one of these words still passes.
 */
export const RATIONALE_BLOCKLIST: readonly string[] = [
  'updating',
  'update',
  'edit',
  'edits',
  'change',
  'changes',
  'changing',
  'fix',
  'fixing',
  'tweak',
  'tweaking',
  'n/a',
  'na',
  'none',
  'test',
  'testing',
  '.',
  '-',
];

export interface RationaleValidationOk {
  ok: true;
  rationale: string;
}
export interface RationaleValidationErr {
  ok: false;
  error: string;
}
export type RationaleValidationResult =
  | RationaleValidationOk
  | RationaleValidationErr;

export function validateRationale(raw: unknown): RationaleValidationResult {
  if (typeof raw !== 'string') {
    return {
      ok: false,
      error: `rationale is required — provide a one-sentence explanation of why this edit is being made (min ${RATIONALE_MIN_CHARS} chars).`,
    };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      error: `rationale cannot be empty or whitespace-only. Provide a one-sentence explanation of why this edit is being made (min ${RATIONALE_MIN_CHARS} chars).`,
    };
  }
  if (trimmed.length < RATIONALE_MIN_CHARS) {
    return {
      ok: false,
      error: `rationale is too short (${trimmed.length} chars, min ${RATIONALE_MIN_CHARS}). Explain *why* this edit, citing the conversation signal if applicable.`,
    };
  }
  if (trimmed.length > RATIONALE_MAX_CHARS) {
    return {
      ok: false,
      error: `rationale is too long (${trimmed.length} chars, max ${RATIONALE_MAX_CHARS}). Keep it to one sentence.`,
    };
  }
  const lowerBare = trimmed.toLowerCase();
  if (RATIONALE_BLOCKLIST.includes(lowerBare)) {
    return {
      ok: false,
      error: `rationale "${trimmed}" is a lazy placeholder — explain *why* this edit, not that there is one. Example: "Manager mentioned the late-checkout SOP was missing the 2pm fallback, so I tightened the default."`,
    };
  }
  return { ok: true, rationale: trimmed };
}
