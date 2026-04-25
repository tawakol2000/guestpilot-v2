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
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  assembleSystemPrompt,
  buildSharedPrefix,
  type AgentMode,
  type SystemPromptContext,
} from '../system-prompt';
import { SHARED_MODE_BOUNDARY_MARKER, DYNAMIC_BOUNDARY_MARKER } from '../config';
import {
  splitSystemPromptIntoBlocks,
  buildCacheStatsPayload,
} from '../prompt-cache-blocks';

// Anthropic's prompt-caching minimum is model-dependent. Sonnet/Opus
// 4.5 and 4.6 (the tuning-agent's generator) require ≥2048 tokens for
// an independent cached layer; the earlier 1024-token floor applies to
// older Sonnet/Opus families we no longer target. Bumped 2026-04-19
// (sprint 045, session 3) after the user flagged the older threshold
// was stale — see PROGRESS.md Decisions.
const CACHE_MIN_TOKENS = 2048;

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

/**
 * Tools-only token estimate. Scrapes the tool descriptions from each
 * `src/build-tune-agent/tools/*.ts` source file (every tool is wired up
 * with `tool('name', 'description', schema, handler)`) and sums their
 * character weight. Not byte-exact — the real `tools` array sent to
 * Anthropic also includes the zod schema's JSONSchema serialisation,
 * which this heuristic ignores. Good enough for order-of-magnitude
 * regression detection.
 *
 * We log the number in CI so PROGRESS.md can record it; we deliberately
 * do NOT assert a floor — the tools array is permitted to be below the
 * 2048-token per-layer cache minimum (the cumulative prefix still caches).
 */
