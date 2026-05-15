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

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err) || attempt === MAX_RETRIES) throw err;
      const baseDelay = Math.min(1000 * Math.pow(2, attempt), 60000);
      const jitter = baseDelay * (0.5 + Math.random() * 0.5);
      await sleep(jitter);
    }
  }
  // Unreachable — the loop either returns or throws.
  throw new Error('withRetry: exhausted retries without resolving');
}
