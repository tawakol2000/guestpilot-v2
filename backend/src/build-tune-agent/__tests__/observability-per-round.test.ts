/**
 * Feature 047 PR 1 — per-round Langfuse emit envelope tests.
 *
 * Run:  JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/observability-per-round.test.ts
 *
 * Tests the pure builder `buildPerRoundGenerationParams` which captures the
 * shape of one round's logAgentGeneration call. Doing it at the builder
 * level avoids mocking the Anthropic Agent SDK + Langfuse client; if the
 * builder is correct, the actual call site in sdk-runner.ts (a single
 * `logAgentGeneration(buildPerRoundGenerationParams(...))` invocation per
 * SDK assistant message in the for-await loop) is correct by construction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPerRoundGenerationParams } from '../../services/observability.service';

test('per-round params: produces a tuning-agent.query generation with monotonic roundIndex across 5 rounds', () => {
  const usages = [
    { input_tokens: 18000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 12000 },
    { input_tokens: 1000,  output_tokens: 150, cache_read_input_tokens: 25000, cache_creation_input_tokens: 8000 },
    { input_tokens: 800,   output_tokens: 100, cache_read_input_tokens: 38000, cache_creation_input_tokens: 5000 },
    { input_tokens: 500,   output_tokens: 80,  cache_read_input_tokens: 50000, cache_creation_input_tokens: 3000 },
    { input_tokens: 300,   output_tokens: 60,  cache_read_input_tokens: 60000, cache_creation_input_tokens: 1000 },
  ];

  const params = usages.map((u, idx) =>
    buildPerRoundGenerationParams({
      model: 'claude-sonnet-4-6',
      roundIndex: idx + 1,
      usage: u,
      toolNamesInRound: idx < 4 ? [`studio_get_artifact`] : [],
      tenantId: 't-1',
      conversationId: 'c-1',
    }),
  );

  // 5 rounds emitted
  assert.equal(params.length, 5);

  // Monotonic roundIndex 1..5
  for (let i = 0; i < params.length; i += 1) {
    const md = params[i].metadata as { roundIndex: number };
    assert.equal(md.roundIndex, i + 1);
  }

  // Name is the parent span name (audit script groups by this)
  for (const p of params) {
    assert.equal(p.name, 'tuning-agent.query');
    assert.equal(p.model, 'claude-sonnet-4-6');
  }

  // Summed input across rounds matches the usage feed (verifies no
  // double-counting or off-by-one in the builder)
  const summedInput = params.reduce((s, p) => s + p.inputTokens, 0);
  const summedCacheRead = params.reduce((s, p) => s + (p.cacheReadTokens ?? 0), 0);
  const summedCacheCreate = params.reduce((s, p) => s + (p.cacheCreationTokens ?? 0), 0);
  const summedOutput = params.reduce((s, p) => s + p.outputTokens, 0);
  assert.equal(summedInput, 18000 + 1000 + 800 + 500 + 300);
  assert.equal(summedCacheRead, 0 + 25000 + 38000 + 50000 + 60000);
  assert.equal(summedCacheCreate, 12000 + 8000 + 5000 + 3000 + 1000);
  assert.equal(summedOutput, 200 + 150 + 100 + 80 + 60);
});

test('per-round params: tool names propagate into metadata.toolCallsInRound', () => {
  const p = buildPerRoundGenerationParams({
    model: 'claude-sonnet-4-6',
    roundIndex: 2,
    usage: { input_tokens: 100, output_tokens: 50 },
    toolNamesInRound: ['studio_get_artifact', 'studio_search_corrections'],
    tenantId: 't-1',
    conversationId: 'c-1',
  });
  const md = p.metadata as { toolCallsInRound: string[] };
  assert.deepEqual(md.toolCallsInRound, ['studio_get_artifact', 'studio_search_corrections']);
});

test('per-round params: missing tool names → metadata omits the field (not undefined / not [])', () => {
  // When the round had no tool calls (the agent's final response round),
  // we do still include an empty array so audit scripts can distinguish
  // "no tools called" from "tool data missing." The builder gates on
  // `toolNamesInRound !== undefined`, so passing [] keeps it; not passing
  // omits it.
  const withEmpty = buildPerRoundGenerationParams({
    model: 'm',
    roundIndex: 1,
    usage: { input_tokens: 1, output_tokens: 1 },
    toolNamesInRound: [],
  });
  assert.deepEqual((withEmpty.metadata as { toolCallsInRound: string[] }).toolCallsInRound, []);

  const without = buildPerRoundGenerationParams({
    model: 'm',
    roundIndex: 1,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  assert.equal((without.metadata as Record<string, unknown>).toolCallsInRound, undefined);
});

test('per-round params: zero usage values pass through (no special-case suppression)', () => {
  // A round that produced no output (rare but possible — e.g., a
  // tool_result-only round where the agent immediately tool-calls again)
  // must still emit a generation so audit scripts can count it.
  const p = buildPerRoundGenerationParams({
    model: 'm',
    roundIndex: 1,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  });
  assert.equal(p.inputTokens, 0);
  assert.equal(p.outputTokens, 0);
  assert.equal(p.cacheReadTokens, 0);
  assert.equal(p.cacheCreationTokens, 0);
});

test('per-round params: tenantId / conversationId omitted when not provided', () => {
  const p = buildPerRoundGenerationParams({
    model: 'm',
    roundIndex: 1,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const md = p.metadata as Record<string, unknown>;
  assert.equal(md.tenantId, undefined);
  assert.equal(md.conversationId, undefined);
  // roundIndex always present
  assert.equal(md.roundIndex, 1);
});
