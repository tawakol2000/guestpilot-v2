/**
 * create_tool_definition — unit tests.
 *
 * Run: npx tsx --test src/build-tune-agent/tools/__tests__/create-tool-definition.test.ts
 *
 * Covers: happy path (coordinator default), explicit scope, transactionId
 * flip, duplicate name rejection, tx validation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCreateToolDefinitionTool } from '../create-tool-definition';
import type { ToolContext } from '../types';

const DEFAULT_RATIONALE =
  'Test rationale — add this custom webhook so the AI can resolve scheduling questions without escalating.';

function captureTool() {
  let captured: any = null;
  const fakeToolFactory = ((_n: string, _d: string, _s: any, handler: any) => {
    captured = handler;
    return { name: _n };
  }) as any;
  return {
    factory: fakeToolFactory,
    invoke: (args: any) =>
      captured({ rationale: DEFAULT_RATIONALE, ...args }),
  };
}

type ToolRow = {
  id: string;
  tenantId: string;
  name: string;
  displayName: string;
  description: string;
  parameters: any;
  agentScope: string;
  type: string;
  webhookUrl: string | null;
  webhookTimeout: number;
  buildTransactionId: string | null;
};

function makeFakePrisma(opts?: {
  transactions?: Array<{ id: string; tenantId: string; status: string }>;
  preexisting?: Array<Partial<ToolRow> & { tenantId: string; name: string }>;
}) {
  const tools: ToolRow[] = [];
  for (const p of opts?.preexisting ?? []) {
    tools.push({
      id: `tool_${tools.length + 1}`,
      tenantId: p.tenantId,
      name: p.name,
      displayName: p.displayName ?? p.name,
      description: p.description ?? 'desc',
      parameters: p.parameters ?? {},
      agentScope: p.agentScope ?? 'coordinator',
      type: p.type ?? 'custom',
      webhookUrl: p.webhookUrl ?? null,
      webhookTimeout: p.webhookTimeout ?? 10000,
      buildTransactionId: p.buildTransactionId ?? null,
    });
  }
  const txRows = [...(opts?.transactions ?? [])];
  const prisma: any = {
    buildTransaction: {
      findFirst: async ({ where }: any) =>
        txRows.find((t) => t.id === where.id && t.tenantId === where.tenantId) ?? null,
      update: async ({ where, data }: any) => {
        const r = txRows.find((t) => t.id === where.id);
        if (r) r.status = data.status;
        return r;
      },
    },
    toolDefinition: {
      findFirst: async ({ where }: any) =>
        tools.find((t) => t.tenantId === where.tenantId && t.name === where.name) ?? null,
      create: async ({ data, select: _select }: any) => {
        const row: ToolRow = {
          id: `tool_${tools.length + 1}`,
          tenantId: data.tenantId,
          name: data.name,
          displayName: data.displayName,
          description: data.description,
          parameters: data.parameters,
          agentScope: data.agentScope,
          type: data.type,
          webhookUrl: data.webhookUrl,
          webhookTimeout: data.webhookTimeout,
          buildTransactionId: data.buildTransactionId ?? null,
        };
        tools.push(row);
        return row;
      },
    },
  };
  return { prisma, tools, txRows };
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
    emitDataPart: (part) => emitted.push({ type: part.type, id: part.id, data: part.data }),
    _emitted: emitted,
  };
}

const baseArgs = {
  name: 'check_cleaning_schedule',
  description:
    'Look up the next scheduled cleaning for a property. Returns the date, cleaner name, and any outstanding guest handover tasks. Use when a guest asks about mid-stay cleaning.',
  parameters: {
    type: 'object',
    properties: { propertyId: { type: 'string' } },
    required: ['propertyId'],
  },
  webhookUrl: 'https://webhook.example.com/cleaning-schedule',
  webhookAuth: { type: 'bearer' as const, secretName: 'CLEANING_TOKEN' },
  availableStatuses: ['CONFIRMED', 'CHECKED_IN'],
};

test('create_tool_definition: happy path — coordinator default', async () => {
  const { prisma, tools } = makeFakePrisma();
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildCreateToolDefinitionTool(factory, () => ctx);
  const r = await invoke(baseArgs);
  assert.ok(!r.isError);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].agentScope, 'coordinator');
  assert.equal(tools[0].type, 'custom');
  assert.equal(tools[0].displayName, 'Check Cleaning Schedule');
  assert.equal(ctx._emitted[0].type, 'data-tool-created');
});

test('create_tool_definition: rejects duplicate name', async () => {
  const { prisma } = makeFakePrisma({
    preexisting: [{ tenantId: 't1', name: 'check_cleaning_schedule' }],
  });
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildCreateToolDefinitionTool(factory, () => ctx);
  const r = await invoke(baseArgs);
  assert.ok(r.isError);
  assert.ok(r.content[0].text.includes('already exists'));
});

test('create_tool_definition: explicit agentScope carried through', async () => {
  const { prisma, tools } = makeFakePrisma();
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildCreateToolDefinitionTool(factory, () => ctx);
  const r = await invoke({ ...baseArgs, agentScope: 'screening', name: 'verify_id_photo' });
  assert.ok(!r.isError);
  assert.equal(tools[0].agentScope, 'screening');
});

test('create_tool_definition: transactionId flips PLANNED → EXECUTING + tags row', async () => {
  const { prisma, tools, txRows } = makeFakePrisma({
    transactions: [{ id: 'tx1', tenantId: 't1', status: 'PLANNED' }],
  });
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildCreateToolDefinitionTool(factory, () => ctx);
  const r = await invoke({ ...baseArgs, transactionId: 'tx1' });
  assert.ok(!r.isError);
  assert.equal(tools[0].buildTransactionId, 'tx1');
  assert.equal(txRows[0].status, 'EXECUTING');
});

test('create_tool_definition: rejects ROLLED_BACK transaction', async () => {
  const { prisma } = makeFakePrisma({
    transactions: [{ id: 'txR', tenantId: 't1', status: 'ROLLED_BACK' }],
  });
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildCreateToolDefinitionTool(factory, () => ctx);
  const r = await invoke({ ...baseArgs, transactionId: 'txR' });
  assert.ok(r.isError);
  assert.ok(r.content[0].text.includes('ROLLED_BACK'));
});
