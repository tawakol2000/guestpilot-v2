/**
 * plan_build_changes — unit tests.
 *
 * Run: npx tsx --test src/build-tune-agent/tools/__tests__/plan-build-changes.test.ts
 *
 * Covers: single-item plan (approvalRequired=false), multi-item plan
 * (approvalRequired=true), conversationId propagation, data-build-plan
 * emit, PLANNED status persisted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPlanBuildChangesTool } from '../plan-build-changes';
import type { ToolContext } from '../types';

function captureTool() {
  let captured: any = null;
  const fakeToolFactory = ((_n: string, _d: string, _s: any, handler: any) => {
    captured = handler;
    return { name: _n };
  }) as any;
  return { factory: fakeToolFactory, invoke: (args: any) => captured(args) };
}

function makeFakePrisma() {
  const txs: any[] = [];
  const prisma: any = {
    buildTransaction: {
      create: async ({ data, select: _s }: any) => {
        const row = {
          id: `tx_${txs.length + 1}`,
          tenantId: data.tenantId,
          conversationId: data.conversationId ?? null,
          plannedItems: data.plannedItems,
          status: data.status,
          rationale: data.rationale,
          createdAt: new Date('2026-04-19T00:00:00Z'),
        };
        txs.push(row);
        return row;
      },
    },
  };
  return { prisma, txs };
}

function makeCtx(prisma: any): ToolContext & {
  _emitted: Array<{ type: string; id?: string; data: unknown }>;
} {
  const emitted: Array<{ type: string; id?: string; data: unknown }> = [];
  return {
    prisma,
    tenantId: 't1',
    conversationId: 'conv1',
    userId: 'u1',
    lastUserSanctionedApply: false,
    emitDataPart: (part) => emitted.push({ type: part.type, id: part.id, data: part.data }),
    _emitted: emitted,
  };
}

test('plan_build_changes: single-item plan — approvalRequired=false', async () => {
  const { prisma, txs } = makeFakePrisma();
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildPlanBuildChangesTool(factory, () => ctx);
  const r = await invoke({
    items: [{ type: 'faq', name: 'wifi-password', rationale: 'Guests frequently ask.' }],
    rationale: 'Add the one missing wifi FAQ.',
  });
  assert.ok(!r.isError);
  assert.ok(r.content[0].text.includes('"approvalRequired": false'));
  assert.equal(txs.length, 1);
  assert.equal(txs[0].status, 'PLANNED');
  assert.equal(txs[0].conversationId, 'conv1');
  assert.equal(ctx._emitted[0].type, 'data-build-plan');
});

test('plan_build_changes: multi-item plan — approvalRequired=true', async () => {
  const { prisma, txs } = makeFakePrisma();
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildPlanBuildChangesTool(factory, () => ctx);
  const r = await invoke({
    items: [
      { type: 'sop', name: 'late-checkout', rationale: 'Missing policy.' },
      { type: 'sop', name: 'cleaning-schedule', rationale: 'Missing.' },
      { type: 'faq', name: 'parking', rationale: 'Recurrent question.' },
      { type: 'system_prompt', name: 'coordinator', rationale: 'Final graduation.' },
    ],
    rationale: 'End-to-end BUILD graduation for GREENFIELD tenant.',
  });
  assert.ok(!r.isError);
  assert.ok(r.content[0].text.includes('"approvalRequired": true'));
  assert.equal((txs[0].plannedItems as any[]).length, 4);
});

test('plan_build_changes: uiHint surfaces approval instruction', async () => {
  const { prisma } = makeFakePrisma();
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildPlanBuildChangesTool(factory, () => ctx);
  const r = await invoke({
    items: [
      { type: 'sop', name: 'x', rationale: 'rationale one' },
      { type: 'faq', name: 'y', rationale: 'rationale two' },
    ],
    rationale: 'test',
  });
  assert.ok(r.content[0].text.includes('wait for approval'));
});

test('plan_build_changes: does NOT execute create_* — only persists PLANNED', async () => {
  const { prisma, txs } = makeFakePrisma();
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildPlanBuildChangesTool(factory, () => ctx);
  await invoke({
    items: [
      { type: 'sop', name: 'x', rationale: 'rr' },
      { type: 'faq', name: 'y', rationale: 'rr' },
    ],
    rationale: 'r',
  });
  // Only the buildTransaction row is written — no SOPs/FAQs/etc.
  assert.equal(txs.length, 1);
  assert.equal(txs[0].status, 'PLANNED');
  // completedAt not set at plan time.
  assert.equal(txs[0].completedAt, undefined);
});

test('plan_build_changes: item target + previewDiff flow through to the data-build-plan emit', async () => {
  const { prisma, txs } = makeFakePrisma();
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildPlanBuildChangesTool(factory, () => ctx);
  await invoke({
    items: [
      {
        type: 'system_prompt',
        name: 'coordinator',
        rationale: 'Tighten weekend late-checkout policy.',
        target: { sectionId: 'checkout_time' },
        previewDiff: {
          before: 'Checkout is at 11am.',
          after: 'Checkout is at 10am on weekends, 11am otherwise.',
        },
      },
      {
        type: 'sop',
        name: 'weekend-late-checkout',
        rationale: 'New SOP to cover the policy change.',
      },
    ],
    rationale: 'Weekend turnover tightening.',
  });

  assert.equal(txs.length, 1);
  const emitted = ctx._emitted.find((p) => p.type === 'data-build-plan');
  assert.ok(emitted, 'data-build-plan emitted');
  const items = (emitted!.data as any).items;
  assert.equal(items.length, 2);
  // Item 1 carries the new target + previewDiff.
  assert.deepEqual(items[0].target, { sectionId: 'checkout_time' });
  assert.equal(items[0].previewDiff.before, 'Checkout is at 11am.');
  assert.equal(
    items[0].previewDiff.after,
    'Checkout is at 10am on weekends, 11am otherwise.'
  );
  // Item 2 is valid without target/previewDiff (both optional).
  assert.equal(items[1].target, undefined);
  assert.equal(items[1].previewDiff, undefined);
});
