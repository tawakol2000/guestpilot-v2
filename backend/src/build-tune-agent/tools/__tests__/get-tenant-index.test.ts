/**
 * studio_get_tenant_index + studio_get_artifact — sprint 060-D phase 7.
 *
 * Run: JWT_SECRET=test npx tsx --test src/build-tune-agent/tools/__tests__/get-tenant-index.test.ts
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-tenant-index';

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGetTenantIndexTool } from '../get-tenant-index';
import { buildGetArtifactTool } from '../get-artifact';
import { decodePointer } from '../lib/pointer';

interface CapturedHandler {
  name: string;
  handler: (args: any) => Promise<{ content: any[] }>;
}
const captured: CapturedHandler[] = [];
const fakeFactory = (name: string, _desc: any, _schema: any, handler: any) => {
  captured.push({ name, handler });
  return { name, handler };
};

function makePrisma(opts?: {
  systemPrompt?: { coordinator: string; screening?: string; version: number };
  sops?: Array<{ id: string; category: string; toolDescription: string; enabled: boolean; variantContent: string }>;
  faqs?: Array<{ id: string; question: string; answer: string }>;
  tools?: Array<{ id: string; name: string; displayName: string; description: string }>;
}) {
  const sops = (opts?.sops ?? []).map((s) => ({
    id: s.id,
    category: s.category,
    toolDescription: s.toolDescription,
    enabled: s.enabled,
    variants: [{ id: `${s.id}_v1`, status: 'DEFAULT', content: s.variantContent, enabled: true }],
    propertyOverrides: [],
  }));
  const faqs = (opts?.faqs ?? []).map((f) => ({
    id: f.id,
    category: 'general',
    scope: 'GLOBAL',
    propertyId: null,
    question: f.question,
    answer: f.answer,
    status: 'PUBLISHED',
  }));
  const tools = (opts?.tools ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    displayName: t.displayName,
    description: t.description,
    type: 'system',
    agentScope: 'all',
    enabled: true,
  }));
  return {
    tenantAiConfig: {
      findUnique: async () => ({
        systemPromptCoordinator: opts?.systemPrompt?.coordinator ?? '',
        systemPromptScreening: opts?.systemPrompt?.screening ?? '',
        systemPromptVersion: opts?.systemPrompt?.version ?? 1,
      }),
    },
    sopDefinition: {
      count: async () => sops.length,
      findMany: async () => sops,
    },
    sopVariant: {
      findMany: async () => [],
    },
    faqEntry: {
      count: async ({ where }: any) =>
        where?.scope === 'GLOBAL' ? faqs.length : where?.scope === 'PROPERTY' ? 0 : faqs.length,
      findMany: async () => faqs,
    },
    toolDefinition: {
      count: async ({ where }: any) => (where?.type === 'custom' ? 0 : tools.length),
      findMany: async () => tools,
    },
    property: { count: async () => 0 },
    buildTransaction: { findFirst: async () => null },
  } as any;
}

test('studio_get_tenant_index: returns metadata + body_pointer per artifact, no body', async () => {
  captured.length = 0;
  const prisma = makePrisma({
    systemPrompt: { coordinator: 'You are an assistant', version: 3 },
    sops: [{ id: 'sop_a', category: 'cleaning', toolDescription: 'Cleaning policy SOP', enabled: true, variantContent: 'CLEAN ALL THE THINGS' }],
    faqs: [{ id: 'faq_a', question: 'wifi password?', answer: 'It is hunter2' }],
    tools: [{ id: 'td_a', name: 'send_passport_request', displayName: 'Send passport request', description: 'Asks the guest for passport.' }],
  });
  const ctx = () => ({ prisma, tenantId: 't1', conversationId: 'c1', userId: null }) as any;
  buildGetTenantIndexTool(fakeFactory as any, ctx);
  const tool = captured[0];
  const out = await tool.handler({});
  const json = JSON.parse(out.content[0].text);

  assert.equal(json.system_prompts.length, 2);
  assert.equal(json.sops.length, 1);
  assert.equal(json.faqs.length, 1);
  assert.equal(json.tools.length, 1);
  // Each entry has a body_pointer; no body field at the index level.
  assert.ok(json.sops[0].body_pointer.startsWith('ref://'));
  assert.equal(json.sops[0].body_pointer.includes('CLEAN ALL'), false);
  assert.equal(typeof json.sops[0].body_tokens, 'number');
});

test('studio_get_artifact: resolves a sop body_pointer to full body', async () => {
  captured.length = 0;
  const prisma = makePrisma({
    sops: [{ id: 'sop_a', category: 'cleaning', toolDescription: 'desc', enabled: true, variantContent: 'BODY-A' }],
  });
  const ctx = () => ({ prisma, tenantId: 't1', conversationId: 'c1', userId: null }) as any;
  buildGetTenantIndexTool(fakeFactory as any, ctx);
  buildGetArtifactTool(fakeFactory as any, ctx);
  const indexHandler = captured[0].handler;
  const artifactHandler = captured[1].handler;

  const indexJson = JSON.parse((await indexHandler({})).content[0].text);
  const sopPointer = indexJson.sops[0].body_pointer;
  const decoded = decodePointer(sopPointer, 'artifact');
  assert.equal(decoded.ok, true);

  const artifactOut = JSON.parse((await artifactHandler({ pointer: sopPointer })).content[0].text);
  assert.equal(artifactOut.kind, 'sop');
  assert.equal(artifactOut.sop.id, 'sop_a');
  assert.equal(artifactOut.sop.variants[0].content, 'BODY-A');
});

test('studio_get_artifact: rejects forged pointer', async () => {
  captured.length = 0;
  const prisma = makePrisma({});
  const ctx = () => ({ prisma, tenantId: 't1', conversationId: 'c1', userId: null }) as any;
  buildGetArtifactTool(fakeFactory as any, ctx);
  const handler = captured[0].handler;
  const out = await handler({ pointer: 'ref://artifact/fake/AAAA.BBBB' });
  assert.equal(out.content[0].type, 'text');
  assert.match(out.content[0].text, /invalid pointer/);
});

test('studio_get_artifact: resolves system_prompt variant pointer', async () => {
  captured.length = 0;
  const prisma = makePrisma({
    systemPrompt: { coordinator: 'COORD-TEXT', screening: 'SCREEN-TEXT', version: 7 },
  });
  const ctx = () => ({ prisma, tenantId: 't1', conversationId: 'c1', userId: null }) as any;
  buildGetTenantIndexTool(fakeFactory as any, ctx);
  buildGetArtifactTool(fakeFactory as any, ctx);
  const idx = JSON.parse((await captured[0].handler({})).content[0].text);
  const screening = idx.system_prompts.find((e: any) => e.id === 'screening');
  const out = JSON.parse((await captured[1].handler({ pointer: screening.body_pointer })).content[0].text);
  assert.equal(out.kind, 'system_prompt');
  assert.equal(out.variant, 'screening');
  assert.equal(out.text, 'SCREEN-TEXT');
  assert.equal(out.version, 7);
});
