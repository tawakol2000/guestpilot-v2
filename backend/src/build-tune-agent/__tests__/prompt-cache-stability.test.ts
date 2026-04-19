/**
 * Prefix-stability + token-budget regression guard (sprint 045, Gate 2).
 *
 * Run:  npx tsx --test src/build-tune-agent/__tests__/prompt-cache-stability.test.ts
 *
 * Why this test exists: the cache_control divergence documented in
 * specs/045-build-mode/PROGRESS.md means we rely on Anthropic's *automatic*
 * prefix caching matching byte-identical regions across requests. If
 * someone later injects a timestamp, request id, or any other per-
 * invocation drift into the shared system section, automatic caching
 * silently caches less and prod cost climbs without an alarm.
 *
 * Two assertions per mode (BUILD + TUNE), plus a TUNE vs BUILD divergence
 * check that confirms the Region-A prefix is shared across modes (i.e.
 * the cache entries share the Region-A bytes and differ only at the
 * mode-addendum boundary).
 *
 * Token estimate: uses a simple characters × 0.25 heuristic (Anthropic's
 * "rule of thumb for English text"). Exact counts are not the goal —
 * order-of-magnitude regression detection is.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assembleSystemPrompt,
  buildSharedPrefix,
  type AgentMode,
  type SystemPromptContext,
} from '../system-prompt';
import { SHARED_MODE_BOUNDARY_MARKER } from '../config';

// Minimum for automatic prefix caching on Sonnet/Opus per Anthropic's
// prompt-caching docs. Prefixes under this threshold will not be cached
// as an independent layer (the cumulative prefix may still hit cache).
const CACHE_MIN_TOKENS = 1024;

// Character-count heuristic. Anthropic's own estimate for English text
// is ~4 chars/token. Good enough for order-of-magnitude regression.
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

function fixtureCtx(mode: AgentMode): SystemPromptContext {
  const base: SystemPromptContext = {
    tenantId: 'fixture-tenant',
    conversationId: 'fixture-conv',
    anchorMessageId: null,
    selectedSuggestionId: null,
    memorySnapshot: [],
    pending: { total: 0, topThree: [], countsByCategory: {} },
    mode,
  };
  if (mode === 'BUILD') {
    base.tenantState = {
      posture: 'GREENFIELD',
      systemPromptStatus: 'EMPTY',
      systemPromptEditCount: 0,
      sopsDefined: 0,
      sopsDefaulted: 0,
      faqsGlobal: 0,
      faqsPropertyScoped: 0,
      customToolsDefined: 0,
      propertiesImported: 0,
      lastBuildSessionAt: null,
    };
    base.interviewProgress = {
      loadBearingFilled: 0,
      loadBearingTotal: 6,
      nonLoadBearingFilled: 0,
      nonLoadBearingTotal: 14,
      defaultedSlots: [],
    };
  }
  return base;
}

test('Region A (shared prefix) is byte-identical across renders', () => {
  const a = buildSharedPrefix();
  const b = buildSharedPrefix();
  const c = buildSharedPrefix();
  assert.equal(a, b, 'shared prefix must not drift between calls');
  assert.equal(b, c, 'shared prefix must not drift between calls');
});

test('Region A is shared BUILD ↔ TUNE (same cached bytes)', () => {
  // The first region of the assembled prompt — up to the shared/mode
  // boundary marker — must be identical in both modes. This is what
  // Anthropic's automatic prefix cache keys on.
  const tune = assembleSystemPrompt(fixtureCtx('TUNE'));
  const build = assembleSystemPrompt(fixtureCtx('BUILD'));
  const tuneRegionA = tune.slice(0, tune.indexOf(SHARED_MODE_BOUNDARY_MARKER));
  const buildRegionA = build.slice(0, build.indexOf(SHARED_MODE_BOUNDARY_MARKER));
  assert.equal(tuneRegionA, buildRegionA, 'Region A must be shared across modes');
});

for (const mode of ['TUNE', 'BUILD'] as const) {
  test(`[${mode}] assembled prompt is byte-identical across renders with same inputs`, () => {
    const first = assembleSystemPrompt(fixtureCtx(mode));
    const second = assembleSystemPrompt(fixtureCtx(mode));
    assert.equal(
      first,
      second,
      `${mode} prompt must not leak timestamps, random ids, or other drift between renders`
    );
  });

  test(`[${mode}] cacheable prefix (Region A + mode addendum) is above caching minimum`, () => {
    const prompt = assembleSystemPrompt(fixtureCtx(mode));
    // Cacheable prefix = everything up through the dynamic-suffix
    // boundary. Since the boundary markers are literal strings in the
    // assembled text, slicing at the marker gives us the exact bytes
    // that enter Anthropic's automatic cache.
    const dynamicMarker = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__';
    const cacheableEnd = prompt.indexOf(dynamicMarker);
    assert.ok(cacheableEnd > 0, 'dynamic boundary marker must be present');
    const cacheable = prompt.slice(0, cacheableEnd);
    const tokens = estimateTokens(cacheable);
    assert.ok(
      tokens >= CACHE_MIN_TOKENS,
      `${mode} cacheable prefix must be ≥${CACHE_MIN_TOKENS} tokens to hit Anthropic's ` +
        `automatic prefix cache (got ~${tokens} tokens)`
    );
  });
}

// Emit the baseline numbers to stdout so PROGRESS.md can record them.
// Not an assertion — informational only, won't fail the run.
test('record baseline token counts', () => {
  const shared = buildSharedPrefix();
  const tuneFull = assembleSystemPrompt(fixtureCtx('TUNE'));
  const buildFull = assembleSystemPrompt(fixtureCtx('BUILD'));
  const dynamicMarker = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__';
  const tuneCacheable = tuneFull.slice(0, tuneFull.indexOf(dynamicMarker));
  const buildCacheable = buildFull.slice(0, buildFull.indexOf(dynamicMarker));
  const sharedEnd = tuneFull.indexOf(SHARED_MODE_BOUNDARY_MARKER);
  const sharedOnly = tuneFull.slice(0, sharedEnd);

  // Single structured line — easy to grep out of CI logs into PROGRESS.md.
  // eslint-disable-next-line no-console
  console.log(
    `[prompt-cache-stability] baseline chars/tokens:` +
      ` shared_prefix=${sharedOnly.length}/${estimateTokens(sharedOnly)}` +
      ` tune_cacheable=${tuneCacheable.length}/${estimateTokens(tuneCacheable)}` +
      ` build_cacheable=${buildCacheable.length}/${estimateTokens(buildCacheable)}`
  );
  assert.ok(shared.length > 0);
});
