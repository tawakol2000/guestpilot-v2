/**
 * Shared elision-marker detection used by both the PostToolUse validator
 * (hooks/post-tool-use.ts) and the suggestion_action draft pre-persist
 * validator (tools/suggestion-action.ts).
 *
 * The patterns here look for AI-generated placeholders that stand in for
 * "the rest of the artifact I didn't bother to include". They must be tight
 * enough to avoid matching legitimate SOP/FAQ content like "call us for the
 * rest of your stay" or "TODO: fill form on arrival", and loose enough to
 * catch obvious elision tokens the agent occasionally emits.
 */

export const ELISION_PATTERNS: ReadonlyArray<RegExp> = [
  /\/\/\s*\.\.\./i,
  /\/\/\s*rest\s+(of\s+)?unchanged/i,
  /\/\/\s*existing\s+code/i,
  /\/\*\s*\.\.\.\s*\*\//i,
  /#\s*rest\s+(of\s+)?unchanged/i,
  /#\s*existing\s+code/i,
  /<!--\s*remaining\s*-->/i,
  /<!--\s*\.\.\.\s*-->/i,
  /\[\s*unchanged\s*\]/i,
  /\[\s*rest\s+of\s+(the\s+)?(content|prompt|rules|section|file|text|code)[^\]]*\]/i,
  /TODO:\s*fill\s+in\b/i,
  /\.\.\.\s*existing\s+code\s*\.\.\./i,
];

/**
 * Returns the source of the first matching pattern (for error-message
 * feedback to the agent), or a short code for the bare-ellipsis-line case,
 * or null when the text is clean.
 */
export function detectElisionMarker(text: string): string | null {
  for (const re of ELISION_PATTERNS) {
    if (re.test(text)) return re.source;
  }
  if (/^\s*\.\.\.\s*$/m.test(text)) return 'bare-ellipsis-line';
  return null;
}
