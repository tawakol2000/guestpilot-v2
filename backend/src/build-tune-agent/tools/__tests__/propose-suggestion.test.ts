/**
 * propose_suggestion — sprint 046 Session D tests.
 *
 * Session D retires the legacy `data-suggestion-preview` emit (it was
 * dual-emitted alongside `data-suggested-fix` during sprints B/C for
 * TUNE/Studio parity). From this session forward only
 * `data-suggested-fix` ships. Session D also adds a session-scoped
 * rejection-memory guard — if the current conversation has already
 * rejected a semantically-equivalent fix, the tool skips the emit and
 * returns a `SKIPPED_REJECTED` hint so the agent re-reasons.
 *
 * Run: JWT_SECRET=test npx tsx --test src/build-tune-agent/tools/__tests__/propose-suggestion.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildProposeSuggestionTool, deriveRejectionIntent } from '../propose-suggestion';
import type { ToolContext } from '../types';
import {
  computeRejectionFixHash,
  type RejectionIntent,
} from '../../memory/service';

function captureTool() {
  let captured: any = null;
  const fakeToolFactory = ((_n: string, _d: string, _s: any, handler: any) => {
    captured = handler;
    return { name: _n };
  }) as any;
  return { factory: fakeToolFactory, invoke: (args: any) => captured(args) };
}

function makeCtx(opts: { rejectedHashes?: string[] } = {}): ToolContext & {
  _emitted: Array<{ type: string; id?: string; data: unknown }>;
} {
  const emitted: Array<{ type: string; id?: string; data: unknown }> = [];
  const prefix = 'session/conv1/rejected/';
  const rows = (opts.rejectedHashes ?? []).map((h) => ({ key: prefix + h }));
  return {
    prisma: {
      agentMemory: {
        findMany: async () => rows,
      },
    } as any,
    tenantId: 't1',
    conversationId: 'conv1',
    userId: 'u1',
    lastUserSanctionedApply: false,
    emitDataPart: (part) => emitted.push({ type: part.type, id: part.id, data: part.data }),
    _emitted: emitted,
  };
}

test('propose_suggestion emits only data-suggested-fix (legacy preview retired)', async () => {
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
  assert.ok(
    !types.includes('data-suggestion-preview'),
    'legacy data-suggestion-preview must NOT emit after Session D'
  );
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

test('propose_suggestion skips emit when rejection memory matches (same session)', async () => {
  const intent: RejectionIntent = deriveRejectionIntent({
    category: 'FAQ',
    subLabel: 'wifi-password',
    target: { artifact: 'faq', artifactId: 'faq-abc' },
  });
  const existingHash = computeRejectionFixHash(intent);

  const ctx = makeCtx({ rejectedHashes: [existingHash] });
  const { factory, invoke } = captureTool();
  buildProposeSuggestionTool(factory, () => ctx);
  const result = await invoke({
    category: 'FAQ',
    subLabel: 'wifi-password',
    rationale: 'Manager already rejected this fix intent.',
    editFormat: 'full_replacement',
    beforeText: 'WIFI-2024',
    proposedText: 'WIFI-2024',
    target: { artifact: 'faq', artifactId: 'faq-abc' },
  });

  assert.equal(ctx._emitted.length, 0, 'no data-parts should emit on rejection match');
  const structured = result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? '{}');
  assert.equal(structured.status, 'SKIPPED_REJECTED');
});

test('propose_suggestion still emits when rejection memory does not match', async () => {
  const unrelated = 'deadbeef'.repeat(5);
  const ctx = makeCtx({ rejectedHashes: [unrelated] });
  const { factory, invoke } = captureTool();
  buildProposeSuggestionTool(factory, () => ctx);
  const result = await invoke({
    category: 'FAQ',
    subLabel: 'wifi-password',
    rationale: 'Different fix intent.',
    editFormat: 'full_replacement',
    beforeText: 'WIFI-2024',
    proposedText: 'Summit-Wifi-2026',
    target: { artifact: 'faq', artifactId: 'faq-abc' },
  });

  const types = ctx._emitted.map((p) => p.type);
  assert.ok(types.includes('data-suggested-fix'));
  const structured = result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? '{}');
  assert.equal(structured.status, 'PREVIEWED');
});

test('rejection hash is stable across minor rationale rephrasing', () => {
  const a = deriveRejectionIntent({
    category: 'SYSTEM_PROMPT',
    subLabel: 'checkout-time-tone',
    target: { artifact: 'system_prompt', sectionId: 'checkout_time' },
  });
  const b = deriveRejectionIntent({
    category: 'SYSTEM_PROMPT',
    subLabel: 'checkout-time-tone',
    target: { artifact: 'system_prompt', sectionId: 'checkout_time' },
  });
  assert.equal(computeRejectionFixHash(a), computeRejectionFixHash(b));

  const c = deriveRejectionIntent({
    category: 'SYSTEM_PROMPT',
    subLabel: 'checkout-time-wording',
    target: { artifact: 'system_prompt', sectionId: 'checkout_time' },
  });
  assert.notEqual(computeRejectionFixHash(a), computeRejectionFixHash(c));
});

// ─── Sprint 051 A B4 — artifact-quote emission ────────────────────────────

test('propose_suggestion emits a data-artifact-quote alongside the suggested-fix when rewriting an existing artifact', async () => {
  const ctx = makeCtx();
  const { factory, invoke } = captureTool();
  buildProposeSuggestionTool(factory, () => ctx);
  await invoke({
    category: 'SOP_CONTENT',
    subLabel: 'early-checkin-tone',
    rationale: 'Manager softened the CONFIRMED variant.',
    editFormat: 'full_replacement',
    beforeText: 'Arrival window 14:00–22:00.',
    proposedText: 'Arrival window 14:00–22:00 — flexible on request.',
    target: {
      artifact: 'sop',
      artifactId: 'v1',
    },
    targetHint: { sopCategory: 'early-checkin', sopStatus: 'CONFIRMED' },
  });

  const types = ctx._emitted.map((p) => p.type);
  assert.ok(types.includes('data-suggested-fix'));
  assert.ok(
    types.includes('data-artifact-quote'),
    'expected data-artifact-quote emission when before-body is non-empty',
  );
  const quote = ctx._emitted.find((p) => p.type === 'data-artifact-quote')!
    .data as any;
  assert.equal(quote.artifact, 'sop');
  assert.equal(quote.artifactId, 'v1');
  assert.equal(quote.body, 'Arrival window 14:00–22:00.');
  // sourceLabel carries the SOP category + status so the chip reads
  // consistently with the session-artifacts rail.
  assert.match(quote.sourceLabel, /SOP/);
});

test('propose_suggestion skips the quote emit when the before-body is empty (net-new artifact)', async () => {
  const ctx = makeCtx();
  const { factory, invoke } = captureTool();
  buildProposeSuggestionTool(factory, () => ctx);
  await invoke({
    category: 'FAQ',
    subLabel: 'new-wifi-entry',
    rationale: 'No FAQ covers WiFi yet — add one.',
    editFormat: 'full_replacement',
    beforeText: '',
    proposedText: 'Network: Guest, password: ****',
    target: { artifact: 'faq' },
  });
  const types = ctx._emitted.map((p) => p.type);
  assert.ok(types.includes('data-suggested-fix'));
  assert.ok(!types.includes('data-artifact-quote'));
});
