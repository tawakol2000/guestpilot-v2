/**
 * Sprint 053-A D1 — dryRun seam regression tests for write tools.
 *
 * Run:  JWT_SECRET=test OPENAI_API_KEY=test-fake \
 *         npx tsx --test src/build-tune-agent/tools/__tests__/dry-run-seam.test.ts
 *
 * For each write tool (create_faq, create_sop, create_tool_definition,
 * write_system_prompt) we assert:
 *   - dryRun: true → returns preview, performs zero DB writes
 *   - dryRun: true with invalid input → returns validation error, no DB writes
 *   - dryRun-default behaviour unchanged
 *   - tool_definition preview is sanitised (api keys redacted)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCreateFaqTool } from '../create-faq';
import { buildCreateSopTool } from '../create-sop';
import { buildCreateToolDefinitionTool } from '../create-tool-definition';
import { buildWriteSystemPromptTool } from '../write-system-prompt';
import { sanitiseArtifactPayload } from '../../lib/sanitise-artifact-payload';
import type { ToolContext } from '../types';

function captureTool() {
  let captured: any = null;
  const fakeToolFactory = ((_name: string, _desc: string, _schema: any, handler: any) => {
    captured = handler;
    return { name: _name };
  }) as any;
  return {
    factory: fakeToolFactory,
    invoke: (args: any) => captured(args),
  };
}

function makeFakePrisma(opts?: {
  properties?: Array<{ id: string; tenantId: string }>;
  existingDefinitions?: Array<{ id: string; tenantId: string; category: string }>;
  existingVariants?: Array<{ id: string; sopDefinitionId: string; status: string }>;
  existingOverrides?: Array<{ id: string; sopDefinitionId: string; propertyId: string; status: string }>;
  existingTools?: Array<{ id: string; tenantId: string; name: string }>;
}) {
  const writes: string[] = [];
  const propRows = [...(opts?.properties ?? [])];
  const defs = [...(opts?.existingDefinitions ?? [])];
  const variants = [...(opts?.existingVariants ?? [])];
  const overrides = [...(opts?.existingOverrides ?? [])];
  const tools = [...(opts?.existingTools ?? [])];

  const prisma: any = {
    buildTransaction: {
      findFirst: async () => null,
      update: async () => { writes.push('buildTransaction.update'); return {}; },
    },
    property: {
      findFirst: async ({ where }: any) => {
        const r = propRows.find((p) => p.id === where.id && p.tenantId === where.tenantId);
        return r ? { id: r.id } : null;
      },
    },
    faqEntry: {
      create: async () => { writes.push('faqEntry.create'); return { id: 'should-not-happen' }; },
    },
    sopDefinition: {
      findUnique: async ({ where }: any) => {
        const r = defs.find(
          (d) => d.tenantId === where.tenantId_category.tenantId &&
                 d.category === where.tenantId_category.category
        );
        return r ? { id: r.id } : null;
      },
      upsert: async () => { writes.push('sopDefinition.upsert'); return { id: 'def-x', category: 'x' }; },
    },
    sopVariant: {
      findUnique: async ({ where }: any) => {
        const r = variants.find(
          (v) => v.sopDefinitionId === where.sopDefinitionId_status.sopDefinitionId &&
                 v.status === where.sopDefinitionId_status.status
        );
        return r ? { id: r.id } : null;
      },
      create: async () => { writes.push('sopVariant.create'); return { id: 'should-not-happen' }; },
    },
    sopPropertyOverride: {
      findUnique: async ({ where }: any) => {
        const k = where.sopDefinitionId_propertyId_status;
        const r = overrides.find(
          (o) => o.sopDefinitionId === k.sopDefinitionId &&
                 o.propertyId === k.propertyId &&
                 o.status === k.status
        );
        return r ? { id: r.id } : null;
      },
      create: async () => { writes.push('sopPropertyOverride.create'); return { id: 'should-not-happen' }; },
    },
    toolDefinition: {
      findFirst: async ({ where }: any) => {
        const r = tools.find((t) => t.tenantId === where.tenantId && t.name === where.name);
        return r ? { id: r.id } : null;
      },
      create: async () => { writes.push('toolDefinition.create'); return { id: 'should-not-happen', name: '', displayName: '', agentScope: '' }; },
    },
    tenantAiConfig: {
      findUnique: async () => null,
      upsert: async () => { writes.push('tenantAiConfig.upsert'); return { systemPromptVersion: 1, systemPromptCoordinator: '', systemPromptScreening: null }; },
    },
    aiConfigVersion: {
      create: async () => { writes.push('aiConfigVersion.create'); return { id: 'should-not-happen', version: 1 }; },
    },
  };
  return { prisma, writes };
}

function makeCtx(prisma: any): ToolContext & { _emitted: any[] } {
  const emitted: any[] = [];
  return {
    prisma,
    tenantId: 't1',
    conversationId: 'c1',
    userId: 'u1',
    lastUserSanctionedApply: false,
    emitDataPart: (part) => { emitted.push(part); },
    _emitted: emitted,
  };
}

test('dryRun seam: create_faq returns preview, performs zero DB writes', async () => {
  const { prisma, writes } = makeFakePrisma();
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildCreateFaqTool(factory, () => ctx);
  const r = await invoke({
    category: 'wifi-technology',
    question: 'What is the wifi password?',
    answer: 'Inside the welcome book on the counter.',
    dryRun: true,
  });
  assert.ok(!r.isError, 'should succeed');
  const parsed = JSON.parse(r.content[0].text);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.artifactType, 'faq');
  assert.equal(parsed.preview.question, 'What is the wifi password?');
  assert.equal(parsed.preview.scope, 'GLOBAL');
  assert.equal(parsed.diff.kind, 'create');
  assert.equal(writes.length, 0, 'no DB writes in dry-run');
  assert.equal(ctx._emitted.length, 0, 'no data parts in dry-run');
});

test('dryRun seam: create_faq with invalid property returns error, no writes', async () => {
  const { prisma, writes } = makeFakePrisma();
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildCreateFaqTool(factory, () => ctx);
  const r = await invoke({
    category: 'wifi-technology',
    question: 'q?',
    answer: 'a',
    propertyId: 'unknown-prop',
    dryRun: true,
  });
  assert.ok(r.isError, 'invalid property must error in dry-run too');
  assert.ok(r.content[0].text.includes('unknown-prop'));
  assert.equal(writes.length, 0);
});

test('dryRun seam: create_faq without dryRun still writes (control)', async () => {
  const { prisma, writes } = makeFakePrisma();
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildCreateFaqTool(factory, () => ctx);
  const r = await invoke({
    category: 'wifi-technology',
    question: 'q?',
    answer: 'a',
  });
  assert.ok(!r.isError);
  assert.ok(writes.includes('faqEntry.create'), 'real write must run when dryRun is omitted');
});

test('dryRun seam: create_sop variant preview, no writes', async () => {
  const { prisma, writes } = makeFakePrisma();
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildCreateSopTool(factory, () => ctx);
  const r = await invoke({
    sopCategory: 'late-checkout-policy',
    status: 'DEFAULT',
    title: 'Late checkout policy',
    body: 'When a guest requests a late checkout, accommodate up to 2pm if possible.',
    dryRun: true,
  });
  assert.ok(!r.isError);
  const parsed = JSON.parse(r.content[0].text);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.artifactType, 'sop');
  assert.equal(parsed.preview.kind, 'variant');
  assert.equal(parsed.preview.sopCategory, 'late-checkout-policy');
  assert.equal(writes.length, 0);
});

test('dryRun seam: create_sop override preview, no writes', async () => {
  const { prisma, writes } = makeFakePrisma({
    properties: [{ id: 'prop1', tenantId: 't1' }],
  });
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildCreateSopTool(factory, () => ctx);
  const r = await invoke({
    sopCategory: 'late-checkout-policy',
    status: 'CONFIRMED',
    propertyId: 'prop1',
    title: 'Late checkout — Marina suite',
    body: 'For the Marina suite, late checkout up to 4pm is fine in low season.',
    dryRun: true,
  });
  assert.ok(!r.isError);
  const parsed = JSON.parse(r.content[0].text);
  assert.equal(parsed.preview.kind, 'override');
  assert.equal(parsed.preview.propertyId, 'prop1');
  assert.equal(writes.length, 0);
});

test('dryRun seam: create_sop blocks if variant already exists (validation runs)', async () => {
  const { prisma, writes } = makeFakePrisma({
    existingDefinitions: [{ id: 'def-1', tenantId: 't1', category: 'late-checkout-policy' }],
    existingVariants: [{ id: 'var-1', sopDefinitionId: 'def-1', status: 'DEFAULT' }],
  });
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildCreateSopTool(factory, () => ctx);
  const r = await invoke({
    sopCategory: 'late-checkout-policy',
    status: 'DEFAULT',
    title: 'Late checkout policy',
    body: 'Some body that is at least twenty characters long.',
    dryRun: true,
  });
  assert.ok(r.isError, 'duplicate variant must error in dry-run too');
  assert.ok(r.content[0].text.includes('already exists'));
  assert.equal(writes.length, 0);
});

test('dryRun seam: create_tool_definition returns SANITISED preview, no writes', async () => {
  const { prisma, writes } = makeFakePrisma();
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildCreateToolDefinitionTool(factory, () => ctx);
  const r = await invoke({
    name: 'check_cleaning_schedule',
    description: 'Checks the cleaning schedule for a given property and date. Returns a list of scheduled cleanings with their windows.',
    parameters: { type: 'object', properties: { propertyId: { type: 'string' }, apiKey: { type: 'string' } } },
    webhookUrl: 'https://example.com/webhook',
    webhookAuth: { type: 'bearer', secretName: 'CLEANING_API_TOKEN' },
    availableStatuses: ['CONFIRMED'],
    dryRun: true,
  });
  assert.ok(!r.isError);
  const parsed = JSON.parse(r.content[0].text);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.artifactType, 'tool_definition');
  // Sanitiser must have run on the preview.
  // The `parameters` object has a key matching /api[_-]?key/i — should be redacted.
  const params = parsed.preview.parameters;
  assert.equal(params.properties.apiKey, '[redacted]', 'apiKey key in parameters must be redacted');
  assert.equal(writes.length, 0);
});

test('dryRun seam: create_tool_definition with name collision errors, no writes', async () => {
  const { prisma, writes } = makeFakePrisma({
    existingTools: [{ id: 'tool-1', tenantId: 't1', name: 'existing_tool' }],
  });
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildCreateToolDefinitionTool(factory, () => ctx);
  const r = await invoke({
    name: 'existing_tool',
    description: 'Some long description that meets the 40-character minimum requirement here.',
    parameters: { type: 'object' },
    webhookUrl: 'https://example.com/x',
    webhookAuth: { type: 'none' },
    availableStatuses: ['CONFIRMED'],
    dryRun: true,
  });
  assert.ok(r.isError);
  assert.ok(r.content[0].text.includes('already exists'));
  assert.equal(writes.length, 0);
});

test('dryRun seam: write_system_prompt returns preview, no writes', async () => {
  const { prisma, writes } = makeFakePrisma();
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildWriteSystemPromptTool(factory, () => ctx);
  const slotValues = {
    property_identity: 'Marina Heights, 3 units in Dubai Marina',
    checkin_time: '3pm',
    checkout_time: '11am',
    escalation_contact: '+971 50 123 4567',
    payment_policy: 'Card on file at booking',
    brand_voice: 'Warm, professional, concise',
    cleaning_policy: 'Daily housekeeping',
    amenities_list: 'Pool, gym, parking',
    local_recommendations: 'Beach, JBR walk',
    emergency_contact: '999',
    noise_policy: 'Quiet hours 10pm-8am',
    pet_policy: 'No pets',
    smoking_policy: 'Non-smoking',
    max_occupancy: '4 guests',
    id_verification: 'Required at check-in',
    long_stay_discount: '10% off 7+ nights',
    cancellation_policy: 'Free 48h prior',
    channel_coverage: 'Airbnb, Booking, Direct',
    timezone: 'Asia/Dubai',
    ai_autonomy: 'Coordinator + screening',
  };
  const text = 'You are the Marina Heights guest coordinator. ' + 'a'.repeat(120);
  const r = await invoke({
    variant: 'coordinator',
    text,
    sourceTemplateVersion: 'sha:abc123',
    slotValues,
    managerSanctioned: true,
    dryRun: true,
  });
  assert.ok(!r.isError, `should succeed, got: ${r.content?.[0]?.text ?? 'no body'}`);
  const parsed = JSON.parse(r.content[0].text);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.artifactType, 'system_prompt');
  assert.equal(parsed.preview.variant, 'coordinator');
  assert.equal(parsed.preview.text, text);
  assert.equal(writes.length, 0);
});

test('dryRun seam: write_system_prompt with low coverage errors, no writes', async () => {
  const { prisma, writes } = makeFakePrisma();
  const ctx = makeCtx(prisma);
  const { factory, invoke } = captureTool();
  buildWriteSystemPromptTool(factory, () => ctx);
  const r = await invoke({
    variant: 'coordinator',
    text: 'a'.repeat(150),
    sourceTemplateVersion: 'sha:abc123',
    slotValues: { property_identity: 'X' }, // only 1 slot — coverage will be ~0.05
    managerSanctioned: true,
    dryRun: true,
  });
  assert.ok(r.isError, 'low coverage must error in dry-run');
  assert.equal(writes.length, 0);
});

test('dryRun seam: sanitiser parity — same input produces same output for D1 + D2 paths', () => {
  // The same function backs preview (D1) and history storage (D2). If they
  // ever diverge, an attacker could see a key in the preview that the
  // history would have stored — or vice versa. Assert literal identity.
  const input = {
    apiKey: 'SK_FAKE_1234567890abcdef1234567890abcdef',
    secretName: 'CLEANING_API_TOKEN',
    nested: {
      authorization: 'Bearer xyz',
      visible: 'fine',
      opaqueToken: 'A1B2C3D4E5F6G7H8I9J0KLMNOPQRSTUV',
    },
    arr: ['short', 'A1B2C3D4E5F6G7H8I9J0KLMNOPQRSTUV'],
  };
  const a = sanitiseArtifactPayload(input);
  const b = sanitiseArtifactPayload(input);
  assert.deepEqual(a, b, 'two calls must produce identical output');
  // Spot-check: redaction actually happened.
  const ja = JSON.stringify(a);
  assert.ok(!ja.includes('SK_FAKE_1234567890abcdef1234567890abcdef'), 'apiKey body must not appear');
  assert.ok(!ja.includes('Bearer xyz'), 'authorization value must not appear');
});
