// Feature 042 — Inbound message translation service.
//
// Provider-abstracted so swapping the free Google endpoint for a paid / official
// provider (Google Cloud Translation, DeepL, OpenAI, etc.) later is a one-file
// change. Translation *quality* is identical between the free gtx endpoint and
// the paid Cloud Translation API (same underlying model); the abstraction is
// motivated by rate-limit and terms-of-service risk, not quality.
import axios from 'axios';

export interface TranslationProvider {
  translate(
    text: string,
    opts: { targetLang: 'en' }
  ): Promise<{ translated: string; detectedSourceLang?: string }>;
}

export class GoogleFreeTranslationProvider implements TranslationProvider {
  async translate(
    text: string,
    opts: { targetLang: 'en' }
  ): Promise<{ translated: string; detectedSourceLang?: string }> {
    const params = new URLSearchParams({
      client: 'gtx',
      sl: 'auto',
      tl: opts.targetLang,
      dt: 't',
      q: text,
    });

    const t0 = Date.now();
    let ok = false;
    let attempts = 0;
    try {
      // Bugfix (2026-04-22): the free Google gtx endpoint is rate-limit
      // prone (429) and occasionally returns 5xx. Previously a single
      // axios call surfaced any failure as 502 to the operator with no
      // retry. Wrap with a small exponential backoff (3 attempts: 0,
      // 250ms, 750ms) for 429/5xx/timeout — quality unchanged, but the
      // translate-button reliability under load goes up.
      const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
      let lastErr: unknown = null;
      for (attempts = 1; attempts <= 3; attempts++) {
        try {
          const res = await axios.get(
            `https://translate.googleapis.com/translate_a/single?${params.toString()}`,
            { timeout: 10_000 }
          );
          // Google returns: [[["translated", "source", ...], ...], ...lang-info..., "detectedLang", ...]
          const segments = (res.data?.[0] as Array<[string]> | undefined) ?? [];
          const translated = segments.map((part) => part[0]).join('').trim();
          const detectedSourceLang: string | undefined =
            typeof res.data?.[2] === 'string' ? res.data[2] : undefined;

          if (!translated) throw new Error('empty translation');
          ok = true;
          return { translated, detectedSourceLang };
        } catch (err) {
          lastErr = err;
          const status = (err as any)?.response?.status as number | undefined;
          const isTimeout = (err as any)?.code === 'ECONNABORTED';
          const retryable = isTimeout || (status !== undefined && RETRYABLE_STATUS.has(status));
          if (!retryable || attempts === 3) throw err;
          const backoffMs = attempts === 1 ? 250 : 750;
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
      throw lastErr;
    } finally {
      console.log(
        `[Translation] provider=google ms=${Date.now() - t0} ok=${ok} attempts=${attempts}`
      );
    }
  }
}

// Default export — controllers depend on the interface via this singleton, not
// on the concrete class. Swap the right-hand side to change providers.
export const translationService: TranslationProvider = new GoogleFreeTranslationProvider();
