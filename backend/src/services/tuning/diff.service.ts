/**
 * Feature 041 sprint 02 §2 — Pure preprocessing helpers for the diagnostic
 * pipeline. No LLM calls. No embeddings (per roadmap D10 — we do not put
 * embeddings on dynamic user-facing text, and a copilot-drafted vs
 * manager-edited reply is close enough to that case to honor the rule).
 *
 * Three exports:
 *   - computeMyersDiff        (word-level Myers diff via the `diff` npm pkg)
 *   - semanticSimilarity      (Jaccard over 3-token shingles; deterministic)
 *   - classifyEditMagnitude   (heuristic tier: MINOR / MODERATE / MAJOR / WHOLESALE)
 *
 * Why Jaccard on shingles vs normalized Levenshtein: shingles are robust to
 * word-order changes a manager would consider "same text, different phrasing",
 * while Levenshtein punishes them. Jaccard is also O(n) after tokenization
 * whereas Levenshtein is O(n*m). For the 50–800 char replies the copilot
 * produces, either works, but Jaccard is simpler to explain and keeps the
 * MAJOR/WHOLESALE cut cleaner when the edit reorders sentences.
 */
import { createPatch, diffWordsWithSpace } from 'diff';

// ─── Myers diff (word-level) ─────────────────────────────────────────────────

export interface MyersDiffResult {
  /** Inserted runs — pieces of text present in `final` but not in `original`. */
  insertions: string[];
  /** Deleted runs — pieces of text present in `original` but not in `final`. */
  deletions: string[];
  /** Unified diff string, useful for passing to the LLM verbatim. */
  unified: string;
}

export function computeMyersDiff(original: string, final: string): MyersDiffResult {
  const insertions: string[] = [];
  const deletions: string[] = [];
  for (const part of diffWordsWithSpace(original, final)) {
    if (part.added) {
      insertions.push(part.value);
    } else if (part.removed) {
      deletions.push(part.value);
    }
  }
  const unified = createPatch('edit', original, final, 'original', 'final');
  return { insertions, deletions, unified };
}

// ─── Similarity (Jaccard over 1-token + 2-token shingles) ────────────────────

/**
 * Deterministic 0..1 similarity between two strings. After case-folding and
 * stripping non-word punctuation, we form both unigrams and bigrams and
 * average their Jaccard coefficients. Bigrams catch phrasing changes,
 * unigrams keep the signal meaningful on the 5–15-token replies the copilot
 * produces (where bigrams alone are brittle).
 *
 * Identical normalized strings → 1. Two empty strings → 1. Empty vs
 * non-empty → 0.
 */
export function semanticSimilarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  if (na.length === 0 || nb.length === 0) return 0;

  const uni = jaccard(shingles(na, 1), shingles(nb, 1));
  const bi = jaccard(shingles(na, 2), shingles(nb, 2));
  return (uni + bi) / 2;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    // Replace non-word characters with spaces, then collapse.
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function shingles(s: string, k: number): Set<string> {
  const tokens = s.split(' ').filter(Boolean);
  const out = new Set<string>();
  if (tokens.length === 0) return out;
  if (tokens.length < k) {
    for (const t of tokens) out.add(t);
    return out;
  }
  for (let i = 0; i <= tokens.length - k; i++) {
    out.add(tokens.slice(i, i + k).join(' '));
  }
  return out;
}

// ─── Numerical edit-magnitude score (sprint 05 §3 / C19) ────────────────────
//
// Authoritative numeric edit magnitude. Returns a fraction in [0, 1] where 0
// means no semantic change and 1 means a complete rewrite. Computed as
// 1 - semanticSimilarity, so the categorical classifier (MINOR/MODERATE/...)
// and the numeric score are derived from the same signal.
//
// Persisted on Message.editMagnitudeScore at trigger time so the graduation
// dashboard can average actual edit magnitudes instead of the pre-sprint-05
// character-position-equality proxy.

export function computeEditMagnitudeScore(original: string, final: string): number {
  const sim = semanticSimilarity(original, final);
  const score = 1 - sim;
  // Defensive clamp — JavaScript floating point can produce -0 or marginal
  // overshoots from the Jaccard arithmetic.
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(1, score));
}

// ─── Edit magnitude classification ───────────────────────────────────────────

export type EditMagnitude = 'MINOR' | 'MODERATE' | 'MAJOR' | 'WHOLESALE';

/**
 * Heuristic magnitude tier, driven by three signals:
 *   a) Jaccard similarity of original vs final
 *   b) relative length delta |len(final) - len(original)| / max(len, 1)
 *   c) sentence-level preservation — fraction of original sentences still
 *      present verbatim in final
 *
 * Thresholds were picked to be meaningful at the 50–800 char reply size the
 * copilot produces. They are intentionally coarse; edge-case tie-breaking is
 * done by the LLM diagnostic step downstream, so this function's job is just
 * to give the LLM a useful hint and to drive the reject-trigger threshold.
 */
export function classifyEditMagnitude(original: string, final: string): EditMagnitude {
  const similarity = semanticSimilarity(original, final);
  const lenOrig = original.length || 1;
  const lenDelta = Math.abs(final.length - original.length) / lenOrig;
  const preservation = sentencePreservation(original, final);

  // WHOLESALE: similarity collapsed and/or length moved dramatically and
  // almost no sentences were preserved. Matches the reject-trigger contract
  // (sprint brief §5 trigger 2: similarity < 0.3 → REJECT_TRIGGERED).
  if (similarity < 0.3 || (preservation < 0.15 && lenDelta > 0.6)) return 'WHOLESALE';
  // MAJOR: partial overlap but substantial rewrite.
  if (similarity < 0.55 || preservation < 0.4 || lenDelta > 0.5) return 'MAJOR';
  // MODERATE: noticeable edit but most content preserved.
  if (similarity < 0.8 || preservation < 0.75 || lenDelta > 0.2) return 'MODERATE';
  // Else a light touch-up — typo, punctuation, tone nudge.
  return 'MINOR';
}

function sentencePreservation(original: string, final: string): number {
  const origSentences = splitSentences(original);
  if (origSentences.length === 0) return 1;
  const finalSet = new Set(splitSentences(final));
  let kept = 0;
  for (const s of origSentences) {
    if (finalSet.has(s)) kept++;
  }
  return kept / origSentences.length;
}

function splitSentences(s: string): string[] {
  // Normalize before comparing — otherwise "check-in" vs "check in" are seen
  // as different sentences and a typo gets scored as no preservation.
  return s
    .split(/(?<=[.!?])\s+/)
    .map((x) => normalize(x))
    .filter(Boolean);
}
