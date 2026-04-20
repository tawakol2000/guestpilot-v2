/**
 * emit_audit — unit tests (sprint 046 Session B, Gate B2).
 *
 * Run: JWT_SECRET=test npx tsx --test src/build-tune-agent/tools/__tests__/emit-audit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildEmitAuditTool } from '../emit-audit';
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

test('emit_audit: happy path emits data-audit-report with rows + topFindingId', async () => {
  const ctx = makeCtx();
  const { factory, invoke } = captureTool();
  buildEmitAuditTool(factory, () => ctx);
  const r = await invoke({
    rows: [
      { artifact: 'system_prompt', label: 'Coordinator', status: 'ok', note: 'Up to date.' },
      {
        artifact: 'sop',
        label: 'Late checkout',
        status: 'gap',
        note: 'No CONFIRMED variant.',
        findingId: 'f-1',
      },
    ],
    topFindingId: 'f-1',
    summary: '1 gap found.',
  });
  assert.ok(!r.isError);
  assert.equal(ctx._emitted.length, 1);
  assert.equal(ctx._emitted[0].type, 'data-audit-report');
  const data = ctx._emitted[0].data as any;
  assert.equal(data.rows.length, 2);
  assert.equal(data.topFindingId, 'f-1');
  assert.equal(data.summary, '1 gap found.');
});

test('emit_audit: validation rejects topFindingId that matches no row', async () => {
  const ctx = makeCtx();
  const { factory, invoke } = captureTool();
  buildEmitAuditTool(factory, () => ctx);
  const r = await invoke({
    rows: [
      { artifact: 'faq', label: 'FAQ', status: 'warn', note: 'No property-scoped entries.' },
    ],
    topFindingId: 'does-not-exist',
  });
  assert.ok(r.isError);
  assert.ok(r.content[0].text.includes('does not match'));
  assert.equal(ctx._emitted.length, 0);
});

test('emit_audit: topFindingId=null is allowed when audit finds no fixes', async () => {
  const ctx = makeCtx();
  const { factory, invoke } = captureTool();
  buildEmitAuditTool(factory, () => ctx);
  const r = await invoke({
    rows: [
      { artifact: 'system_prompt', label: 'Coordinator', status: 'ok', note: 'Looks good.' },
    ],
    topFindingId: null,
  });
  assert.ok(!r.isError);
  const payload = JSON.parse(r.content[0].text);
  assert.ok(payload.hint.includes('no fixes worth proposing'));
});

test('emit_audit: id is unique-ish across calls', async () => {
  const ctx = makeCtx();
  const { factory, invoke } = captureTool();
  buildEmitAuditTool(factory, () => ctx);
  await invoke({
    rows: [{ artifact: 'faq', label: 'FAQ', status: 'ok', note: '.' }],
    topFindingId: null,
  });
  await invoke({
    rows: [{ artifact: 'sop', label: 'SOP', status: 'ok', note: '.' }],
    topFindingId: null,
  });
  const [a, b] = ctx._emitted;
  assert.notEqual(a.id, b.id, 'each audit emit has its own id');
});
