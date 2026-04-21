/**
 * Sprint 051 A B1/B2 — build-artifact service unit tests.
 *
 * Covers: tenant-scoped lookup for each artifact type (returns detail /
 * notFound), and the B2 prev-body history helper (SopVariantHistory +
 * FaqEntryHistory paths, unsupported-type short-circuit).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getBuildArtifact,
  getBuildArtifactPrevBody,
} from '../build-artifact.service';

function makePrisma(data: {
  sopVariants?: any[];
  faqEntries?: any[];
  tools?: any[];
  overrides?: any[];
  aiConfigs?: any[];
  sopHistory?: any[];
  faqHistory?: any[];
}) {
  return {
    sopVariant: {
      findFirst: async ({ where, include: _include }: any) => {
        return (
          (data.sopVariants ?? []).find(
            (v) =>
              v.id === where.id &&
              v.sopDefinition.tenantId === where.sopDefinition.tenantId,
          ) ?? null
        );
      },
    },
    faqEntry: {
      findFirst: async ({ where }: any) => {
        return (
          (data.faqEntries ?? []).find(
            (f) => f.id === where.id && f.tenantId === where.tenantId,
          ) ?? null
        );
      },
    },
    toolDefinition: {
      findFirst: async ({ where }: any) => {
        return (
          (data.tools ?? []).find(
            (t) => t.id === where.id && t.tenantId === where.tenantId,
          ) ?? null
        );
      },
    },
    sopPropertyOverride: {
      findFirst: async ({ where }: any) => {
        return (
          (data.overrides ?? []).find(
            (o) =>
              o.id === where.id &&
              o.sopDefinition.tenantId === where.sopDefinition.tenantId,
          ) ?? null
        );
      },
    },
    tenantAiConfig: {
      findUnique: async ({ where }: any) =>
        (data.aiConfigs ?? []).find((c) => c.tenantId === where.tenantId) ??
        null,
    },
    sopVariantHistory: {
      findFirst: async ({ where, orderBy: _orderBy }: any) => {
        const rows = (data.sopHistory ?? [])
          .filter(
            (r) =>
              r.tenantId === where.tenantId &&
              r.targetId === where.targetId &&
              r.editedAt >= where.editedAt.gte,
          )
          .sort((a, b) => (a.editedAt < b.editedAt ? -1 : 1));
        return rows[0] ?? null;
      },
    },
    faqEntryHistory: {
      findFirst: async ({ where }: any) => {
        const rows = (data.faqHistory ?? [])
          .filter(
            (r) =>
              r.tenantId === where.tenantId &&
              r.targetId === where.targetId &&
              r.editedAt >= where.editedAt.gte,
          )
          .sort((a, b) => (a.editedAt < b.editedAt ? -1 : 1));
        return rows[0] ?? null;
      },
    },
  } as any;
}

test('getBuildArtifact(sop) returns typed detail joined with the definition', async () => {
  const prisma = makePrisma({
    sopVariants: [
      {
        id: 'v1',
        sopDefinitionId: 'sd1',
        status: 'CONFIRMED',
        content: 'Arrival window 14:00.',
        enabled: true,
        updatedAt: new Date('2026-04-01T12:00:00Z'),
        createdAt: new Date('2026-03-01T12:00:00Z'),
        buildTransactionId: 'tx-1',
        sopDefinition: {
          tenantId: 't1',
          category: 'early-checkin',
          toolDescription: 'Guest asks about early check-in',
        },
      },
    ],
  });
  const out = await getBuildArtifact(prisma, 't1', 'sop', 'v1');
  assert.ok(!('notFound' in out));
  assert.equal(out.type, 'sop');
  assert.equal(out.id, 'v1');
  assert.equal(out.body, 'Arrival window 14:00.');
  assert.equal((out.meta as any).category, 'early-checkin');
  assert.equal((out.meta as any).status, 'CONFIRMED');
});

test('getBuildArtifact rejects cross-tenant lookups with notFound', async () => {
  const prisma = makePrisma({
    sopVariants: [
      {
        id: 'v1',
        sopDefinition: { tenantId: 'other', category: 'x', toolDescription: '' },
        status: 'DEFAULT',
        content: '',
        enabled: true,
        updatedAt: new Date(),
        createdAt: new Date(),
        buildTransactionId: null,
      },
    ],
  });
  const out = await getBuildArtifact(prisma, 't1', 'sop', 'v1');
  assert.deepEqual(out, { notFound: true });
});

test('getBuildArtifact(tool) carries webhookConfig only for custom tools with a URL', async () => {
  const prisma = makePrisma({
    tools: [
      {
        id: 'tool-1',
        tenantId: 't1',
        name: 'slack-notify',
        displayName: 'slack-notify',
        description: 'Posts to Slack.',
        defaultDescription: '',
        parameters: {},
        agentScope: 'coordinator',
        type: 'custom',
        enabled: true,
        webhookUrl: 'https://example.com/hook',
        webhookTimeout: 5000,
        updatedAt: new Date(),
        buildTransactionId: null,
      },
      {
        id: 'tool-2',
        tenantId: 't1',
        name: 'get-sop',
        displayName: 'get-sop',
        description: 'Internal.',
        defaultDescription: '',
        parameters: {},
        agentScope: 'coordinator',
        type: 'system',
        enabled: true,
        webhookUrl: null,
        webhookTimeout: 10000,
        updatedAt: new Date(),
        buildTransactionId: null,
      },
    ],
  });
  const custom = await getBuildArtifact(prisma, 't1', 'tool', 'tool-1');
  assert.ok(!('notFound' in custom));
  assert.ok(custom.webhookConfig);
  assert.equal((custom.webhookConfig as any).webhookUrl, 'https://example.com/hook');
  const system = await getBuildArtifact(prisma, 't1', 'tool', 'tool-2');
  assert.ok(!('notFound' in system));
  assert.equal(system.webhookConfig, undefined);
});

test('getBuildArtifact(system_prompt) rejects unknown variant ids', async () => {
  const prisma = makePrisma({
    aiConfigs: [
      {
        tenantId: 't1',
        systemPromptCoordinator: 'coord body',
        systemPromptScreening: 'screen body',
        systemPromptVersion: 3,
        updatedAt: new Date(),
      },
    ],
  });
  const notVariant = await getBuildArtifact(
    prisma,
    't1',
    'system_prompt',
    'not-a-variant',
  );
  assert.deepEqual(notVariant, { notFound: true });
  const coord = await getBuildArtifact(
    prisma,
    't1',
    'system_prompt',
    'coordinator',
  );
  assert.ok(!('notFound' in coord));
  assert.equal(coord.body, 'coord body');
});

test('getBuildArtifactPrevBody returns oldest SopVariantHistory row ≥ sessionStart', async () => {
  const t0 = new Date('2026-04-20T12:00:00Z');
  const before = new Date('2026-04-20T10:00:00Z'); // pre-session — must be ignored
  const mid = new Date('2026-04-20T13:00:00Z');
  const later = new Date('2026-04-20T15:00:00Z');
  const prisma = makePrisma({
    sopHistory: [
      {
        tenantId: 't1',
        targetId: 'v1',
        editedAt: before,
        previousContent: { content: 'stale before-session body' },
      },
      {
        tenantId: 't1',
        targetId: 'v1',
        editedAt: mid,
        previousContent: { content: 'oldest in-window body' },
      },
      {
        tenantId: 't1',
        targetId: 'v1',
        editedAt: later,
        previousContent: { content: 'newer body' },
      },
    ],
  });
  const out = await getBuildArtifactPrevBody(
    prisma,
    't1',
    'sop',
    'v1',
    t0.toISOString(),
  );
  assert.equal(out.prevBody, 'oldest in-window body');
});

test('getBuildArtifactPrevBody short-circuits for unsupported types', async () => {
  const prisma = makePrisma({});
  const out = await getBuildArtifactPrevBody(
    prisma,
    't1',
    'tool',
    'tool-1',
    new Date().toISOString(),
  );
  assert.equal(out.prevBody, null);
  assert.equal(out.reason, 'unsupported-type');
});

test('getBuildArtifactPrevBody returns null + reason when no history row exists', async () => {
  const prisma = makePrisma({ faqHistory: [] });
  const out = await getBuildArtifactPrevBody(
    prisma,
    't1',
    'faq',
    'f1',
    new Date().toISOString(),
  );
  assert.equal(out.prevBody, null);
  assert.equal(out.reason, 'no-history-in-window');
});
