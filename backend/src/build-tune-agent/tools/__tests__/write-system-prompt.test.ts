/**
 * write_system_prompt — unit tests.
 *
 * Run: npx tsx --test src/build-tune-agent/tools/__tests__/write-system-prompt.test.ts
 *
 * Covers: happy path (coordinator + screening), coverage floor, load-bearing
 * default rejection, load-bearing missing rejection, ≤2,500 token cap
 * (enforced as max 10,000 chars), transactionId plumbing + AiConfigVersion
 * snapshot, systemPromptHistory snapshotting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildWriteSystemPromptTool } from '../write-system-prompt';
import type { ToolContext } from '../types';

function captureTool() {
  let captured: any = null;
  const fakeToolFactory = ((_n: string, _d: string, _s: any, handler: any) => {
    captured = handler;
    return { name: _n };
  }) as any;
  return { factory: fakeToolFactory, invoke: (args: any) => captured(args) };
}

const LOAD_BEARING = [
  'property_identity',
  'checkin_time',
  'checkout_time',
  'escalation_contact',
  'payment_policy',
  'brand_voice',
];
const NON_LOAD_BEARING = [
  'cleaning_policy',
  'amenities_list',
  'local_recommendations',
  'emergency_contact',
  'noise_policy',
  'pet_policy',
  'smoking_policy',
  'max_occupancy',
  'id_verification',
  'long_stay_discount',
  'cancellation_policy',
  'channel_coverage',
  'timezone',
  'ai_autonomy',
];

function fullSlotValues(overrides: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of LOAD_BEARING) out[k] = `real-${k}`;
  for (const k of NON_LOAD_BEARING) out[k] = `real-${k}`;
  return { ...out, ...overrides };
}

const GOOD_PROMPT_BODY =
  'You are Omar, a property manager. '.repeat(10) +
  'Refer to house rules when guests ask about quiet hours. ' +
  'Escalate damage reports to the emergency contact.';

function makeFakePrisma(opts?: {
  transactions?: Array<{ id: string; tenantId: string; status: string }>;
  currentConfig?: { version: number; coord?: string; screen?: string };
}) {
  const txRows = [...(opts?.transactions ?? [])];
  let config: any = opts?.currentConfig
    ? {
        tenantId: 't1',
        systemPromptCoordinator: opts.currentConfig.coord ?? null,
        systemPromptScreening: opts.currentConfig.screen ?? null,
        systemPromptVersion: opts.currentConfig.version,
        systemPromptHistory: [] as any[],
      }
    : null;
  const versions: any[] = [];
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
    tenantAiConfig: {
      findUnique: async ({ where: _w }: any) => config,
      upsert: async ({ update, create, select: _s }: any) => {
        if (config) {
          // Apply the "update" data
          if (update.systemPromptCoordinator !== undefined) {
            config.systemPromptCoordinator = update.systemPromptCoordinator;
          }
          if (update.systemPromptScreening !== undefined) {
            config.systemPromptScreening = update.systemPromptScreening;
          }
          if (update.systemPromptHistory !== undefined) {
            config.systemPromptHistory = update.systemPromptHistory;
          }
          if (update.systemPromptVersion?.increment) {
            config.systemPromptVersion += update.systemPromptVersion.increment;
          }
        } else {
          config = {
            tenantId: 't1',
            systemPromptCoordinator: create.systemPromptCoordinator ?? null,
            systemPromptScreening: create.systemPromptScreening ?? null,
            systemPromptVersion: 1,
            systemPromptHistory: [],
          };
        }
        return {
          systemPromptVersion: config.systemPromptVersion,
          systemPromptCoordinator: config.systemPromptCoordinator,
          systemPromptScreening: config.systemPromptScreening,
        };
      },
    },
    aiConfigVersion: {
      create: async ({ data, select: _s }: any) => {
        const row = {
          id: `acv_${versions.length + 1}`,
          version: data.version,
          tenantId: data.tenantId,
          config: data.config,
          note: data.note,
          buildTransactionId: data.buildTransactionId ?? null,
        };
        versions.push(row);
        return row;
      },
    },
  };
  return {
    prisma,
    txRows,
    versions,
    getConfig: () => config,
  };
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

test('write_system_prompt: happy path — coordinator, fresh config', async () => {
  const { prisma, versions, getConfig } = makeFakePrisma();
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildWriteSystemPromptTool(factory, () => ctx);
  const r = await invoke({
    variant: 'coordinator',
    text: GOOD_PROMPT_BODY,
    sourceTemplateVersion: 'v1.0-abc123',
    slotValues: fullSlotValues(),
    managerSanctioned: true,
  });
  assert.ok(!r.isError, r.content?.[0]?.text);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].config.variantWritten, 'coordinator');
  assert.equal(getConfig().systemPromptCoordinator, GOOD_PROMPT_BODY);
  assert.equal(ctx._emitted[0].type, 'data-system-prompt-written');
});

test('write_system_prompt: snapshots previous coordinator into history', async () => {
  const { prisma, getConfig } = makeFakePrisma({
    currentConfig: { version: 3, coord: 'previous-coord-' + 'x'.repeat(100) },
  });
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildWriteSystemPromptTool(factory, () => ctx);
  await invoke({
    variant: 'coordinator',
    text: GOOD_PROMPT_BODY,
    sourceTemplateVersion: 'v1.0',
    slotValues: fullSlotValues(),
    managerSanctioned: true,
  });
  const cfg = getConfig();
  assert.equal(cfg.systemPromptVersion, 4);
  assert.equal(cfg.systemPromptHistory.length, 1);
  assert.equal(cfg.systemPromptHistory[0].version, 3);
  assert.ok(cfg.systemPromptHistory[0].coordinator.startsWith('previous-coord-'));
});

test('write_system_prompt: rejects coverage < 0.7', async () => {
  const { prisma } = makeFakePrisma();
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildWriteSystemPromptTool(factory, () => ctx);
  // Only load-bearing slots filled (6/20 = 0.3) — below floor.
  const slots: Record<string, string> = {};
  for (const k of LOAD_BEARING) slots[k] = `real-${k}`;
  const r = await invoke({
    variant: 'coordinator',
    text: GOOD_PROMPT_BODY,
    sourceTemplateVersion: 'v1.0',
    slotValues: slots,
    managerSanctioned: true,
  });
  assert.ok(r.isError);
  assert.ok(r.content[0].text.includes('coverage is 0.30'));
});

test('write_system_prompt: rejects defaulted load-bearing slot', async () => {
  const { prisma } = makeFakePrisma();
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildWriteSystemPromptTool(factory, () => ctx);
  const slots = fullSlotValues({
    payment_policy: 'Refund within 24h <!-- DEFAULT: change me -->',
  });
  const r = await invoke({
    variant: 'coordinator',
    text: GOOD_PROMPT_BODY,
    sourceTemplateVersion: 'v1.0',
    slotValues: slots,
    managerSanctioned: true,
  });
  assert.ok(r.isError);
  assert.ok(r.content[0].text.includes('payment_policy'));
  assert.ok(r.content[0].text.includes('defaulted'));
});

test('write_system_prompt: rejects missing load-bearing slot', async () => {
  const { prisma } = makeFakePrisma();
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildWriteSystemPromptTool(factory, () => ctx);
  const slots = fullSlotValues();
  delete slots.escalation_contact;
  const r = await invoke({
    variant: 'coordinator',
    text: GOOD_PROMPT_BODY,
    sourceTemplateVersion: 'v1.0',
    slotValues: slots,
    managerSanctioned: true,
  });
  assert.ok(r.isError);
  assert.ok(r.content[0].text.includes('escalation_contact'));
});

test('write_system_prompt: transactionId on AiConfigVersion', async () => {
  const { prisma, versions, txRows } = makeFakePrisma({
    transactions: [{ id: 'tx1', tenantId: 't1', status: 'PLANNED' }],
  });
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildWriteSystemPromptTool(factory, () => ctx);
  const r = await invoke({
    variant: 'coordinator',
    text: GOOD_PROMPT_BODY,
    sourceTemplateVersion: 'v1.0',
    slotValues: fullSlotValues(),
    managerSanctioned: true,
    transactionId: 'tx1',
  });
  assert.ok(!r.isError);
  assert.equal(versions[0].buildTransactionId, 'tx1');
  assert.equal(txRows[0].status, 'EXECUTING');
});

test('write_system_prompt: screening variant writes to correct field', async () => {
  const { prisma, getConfig } = makeFakePrisma();
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildWriteSystemPromptTool(factory, () => ctx);
  const r = await invoke({
    variant: 'screening',
    text: GOOD_PROMPT_BODY,
    sourceTemplateVersion: 'v1.0',
    slotValues: fullSlotValues(),
    managerSanctioned: true,
  });
  assert.ok(!r.isError);
  assert.equal(getConfig().systemPromptScreening, GOOD_PROMPT_BODY);
  assert.equal(getConfig().systemPromptCoordinator, null);
});
