/**
 * propose_suggestion — sprint 046 Session B retrofit tests.
 *
 * The legacy tool has been in production since sprint 02. Session B
 * adds a second emit — `data-suggested-fix` with the new
 * target + before/after shape — alongside the existing
 * `data-suggestion-preview`. These tests only cover the retrofit;
 * the legacy behavior is exercised by the integration suite.
 *
 * Run: JWT_SECRET=test npx tsx --test src/build-tune-agent/tools/__tests__/propose-suggestion.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildProposeSuggestionTool } from '../propose-suggestion';
import type { ToolContext } from '../types';

function captureTool() {
  let captured: any = null;
  const fakeToolFactory = ((_n: string, _d: string, _s: any, handler: any) => {
    captured = handler;
    return { name: _n };
  }) as any;
  return { factory: fakeToolFactory, invoke: (args: any) => captured(args) };
}

function makeCtx(): ToolContext & {
  _emitted: Array<{ type: string; id?: string; data: unknown }>;
} {
  const emitted: Array<{ type: string; id?: string; data: unknown }> = [];
  return {
    prisma: {} as any,
    tenantId: 't1',
    conversationId: 'conv1',
    userId: 'u1',
    lastUserSanctionedApply: false,
    emitDataPart: (part) => emitted.push({ type: part.type, id: part.id, data: part.data }),
    _emitted: emitted,
  };
}

test('propose_suggestion emits both data-suggestion-preview AND data-suggested-fix', async () => {
  const ctx = makeCtx();
  const { factory, invoke } = captureTool();
  buildProposeSuggestionTool(factory, () => ctx);
  await invoke({
    category: 'SYSTEM_PROMPT',
    subLabel: 'checkout-time-tone',
    rationale: 'Manager corrected a too-formal late-checkout decline.',
    editFormat: 'search_replace',
    oldText: 'We regret to inform you that late checkout is not available.',
    newText: 'Late checkout is not available this weekend, sorry about that!',
    target: { artifact: 'system_prompt', sectionId: 'checkout_time' },
    impact: 'Softens tone on a common decline path.',
  });

  const types = ctx._emitted.map((p) => p.type);
  assert.ok(types.includes('data-suggestion-preview'), 'legacy preview part must still emit');
  assert.ok(types.includes('data-suggested-fix'), 'new suggested-fix part must emit');

  const fix = ctx._emitted.find((p) => p.type === 'data-suggested-fix')!.data as any;
  assert.equal(fix.target.artifact, 'system_prompt');
  assert.equal(fix.target.sectionId, 'checkout_time');
  assert.equal(fix.before, 'We regret to inform you that late checkout is not available.');
  assert.equal(fix.after, 'Late checkout is not available this weekend, sorry about that!');
  assert.equal(fix.rationale, 'Manager corrected a too-formal late-checkout decline.');
  assert.equal(fix.impact, 'Softens tone on a common decline path.');
  assert.equal(fix.category, 'SYSTEM_PROMPT');
  assert.ok(fix.id, 'id present');
  assert.ok(fix.createdAt, 'createdAt present');
});

test('propose_suggestion (full_replacement) derives before/after from proposedText + beforeText', async () => {
  const ctx = makeCtx();
  const { factory, invoke } = captureTool();
  buildProposeSuggestionTool(factory, () => ctx);
  await invoke({
    category: 'FAQ',
    subLabel: 'wifi-password',
    rationale: 'Password shape changed after router swap.',
    editFormat: 'full_replacement',
    beforeText: 'WIFI-2024',
    proposedText: 'GuestWifi-2026',
    target: { artifact: 'faq', artifactId: 'faq-abc' },
  });

  const fix = ctx._emitted.find((p) => p.type === 'data-suggested-fix')!.data as any;
  assert.equal(fix.before, 'WIFI-2024');
  assert.equal(fix.after, 'GuestWifi-2026');
  assert.equal(fix.target.artifact, 'faq');
  assert.equal(fix.target.artifactId, 'faq-abc');
});

test('propose_suggestion derives FixTarget from legacy targetHint when no target is supplied', async () => {
  const ctx = makeCtx();
  const { factory, invoke } = captureTool();
  buildProposeSuggestionTool(factory, () => ctx);
  await invoke({
    category: 'FAQ',
    subLabel: 'parking-note',
    rationale: 'Property-specific detail missing.',
    editFormat: 'full_replacement',
    beforeText: '',
    proposedText: 'Parking is at the rear; access via the red gate.',
    targetHint: { faqEntryId: 'faq-xyz' },
  });

  const fix = ctx._emitted.find((p) => p.type === 'data-suggested-fix')!.data as any;
  assert.equal(fix.target.artifact, 'faq');
  assert.equal(fix.target.artifactId, 'faq-xyz');
});
