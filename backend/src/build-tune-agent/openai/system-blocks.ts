/**
 * Studio system-prompt → OpenAI Responses API instructions.
 *
 * OpenAI's Responses API does NOT honour Anthropic-style `cache_control`
 * markers on individual content blocks. Instead it auto-caches any prompt
 * prefix ≥1024 tokens — which is exactly what our Region A+B prefix is
 * (~20k tokens, byte-identical across turns of the same mode).
 *
 * 2026-05-15 (C4 + C5): the static prefix (Region A + B = sharedPrefix +
 * modeAddendum) goes into `instructions` where OpenAI's prefix cache
 * attaches it to `prompt_cache_key`. The per-turn dynamic suffix
 * (Region C — pending snapshot, memory, state, conversation anchor) is
 * emitted as a separate system role input item so it doesn't break the
 * cacheable prefix. The cache key is now scoped by `conversationId` too
 * — two conversations of the same tenant share the underlying prefix
 * cache but get distinct attribution rows.
 */

export interface OpenAiSystemBundle {
  /** Cacheable Region A + B prefix. Always sent verbatim in `instructions`. */
  instructions: string;
  /**
   * Per-turn Region C suffix (pending snapshot, memory, state, conversation
   * anchor). Sent as a `system` role input item ahead of the replayed
   * history, so it does not invalidate the cached prefix.
   */
  dynamicSuffix: string;
  /** Cache attribution key — same prefix → same key → same cached prefix. */
  promptCacheKey: string;
  /** 24-hour retention is OpenAI's longest available window. */
  promptCacheRetention: '24h';
  /** Always true — Responses API requires `store: true` for cache attribution. */
  store: true;
}

export interface BuildOpenAiSystemBundleInput {
  cacheablePrefix: string;
  dynamicSuffix: string;
  tenantId: string;
  conversationId: string;
  mode: 'BUILD' | 'TUNE';
}

export function buildOpenAiSystemBundle(
  input: BuildOpenAiSystemBundleInput,
): OpenAiSystemBundle {
  return {
    instructions: input.cacheablePrefix,
    dynamicSuffix: input.dynamicSuffix,
    // 2026-05-15 (C4): include conversationId so cache attribution doesn't
    // bucket every conversation of a tenant under the same row. The
    // underlying prefix cache still shares storage across conversations
    // because the bytes are identical; the key is for analytics/routing.
    promptCacheKey: `studio-${input.tenantId}-${input.conversationId}-${input.mode.toLowerCase()}`,
    promptCacheRetention: '24h',
    store: true,
  };
}
