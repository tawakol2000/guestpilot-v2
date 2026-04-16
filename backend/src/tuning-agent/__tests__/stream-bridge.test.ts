/**
 * Sprint 04 — SDKMessage → UIMessageChunk bridge tests.
 *
 * Run:  npx tsx --test src/tuning-agent/__tests__/stream-bridge.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeBridgeState, bridgeSDKMessage } from '../stream-bridge';

function capture() {
  const chunks: any[] = [];
  return { write: (c: any) => chunks.push(c), chunks };
}

test('assistant message with text emits text-start/text-delta/finish-step sequence', () => {
  const { write, chunks } = capture();
  const state = makeBridgeState('asst-1');
  bridgeSDKMessage(
    {
      type: 'assistant',
      session_id: 's',
      uuid: 'u',
      parent_tool_use_id: null,
      message: {
        id: 'm',
        role: 'assistant',
        type: 'message',
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'text', text: 'Hello manager.' }],
      },
    } as any,
    state,
    write
  );
  bridgeSDKMessage(
    {
      type: 'result',
      subtype: 'success',
      session_id: 's',
      uuid: 'u2',
      result: 'Hello manager.',
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
      num_turns: 1,
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 } as any,
      modelUsage: {},
      permission_denials: [],
    } as any,
    state,
    write
  );
  const kinds = chunks.map((c) => c.type);
  assert.ok(kinds.includes('text-start'));
  assert.ok(kinds.includes('text-delta'));
  assert.ok(kinds.includes('text-end'));
  assert.ok(kinds.includes('finish-step'));
  assert.ok(kinds.includes('finish'));
  const delta = chunks.find((c) => c.type === 'text-delta');
  assert.equal(delta.delta, 'Hello manager.');
});

test('tool_use content emits tool-input-start + tool-input-available', () => {
  const { write, chunks } = capture();
  const state = makeBridgeState('asst-1');
  bridgeSDKMessage(
    {
      type: 'assistant',
      session_id: 's',
      uuid: 'u',
      parent_tool_use_id: null,
      message: {
        id: 'm',
        role: 'assistant',
        type: 'message',
        content: [
          { type: 'tool_use', id: 'tu1', name: 'mcp__tuning-agent__get_context', input: { verbosity: 'concise' } },
        ],
      },
    } as any,
    state,
    write
  );
  const startChunk = chunks.find((c) => c.type === 'tool-input-start');
  const availableChunk = chunks.find((c) => c.type === 'tool-input-available');
  assert.ok(startChunk);
  assert.ok(availableChunk);
  assert.equal(availableChunk.toolName, 'mcp__tuning-agent__get_context');
  assert.deepEqual(availableChunk.input, { verbosity: 'concise' });
});

test('tool_result from user message emits tool-output-available', () => {
  const { write, chunks } = capture();
  const state = makeBridgeState('asst-1');
  bridgeSDKMessage(
    {
      type: 'user',
      session_id: 's',
      uuid: 'u',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu1',
            content: [{ type: 'text', text: '{"ok":true}' }],
          },
        ],
      },
    } as any,
    state,
    write
  );
  const chunk = chunks.find((c) => c.type === 'tool-output-available');
  assert.ok(chunk);
  assert.equal(chunk.toolCallId, 'tu1');
});

test('partial stream event text_delta emits text-delta', () => {
  const { write, chunks } = capture();
  const state = makeBridgeState('asst-1');
  bridgeSDKMessage(
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'streaming ' },
      },
    } as any,
    state,
    write
  );
  const delta = chunks.find((c) => c.type === 'text-delta');
  assert.ok(delta);
  assert.equal(delta.delta, 'streaming ');
});

test('assistant aggregate text does NOT duplicate after stream_event partial deltas', () => {
  const { write, chunks } = capture();
  const state = makeBridgeState('asst-1');
  for (const piece of ['Hello ', 'manager', '.']) {
    bridgeSDKMessage(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: piece },
        },
      } as any,
      state,
      write
    );
  }
  bridgeSDKMessage(
    {
      type: 'assistant',
      session_id: 's',
      uuid: 'u',
      parent_tool_use_id: null,
      message: {
        id: 'm',
        role: 'assistant',
        type: 'message',
        content: [{ type: 'text', text: 'Hello manager.' }],
      },
    } as any,
    state,
    write
  );
  const textDeltas = chunks.filter((c) => c.type === 'text-delta');
  assert.equal(
    textDeltas.length,
    3,
    'expected one text-delta per partial event; the aggregate must not re-emit'
  );
  const combined = textDeltas.map((c) => c.delta).join('');
  assert.equal(combined, 'Hello manager.');
  const starts = chunks.filter((c) => c.type === 'text-start');
  assert.equal(starts.length, 1, 'only the first partial should open the text block');
});

test('assistant aggregate thinking does NOT duplicate after stream_event thinking deltas', () => {
  const { write, chunks } = capture();
  const state = makeBridgeState('asst-1');
  for (const piece of ['reason ', 'about ', 'it']) {
    bridgeSDKMessage(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: piece },
        },
      } as any,
      state,
      write
    );
  }
  bridgeSDKMessage(
    {
      type: 'assistant',
      session_id: 's',
      uuid: 'u',
      parent_tool_use_id: null,
      message: {
        id: 'm',
        role: 'assistant',
        type: 'message',
        content: [{ type: 'thinking', thinking: 'reason about it' }],
      },
    } as any,
    state,
    write
  );
  const deltas = chunks.filter((c) => c.type === 'reasoning-delta');
  assert.equal(deltas.length, 3);
  const starts = chunks.filter((c) => c.type === 'reasoning-start');
  assert.equal(starts.length, 1);
});