function estimateToolsOnly(): { chars: number; toolCount: number } {
  const toolsDir = join(__dirname, '..', 'tools');
  // Case 1: inline string description — `tool('name',\n    'description',`
  const inlineSingle = /\btool\(\s*\n\s*'([a-z_]+)'\s*,\s*\n\s*'([\s\S]*?)'\s*,/g;
  const inlineDouble = /\btool\(\s*\n\s*'([a-z_]+)'\s*,\s*\n\s*"([\s\S]*?)"\s*,/g;
  // Case 2: named constant — `const DESCRIPTION = \`...\`` (+ `tool('name', DESCRIPTION, ...)`)
  const describedCall = /\btool\(\s*\n?\s*'([a-z_]+)'\s*,\s*\n?\s*([A-Z_]+)\s*,/g;
  const describedConst = (id: string) =>
    new RegExp(`\\bconst\\s+${id}\\s*=\\s*\`([\\s\\S]*?)\`;`, 'g');

  let totalChars = 0;
  let count = 0;
  for (const entry of readdirSync(toolsDir)) {
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    if (entry === 'names.ts' || entry === 'types.ts' || entry === 'index.ts') continue;
    if (entry === 'build-transaction.ts') continue;
    const src = readFileSync(join(toolsDir, entry), 'utf8');

    for (const pattern of [inlineSingle, inlineDouble]) {
      pattern.lastIndex = 0;
      let hit: RegExpMatchArray | null;
      while ((hit = pattern.exec(src)) !== null) {
        totalChars += hit[1].length + hit[2].length;
        count++;
      }
    }

    describedCall.lastIndex = 0;
    let call: RegExpMatchArray | null;
    while ((call = describedCall.exec(src)) !== null) {
      const [, name, constName] = call;
      const constRe = describedConst(constName);
      const constMatch = constRe.exec(src);
      if (constMatch) {
        totalChars += name.length + constMatch[1].length;
        count++;
      }
    }
  }
  return { chars: totalChars, toolCount: count };
}

// ─── F3: explicit cache-block structure assertions (sprint 056-A) ──────────

test('F3: splitSystemPromptIntoBlocks returns exactly 3 blocks when markers present', () => {
  for (const mode of ['TUNE', 'BUILD'] as const) {
    const assembled = assembleSystemPrompt(fixtureCtx(mode));
    const blocks = splitSystemPromptIntoBlocks(assembled);
    assert.equal(blocks.length, 3, `${mode}: must produce exactly 3 blocks`);
  }
});

test('F3: Region A block (index 0) has shouldCache=true and region="region-a"', () => {
  const assembled = assembleSystemPrompt(fixtureCtx('BUILD'));
  const blocks = splitSystemPromptIntoBlocks(assembled);
  assert.equal(blocks[0]!.shouldCache, true, 'Region A must be cached');
  assert.equal(blocks[0]!.region, 'region-a');
});

test('F3: Region B block (index 1) has shouldCache=true and region="region-b"', () => {
  const assembled = assembleSystemPrompt(fixtureCtx('BUILD'));
  const blocks = splitSystemPromptIntoBlocks(assembled);
  assert.equal(blocks[1]!.shouldCache, true, 'Region B must be cached');
  assert.equal(blocks[1]!.region, 'region-b');
});

test('F3: Region C block (index 2) has shouldCache=false and region="region-c"', () => {
  const assembled = assembleSystemPrompt(fixtureCtx('BUILD'));
  const blocks = splitSystemPromptIntoBlocks(assembled);
  assert.equal(blocks[2]!.shouldCache, false, 'Region C (dynamic suffix) must NOT be cached');
  assert.equal(blocks[2]!.region, 'region-c');
});

test('F3: Region A block text is byte-identical across two BUILD turns with same inputs', () => {
  const ctx = fixtureCtx('BUILD');
  const blocks1 = splitSystemPromptIntoBlocks(assembleSystemPrompt(ctx));
  const blocks2 = splitSystemPromptIntoBlocks(assembleSystemPrompt(ctx));
  assert.equal(
    blocks1[0]!.text,
    blocks2[0]!.text,
    'Region A must be byte-identical across turns (golden file / stability guard)',
  );
});

test('F3: Region A block is shared between BUILD and TUNE modes (same cached bytes)', () => {
  const buildBlocks = splitSystemPromptIntoBlocks(assembleSystemPrompt(fixtureCtx('BUILD')));
  const tuneBlocks = splitSystemPromptIntoBlocks(assembleSystemPrompt(fixtureCtx('TUNE')));
  assert.equal(
    buildBlocks[0]!.text,
    tuneBlocks[0]!.text,
    'Region A must be byte-identical across BUILD and TUNE for automatic prefix caching to work',
  );
});

test('F3: block texts round-trip (concatenation = original minus boundary markers)', () => {
  const assembled = assembleSystemPrompt(fixtureCtx('TUNE'));
  const blocks = splitSystemPromptIntoBlocks(assembled);
  // Each block's text appears in the assembled prompt — do a loose check
  // that all three non-empty blocks' first 40 chars are present in assembled.
  for (const b of blocks) {
    const sample = b.text.trim().slice(0, 40);
    if (sample.length > 0) {
      assert.ok(
        assembled.includes(sample),
        `block text sample "${sample}" must appear in assembled prompt`,
      );
    }
  }
});

test('F3: buildCacheStatsPayload computes cachedFraction correctly', () => {
  const stats = buildCacheStatsPayload({
    input_tokens: 100,
    cache_read_input_tokens: 300,
    cache_creation_input_tokens: 0,
  });
  assert.equal(stats.inputTokens, 100);
  assert.equal(stats.cacheReadTokens, 300);
  assert.equal(stats.cachedFraction, 0.75, 'cachedFraction = cached / (input + cached)');
  assert.equal(stats.explicitCacheControlWired, false, 'SDK limitation flag must be false');
});

test('F3: buildCacheStatsPayload handles zero denominator without NaN', () => {
  const stats = buildCacheStatsPayload({});
  assert.equal(stats.cachedFraction, 0);
  assert.equal(stats.inputTokens, 0);
  assert.equal(stats.cacheReadTokens, 0);
});

// ─── Baseline token counts ────────────────────────────────────────────────

// Emit the baseline numbers to stdout so PROGRESS.md can record them.
// Also asserts a floor on Region A (shared prefix) tokens — sprint
// 060-A added three new blocks (<capabilities>, <context_handling>,
// <never_do>) plus the PERSONA meta-firewall paragraph, taking the
// Region-A baseline from ~4200 → ~5650 tokens. Sprint 060-B then
// compressed the prompt (PRINCIPLES, RESPONSE_CONTRACT, CAPABILITIES,
// CITATION_GRAMMAR, CONTEXT_HANDLING, PLATFORM_CONTEXT, NEVER_DO,
// CRITICAL_RULES, TUNE/BUILD addenda) cutting ~900 tokens from
// Region A. Sprint 060-D Phase 11 then slimmed TOOLS_DOC wholesale
// (per-tool prose moved to schema-level descriptions), cutting another
// ~900 tokens. Post-060-D Region A is ~3800 tokens. Floor set at
// 3600 so accidental deletion of any load-bearing block still trips
// the test, while the slim cuts no longer trigger the old 4500 floor.
test('record baseline token counts', () => {
  const shared = buildSharedPrefix();
  const tuneFull = assembleSystemPrompt(fixtureCtx('TUNE'));
  const buildFull = assembleSystemPrompt(fixtureCtx('BUILD'));
  const dynamicMarker = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__';
  const tuneCacheable = tuneFull.slice(0, tuneFull.indexOf(dynamicMarker));
  const buildCacheable = buildFull.slice(0, buildFull.indexOf(dynamicMarker));
  const sharedEnd = tuneFull.indexOf(SHARED_MODE_BOUNDARY_MARKER);
  const sharedOnly = tuneFull.slice(0, sharedEnd);
  const toolsOnly = estimateToolsOnly();
  const toolsTokens = estimateTokens('x'.repeat(toolsOnly.chars));

  // Sprint 060-C re-baseline — adding the <state_machine> block
  // grew Region A by ~750 tokens (post-060-D ~3809 → post-060-C
  // ~4554). Floor bumped to 4300 with a comfortable margin: well
  // above CACHE_MIN_TOKENS (2048), and accidental deletion of a
  // load-bearing block (CAPABILITIES / CONTEXT_HANDLING / NEVER_DO
  // / STATE_MACHINE) still trips this assertion.
  const SPRINT_060C_REGION_A_TOKEN_FLOOR = 4300;
  const sharedTokens = estimateTokens(sharedOnly);
  assert.ok(
    sharedTokens >= SPRINT_060C_REGION_A_TOKEN_FLOOR,
    `Region A must be ≥${SPRINT_060C_REGION_A_TOKEN_FLOOR} tokens post-060-C (got ~${sharedTokens})`,
  );

  // Single structured line — easy to grep out of CI logs into PROGRESS.md.
  // eslint-disable-next-line no-console
  console.log(
    `[prompt-cache-stability] baseline chars/tokens:` +
      ` shared_prefix=${sharedOnly.length}/${estimateTokens(sharedOnly)}` +
      ` tune_cacheable=${tuneCacheable.length}/${estimateTokens(tuneCacheable)}` +
      ` build_cacheable=${buildCacheable.length}/${estimateTokens(buildCacheable)}` +
      ` tools_only=${toolsOnly.chars}/${toolsTokens}` +
      ` tools_count=${toolsOnly.toolCount}`
  );
  if (toolsTokens < CACHE_MIN_TOKENS) {
    // eslint-disable-next-line no-console
    console.log(
      `[prompt-cache-stability] NOTE: tools_only (${toolsTokens} tokens) is below the ` +
        `${CACHE_MIN_TOKENS}-token per-layer cache minimum for Sonnet 4.5/4.6. This is NOT a bug — ` +
        `the cumulative system+tools prefix still caches once the boundary numbers above ` +
        `(shared_prefix + mode-addendum) clear the threshold.`
    );
  }
  assert.ok(shared.length > 0);
});
