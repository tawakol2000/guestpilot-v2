/**
 * studio_propose_transition — Sprint 060-C.
 *
 * Run: JWT_SECRET=test npx tsx --test src/build-tune-agent/tools/__tests__/propose-transition.test.ts
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-propose-transition';

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProposeTransitionTool } from '../propose-transition';
import { coerceSnapshot, DEFAULT_SNAPSHOT } from '../../state-machine';
import { verifyTransitionNonce } from '../lib/transition-nonce';
import { DATA_PART_TYPES } from '../../data-parts';

interface Captured { name: string; handler: (a: any) => Promise<{ content: any[]; isError?: boolean }> }

function makePrismaStub(initialSnapshot: any = { ...DEFAULT_SNAPSHOT }) {
  const store = { snapshot: initialSnapshot };
  const tuningConversation = {
    findFirst: async () => ({ id: 'conv1', stateMachineSnapshot: store.snapshot }),
    update: async (args: any) => {
      store.snapshot = args.data.stateMachineSnapshot;
      return { id: 'conv1', stateMachineSnapshot: store.snapshot };
    },
  };
  return { prisma: { tuningConversation } as any, store };
}

function captureFactory(): { captured: Captured[]; tool: any } {
  const captured: Captured[] = [];
  const tool = (name: string, _d: any, _s: any, handler: any) => {
    captured.push({ name, handler });
    return { name, handler };
  };
  return { captured, tool };
}

test('proposes scoping → drafting transition: writes pending_transition + emits card', async () => {
  const { prisma, store } = makePrismaStub({ ...DEFAULT_SNAPSHOT, inner_state: 'scoping' });
  const emitted: any[] = [];
  const ctxFn = () => ({
    prisma,
    tenantId: 't1',
    conversationId: 'conv1',
    userId: null,
    lastUserSanctionedApply: false,
    emitDataPart: (p: any) => emitted.push(p),
  });
  const { captured, tool } = captureFactory();
  buildProposeTransitionTool(tool, ctxFn);
  const result = await captured[0].handler({ to: 'drafting', because: 'gathered checkin slot; ready to draft SOP' });
  assert.ok(!result.isError, 'should succeed');
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.proposed, true);
  assert.equal(payload.current_state, 'scoping');
  assert.equal(payload.proposed_state, 'drafting');
  assert.ok(payload.nonce);

  // DB pending_transition was written.
  const updated = coerceSnapshot(store.snapshot);
  assert.ok(updated.pending_transition);
  assert.equal(updated.pending_transition!.to, 'drafting');
  assert.equal(updated.pending_transition!.token, payload.nonce);
  // inner_state DID NOT change yet — confirmation is the only path.
  assert.equal(updated.inner_state, 'scoping');

  // Question_choices card with transition_proposal kind.
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].type, DATA_PART_TYPES.question_choices);
  assert.equal(emitted[0].data.kind, 'transition_proposal');
  assert.equal(emitted[0].data.proposed_state, 'drafting');
  assert.equal(emitted[0].data.nonce, payload.nonce);
});

test('mints HMAC-verified nonce', async () => {
  const { prisma } = makePrismaStub({ ...DEFAULT_SNAPSHOT, inner_state: 'scoping' });
  const ctxFn = () => ({
    prisma,
    tenantId: 't1',
    conversationId: 'conv1',
    userId: null,
    lastUserSanctionedApply: false,
    emitDataPart: () => undefined,
  });
  const { captured, tool } = captureFactory();
  buildProposeTransitionTool(tool, ctxFn);
  const r = JSON.parse((await captured[0].handler({ to: 'drafting', because: 'gathered checkin slot; ready to draft SOP' })).content[0].text);
  assert.equal(verifyTransitionNonce(r.nonce).ok, true);
  // Tampering trips verification.
  assert.equal(verifyTransitionNonce(r.nonce.slice(0, -2) + 'XX').ok, false);
});

test('refuses to propose out of verifying state (auto-exit only)', async () => {
  const { prisma } = makePrismaStub({ ...DEFAULT_SNAPSHOT, inner_state: 'verifying' });
  const ctxFn = () => ({
    prisma,
    tenantId: 't1',
    conversationId: 'conv1',
    userId: null,
    lastUserSanctionedApply: false,
    emitDataPart: () => undefined,
  });
  const { captured, tool } = captureFactory();
  buildProposeTransitionTool(tool, ctxFn);
  const result = await captured[0].handler({ to: 'drafting', because: 'want to leave verifying for some reason' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /auto-exits/);
});

test('refuses no-op transition (already in target state)', async () => {
  const { prisma } = makePrismaStub({ ...DEFAULT_SNAPSHOT, inner_state: 'scoping' });
  const ctxFn = () => ({
    prisma,
    tenantId: 't1',
    conversationId: 'conv1',
    userId: null,
    lastUserSanctionedApply: false,
    emitDataPart: () => undefined,
  });
  const { captured, tool } = captureFactory();
  buildProposeTransitionTool(tool, ctxFn);
  const result = await captured[0].handler({ to: 'scoping', because: 'already here but trying anyway hmm hmm hmm' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Already in scoping/);
});
