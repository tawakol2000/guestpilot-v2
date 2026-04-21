/**
 * Sprint 054-A F1 — rationale integration tests across write tools.
 *
 * Run: JWT_SECRET=test OPENAI_API_KEY=test-fake \
 *        npx tsx --test src/build-tune-agent/tools/__tests__/rationale-required.test.ts
 *
 * Covers, for each write tool:
 *   - missing rationale → validation error, no DB write
 *   - blocklist rationale → validation error, no DB write
 *   - valid rationale → stored in history metadata.rationale
 *   - dry-run with valid rationale → preview payload includes rationale, no DB write, no history row
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCreateFaqTool } from '../create-faq';
import { buildCreateSopTool } from '../create-sop';
import { buildCreateToolDefinitionTool } from '../create-tool-definition';
import { buildWriteSystemPromptTool } from '../write-system-prompt';
import type { ToolContext } from '../types';

const GOOD_RATIONALE =
  'Manager mentioned late-checkout requests for VIPs are recurring; adding a DEFAULT SOP so the AI handles it without escalating.';

function rawCapture() {
  let captured: any = null;
  const fakeToolFactory = ((_n: string, _d: string, _s: any, h: any) => {
    captured = h;
    return { name: _n };
  }) as any;
  return { factory: fakeToolFactory, invoke: (a: any) => captured(a) };
}

interface HistoryRow {
  artifactType: string;
  artifactId: string;
  operation: string;
  metadata: Record<string, unknown> | null;
  newBody: unknown;
}

function makeFakePrisma() {
  const history: HistoryRow[] = [];
  const writes: string[] = [];
  const prisma: any = {
    buildTransaction: {
      findFirst: async () => null,
      update: async () => ({}),
    },
    property: { findFirst: async () => ({ id: 'p1' }) },
    faqEntry: {
      create: async ({ data }: any) => {
        writes.push('faqEntry.create');
        return { id: 'faq-1', ...data };
      },
    },
    sopDefinition: {
      findUnique: async () => null,
      upsert: async () => {
        writes.push('sopDefinition.upsert');
        return { id: 'sopdef-1', category: 'late-checkout' };
      },
    },
    sopVariant: {
      findUnique: async () => null,
      create: async () => {
        writes.push('sopVariant.create');
        return { id: 'var-1' };
      },
    },
    sopPropertyOverride: {
      findUnique: async () => null,
      create: async () => {
        writes.push('sopPropertyOverride.create');
        return { id: 'ovr-1' };
      },
    },
    toolDefinition: {
      findFirst: async () => null,
      create: async ({ data }: any) => {
        writes.push('toolDefinition.create');
        return {
          id: 'tool-1',
          name: data.name,
          displayName: data.displayName,
          agentScope: data.agentScope,
        };
      },
    },
    tenantAiConfig: {
      findUnique: async () => null,
      upsert: async () => {
        writes.push('tenantAiConfig.upsert');
        return {
          systemPromptVersion: 1,
          systemPromptCoordinator: 'x',
          systemPromptScreening: null,
        };
      },
    },
    aiConfigVersion: {
      create: async () => {
        writes.push('aiConfigVersion.create');
        return { id: 'cv-1', version: 1 };
      },
    },
    buildArtifactHistory: {
      create: async ({ data }: any) => {
        history.push({
          artifactType: data.artifactType,
          artifactId: data.artifactId,
          operation: data.operation,
          metadata: data.metadata ?? null,
          newBody: data.newBody ?? null,
        });
        return { id: `hist-${history.length}` };
      },
    },
  };
  return { prisma, history, writes };
}

function makeCtx(prisma: any): ToolContext {
  return {
    prisma,
    tenantId: 't1',
    conversationId: 'c1',
    userId: 'u1',
    lastUserSanctionedApply: false,
    emitDataPart: () => {},
  };
}

// --- create_faq ------------------------------------------------------------

test('create_faq: missing rationale → error, no DB write', async () => {
  const { prisma, writes } = makeFakePrisma();
  const { factory, invoke } = rawCapture();
  buildCreateFaqTool(factory, () => makeCtx(prisma));
  const r = await invoke({
    category: 'wifi-technology',
    question: 'What is the wifi password?',
    answer: 'See welcome card.',
  });
  assert.ok(r.isError, 'should error without rationale');
  assert.match(r.content[0].text, /rationale is required/i);
  assert.equal(writes.length, 0);
});

test('create_faq: blocklist rationale → error, no DB write', async () => {
  const { prisma, writes } = makeFakePrisma();
  const { factory, invoke } = rawCapture();
  buildCreateFaqTool(factory, () => makeCtx(prisma));
  const r = await invoke({
    category: 'wifi-technology',
    question: 'q?',
    answer: 'a',
    rationale: 'updating        ',
  });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /lazy placeholder|too short/i);
  assert.equal(writes.length, 0);
});

test('create_faq: valid rationale → stored in history metadata.rationale', async () => {
  const { prisma, history, writes } = makeFakePrisma();
  const { factory, invoke } = rawCapture();
  buildCreateFaqTool(factory, () => makeCtx(prisma));
  const r = await invoke({
    category: 'wifi-technology',
    question: 'What is the wifi password?',
    answer: 'See welcome card.',
    rationale: GOOD_RATIONALE,
  });
  assert.ok(!r.isError);
  assert.ok(writes.includes('faqEntry.create'));
  assert.equal(history.length, 1);
  assert.equal(history[0].metadata?.rationale, GOOD_RATIONALE);
});

test('create_faq: dry-run echoes rationale in preview, no history row', async () => {
  const { prisma, history, writes } = makeFakePrisma();
  const { factory, invoke } = rawCapture();
  buildCreateFaqTool(factory, () => makeCtx(prisma));
  const r = await invoke({
    category: 'wifi-technology',
    question: 'q?',
    answer: 'a',
    rationale: GOOD_RATIONALE,
    dryRun: true,
  });
  assert.ok(!r.isError);
  const parsed = JSON.parse(r.content[0].text);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.rationale, GOOD_RATIONALE);
  assert.equal(writes.length, 0);
  assert.equal(history.length, 0);
});

// --- create_sop (variant + override) ---------------------------------------

test('create_sop: missing rationale → error, no DB write (variant path)', async () => {
  const { prisma, writes } = makeFakePrisma();
  const { factory, invoke } = rawCapture();
  buildCreateSopTool(factory, () => makeCtx(prisma));
  const r = await invoke({
    sopCategory: 'late-checkout-policy',
    status: 'DEFAULT',
    title: 'Late checkout',
    body: 'Grant late checkout up to 2pm.',
  });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /rationale is required/i);
  assert.equal(writes.length, 0);
});

test('create_sop: valid rationale → stored in history metadata.rationale (variant path)', async () => {
  const { prisma, history } = makeFakePrisma();
  const { factory, invoke } = rawCapture();
  buildCreateSopTool(factory, () => makeCtx(prisma));
  const r = await invoke({
    sopCategory: 'late-checkout-policy',
    status: 'DEFAULT',
    title: 'Late checkout',
    body: 'Grant late checkout up to 2pm.',
    rationale: GOOD_RATIONALE,
  });
  assert.ok(!r.isError);
  assert.equal(history.length, 1);
  assert.equal(history[0].artifactType, 'sop');
  assert.equal(history[0].metadata?.rationale, GOOD_RATIONALE);
});

test('create_sop: valid rationale → stored in history metadata.rationale (override path)', async () => {
  const { prisma, history } = makeFakePrisma();
  const { factory, invoke } = rawCapture();
  buildCreateSopTool(factory, () => makeCtx(prisma));
  const r = await invoke({
    sopCategory: 'late-checkout-policy',
    status: 'CONFIRMED',
    title: 'Late checkout — Marina',
    body: 'For Marina suite, late checkout up to 4pm is fine in low season.',
    propertyId: 'p1',
    rationale: GOOD_RATIONALE,
  });
  assert.ok(!r.isError);
  assert.equal(history.length, 1);
  assert.equal(history[0].artifactType, 'property_override');
  assert.equal(history[0].metadata?.rationale, GOOD_RATIONALE);
});

// --- create_tool_definition ------------------------------------------------

test('create_tool_definition: missing rationale → error, no DB write', async () => {
  const { prisma, writes } = makeFakePrisma();
  const { factory, invoke } = rawCapture();
  buildCreateToolDefinitionTool(factory, () => makeCtx(prisma));
  const r = await invoke({
    name: 'check_cleaning_schedule',
    description:
      'Checks the cleaning schedule for a given property and date. Returns scheduled windows.',
    parameters: { type: 'object' },
    webhookUrl: 'https://example.com/webhook',
    webhookAuth: { type: 'none' },
    availableStatuses: ['CONFIRMED'],
  });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /rationale is required/i);
  assert.equal(writes.length, 0);
});

test('create_tool_definition: valid rationale → stored in history metadata.rationale', async () => {
  const { prisma, history } = makeFakePrisma();
  const { factory, invoke } = rawCapture();
  buildCreateToolDefinitionTool(factory, () => makeCtx(prisma));
  const r = await invoke({
    name: 'check_cleaning_schedule',
    description:
      'Checks the cleaning schedule for a given property and date. Returns scheduled windows.',
    parameters: { type: 'object' },
    webhookUrl: 'https://example.com/webhook',
    webhookAuth: { type: 'none' },
    availableStatuses: ['CONFIRMED'],
    rationale: GOOD_RATIONALE,
  });
  assert.ok(!r.isError);
  assert.equal(history.length, 1);
  assert.equal(history[0].artifactType, 'tool_definition');
  assert.equal(history[0].metadata?.rationale, GOOD_RATIONALE);
});

// --- write_system_prompt ---------------------------------------------------

const FULL_SLOTS = {
  property_identity: 'Marina Heights, 3 units in Dubai Marina',
  checkin_time: '3pm',
  checkout_time: '11am',
  escalation_contact: '+971 50 123 4567',
  payment_policy: 'Card on file',
  brand_voice: 'Warm, professional',
  cleaning_policy: 'Daily housekeeping',
  amenities_list: 'Pool, gym',
  local_recommendations: 'JBR walk',
  emergency_contact: '999',
  noise_policy: 'Quiet 10pm-8am',
  pet_policy: 'No pets',
  smoking_policy: 'Non-smoking',
  max_occupancy: '4',
  id_verification: 'Required',
  long_stay_discount: '10% off 7+',
  cancellation_policy: 'Free 48h prior',
  channel_coverage: 'Airbnb, Booking, Direct',
  timezone: 'Asia/Dubai',
  ai_autonomy: 'Coordinator + screening',
};

test('write_system_prompt: missing rationale → error, no DB write', async () => {
  const { prisma, writes } = makeFakePrisma();
  const { factory, invoke } = rawCapture();
  buildWriteSystemPromptTool(factory, () => makeCtx(prisma));
  const r = await invoke({
    variant: 'coordinator',
    text: 'a'.repeat(200),
    sourceTemplateVersion: 'sha:abc',
    slotValues: FULL_SLOTS,
    managerSanctioned: true,
  });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /rationale is required/i);
  assert.equal(writes.length, 0);
});

test('write_system_prompt: valid rationale → stored in history metadata.rationale', async () => {
  const { prisma, history } = makeFakePrisma();
  const { factory, invoke } = rawCapture();
  buildWriteSystemPromptTool(factory, () => makeCtx(prisma));
  const r = await invoke({
    variant: 'coordinator',
    text: 'You are the guest coordinator. ' + 'a'.repeat(200),
    sourceTemplateVersion: 'sha:abc',
    slotValues: FULL_SLOTS,
    managerSanctioned: true,
    rationale: GOOD_RATIONALE,
  });
  assert.ok(!r.isError, `should succeed, got: ${r.content?.[0]?.text ?? 'no body'}`);
  assert.equal(history.length, 1);
  assert.equal(history[0].artifactType, 'system_prompt');
  assert.equal(history[0].metadata?.rationale, GOOD_RATIONALE);
});
