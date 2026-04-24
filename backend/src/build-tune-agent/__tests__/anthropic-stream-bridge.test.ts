/**
 * F1.4 — Anthropic raw-stream → SDKMessage bridge tests (sprint 059-A Stream B).
 *
 * Run: npx tsx --test src/build-tune-agent/__tests__/anthropic-stream-bridge.test.ts
 *
 * Verifies:
 *   1. For each of 3 golden-replay fixtures, bridgeAnthropicStream(rawEvents)
 *      yields exactly fixture.expectedSDKMessageTypes (type-only snapshot).
 *   2. Feeding those SDKMessages into the EXISTING bridgeSDKMessage() (pinned
 *      by stream-bridge.ts Sprint 09 fix 11) yields exactly
 *      fixture.expectedUIChunks. THIS is the cross-gate parity check.
 *   3. message_delta stop_reason=tool_use vs end_turn both produce the
 *      correct `result` SDKMessage.
 *   4. toolResultSDKMessage produces a `user` SDKMessage with the tool_result
 *      block that the existing user-path in stream-bridge.ts handles.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources/messages';

import {
  bridgeAnthropicStream,
  toolResultSDKMessage,
  type BridgedSDKMessage,
} from '../direct/anthropic-stream-bridge';
import {
  makeBridgeState,
  bridgeSDKMessage,
} from '../stream-bridge';

const FIXTURES_DIR = join(__dirname, 'fixtures', 'direct-stream');

function loadFixture(name: string) {
  const p = join(FIXTURES_DIR, `${name}.json`);
  return JSON.parse(readFileSync(p, 'utf-8'));
}

async function* fromArray<T>(arr: T[]): AsyncGenerator<T> {
  for (const item of arr) yield item;
}

async function drain(gen: AsyncGenerator<BridgedSDKMessage>): Promise<BridgedSDKMessage[]> {
  const out: BridgedSDKMessage[] = [];
  for await (const msg of gen) out.push(msg);
  return out;
}

function runThroughSdkBridge(messages: BridgedSDKMessage[]): any[] {
  const state = makeBridgeState('asst-fix');
  const chunks: any[] = [];
  for (const m of messages) {
    bridgeSDKMessage(m as any, state, (c) => chunks.push(c));
  }
  return chunks;
}

for (const fixtureName of ['text-only', 'one-tool-call', 'thinking-interleaved']) {
  test(`fixture ${fixtureName}: adapter yields expected SDKMessage type sequence`, async () => {
    const fx = loadFixture(fixtureName);
    const yielded = await drain(bridgeAnthropicStream(fromArray(fx.rawEvents)));
    const types = yielded.map((m) => m.type);
    assert.deepEqual(
      types,
      fx.expectedSDKMessageTypes,
      `SDKMessage type sequence mismatch for ${fixtureName}`,
    );
  });

  test(`fixture ${fixtureName}: cross-gate parity — bridgeSDKMessage(adapter(raw)) === expectedUIChunks`, async () => {
    const fx = loadFixture(fixtureName);
    const sdkMessages = await drain(bridgeAnthropicStream(fromArray(fx.rawEvents)));
    const chunks = runThroughSdkBridge(sdkMessages);
    assert.deepEqual(
      chunks,
      fx.expectedUIChunks,
      `UIMessageChunk sequence mismatch for ${fixtureName} — this is the load-bearing F1 regression gate (spec §3 F1.4)`,
    );
  });
}

test('message_delta with stop_reason=tool_use still produces a result SDKMessage at message_stop', async () => {
  const events: RawMessageStreamEvent[] = [
    { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'x', stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } } as unknown as RawMessageStreamEvent,
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { input_tokens: 0, output_tokens: 1 } } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
  const msgs = await drain(bridgeAnthropicStream(fromArray(events)));
  const results = msgs.filter((m) => m.type === 'result');
  assert.equal(results.length, 1, 'exactly one result SDKMessage');
  assert.equal((results[0] as any).stop_reason, 'tool_use');
  assert.equal((results[0] as any).subtype, 'success');
});

test('message_delta with stop_reason=end_turn produces a result SDKMessage with stop_reason=end_turn', async () => {
  const events: RawMessageStreamEvent[] = [
    { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'x', stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } } as unknown as RawMessageStreamEvent,
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 0, output_tokens: 1 } } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
  const msgs = await drain(bridgeAnthropicStream(fromArray(events)));
  const result = msgs.find((m) => m.type === 'result')!;
  assert.equal((result as any).stop_reason, 'end_turn');
  assert.equal((result as any).subtype, 'success');
});

test('toolResultSDKMessage: string content is wrapped as [{type:text,text}] in tool_result', () => {
  const msg = toolResultSDKMessage('toolu_xy', { content: '{"ok":true}' });
  assert.equal(msg.type, 'user');
  const block = ((msg as any).message.content as any[])[0];
  assert.equal(block.type, 'tool_result');
  assert.equal(block.tool_use_id, 'toolu_xy');
  assert.deepEqual(block.content, [{ type: 'text', text: '{"ok":true}' }]);
  assert.equal(block.is_error, undefined);
});

test('toolResultSDKMessage: is_error=true is propagated to the block', () => {
  const msg = toolResultSDKMessage('toolu_xy', {
    content: 'boom',
    is_error: true,
  });
  const block = ((msg as any).message.content as any[])[0];
  assert.equal(block.is_error, true);
});

test('toolResultSDKMessage: feeding through bridgeSDKMessage emits tool-output-available', () => {
  const msg = toolResultSDKMessage('toolu_xy', { content: 'result body' });
  const state = makeBridgeState('asst-tr');
  const chunks: any[] = [];
  bridgeSDKMessage(msg as any, state, (c) => chunks.push(c));
  const out = chunks.find((c) => c.type === 'tool-output-available');
  assert.ok(out, 'tool-output-available emitted');
  assert.equal(out.toolCallId, 'toolu_xy');
});

test('assembled tool_use input_json parses full JSON across multiple deltas', async () => {
  const fx = loadFixture('one-tool-call');
  const sdkMessages = await drain(bridgeAnthropicStream(fromArray(fx.rawEvents)));
  const assistant = sdkMessages.find((m) => m.type === 'assistant') as any;
  assert.ok(assistant, 'assistant SDKMessage synthesised');
  const block = assistant.message.content[0];
  assert.equal(block.type, 'tool_use');
  assert.equal(block.id, 'toolu_abc');
  assert.equal(block.name, 'mcp__tuning-agent__studio_get_context');
  assert.deepEqual(block.input, { scope: 'summary' });
});
