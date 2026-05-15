/**
 * Studio system-prompt → OpenAI Responses API instructions.
 *
 * OpenAI's Responses API does NOT honour Anthropic-style `cache_control`
 * markers on individual content blocks. Instead it auto-caches any prompt
 * prefix ≥1024 tokens — which is exactly what our Region A+B prefix is
 * (~20k tokens, byte-identical across turns of the same mode).
 *
 * We pass the assembled system prompt as a single string in
 * `instructions`, and tag the request with `prompt_cache_key` so OpenAI
 * tracks cache attribution per (tenant, mode) tuple.
 */
import { splitSystemPromptIntoBlocks } from '../prompt-cache-blocks';

export interface OpenAiSystemBundle {
  /** Single concatenated instructions string for the Responses API. */
  instructions: string;
  /** Cache attribution key — same prefix → same key → same cached prefix. */
  promptCacheKey: string;
  /** 24-hour retention is OpenAI's longest available window. */
  promptCacheRetention: '24h';
  /** Always true — Responses API requires `store: true` for cache attribution. */
  store: true;
}

export interface BuildOpenAiSystemBundleInput {
  assembledSystemPrompt: string;
  tenantId: string;
  mode: 'BUILD' | 'TUNE';
}

export function buildOpenAiSystemBundle(
  input: BuildOpenAiSystemBundleInput,
): OpenAiSystemBundle {
  // Splitting is purely diagnostic for the OpenAI path — the blocks are
  // joined right back into a single string. We keep the call so future
  // sprints (e.g. moving the dynamic suffix into a separate `input` item)
  // can wire it without re-walking the assembled string.
  const blocks = splitSystemPromptIntoBlocks(input.assembledSystemPrompt);
  const instructions = blocks.map((b) => b.text).join('\n\n');

  return {
    instructions,
    promptCacheKey: `studio-${input.tenantId}-${input.mode.toLowerCase()}`,
    promptCacheRetention: '24h',
    store: true,
  };
}
