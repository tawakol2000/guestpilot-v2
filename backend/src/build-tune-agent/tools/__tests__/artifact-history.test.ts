/**
 * Sprint 053-A D2 — BuildArtifactHistory write-path emission tests.
 *
 * Asserts:
 *   - each write tool emits exactly one history row on success
 *   - dryRun path emits ZERO history rows (plumbing boundary)
 *   - tool_definition history row is sanitised (bearer tokens redacted)
 *   - history-insert failure is swallowed: real write still succeeds
 *   - getToolArtifactPrevJson parses tool_definition history rows
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCreateFaqTool } from '../create-faq';
import { buildCreateSopTool } from '../create-sop';
import { buildCreateToolDefinitionTool } from '../create-tool-definition';
import { buildWriteSystemPromptTool } from '../write-system-prompt';
import { emitArtifactHistory } from '../../lib/artifact-history';
import { getToolArtifactPrevJson } from '../../../services/build-artifact.service';
import type { ToolContext } from '../types';

const DEFAULT_RATIONALE =
  'Test rationale — emit a history row so the ledger shows why this artifact was written.';

function captureTool() {
  let captured: any = null;
  const fakeToolFactory = ((_name: string, _desc: string, _schema: any, handler: any) => {
    captured = handler;
    return { name: _name };
  }) as any;
  return {
    factory: fakeToolFactory,
    invoke: (args: any) =>
      captured({ rationale: DEFAULT_RATIONALE, ...args }),
  };
}

interface HistoryRow {
  tenantId: string;
  artifactType: string;
  artifactId: string;
  operation: string;
  prevBody: unknown;
  newBody: unknown;
  actorUserId: string | null;
  actorEmail: string | null;
  conversationId: string | null;
  metadata: unknown;
}

function makeFakePrisma(opts?: {
  properties?: Array<{ id: string; tenantId: string }>;
  historyThrows?: boolean;
  aiConfigCoordinator?: string | null;
  buildArtifactHistory?: Array<{
    tenantId: string;
    artifactType: string;
    artifactId: string;
    createdAt: Date;
    prevBody?: unknown;
    newBody?: unknown;
  }>;
}) {
  const historyRows: HistoryRow[] = [];
  const propRows = [...(opts?.properties ?? [])];
  const history = [...(opts?.buildArtifactHistory ?? [])];

  const prisma: any = {
    buildTransaction: {
      findFirst: async () => null,
      update: async () => ({}),
    },
    property: {
      findFirst: async ({ where }: any) => {
        const r = propRows.find((p) => p.id === where.id && p.tenantId === where.tenantId);
        return r ? { id: r.id } : null;
      },
    },
    faqEntry: {
      create: async ({ data }: any) => ({ id: 'faq-new-1', ...data }),
    },
    sopDefinition: {
      findUnique: async () => null,
      upsert: async () => ({ id: 'sopdef-new-1', category: 'x' }),
    },
    sopVariant: {
      findUnique: async () => null,
      create: async () => ({ id: 'sopv-new-1' }),
    },
    sopPropertyOverride: {
      findUnique: async () => null,
      create: async () => ({ id: 'over-new-1' }),
    },
    toolDefinition: {
      findFirst: async () => null,
      create: async ({ data }: any) => ({
        id: 'tool-new-1',
        name: data.name,
        displayName: data.displayName,
        agentScope: data.agentScope,
      }),
    },
    tenantAiConfig: {
      findUnique: async () => {
        if (opts?.aiConfigCoordinator === undefined) return null;
        return {
          systemPromptCoordinator: opts.aiConfigCoordinator,
          systemPromptScreening: null,
          systemPromptVersion: 1,
          systemPromptHistory: [],
        };
      },
      upsert: async () => ({
        systemPromptVersion: 2,
        systemPromptCoordinator: 'new coordinator body',
        systemPromptScreening: null,
      }),
    },
    aiConfigVersion: {
      create: async () => ({ id: 'cfgv-new-1', version: 2 }),
    },
    buildArtifactHistory: {
      create: async ({ data }: any) => {
        if (opts?.historyThrows) {
          throw new Error('simulated-db-down');
        }
        historyRows.push(data as HistoryRow);
        return { id: `hist_${historyRows.length}`, ...data };
      },
      findFirst: async ({ where, orderBy: _o }: any) => {
        const rows = history
          .filter(
            (r) =>
              r.tenantId === where.tenantId &&
              r.artifactType === where.artifactType &&
              r.artifactId === where.artifactId &&
              r.createdAt >= where.createdAt.gte,
          )
          .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
        return rows[0] ?? null;
      },
    },
  };
  return { prisma, historyRows };
}

function makeCtx(prisma: any, overrides?: Partial<ToolContext>): ToolContext {
  return {
    prisma,
    tenantId: 't1',
    conversationId: 'c1',
    userId: 'u1',
    actorEmail: 'manager@tenant.example',
    lastUserSanctionedApply: false,
    emitDataPart: () => {},
    ...overrides,
  };
}

test('D2: create_faq emits one history row with CREATE operation', async () => {
  const { prisma, historyRows } = makeFakePrisma();
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildCreateFaqTool(factory, () => ctx);
  const r = await invoke({
    category: 'wifi-technology',
    question: 'Wifi password?',
    answer: 'Inside the welcome book.',
  });
  assert.ok(!r.isError);
  assert.equal(historyRows.length, 1);
  const row = historyRows[0]!;
  assert.equal(row.artifactType, 'faq');
  assert.equal(row.operation, 'CREATE');
  assert.equal(row.actorEmail, 'manager@tenant.example');
  assert.equal(row.conversationId, 'c1');
  assert.equal(row.prevBody, null);
  assert.ok(row.newBody);
});

test('D2: create_faq dryRun emits ZERO history rows', async () => {
  const { prisma, historyRows } = makeFakePrisma();
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildCreateFaqTool(factory, () => ctx);
  await invoke({
    category: 'wifi-technology',
    question: 'q?',
    answer: 'a',
    dryRun: true,
  });
  assert.equal(historyRows.length, 0);
});

test('D2: create_sop variant emits history with artifactType "sop"', async () => {
  const { prisma, historyRows } = makeFakePrisma();
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildCreateSopTool(factory, () => ctx);
  await invoke({
    sopCategory: 'late-checkout',
    status: 'DEFAULT',
    title: 'Late checkout',
    body: 'Accommodate up to 2pm if possible.',
  });
  assert.equal(historyRows.length, 1);
  assert.equal(historyRows[0]!.artifactType, 'sop');
  assert.equal(historyRows[0]!.operation, 'CREATE');
});

test('D2: create_sop override emits history with artifactType "property_override"', async () => {
  const { prisma, historyRows } = makeFakePrisma({
    properties: [{ id: 'prop1', tenantId: 't1' }],
  });
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildCreateSopTool(factory, () => ctx);
  await invoke({
    sopCategory: 'late-checkout',
    status: 'CONFIRMED',
    propertyId: 'prop1',
    title: 'Late checkout — Marina suite',
    body: 'For Marina suite, late checkout up to 4pm is fine.',
  });
  assert.equal(historyRows.length, 1);
  assert.equal(historyRows[0]!.artifactType, 'property_override');
});

test('D2: create_tool_definition emits history with SANITISED bodies (api keys redacted)', async () => {
  const { prisma, historyRows } = makeFakePrisma();
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildCreateToolDefinitionTool(factory, () => ctx);
  await invoke({
    name: 'check_cleaning',
    description: 'A webhook tool that checks cleaning schedules for a property and returns bookings.',
    parameters: {
      type: 'object',
      properties: {
        propertyId: { type: 'string' },
        apiKey: { type: 'string', default: 'SK_FAKE_abcdef1234567890abcdef1234567890' },
      },
    },
    webhookUrl: 'https://cleaning.example.com/check',
    webhookAuth: { type: 'bearer', secretName: 'CLEANING_TOKEN' },
    availableStatuses: ['CONFIRMED'],
  });
  assert.equal(historyRows.length, 1);
  const row = historyRows[0]!;
  assert.equal(row.artifactType, 'tool_definition');
  const newBody = row.newBody as any;
  // apiKey inside parameters.properties should be redacted (sensitive-key regex)
  assert.equal(newBody.parameters.properties.apiKey, '[redacted]');
  // Secret value should not land verbatim anywhere
  const json = JSON.stringify(row);
  assert.ok(!json.includes('SK_FAKE_abcdef1234567890abcdef1234567890'));
});

test('D2: write_system_prompt emits UPDATE when prior coordinator exists, CREATE otherwise', async () => {
  // UPDATE path — prior body present.
  {
    const { prisma, historyRows } = makeFakePrisma({
      aiConfigCoordinator: 'old coordinator body',
    });
    const ctx = makeCtx(prisma);
    const { factory, invoke } = captureTool();
    buildWriteSystemPromptTool(factory, () => ctx);
    const loadBearing = {
      property_identity: 'Marina Heights',
      checkin_time: '3pm',
      checkout_time: '11am',
      escalation_contact: '+971 50 1',
      payment_policy: 'Card on file',
      brand_voice: 'Warm',
    };
    const nonLoad: Record<string, string> = {};
    for (const k of ['cleaning_policy', 'amenities_list', 'local_recommendations', 'emergency_contact', 'noise_policy', 'pet_policy', 'smoking_policy', 'max_occupancy', 'id_verification', 'long_stay_discount', 'cancellation_policy', 'channel_coverage', 'timezone', 'ai_autonomy']) {
      nonLoad[k] = 'v';
    }
    await invoke({
      variant: 'coordinator',
      text: 'You are the coordinator.' + 'x'.repeat(120),
      sourceTemplateVersion: 'sha:abc',
      slotValues: { ...loadBearing, ...nonLoad },
      managerSanctioned: true,
    });
    assert.equal(historyRows.length, 1);
    assert.equal(historyRows[0]!.operation, 'UPDATE');
    assert.deepEqual(historyRows[0]!.prevBody, {
      text: 'old coordinator body',
      variant: 'coordinator',
    });
  }
  // CREATE path — fresh tenant.
  {
    const { prisma, historyRows } = makeFakePrisma({
      aiConfigCoordinator: null,
    });
    const ctx = makeCtx(prisma);
    const { factory, invoke } = captureTool();
    buildWriteSystemPromptTool(factory, () => ctx);
    const loadBearing = {
      property_identity: 'Marina',
      checkin_time: '3pm',
      checkout_time: '11am',
      escalation_contact: '+971',
      payment_policy: 'Card',
      brand_voice: 'Warm',
    };
    const nonLoad: Record<string, string> = {};
    for (const k of ['cleaning_policy', 'amenities_list', 'local_recommendations', 'emergency_contact', 'noise_policy', 'pet_policy', 'smoking_policy', 'max_occupancy', 'id_verification', 'long_stay_discount', 'cancellation_policy', 'channel_coverage', 'timezone', 'ai_autonomy']) {
      nonLoad[k] = 'v';
    }
    await invoke({
      variant: 'coordinator',
      text: 'Fresh prompt body ' + 'x'.repeat(120),
      sourceTemplateVersion: 'sha:abc',
      slotValues: { ...loadBearing, ...nonLoad },
      managerSanctioned: true,
    });
    assert.equal(historyRows.length, 1);
    assert.equal(historyRows[0]!.operation, 'CREATE');
    assert.equal(historyRows[0]!.prevBody, null);
  }
});

test('D2: history-insert failure is swallowed — real write still succeeds', async () => {
  const { prisma } = makeFakePrisma({ historyThrows: true });
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildCreateFaqTool(factory, () => ctx);
  // Silence the expected console.error so the test output stays clean.
  const origErr = console.error;
  console.error = () => {};
  try {
    const r = await invoke({
      category: 'wifi-technology',
      question: 'q?',
      answer: 'a',
    });
    assert.ok(!r.isError, 'write must succeed despite history insert throwing');
    const parsed = JSON.parse(r.content[0].text);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.faqEntryId, 'faq-new-1');
  } finally {
    console.error = origErr;
  }
});

test('D2: emitArtifactHistory sanitises tool_definition rows', async () => {
  const { prisma, historyRows } = makeFakePrisma();
  await emitArtifactHistory(prisma, {
    tenantId: 't1',
    artifactType: 'tool_definition',
    artifactId: 'tool-1',
    operation: 'CREATE',
    newBody: {
      name: 'custom_tool',
      webhookAuth: { type: 'bearer', apiKey: 'SK_FAKE_xxxx1234567890abcdef123456789012' },
    },
  });
  assert.equal(historyRows.length, 1);
  const row = historyRows[0]!;
  const newBody = row.newBody as any;
  assert.equal(newBody.webhookAuth.apiKey, '[redacted]');
});

test('D2: emitArtifactHistory does NOT sanitise non-tool types (faq/sop pass through)', async () => {
  const { prisma, historyRows } = makeFakePrisma();
  await emitArtifactHistory(prisma, {
    tenantId: 't1',
    artifactType: 'faq',
    artifactId: 'faq-1',
    operation: 'CREATE',
    newBody: {
      question: 'What is the wifi?',
      answer: 'abc',
      apiKey: 'would-be-redacted-if-tool', // faq rows should pass through
    },
  });
  const row = historyRows[0]!;
  const newBody = row.newBody as any;
  // FAQ passes through — apiKey key stays as-is (not a tool_definition).
  assert.equal(newBody.apiKey, 'would-be-redacted-if-tool');
});

test('D2: getToolArtifactPrevJson extracts parameters + webhookConfig from oldest history row', async () => {
  const t0 = new Date('2026-04-21T12:00:00Z');
  const firstInSession = new Date('2026-04-21T12:30:00Z');
  const { prisma } = makeFakePrisma({
    buildArtifactHistory: [
      {
        tenantId: 't1',
        artifactType: 'tool_definition',
        artifactId: 'tool-x',
        createdAt: firstInSession,
        prevBody: {
          parameters: { type: 'object', properties: { id: { type: 'string' } } },
          webhookUrl: 'https://old.example.com/w',
          webhookTimeout: 5000,
          webhookAuth: { type: 'none' },
        },
      },
    ],
  });
  const out = await getToolArtifactPrevJson(prisma, 't1', 'tool-x', t0.toISOString());
  assert.ok(out);
  assert.deepEqual(out!.prevParameters, {
    type: 'object',
    properties: { id: { type: 'string' } },
  });
  assert.ok(out!.prevWebhookConfig);
});

test('D2: getToolArtifactPrevJson returns null for unknown artifact or empty history', async () => {
  const { prisma } = makeFakePrisma();
  const out = await getToolArtifactPrevJson(
    prisma,
    't1',
    'tool-none',
    new Date().toISOString(),
  );
  assert.equal(out, null);
});
