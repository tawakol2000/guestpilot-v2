/**
 * Sprint 053-A D3/D4 — artifact-apply executor unit tests.
 *
 * Covers: dryRun preview, real update emits history row, validation
 * errors short-circuit without writes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyArtifactUpdate } from '../artifact-apply';

function makeFakePrisma(opts: {
  sopVariant?: { id: string; content: string; status: string; category: string };
  faqEntry?: { id: string; tenantId: string; question: string; answer: string; category: string };
  aiConfigCoordinator?: string | null;
  tool?: { id: string; tenantId: string; description: string; parameters: any; webhookUrl: string | null; webhookTimeout: number; enabled: boolean };
}) {
  const historyWrites: any[] = [];
  const updates: Array<{ table: string; where: any; data: any }> = [];
  const prisma: any = {
    sopVariant: {
      findFirst: async ({ where }: any) => {
        if (!opts.sopVariant) return null;
        if (where.id !== opts.sopVariant.id) return null;
        return {
          id: opts.sopVariant.id,
          content: opts.sopVariant.content,
          status: opts.sopVariant.status,
          sopDefinition: { category: opts.sopVariant.category },
        };
      },
      update: async ({ where, data }: any) => {
        updates.push({ table: 'sopVariant', where, data });
        return {};
      },
    },
    faqEntry: {
      findFirst: async ({ where }: any) => {
        if (!opts.faqEntry) return null;
        if (where.id !== opts.faqEntry.id || where.tenantId !== opts.faqEntry.tenantId) return null;
        return { ...opts.faqEntry };
      },
      update: async ({ where, data }: any) => {
        updates.push({ table: 'faqEntry', where, data });
        return {};
      },
    },
    tenantAiConfig: {
      findUnique: async () => {
        if (opts.aiConfigCoordinator === undefined) return null;
        return { systemPromptCoordinator: opts.aiConfigCoordinator, systemPromptScreening: null };
      },
      upsert: async ({ where, data }: any) => {
        updates.push({ table: 'tenantAiConfig', where, data });
        return {};
      },
    },
    toolDefinition: {
      findFirst: async ({ where }: any) => {
        if (!opts.tool) return null;
        if (where.id !== opts.tool.id || where.tenantId !== opts.tool.tenantId) return null;
        return { ...opts.tool };
      },
      update: async ({ where, data }: any) => {
        updates.push({ table: 'toolDefinition', where, data });
        return {};
      },
    },
    sopPropertyOverride: {
      findFirst: async () => null,
      update: async () => ({}),
    },
    buildArtifactHistory: {
      create: async ({ data }: any) => {
        historyWrites.push(data);
        return { id: `hist_${historyWrites.length}` };
      },
    },
  };
  return { prisma, historyWrites, updates };
}

test('applyArtifactUpdate(sop) dryRun returns preview, no writes', async () => {
  const { prisma, historyWrites, updates } = makeFakePrisma({
    sopVariant: {
      id: 'sop-1',
      content: 'OLD sop body',
      status: 'DEFAULT',
      category: 'late-checkout',
    },
  });
  const r = await applyArtifactUpdate(prisma, {
    tenantId: 't1',
    type: 'sop',
    id: 'sop-1',
    dryRun: true,
    body: { content: 'NEW sop body content, long enough for the 20-char floor.' },
  });
  assert.ok(r.ok);
  assert.equal(r.dryRun, true);
  assert.ok(r.preview);
  assert.equal(updates.length, 0);
  assert.equal(historyWrites.length, 0);
});

test('applyArtifactUpdate(sop) real write updates DB + emits UPDATE history', async () => {
  const { prisma, historyWrites, updates } = makeFakePrisma({
    sopVariant: {
      id: 'sop-1',
      content: 'OLD sop body',
      status: 'DEFAULT',
      category: 'late-checkout',
    },
  });
  const r = await applyArtifactUpdate(prisma, {
    tenantId: 't1',
    type: 'sop',
    id: 'sop-1',
    dryRun: false,
    body: { content: 'NEW sop body content, long enough for the 20-char floor.' },
    actorEmail: 'manager@tenant.example',
    conversationId: 'c1',
  });
  assert.ok(r.ok);
  assert.equal(r.dryRun, false);
  assert.equal(updates.filter((u) => u.table === 'sopVariant').length, 1);
  assert.equal(historyWrites.length, 1);
  assert.equal(historyWrites[0].operation, 'UPDATE');
  assert.equal(historyWrites[0].artifactType, 'sop');
  assert.ok(historyWrites[0].prevBody);
  assert.ok(historyWrites[0].newBody);
});

test('applyArtifactUpdate(sop) validation failure returns error, no writes', async () => {
  const { prisma, updates } = makeFakePrisma({
    sopVariant: {
      id: 'sop-1',
      content: 'OLD',
      status: 'DEFAULT',
      category: 'late-checkout',
    },
  });
  const r = await applyArtifactUpdate(prisma, {
    tenantId: 't1',
    type: 'sop',
    id: 'sop-1',
    dryRun: false,
    body: { content: 'too short' }, // < 20 chars
  });
  assert.equal(r.ok, false);
  assert.ok(r.error);
  assert.equal(updates.length, 0);
});

test('applyArtifactUpdate(tool) sanitises preview + history (redacts api-key fields)', async () => {
  const { prisma, historyWrites } = makeFakePrisma({
    tool: {
      id: 'tool-1',
      tenantId: 't1',
      description: 'existing',
      parameters: {},
      webhookUrl: 'https://old.example.com',
      webhookTimeout: 10000,
      enabled: true,
    },
  });
  const r = await applyArtifactUpdate(prisma, {
    tenantId: 't1',
    type: 'tool',
    id: 'tool-1',
    dryRun: false,
    body: {
      description: 'New description',
      parameters: {
        type: 'object',
        properties: { apiKey: { default: 'SK_FAKE_1234567890abcdef1234567890abcdef' } },
      },
    },
  });
  assert.ok(r.ok);
  // History row should have had the sanitiser run (via emitArtifactHistory's
  // tool_definition branch).
  assert.equal(historyWrites.length, 1);
  const asJson = JSON.stringify(historyWrites[0]);
  assert.ok(!asJson.includes('SK_FAKE_1234567890abcdef1234567890abcdef'));
});

test('applyArtifactUpdate(faq) partial update with only answer field', async () => {
  const { prisma, historyWrites, updates } = makeFakePrisma({
    faqEntry: {
      id: 'faq-1',
      tenantId: 't1',
      question: 'Wifi?',
      answer: 'Old answer',
      category: 'wifi-technology',
    },
  });
  const r = await applyArtifactUpdate(prisma, {
    tenantId: 't1',
    type: 'faq',
    id: 'faq-1',
    dryRun: false,
    body: { answer: 'New better answer with more detail.' },
  });
  assert.ok(r.ok);
  const u = updates.find((x) => x.table === 'faqEntry');
  assert.ok(u);
  assert.equal(u!.data.answer, 'New better answer with more detail.');
  assert.equal(u!.data.question, undefined); // question was not supplied
  assert.equal(historyWrites.length, 1);
});

test('applyArtifactUpdate(system_prompt) UPDATE when prior coordinator exists', async () => {
  const { prisma, historyWrites } = makeFakePrisma({
    aiConfigCoordinator: 'OLD coordinator body text',
  });
  const r = await applyArtifactUpdate(prisma, {
    tenantId: 't1',
    type: 'system_prompt',
    id: 'coordinator',
    dryRun: false,
    body: { text: 'x'.repeat(150) },
  });
  assert.ok(r.ok);
  assert.equal(historyWrites.length, 1);
  assert.equal(historyWrites[0].operation, 'UPDATE');
});
