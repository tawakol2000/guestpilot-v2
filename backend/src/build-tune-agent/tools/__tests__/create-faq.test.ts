/**
 * create_faq — unit tests.
 *
 * Run:  npx tsx --test src/build-tune-agent/tools/__tests__/create-faq.test.ts
 *
 * Covers: happy path, global vs property scope, transactionId validation
 * (PLANNED → EXECUTING flip), unknown tenant property rejection, and
 * unique-constraint handling.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCreateFaqTool } from '../create-faq';
import type { ToolContext } from '../types';

// Mock the SDK's tool() factory — captures the handler so tests can invoke
// it directly without an MCP server round-trip.
const DEFAULT_RATIONALE =
  'Test rationale — add this FAQ so guests can self-serve instead of escalating.';

function captureTool() {
  let captured: any = null;
  const fakeToolFactory = ((_name: string, _desc: string, _schema: any, handler: any) => {
    captured = handler;
    return { name: _name };
  }) as any;
  return {
    factory: fakeToolFactory,
    // Auto-inject a valid rationale for pre-054-a tests; a caller that
    // explicitly passes rationale (incl. invalid ones) overrides the default.
    invoke: (args: any) =>
      captured({ rationale: DEFAULT_RATIONALE, ...args }),
  };
}

type Row = {
  id: string;
  tenantId: string;
  propertyId: string | null;
  question: string;
  answer: string;
  category: string;
  scope: string;
  status: string;
  source: string;
  buildTransactionId: string | null;
};

function makeFakePrisma(opts?: {
  properties?: Array<{ id: string; tenantId: string }>;
  transactions?: Array<{ id: string; tenantId: string; status: string }>;
  uniqueCollision?: { question: string };
}) {
  const faqRows: Row[] = [];
  const txRows = [...(opts?.transactions ?? [])];
  const propRows = [...(opts?.properties ?? [])];
  const txStatusFlips: Array<{ id: string; status: string }> = [];

  const prisma: any = {
    buildTransaction: {
      findFirst: async ({ where, select: _select }: any) => {
        const r = txRows.find((t) => t.id === where.id && t.tenantId === where.tenantId);
        return r ? { id: r.id, status: r.status } : null;
      },
      update: async ({ where, data }: any) => {
        const r = txRows.find((t) => t.id === where.id);
        if (!r) throw new Error('tx not found');
        r.status = data.status;
        txStatusFlips.push({ id: r.id, status: data.status });
        return r;
      },
      // 2026-04-23 atomic flip: see create-sop.test.ts comment.
      updateMany: async ({ where, data }: any) => {
        const r = txRows.find(
          (t) => t.id === where.id && t.tenantId === where.tenantId && t.status === where.status
        );
        if (!r) return { count: 0 };
        r.status = data.status;
        txStatusFlips.push({ id: r.id, status: data.status });
        return { count: 1 };
      },
    },
    buildArtifactHistory: {
      create: async () => ({ id: `bah_${Date.now()}` }),
    },
    property: {
      findFirst: async ({ where }: any) => {
        const r = propRows.find((p) => p.id === where.id && p.tenantId === where.tenantId);
        return r ? { id: r.id } : null;
      },
    },
    faqEntry: {
      create: async ({ data, select: _select }: any) => {
        if (
          opts?.uniqueCollision &&
          data.question === opts.uniqueCollision.question
        ) {
          const err: any = new Error('Unique constraint');
          err.code = 'P2002';
          throw err;
        }
        const row: Row = {
          id: `faq_${faqRows.length + 1}`,
          tenantId: data.tenantId,
          propertyId: data.propertyId ?? null,
          question: data.question,
          answer: data.answer,
          category: data.category,
          scope: data.scope ?? 'GLOBAL',
          status: data.status ?? 'ACTIVE',
          source: data.source ?? 'MANUAL',
          buildTransactionId: data.buildTransactionId ?? null,
        };
        faqRows.push(row);
        return { id: row.id };
      },
    },
  };
  return { prisma, faqRows, txRows, txStatusFlips };
}

function makeCtx(prisma: any): ToolContext & {
  _emitted: Array<{ type: string; id?: string; data: unknown }>;
} {
  const emitted: Array<{ type: string; id?: string; data: unknown }> = [];
  return {
    prisma,
    tenantId: 't1',
    conversationId: 'c1',
    userId: 'u1',
    lastUserSanctionedApply: false,
    emitDataPart: (part) => {
      emitted.push({ type: part.type, id: part.id, data: part.data });
    },
    _emitted: emitted,
  };
}

test('create_faq: happy path, global scope', async () => {
  const { prisma, faqRows } = makeFakePrisma();
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildCreateFaqTool(factory, () => ctx);
  const result = await invoke({
    category: 'wifi-technology',
    question: 'What is the wifi password?',
    answer: 'Check the welcome booklet on the counter — it is printed inside.',
  });
  const text = result.content[0].text;
  assert.ok(text.includes('faq_1'), 'result should carry created id');
  assert.equal(faqRows.length, 1);
  assert.equal(faqRows[0].scope, 'GLOBAL');
  assert.equal(faqRows[0].propertyId, null);
  assert.equal(faqRows[0].buildTransactionId, null);
  const emitted = ctx._emitted;
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].type, 'data-faq-created');
});

test('create_faq: property scope validates ownership', async () => {
  const { prisma } = makeFakePrisma({
    properties: [{ id: 'p1', tenantId: 't1' }],
  });
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildCreateFaqTool(factory, () => ctx);
  const r1 = await invoke({
    category: 'check-in-access',
    question: 'What time is check-in?',
    answer: 'After 3pm.',
    propertyId: 'p1',
  });
  assert.ok(r1.content[0].text.includes('"scope": "PROPERTY"'));

  const r2 = await invoke({
    category: 'check-in-access',
    question: 'What time is check-in?',
    answer: 'After 3pm.',
    propertyId: 'other-tenant-prop',
  });
  assert.ok(r2.isError, 'unknown property should error');
  assert.ok(r2.content[0].text.includes('other-tenant-prop'));
});

test('create_faq: transactionId PLANNED → EXECUTING flip', async () => {
  const { prisma, faqRows, txRows, txStatusFlips } = makeFakePrisma({
    transactions: [{ id: 'tx1', tenantId: 't1', status: 'PLANNED' }],
  });
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildCreateFaqTool(factory, () => ctx);
  const r = await invoke({
    category: 'house-rules',
    question: 'Are parties allowed?',
    answer: 'No parties.',
    transactionId: 'tx1',
  });
  assert.ok(!r.isError, 'should succeed');
  assert.equal(faqRows[0].buildTransactionId, 'tx1');
  assert.equal(txRows[0].status, 'EXECUTING');
  assert.deepEqual(txStatusFlips, [{ id: 'tx1', status: 'EXECUTING' }]);
});

test('create_faq: rejects COMPLETED transaction', async () => {
  const { prisma } = makeFakePrisma({
    transactions: [{ id: 'txC', tenantId: 't1', status: 'COMPLETED' }],
  });
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildCreateFaqTool(factory, () => ctx);
  const r = await invoke({
    category: 'house-rules',
    question: 'q',
    answer: 'a',
    transactionId: 'txC',
  });
  assert.ok(r.isError);
  assert.ok(r.content[0].text.includes('COMPLETED'));
});

test('create_faq: rejects unknown transactionId', async () => {
  const { prisma } = makeFakePrisma();
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildCreateFaqTool(factory, () => ctx);
  const r = await invoke({
    category: 'house-rules',
    question: 'q',
    answer: 'a',
    transactionId: 'nope',
  });
  assert.ok(r.isError);
  assert.ok(r.content[0].text.includes('not found'));
});

test('create_faq: unique collision surfaces readable error', async () => {
  const { prisma } = makeFakePrisma({
    uniqueCollision: { question: 'dup?' },
  });
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildCreateFaqTool(factory, () => ctx);
  const r = await invoke({
    category: 'amenities-supplies',
    question: 'dup?',
    answer: 'a',
  });
  assert.ok(r.isError);
  assert.ok(r.content[0].text.includes('already exists'));
});
