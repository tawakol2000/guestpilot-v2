/**
 * Sprint 051 A B4 — `data-artifact-quote` emit helpers.
 *
 * Wakes up the renderer that shipped in sprint-050-A1 (inert until a
 * first emitter). Two call sites live in this sprint:
 *   1. propose-suggestion — when the fix rewrites an existing artifact,
 *      quote the pre-fix body so operators have an inline anchor to
 *      the source.
 *   2. emit-audit — when an audit row labels a concrete artifact, quote
 *      the referenced body so the operator can read the excerpt
 *      alongside the finding.
 *
 * Safety: every quoted body passes through `sanitiseQuoteBody` before
 * emit. If the body would be entirely redacted (empty after scrub), the
 * emit is suppressed rather than producing a misleading empty block.
 */
import { DATA_PART_TYPES, type ArtifactQuoteData } from './data-parts';

export type QuoteArtifactType = ArtifactQuoteData['artifact'];

export interface QuoteEmitInput {
  artifact: QuoteArtifactType;
  artifactId: string;
  sourceLabel: string;
  body: string;
  /** Optional cap (default 1200 chars) — quotes are context, not novels. */
  maxLength?: number;
}

// Length-heuristic redactor, matching the sprint-050-A tighten-up on
// the frontend sanitiser. Catches opaque bearer-style tokens the agent
// might accidentally quote from a tool payload. Whole-body whitespace
// /punctuation defeats the heuristic, which is what we want — prose
// should always pass through.
const LIKELY_SECRET_REGEX = /\b[A-Za-z0-9_\-]{32,}\b/g;
const LIKELY_SECRET_MIDDLE = '…[likely-secret]…';

export function sanitiseQuoteBody(raw: string): string {
  if (!raw) return '';
  return raw.replace(LIKELY_SECRET_REGEX, (match) => {
    return match.slice(0, 4) + LIKELY_SECRET_MIDDLE + match.slice(-4);
  });
}

/**
 * Build the sanitised `data-artifact-quote` payload. Returns null when
 * the body is empty or the sanitised result is empty — the caller
 * should skip the emit in that case.
 */
export function buildArtifactQuotePart(
  input: QuoteEmitInput,
): { type: typeof DATA_PART_TYPES.artifact_quote; data: ArtifactQuoteData } | null {
  const trimmed = (input.body ?? '').trim();
  if (!trimmed) return null;
  const cap = input.maxLength ?? 1200;
  const truncated =
    trimmed.length > cap ? trimmed.slice(0, cap) + '\n…[truncated]' : trimmed;
  const sanitised = sanitiseQuoteBody(truncated);
  if (!sanitised.trim()) return null;
  return {
    type: DATA_PART_TYPES.artifact_quote,
    data: {
      artifact: input.artifact,
      artifactId: input.artifactId,
      sourceLabel: input.sourceLabel,
      body: sanitised,
    },
  };
}

/**
 * Fire-and-forget emit. The brief is explicit: quote emission is
 * redundancy, not a dependency — a failed emit must not propagate to
 * the tool caller. Callers pass the already-typed `emitDataPart`
 * callback from ToolContext.
 */
export function emitArtifactQuoteIfPossible(
  emit: ((part: { type: string; data: unknown; id?: string }) => void) | undefined,
  input: QuoteEmitInput,
): boolean {
  if (!emit) return false;
  const part = buildArtifactQuotePart(input);
  if (!part) return false;
  try {
    emit({
      type: part.type,
      data: part.data,
      id: `artifact-quote:${input.artifact}:${input.artifactId}`,
    });
    return true;
  } catch (err) {
    console.warn('[quote-emit] emit failed (non-fatal):', err);
    return false;
  }
}

const QUOTE_ARTIFACT_TYPE_MAP: Record<string, QuoteArtifactType> = {
  sop: 'sop',
  faq: 'faq',
  system_prompt: 'system_prompt',
  tool: 'tool_definition',
  tool_definition: 'tool_definition',
  property_override: 'property_override',
};

/** Tolerant mapper for the audit-row artifact field which uses a
 * slightly different enum than FixTarget (no 'tool_definition'). */
export function normaliseQuoteArtifactType(
  raw: string | undefined,
): QuoteArtifactType | null {
  if (!raw) return null;
  return QUOTE_ARTIFACT_TYPE_MAP[raw] ?? null;
}
