/**
 * Sprint 058-A F1 — direct-transport builder tests.
 *
 * Run:  npx tsx --test src/build-tune-agent/__tests__/runtime-direct.test.ts
 *
 * Scope: pure, offline unit tests for the helpers that construct the
 * `@anthropic-ai/sdk` messages.create params when
 * BUILD_AGENT_DIRECT_TRANSPORT is on. These assertions are the contract
 * the direct path must keep so explicit prompt caching (cache_control
 * markers on system blocks 0+1 and on the last tool) is wired correctly
 * the moment the runtime swap lands.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAnthropicSystemBlocks,
  withLastToolCacheControl,
  withLastMessageCacheControl,
  isDirectTransportEnabled,
} from '../prompt-cache-blocks';
import {
  buildDirectMessagesCreateParams,
  type DirectToolDefinition,
} from '../runtime-direct';
import {
  SHARED_MODE_BOUNDARY_MARKER,
  DYNAMIC_BOUNDARY_MARKER,
} from '../config';

function fakeAssembledPrompt(regionA: string, regionB: string, regionC: string): string {
  // Mirrors the runtime's assembleSystemPrompt layout: Region A is the
  // shared prefix, Region B the per-mode addendum, Region C the per-turn
  // dynamic suffix. Boundary markers are the literal strings the real
  // assembler writes between regions.
  return [
    regionA,
    SHARED_MODE_BOUNDARY_MARKER,
    regionB,
    DYNAMIC_BOUNDARY_MARKER,
    regionC,
  ].join('\n');
}

// ─── buildAnthropicSystemBlocks ────────────────────────────────────────

test('F1 buildAnthropicSystemBlocks returns exactly 3 text blocks when both markers present', () => {
  const assembled = fakeAssembledPrompt('A'.repeat(100), 'B'.repeat(50), 'C'.repeat(25));
  const blocks = buildAnthropicSystemBlocks(assembled);
  assert.equal(blocks.length, 3);
  for (const b of blocks) {
    assert.equal(b.type, 'text');
    assert.equal(typeof b.text, 'string');
  }
});

test('F1 buildAnthropicSystemBlocks attaches cache_control ephemeral to blocks 0 and 1 only', () => {
  const assembled = fakeAssembledPrompt('shared-A', 'mode-B', 'dynamic-C');
  const [a, b, c] = buildAnthropicSystemBlocks(assembled);
  assert.deepEqual(a.cache_control, { type: 'ephemeral' });
  assert.deepEqual(b.cache_control, { type: 'ephemeral' });
  assert.equal(c.cache_control, undefined);
});

test('F1 buildAnthropicSystemBlocks degrades to single uncached block when markers missing', () => {
  const assembled = 'no-markers-here just plain text';
  const blocks = buildAnthropicSystemBlocks(assembled);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].cache_control, undefined);
  assert.equal(blocks[0].text, assembled);
});

test('F1 buildAnthropicSystemBlocks preserves region content byte-for-byte', () => {
  const regionA = 'shared prefix AAA';
  const regionB = 'mode addendum BBB';
  const regionC = 'dynamic suffix CCC';
  const assembled = fakeAssembledPrompt(regionA, regionB, regionC);
  const [a, b, c] = buildAnthropicSystemBlocks(assembled);
  // splitSystemPromptIntoBlocks trims edges, so exact-match after trim.
  assert.equal(a.text, regionA);
  assert.equal(b.text, regionB);
  assert.equal(c.text, regionC);
});

// ─── withLastToolCacheControl ──────────────────────────────────────────

test('F1 withLastToolCacheControl adds cache_control to the LAST tool only', () => {
  const tools = [
    { name: 't1', input_schema: {} },
    { name: 't2', input_schema: {} },
    { name: 't3', input_schema: {} },
  ];
  const out = withLastToolCacheControl(tools);
  assert.equal(out.length, 3);
  assert.equal((out[0] as any).cache_control, undefined);
  assert.equal((out[1] as any).cache_control, undefined);
  assert.deepEqual((out[2] as any).cache_control, { type: 'ephemeral' });
});

test('F1 withLastToolCacheControl does not mutate the input array or its entries', () => {
  const tool = { name: 't1', input_schema: {} };
  const tools = [tool];
  const out = withLastToolCacheControl(tools);
  assert.notStrictEqual(out, tools); // new array
  assert.notStrictEqual(out[0], tool); // cloned entry
  assert.equal((tool as any).cache_control, undefined); // original untouched
});

test('F1 withLastToolCacheControl returns empty array unchanged', () => {
  const empty: DirectToolDefinition[] = [];
  const out = withLastToolCacheControl(empty);
  assert.equal(out.length, 0);
});

// ─── buildDirectMessagesCreateParams ───────────────────────────────────

test('F1 buildDirectMessagesCreateParams produces the full Anthropic params shape', () => {
  const assembled = fakeAssembledPrompt('A'.repeat(30), 'B'.repeat(20), 'C'.repeat(10));
  const tools: DirectToolDefinition[] = [
    { name: 'a', input_schema: { type: 'object' } },
    { name: 'b', input_schema: { type: 'object' } },
  ];
  const params = buildDirectMessagesCreateParams({
    model: 'claude-sonnet-4-6',
    maxTokens: 4096,
    assembledSystemPrompt: assembled,
    tools,
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(params.model, 'claude-sonnet-4-6');
  assert.equal(params.max_tokens, 4096);
  assert.equal(params.stream, true);

  // System is a 3-block array with cache_control on 0 + 1.
  assert.equal(params.system.length, 3);
  assert.deepEqual(params.system[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(params.system[1].cache_control, { type: 'ephemeral' });
  assert.equal(params.system[2].cache_control, undefined);

  // Tools: last-tool cache_control, earlier tools untouched.
  assert.equal(params.tools.length, 2);
  assert.equal((params.tools[0] as any).cache_control, undefined);
  assert.deepEqual((params.tools[1] as any).cache_control, { type: 'ephemeral' });

  // Caller's tools array was not mutated.
  assert.equal((tools[0] as any).cache_control, undefined);
  assert.equal((tools[1] as any).cache_control, undefined);

  // Messages pass through.
  assert.equal(params.messages.length, 1);
  assert.equal(params.messages[0].role, 'user');
});

test('F1 buildDirectMessagesCreateParams passes thinking config through when present', () => {
  const params = buildDirectMessagesCreateParams({
    model: 'm',
    maxTokens: 1,
    assembledSystemPrompt: fakeAssembledPrompt('a', 'b', 'c'),
    tools: [],
    messages: [{ role: 'user', content: 'x' }],
    thinking: { type: 'enabled', budget_tokens: 2048 },
  });
  assert.deepEqual(params.thinking, { type: 'enabled', budget_tokens: 2048 });
});

test('F1 buildDirectMessagesCreateParams omits thinking when not provided', () => {
  const params = buildDirectMessagesCreateParams({
    model: 'm',
    maxTokens: 1,
    assembledSystemPrompt: fakeAssembledPrompt('a', 'b', 'c'),
    tools: [],
    messages: [{ role: 'user', content: 'x' }],
  });
  assert.equal(params.thinking, undefined);
});

test('F1 buildDirectMessagesCreateParams is deterministic — two calls with same input produce equal output', () => {
  const input = {
    model: 'claude-sonnet-4-6',
    maxTokens: 2048,
    assembledSystemPrompt: fakeAssembledPrompt('A'.repeat(100), 'B'.repeat(50), 'C'.repeat(25)),
    tools: [
      { name: 'x', input_schema: {} },
      { name: 'y', input_schema: {} },
    ],
    messages: [{ role: 'user' as const, content: 'hi' }],
  };
  const a = buildDirectMessagesCreateParams(input);
  const b = buildDirectMessagesCreateParams(input);
  assert.deepEqual(a, b);
});

// ─── isDirectTransportEnabled ──────────────────────────────────────────

test('F1 isDirectTransportEnabled defaults to false when env var unset', () => {
  const prev = process.env.BUILD_AGENT_DIRECT_TRANSPORT;
  delete process.env.BUILD_AGENT_DIRECT_TRANSPORT;
  assert.equal(isDirectTransportEnabled(), false);
  if (prev !== undefined) process.env.BUILD_AGENT_DIRECT_TRANSPORT = prev;
});

test('F1 isDirectTransportEnabled respects truthy strings', () => {
  const prev = process.env.BUILD_AGENT_DIRECT_TRANSPORT;
  for (const v of ['1', 'true', 'yes', 'on', 'TRUE', 'On']) {
    process.env.BUILD_AGENT_DIRECT_TRANSPORT = v;
    assert.equal(isDirectTransportEnabled(), true, `value=${v}`);
  }
  for (const v of ['0', 'false', 'no', 'off', '', 'random']) {
    process.env.BUILD_AGENT_DIRECT_TRANSPORT = v;
    assert.equal(isDirectTransportEnabled(), false, `value=${v}`);
  }
  if (prev === undefined) delete process.env.BUILD_AGENT_DIRECT_TRANSPORT;
  else process.env.BUILD_AGENT_DIRECT_TRANSPORT = prev;
});

// ─── withLastMessageCacheControl (2026-05-04 cost-cut) ───────────────────

test('2026-05-04 withLastMessageCacheControl: string content normalized to block array with cache_control on the lone block', () => {
  const out = withLastMessageCacheControl([
    { role: 'user' as const, content: 'first user msg' },
    { role: 'assistant' as const, content: 'assistant reply text' },
  ]);
  assert.equal(out.length, 2);
  // Earlier message: untouched (still string).
  assert.equal(out[0].content, 'first user msg');
  // Last message: content is now a block array with cache_control on the
  // single text block.
  const lastContent = out[1].content;
  assert.ok(Array.isArray(lastContent), 'last content must be a block array');
  assert.equal(lastContent.length, 1);
  const block = lastContent[0] as Record<string, unknown>;
  assert.equal(block.type, 'text');
  assert.equal(block.text, 'assistant reply text');
  assert.deepEqual(block.cache_control, { type: 'ephemeral' });
});

test('2026-05-04 withLastMessageCacheControl: array content marks ONLY the last block', () => {
  const out = withLastMessageCacheControl([
    {
      role: 'assistant' as const,
      content: [
        { type: 'text', text: 'reasoning…' },
        { type: 'tool_use', id: 't1', name: 'studio_get_artifact', input: {} },
        { type: 'text', text: 'closing prose' },
      ],
    },
  ]);
  const blocks = out[0].content as unknown as Array<Record<string, unknown>>;
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].cache_control, undefined);
  assert.equal(blocks[1].cache_control, undefined);
  assert.deepEqual(blocks[2].cache_control, { type: 'ephemeral' });
});

test('2026-05-04 withLastMessageCacheControl: empty array unchanged', () => {
  const empty: Array<{ role: 'user' | 'assistant'; content: string | unknown[] }> = [];
  const out = withLastMessageCacheControl(empty);
  assert.equal(out, empty); // referential — short-circuits without copy
});

test('2026-05-04 withLastMessageCacheControl: empty string content unchanged (no block to mark)', () => {
  const input = [{ role: 'user' as const, content: '' }];
  const out = withLastMessageCacheControl(input);
  assert.equal(out, input);
});

test('2026-05-04 withLastMessageCacheControl: does not mutate input messages or their content', () => {
  const original = [
    { role: 'user' as const, content: 'msg' },
    { role: 'assistant' as const, content: [{ type: 'text', text: 'reply' }] },
  ];
  const beforeAssistant = JSON.stringify(original[1]);
  const out = withLastMessageCacheControl(original);
  // Returned array is new
  assert.notEqual(out, original);
  // Original entries untouched
  assert.equal(original[0].content, 'msg');
  assert.equal(JSON.stringify(original[1]), beforeAssistant);
  // Returned array's last entry IS marked
  const lastBlocks = out[1].content as Array<Record<string, unknown>>;
  assert.deepEqual(lastBlocks[0].cache_control, { type: 'ephemeral' });
});

test('2026-05-04 buildDirectMessagesCreateParams: last message in conversation gets cache_control (4th breakpoint)', () => {
  const params = buildDirectMessagesCreateParams({
    model: 'claude-sonnet-4-6',
    maxTokens: 4096,
    assembledSystemPrompt: fakeAssembledPrompt('A'.repeat(30), 'B'.repeat(20), 'C'.repeat(10)),
    tools: [{ name: 'a', input_schema: { type: 'object' } }],
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'follow-up' },
    ],
  });
  assert.equal(params.messages.length, 3);
  // Earlier messages still strings.
  assert.equal(typeof params.messages[0].content, 'string');
  assert.equal(typeof params.messages[1].content, 'string');
  // Last message normalized to block array with cache_control.
  const lastBlocks = params.messages[2].content as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(lastBlocks));
  assert.deepEqual(lastBlocks[lastBlocks.length - 1].cache_control, {
    type: 'ephemeral',
  });
});
