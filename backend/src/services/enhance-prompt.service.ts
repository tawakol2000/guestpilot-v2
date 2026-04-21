/**
 * Sprint 058-A F8 — enhance-prompt service.
 *
 * Thin wrapper around GPT-5-Nano that polishes a manager's composer draft
 * for clarity and concision. Preserves every factual detail; never adds
 * scope. Returns only the rewrite (no preamble, no commentary) so the
 * controller can shove it straight into the Studio composer.
 *
 * Why a dedicated service: the BUILD-agent tools all run through the
 * Claude Agent SDK; the enhance-prompt call is a one-shot OpenAI Nano
 * call that has no business sharing that plumbing. Keeping it in
 * `services/` mirrors summary.service.ts + task-manager.service.ts which
 * use the same model for similar light-weight rewrites.
 *
 * Rate limiting is handled at the controller layer (in-memory bucket
 * keyed by conversationId, 20/min — see build-controller.ts).
 *
 * Graceful degradation: if OPENAI_API_KEY is missing or the Nano call
 * throws, returns `{ ok: false, reason }` — the controller turns that
 * into a friendly toast; the Studio leaves the draft untouched. Never
 * throws from the happy path.
 */
import OpenAI from 'openai';

const ENHANCE_MODEL = 'gpt-5-nano';

const ENHANCE_INSTRUCTIONS = `Rewrite the manager's draft for clarity and concision. Preserve every factual detail. Do not add scope — do not invent new requirements, examples, or constraints the draft doesn't already contain. Do not answer the draft; rewrite it. Keep the rewrite at most 3 sentences. Return ONLY the rewrite — no preamble, no quotes around it, no commentary. If the draft is already clear and concise, you may return it unchanged.`;

export interface EnhancePromptResult {
  ok: boolean;
  rewrite?: string;
  reason?: 'empty_draft' | 'too_short' | 'no_api_key' | 'nano_error' | 'empty_response';
}

/** Minimum draft length before we'll call the LLM. Matches the frontend
 * ✨ button's show-threshold (≥ 10 characters). */
export const MIN_ENHANCE_CHARS = 10;

/** Hard cap on input length — keeps the Nano call bounded. */
export const MAX_ENHANCE_INPUT_CHARS = 4000;

/** Optional dependency-inject slot for tests — skips the real OpenAI call. */
export type EnhancePromptBackend = (draft: string) => Promise<string>;

/**
 * Produce a polished rewrite of the manager's draft. Never throws.
 *
 * @param draft  the composer text (post-trim).
 * @param opts.backend  test-only injection of the LLM call; when absent
 *                      the real OpenAI Responses API Nano call is used.
 */
export async function enhancePromptDraft(
  draft: string,
  opts: { backend?: EnhancePromptBackend } = {},
): Promise<EnhancePromptResult> {
  const trimmed = (draft ?? '').trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'empty_draft' };
  }
  if (trimmed.length < MIN_ENHANCE_CHARS) {
    return { ok: false, reason: 'too_short' };
  }
  const clipped =
    trimmed.length > MAX_ENHANCE_INPUT_CHARS
      ? trimmed.slice(0, MAX_ENHANCE_INPUT_CHARS)
      : trimmed;

  try {
    const rewrite = opts.backend
      ? await opts.backend(clipped)
      : await callNano(clipped);
    const cleaned = (rewrite ?? '').trim();
    if (cleaned.length === 0) {
      return { ok: false, reason: 'empty_response' };
    }
    return { ok: true, rewrite: cleaned };
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (/OPENAI_API_KEY|apiKey/i.test(msg)) {
      return { ok: false, reason: 'no_api_key' };
    }
    return { ok: false, reason: 'nano_error' };
  }
}

async function callNano(draft: string): Promise<string> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY missing');
  }
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await (openai.responses as any).create({
    model: ENHANCE_MODEL,
    instructions: ENHANCE_INSTRUCTIONS,
    input: draft,
    reasoning: { effort: 'minimal' },
    max_output_tokens: 300,
    store: false,
  });
  return String(response?.output_text ?? '').trim();
}

// ─── Controller-layer rate limiter helpers ─────────────────────────────

/**
 * Fixed-window bucket keyed by conversationId (or tenantId when no
 * conversation in scope). 20 requests per 60 seconds — enough headroom
 * for typical interactive use but caps runaway clients.
 */
export interface RateLimitBucket {
  windowStartMs: number;
  count: number;
}

export const ENHANCE_RATE_LIMIT_WINDOW_MS = 60_000;
export const ENHANCE_RATE_LIMIT_MAX = 20;

/**
 * Returns `{ ok: true }` if the request fits in the window; `{ ok: false }`
 * if the caller has exceeded the limit. Mutates `buckets` in place.
 * `now` is injected for testability.
 */
export function checkEnhanceRateLimit(
  buckets: Map<string, RateLimitBucket>,
  key: string,
  now: number = Date.now(),
): { ok: true; remaining: number } | { ok: false; retryAfterMs: number } {
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStartMs >= ENHANCE_RATE_LIMIT_WINDOW_MS) {
    buckets.set(key, { windowStartMs: now, count: 1 });
    return { ok: true, remaining: ENHANCE_RATE_LIMIT_MAX - 1 };
  }
  if (bucket.count >= ENHANCE_RATE_LIMIT_MAX) {
    const retryAfterMs = ENHANCE_RATE_LIMIT_WINDOW_MS - (now - bucket.windowStartMs);
    return { ok: false, retryAfterMs };
  }
  bucket.count += 1;
  return { ok: true, remaining: ENHANCE_RATE_LIMIT_MAX - bucket.count };
}
