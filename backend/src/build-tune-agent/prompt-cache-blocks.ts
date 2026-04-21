/**
 * Sprint 056-A F3 — Explicit prompt-cache breakpoint helpers.
 *
 * The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) accepts
 * `systemPrompt` as `string | { type: 'preset'; ... }` only — structured
 * content blocks with `cache_control` are not exposed through this surface
 * (sdk.d.ts:1475). Sending explicit `cache_control` markers therefore
 * requires bypassing the Agent SDK in favour of a direct `@anthropic-ai/sdk`
 * call, which is a larger architectural change than this sprint scopes.
 *
 * This module provides:
 *   1. `splitSystemPromptIntoBlocks()` — deterministically splits an
 *      assembled system-prompt string into the three cache regions as
 *      typed content block descriptors. Used by tests to assert block
 *      structure, and will feed the real API call when the SDK is
 *      bypassed in a future sprint.
 *   2. `logCacheBlockStructure()` — emits the block structure to the
 *      console so the deployer can verify the split is correct without
 *      a live API call. Called by the runtime every turn.
 *
 * SDK LIMITATION NOTE: Automatic prefix caching (Anthropic caches any
 * prompt ≥1024 tokens with the same prefix) should apply here, since
 * Regions A and B are byte-identical across turns. Explicit `cache_control`
 * blocks would guarantee the caching behaviour and allow per-block
 * attribution in Langfuse — but cannot be wired until the Agent SDK
 * exposes a structured system-prompt surface.
 *
 * When the SDK is eventually bypassed, replace the `systemPrompt: string`
 * in runtime.ts with the blocks returned by `splitSystemPromptIntoBlocks`
 * attached to a direct `@anthropic-ai/sdk` messages.create call, and
 * attach `cache_control: { type: 'ephemeral' }` to blocks 0 and 1 only
 * (block 2 is the dynamic suffix and must not be cached).
 */

import {
  SHARED_MODE_BOUNDARY_MARKER,
  DYNAMIC_BOUNDARY_MARKER,
} from './config';

/** Describes one content block as it would be sent to the Anthropic API. */
export interface CacheBlock {
  /** The text content of this region. */
  text: string;
  /**
   * Whether a `cache_control: { type: 'ephemeral' }` header should be
   * attached to this block. True for Region A (shared) and Region B
   * (mode addendum); false for Region C (dynamic suffix).
   */
  shouldCache: boolean;
  /** Debugging label: 'region-a', 'region-b', or 'region-c'. */
  region: 'region-a' | 'region-b' | 'region-c';
}

/**
 * Split an assembled system-prompt string into three typed cache blocks.
 *
 * Handles the case where one or both boundary markers are absent
 * (returns a single uncached block) so tests and production code never
 * throw even if the prompt assembler changes.
 */
export function splitSystemPromptIntoBlocks(assembled: string): CacheBlock[] {
  const sharedBoundaryIdx = assembled.indexOf(SHARED_MODE_BOUNDARY_MARKER);
  const dynamicBoundaryIdx = assembled.indexOf(DYNAMIC_BOUNDARY_MARKER);

  if (sharedBoundaryIdx === -1 || dynamicBoundaryIdx === -1) {
    // Boundary markers missing — treat the whole prompt as a single
    // uncached block. This should never happen in production but we
    // degrade gracefully rather than throw.
    return [
      {
        text: assembled,
        shouldCache: false,
        region: 'region-a',
      },
    ];
  }

  const regionA = assembled.slice(0, sharedBoundaryIdx).trimEnd();
  const regionB = assembled
    .slice(sharedBoundaryIdx + SHARED_MODE_BOUNDARY_MARKER.length, dynamicBoundaryIdx)
    .trim();
  const regionC = assembled
    .slice(dynamicBoundaryIdx + DYNAMIC_BOUNDARY_MARKER.length)
    .trim();

  return [
    { text: regionA, shouldCache: true, region: 'region-a' },
    { text: regionB, shouldCache: true, region: 'region-b' },
    { text: regionC, shouldCache: false, region: 'region-c' },
  ];
}

/**
 * Log the block structure to the console so the deployer can verify
 * the split is correct without a live API call. Emitted every turn
 * by the runtime (debug-level only — not visible in prod unless
 * NODE_DEBUG includes 'tuning-agent').
 *
 * In a future sprint this will also be the data source for attaching
 * actual `cache_control` blocks to the API call.
 */
export function logCacheBlockStructure(
  tenantId: string,
  assembled: string,
): { blocks: CacheBlock[]; charCounts: number[] } {
  const blocks = splitSystemPromptIntoBlocks(assembled);
  const charCounts = blocks.map((b) => b.text.length);

  // Only emit in debug mode (NODE_DEBUG=tuning-agent or DEBUG=*) to
  // avoid noise in production. Cache structure is already visible via
  // the '[TuningAgent] usage' log line (cache_read / cache_created).
  if (process.env.NODE_DEBUG?.includes('tuning-agent') || process.env.DEBUG === '*') {
    console.log(
      `[TuningAgent] cache-blocks tenant=${tenantId}` +
        blocks
          .map((b, i) => ` block${i}(${b.region},cache=${b.shouldCache},chars=${charCounts[i]})`)
          .join('')
    );
  }

  return { blocks, charCounts };
}

