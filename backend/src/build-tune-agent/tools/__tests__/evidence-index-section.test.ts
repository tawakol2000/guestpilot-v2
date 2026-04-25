/**
 * studio_get_evidence_index + studio_get_evidence_section unit tests.
 *
 * Run: JWT_SECRET=test npx tsx --test src/build-tune-agent/tools/__tests__/evidence-index-section.test.ts
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-evidence';

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGetEvidenceIndexTool } from '../get-evidence-index';
import { buildGetEvidenceSectionTool } from '../get-evidence-section';

interface Captured { name: string; handler: (a: any) => Promise<{ content: any[] }> }
const captured: Captured[] = [];
const fakeFactory = (name: string, _d: any, _s: any, handler: any) => {
  captured.push({ name, handler });
  return { name, handler };
};

const samplePayload = {
  assembledAt: '2026-04-25T00:00:00Z',
  disputedMessage: { id: 'msg_a', role: 'assistant', content: 'Hello there.' },
  conversationContext: { messages: [] },
  entities: { property: { name: 'Beach Cottage' }, reservation: { status: 'CONFIRMED' } },
  mainAiTrace: {
    aiApiLogId: 'log_1',
    model: 'gpt-5.4-mini',
    ragContext: {
      classifier: 'EARLY_CHECKIN',
      sopCategories: ['early-checkin'],
      faqHitIds: ['faq_a'],
      toolCalls: [
        { tool: 'get_sop', duration_ms: 50 },
        { tool: 'get_faq', duration_ms: 80, error: false },
      ],
    },
  },
  sopsInEffect: [{ category: 'early-checkin', toolDescription: '', variants: [], propertyOverrides: [] }],
  langfuseTrace: null,
};

function makePrisma(bundle: any = samplePayload) {
  return {
    evidenceBundle: {
      findFirst: async ({ where }: any) =>
        where?.id === 'evb_a' ? { id: 'evb_a', tenantId: 't1', payload: bundle } : null,
    },
  } as any;
}

test('studio_get_evidence_index: returns metadata + section pointers', async () => {
  captured.length = 0;
  const ctx = () => ({ prisma: makePrisma(), tenantId: 't1', conversationId: 'c1', userId: null }) as any;
  buildGetEvidenceIndexTool(fakeFactory as any, ctx);
  const out = JSON.parse((await captured[0].handler({ bundleId: 'evb_a' })).content[0].text);
  assert.equal(out.bundleId, 'evb_a');
  assert.ok(out.reply.pointer.startsWith('ref://evidence/'));
  assert.equal(out.sop_used.count, 1);
  assert.equal(out.tool_calls.length, 2);
  assert.equal(out.tool_calls[0].name, 'get_sop');
});

test('studio_get_evidence_section: resolves reply pointer to disputed message', async () => {
  captured.length = 0;
  const ctx = () => ({ prisma: makePrisma(), tenantId: 't1', conversationId: 'c1', userId: null }) as any;
  buildGetEvidenceIndexTool(fakeFactory as any, ctx);
  buildGetEvidenceSectionTool(fakeFactory as any, ctx);
  const idxOut = JSON.parse((await captured[0].handler({ bundleId: 'evb_a' })).content[0].text);
  const replyOut = JSON.parse((await captured[1].handler({ pointer: idxOut.reply.pointer })).content[0].text);
  assert.equal(replyOut.section, 'reply');
  assert.equal(replyOut.reply.id, 'msg_a');
});

test('studio_get_evidence_section: resolves classifier_detail pointer', async () => {
  captured.length = 0;
  const ctx = () => ({ prisma: makePrisma(), tenantId: 't1', conversationId: 'c1', userId: null }) as any;
  buildGetEvidenceIndexTool(fakeFactory as any, ctx);
  buildGetEvidenceSectionTool(fakeFactory as any, ctx);
  const idxOut = JSON.parse((await captured[0].handler({ bundleId: 'evb_a' })).content[0].text);
  const out = JSON.parse((await captured[1].handler({ pointer: idxOut.classifier_detail.pointer })).content[0].text);
  assert.equal(out.section, 'classifier_detail');
  assert.equal(out.classifier.decision, 'EARLY_CHECKIN');
  assert.deepEqual(out.classifier.sopCategories, ['early-checkin']);
});

test('studio_get_evidence_section: resolves a specific tool_call pointer', async () => {
  captured.length = 0;
  const ctx = () => ({ prisma: makePrisma(), tenantId: 't1', conversationId: 'c1', userId: null }) as any;
  buildGetEvidenceIndexTool(fakeFactory as any, ctx);
  buildGetEvidenceSectionTool(fakeFactory as any, ctx);
  const idxOut = JSON.parse((await captured[0].handler({ bundleId: 'evb_a' })).content[0].text);
  const ptr = idxOut.tool_calls[1].pointer;
  const out = JSON.parse((await captured[1].handler({ pointer: ptr })).content[0].text);
  assert.equal(out.section, 'tool_call');
  assert.equal(out.toolIndex, 1);
  assert.equal(out.call.tool, 'get_faq');
});

test('studio_get_evidence_index: reads ragContext.tools (canonical ai.service.ts shape)', async () => {
  captured.length = 0;
  const canonicalPayload = {
    ...samplePayload,
    mainAiTrace: {
      ...samplePayload.mainAiTrace,
      ragContext: {
        ...samplePayload.mainAiTrace.ragContext,
        // ai.service.ts attaches per-call as `tools[]` with name + durationMs.
        tools: [
          { name: 'get_sop', input: {}, results: {}, durationMs: 42 },
          { name: 'get_faq', input: {}, results: {}, durationMs: 71 },
        ],
        toolCalls: undefined,
      },
    },
  };
  const ctx = () => ({ prisma: makePrisma(canonicalPayload), tenantId: 't1', conversationId: 'c1', userId: null }) as any;
  buildGetEvidenceIndexTool(fakeFactory as any, ctx);
  const out = JSON.parse((await captured[0].handler({ bundleId: 'evb_a' })).content[0].text);
  assert.equal(out.tool_calls.length, 2);
  assert.equal(out.tool_calls[0].name, 'get_sop');
  assert.equal(out.tool_calls[0].duration_ms, 42);
  assert.equal(out.tool_calls[1].name, 'get_faq');
});

test('studio_get_evidence_section: rejects forged/tampered pointer', async () => {
  captured.length = 0;
  const ctx = () => ({ prisma: makePrisma(), tenantId: 't1', conversationId: 'c1', userId: null }) as any;
  buildGetEvidenceSectionTool(fakeFactory as any, ctx);
  const out = await captured[0].handler({ pointer: 'ref://evidence/x/AAAA.BBBB' });
  assert.match(out.content[0].text, /invalid pointer/);
});
