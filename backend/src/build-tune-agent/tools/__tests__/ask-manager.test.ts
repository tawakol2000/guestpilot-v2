/**
 * ask_manager — unit tests (sprint 046 Session B, Gate B2).
 *
 * Run: JWT_SECRET=test npx tsx --test src/build-tune-agent/tools/__tests__/ask-manager.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildAskManagerTool } from '../ask-manager';
import type { ToolContext } from '../types';

function captureTool() {
  let captured: any = null;
  const fakeToolFactory = ((_n: string, _d: string, _s: any, handler: any) => {
    captured = handler;
    return { name: _n };
  }) as any;
  return { factory: fakeToolFactory, invoke: (args: any) => captured(args) };
}

function makeCtx(): ToolContext & {
  _emitted: Array<{ type: string; id?: string; data: unknown }>;
} {
  const emitted: Array<{ type: string; id?: string; data: unknown }> = [];
  return {
    prisma: {} as any,
    tenantId: 't1',
    conversationId: 'conv1',
    userId: 'u1',
    lastUserSanctionedApply: false,
    emitDataPart: (part) => emitted.push({ type: part.type, id: part.id, data: part.data }),
    _emitted: emitted,
  };
}

test('ask_manager: happy path emits data-question-choices with recommended flag', async () => {
  const ctx = makeCtx();
  const { factory, invoke } = captureTool();
  buildAskManagerTool(factory, () => ctx);
  const r = await invoke({
    question: 'How should late checkouts be priced?',
    options: [
      { id: 'free', label: 'Free up to 1pm' },
      { id: 'flat', label: '£20 flat fee' },
    ],
    recommendedDefault: 'flat',
  });
  assert.ok(!r.isError);
  assert.equal(ctx._emitted.length, 1);
  assert.equal(ctx._emitted[0].type, 'data-question-choices');
  const data = ctx._emitted[0].data as any;
  assert.equal(data.question, 'How should late checkouts be priced?');
  assert.equal(data.options.length, 2);
  assert.equal(data.options.find((o: any) => o.id === 'flat').recommended, true);
  assert.equal(data.options.find((o: any) => o.id === 'free').recommended, false);
  assert.equal(data.allowCustomInput, false);
});

test('ask_manager: allowCustomInput=true flows through to payload', async () => {
  const ctx = makeCtx();
  const { factory, invoke } = captureTool();
  buildAskManagerTool(factory, () => ctx);
  await invoke({
    question: "What's the brand voice?",
    options: [
      { id: 'warm', label: 'Warm + informal' },
      { id: 'pro', label: 'Professional' },
    ],
    allowCustomInput: true,
  });
  const data = ctx._emitted[0].data as any;
  assert.equal(data.allowCustomInput, true);
});

test('ask_manager: explicit option.recommended takes precedence', async () => {
  const ctx = makeCtx();
  const { factory, invoke } = captureTool();
  buildAskManagerTool(factory, () => ctx);
  await invoke({
    question: 'Pick',
    options: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B', recommended: true },
    ],
  });
  const data = ctx._emitted[0].data as any;
  assert.equal(data.options.find((o: any) => o.id === 'b').recommended, true);
});

test('ask_manager: rejects more than one recommended option', async () => {
  const ctx = makeCtx();
  const { factory, invoke } = captureTool();
  buildAskManagerTool(factory, () => ctx);
  const r = await invoke({
    question: 'Pick',
    options: [
      { id: 'a', label: 'A', recommended: true },
      { id: 'b', label: 'B', recommended: true },
    ],
  });
  assert.ok(r.isError);
  assert.ok(r.content[0].text.includes('at most one option'));
  assert.equal(ctx._emitted.length, 0, 'no part emitted when validation fails');
});