/**
 * Shapes the cache-stats payload for the `data-cache-stats` SSE part.
 *
 * Emitted at turn-end by the runtime so LangFuse can tag each turn
 * with token-level cache attribution. The UI does NOT render this
 * part — it is for observability only.
 */
export interface CacheStatsPayload {
  cacheReadTokens: number;
  cacheCreatedTokens: number;
  inputTokens: number;
  cachedFraction: number;
  /**
   * SDK limitation note: explicit cache_control blocks could not be wired
   * because the Agent SDK only accepts `systemPrompt: string`. Automatic
   * prefix caching applies instead. This flag lets a future sprint
   * detect whether explicit wiring has been completed.
   */
  explicitCacheControlWired: false;
}

export function buildCacheStatsPayload(usage: {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}): CacheStatsPayload {
  const inp = usage.input_tokens ?? 0;
  const cached = usage.cache_read_input_tokens ?? 0;
  const created = usage.cache_creation_input_tokens ?? 0;
  const denom = inp + cached;
  const cachedFraction = denom === 0 ? 0 : cached / denom;
  return {
    cacheReadTokens: cached,
    cacheCreatedTokens: created,
    inputTokens: inp,
    cachedFraction,
    explicitCacheControlWired: false,
  };
}

// ─── Sprint 058-A F1 — direct-transport block/tool builders ─────────────
//
// When BUILD_AGENT_DIRECT_TRANSPORT=true the runtime bypasses the Claude
// Agent SDK's `systemPrompt: string` surface and calls
// `@anthropic-ai/sdk`'s `messages.create({ stream: true })` directly with a
// structured system-prompt content-block array so we can attach explicit
// `cache_control: { type: 'ephemeral' }` markers per Anthropic prompt-cache
// rules. The helpers below produce the exact shapes the direct path sends.
//
// Shape reference (Anthropic docs, prompt caching):
//   system: [
//     { type: 'text', text: regionA, cache_control: { type: 'ephemeral' } },
//     { type: 'text', text: regionB, cache_control: { type: 'ephemeral' } },
//     { type: 'text', text: regionC },            // dynamic, uncached
//   ]
// Caching applies to the entire prefix UP TO a cache_control marker, so
// attaching ephemeral to blocks 0 and 1 caches (A) and (A+B). Block C is
// the short per-turn dynamic suffix.

/** Anthropic-shaped text block for the `system` parameter. */
export interface AnthropicSystemTextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

/**
 * Produce the three-block Anthropic `system` parameter from an assembled
 * prompt. Blocks 0 and 1 carry `cache_control: { type: 'ephemeral' }`;
 * block 2 is the dynamic suffix and carries no cache marker.
 *
 * If the boundary markers are missing (shouldn't happen in production),
 * returns a single uncached block — the caller still sends a valid prompt,
 * just without cache benefits. Matches the graceful fallback in
 * splitSystemPromptIntoBlocks().
 */
export function buildAnthropicSystemBlocks(
  assembled: string,
): AnthropicSystemTextBlock[] {
  const regions = splitSystemPromptIntoBlocks(assembled);
  if (regions.length === 1) {
    // Boundary markers missing — single uncached block.
    return [{ type: 'text', text: regions[0].text }];
  }
  return regions.map<AnthropicSystemTextBlock>((r) =>
    r.shouldCache
      ? { type: 'text', text: r.text, cache_control: { type: 'ephemeral' } }
      : { type: 'text', text: r.text },
  );
}

/**
 * Attach a single `cache_control: { type: 'ephemeral' }` to the LAST entry
 * of a tools[] array, cloning the input so the caller's array is not
 * mutated. Per Anthropic prompt-cache rules, this caches the full tools
 * block for all subsequent turns with the same tools prefix.
 *
 * Returns the original array unchanged if it is empty (no last tool to
 * mark). Never throws.
 */
export function withLastToolCacheControl<T extends Record<string, unknown>>(
  tools: T[],
): T[] {
  if (!Array.isArray(tools) || tools.length === 0) return tools;
  const last = tools[tools.length - 1];
  const marked = { ...last, cache_control: { type: 'ephemeral' } } as T;
  return [...tools.slice(0, -1), marked];
}

/**
 * Env-flag check for the direct-transport path. Default OFF — the SDK path
 * stays the default until the MCP tool-call loop is reproduced in the
 * direct transport (tracked separately; see runtime-direct.ts header).
 */
export function isDirectTransportEnabled(): boolean {
  const raw = process.env.BUILD_AGENT_DIRECT_TRANSPORT;
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return (
    normalized === '1' ||
    normalized === 'true' ||
    normalized === 'yes' ||
    normalized === 'on'
  );
}
