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
    try {
      const res = await axios.get(
        `https://translate.googleapis.com/translate_a/single?${params.toString()}`,
        { timeout: 10_000 }
      );
      // Google returns: [[["translated", "source", ...], ...], ...lang-info..., "detectedLang", ...]
      const segments = (res.data?.[0] as Array<[string]> | undefined) ?? [];
      const translated = segments.map(part => part[0]).join('').trim();
      const detectedSourceLang: string | undefined =
        typeof res.data?.[2] === 'string' ? res.data[2] : undefined;

      if (!translated) throw new Error('empty translation');
      ok = true;
      return { translated, detectedSourceLang };
    } finally {
      console.log(
        `[Translation] provider=google ms=${Date.now() - t0} ok=${ok}`
      );
    }
  }
}

// Default export — controllers depend on the interface via this singleton, not
// on the concrete class. Swap the right-hand side to change providers.
export const translationService: TranslationProvider = new GoogleFreeTranslationProvider();
