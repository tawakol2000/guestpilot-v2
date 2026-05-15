/**
 * OpenAI client + retry wrapper for the Studio agent's OpenAI provider path.
 *
 * Mirrors the patterns proven in `backend/src/services/ai.service.ts` for the
 * main guest-reply pipeline:
 *   - Single shared `OpenAI` client constructed lazily on first use.
 *   - `withRetry()` — exponential backoff with jitter on 429 / 5xx.
 *   - Responses API is accessed via `(client.responses as any)` because the
 *     SDK types are still in flux for that surface.
 */
import OpenAI from 'openai';

let cachedClient: OpenAI | null = null;

export function getOpenAiClient(): OpenAI {
  if (cachedClient) return cachedClient;
  cachedClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? '' });
  return cachedClient;
}

const MAX_RETRIES = 6;

function isRetryable(err: unknown): boolean {
  const e = err as { status?: number; code?: string } | undefined;
  return (
    e?.status === 429 ||
    e?.status === 500 ||
    e?.status === 502 ||
    e?.status === 503
  );
}

/**
 * 2026-05-15 (L3): abort-aware sleep. If the caller passes a `signal`
 * that fires mid-backoff (client disconnect, user cancel), throw early
 * so the retry loop doesn't keep sleeping into a stream nobody's
 * listening to.
 */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('aborted');
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (options.signal?.aborted) throw new Error('aborted');
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err) || attempt === MAX_RETRIES) throw err;
      const baseDelay = Math.min(1000 * Math.pow(2, attempt), 60000);
      const jitter = baseDelay * (0.5 + Math.random() * 0.5);
      await sleep(jitter, options.signal);
    }
  }
  // Unreachable — the loop either returns or throws.
  throw new Error('withRetry: exhausted retries without resolving');
}
