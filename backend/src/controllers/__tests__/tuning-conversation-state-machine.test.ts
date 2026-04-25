/**
 * Sprint 060-C — controller tests for the state-machine endpoints.
 *
 * Run: JWT_SECRET=test npx tsx --test src/controllers/__tests__/tuning-conversation-state-machine.test.ts
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-state-machine';

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTuningConversationController } from '../tuning-conversation.controller';
import { mintTransitionNonce } from '../../build-tune-agent/tools/lib/transition-nonce';
import { DEFAULT_SNAPSHOT } from '../../build-tune-agent/state-machine';

interface FakeStore {
  snapshot: any;
}

function makePrisma(store: FakeStore, conv: { id: string; tenantId: string } | null = { id: 'conv1', tenantId: 't1' }) {
  return {
    tuningConversation: {
      findFirst: async (args: any) => {
        if (!conv) return null;
        if (args.where.id !== conv.id || args.where.tenantId !== conv.tenantId) return null;
        return { id: conv.id, stateMachineSnapshot: store.snapshot };
      },
      update: async (args: any) => {
        store.snapshot = args.data.stateMachineSnapshot;
        return { id: conv!.id, stateMachineSnapshot: store.snapshot };
      },
    },
  } as any;
}

interface Harness {
  req: any;
  res: any;
  state: { statusCode: number; body: any };
}

function makeReqRes(overrides: Partial<{ tenantId: string; params: any; body: any }> = {}): Harness {
  const state = { statusCode: 200, body: undefined as any };
  const res = {
    status(c: number) {
      state.statusCode = c;
      return this;
    },
    json(b: any) {
      state.body = b;
      return this;
    },
  } as any;
  const req = { tenantId: overrides.tenantId ?? 't1', params: overrides.params ?? {}, body: overrides.body ?? {} };
  return { req, res, state };
}

test('confirmTransition: HMAC-verified nonce → atomic write to inner_state + ack flag', async () => {
  const nonce = mintTransitionNonce();
  const pending = {
    to: 'drafting',
    because: 'gathered enough info',
    proposed_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    token: nonce,
  };
  const store: FakeStore = {
    snapshot: { ...DEFAULT_SNAPSHOT, inner_state: 'scoping', pending_transition: pending },
  };
  const ctrl = makeTuningConversationController(makePrisma(store));
  const h = makeReqRes({ params: { id: 'conv1', nonce } });
  await ctrl.confirmTransition(h.req, h.res);
  assert.equal(h.state.statusCode, 200);
  assert.equal(h.state.body.ok, true);
  assert.equal(h.state.body.stateMachineSnapshot.inner_state, 'drafting');
  assert.equal(h.state.body.stateMachineSnapshot.pending_transition, null);
  assert.equal(h.state.body.stateMachineSnapshot.transition_ack_pending, true);
  assert.equal(h.state.body.stateMachineSnapshot.last_transition_reason, 'gathered enough info');
  assert.equal(store.snapshot.inner_state, 'drafting');
});

test('confirmTransition: tampered nonce → 400 INVALID_NONCE', async () => {
  const nonce = mintTransitionNonce();
  const tampered = nonce.slice(0, -2) + 'XX';
  const store: FakeStore = { snapshot: DEFAULT_SNAPSHOT };
  const ctrl = makeTuningConversationController(makePrisma(store));
  const h = makeReqRes({ params: { id: 'conv1', nonce: tampered } });
  await ctrl.confirmTransition(h.req, h.res);
  assert.equal(h.state.statusCode, 400);
  assert.equal(h.state.body.error, 'INVALID_NONCE');
});

test('confirmTransition: no pending → 409 NO_PENDING_TRANSITION', async () => {
  const nonce = mintTransitionNonce();
  const store: FakeStore = { snapshot: { ...DEFAULT_SNAPSHOT, pending_transition: null } };
  const ctrl = makeTuningConversationController(makePrisma(store));
  const h = makeReqRes({ params: { id: 'conv1', nonce } });
  await ctrl.confirmTransition(h.req, h.res);
  assert.equal(h.state.statusCode, 409);
  assert.equal(h.state.body.error, 'NO_PENDING_TRANSITION');
});

test('confirmTransition: stale pending (different nonce) → 409 NONCE_MISMATCH', async () => {
  const nonceA = mintTransitionNonce();
  const nonceB = mintTransitionNonce();
  const pending = {
    to: 'drafting',
    because: 'gathered enough info',
    proposed_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    token: nonceB,
  };
  const store: FakeStore = { snapshot: { ...DEFAULT_SNAPSHOT, pending_transition: pending } };
  const ctrl = makeTuningConversationController(makePrisma(store));
  const h = makeReqRes({ params: { id: 'conv1', nonce: nonceA } });
  await ctrl.confirmTransition(h.req, h.res);
  assert.equal(h.state.statusCode, 409);
  assert.equal(h.state.body.error, 'NONCE_MISMATCH');
});

test('confirmTransition: expired pending → 410 NONCE_EXPIRED', async () => {
  const nonce = mintTransitionNonce();
  const pending = {
    to: 'drafting',
    because: 'gathered enough info',
    proposed_at: new Date(Date.now() - 100_000).toISOString(),
    expires_at: new Date(Date.now() - 1_000).toISOString(),
    token: nonce,
  };
  const store: FakeStore = { snapshot: { ...DEFAULT_SNAPSHOT, pending_transition: pending } };
  const ctrl = makeTuningConversationController(makePrisma(store));
  const h = makeReqRes({ params: { id: 'conv1', nonce } });
  await ctrl.confirmTransition(h.req, h.res);
  assert.equal(h.state.statusCode, 410);
  assert.equal(h.state.body.error, 'NONCE_EXPIRED');
});

test('rejectTransition: clears pending without flipping inner_state', async () => {
  const nonce = mintTransitionNonce();
  const pending = {
    to: 'drafting',
    because: 'gathered enough info',
    proposed_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    token: nonce,
  };
  const store: FakeStore = {
    snapshot: { ...DEFAULT_SNAPSHOT, inner_state: 'scoping', pending_transition: pending },
  };
  const ctrl = makeTuningConversationController(makePrisma(store));
  const h = makeReqRes({ params: { id: 'conv1', nonce } });
  await ctrl.rejectTransition(h.req, h.res);
  assert.equal(h.state.statusCode, 200);
  assert.equal(h.state.body.ok, true);
  assert.equal(h.state.body.stateMachineSnapshot.inner_state, 'scoping');
  assert.equal(h.state.body.stateMachineSnapshot.pending_transition, null);
});

test('rejectTransition: idempotent on missing/mismatched pending', async () => {
  const nonce = mintTransitionNonce();
  const store: FakeStore = { snapshot: { ...DEFAULT_SNAPSHOT, pending_transition: null } };
  const ctrl = makeTuningConversationController(makePrisma(store));
  const h = makeReqRes({ params: { id: 'conv1', nonce } });
  await ctrl.rejectTransition(h.req, h.res);
  assert.equal(h.state.statusCode, 200);
  assert.equal(h.state.body.alreadyCleared, true);
});

test('reclassify: BUILD → TUNE preserves inner_state', async () => {
  const store: FakeStore = {
    snapshot: { ...DEFAULT_SNAPSHOT, outer_mode: 'BUILD', inner_state: 'drafting' },
  };
  const ctrl = makeTuningConversationController(makePrisma(store));
  const h = makeReqRes({
    params: { id: 'conv1' },
    body: { outer_mode: 'TUNE' },
  });
  await ctrl.reclassify(h.req, h.res);
  assert.equal(h.state.statusCode, 200);
  assert.equal(h.state.body.stateMachineSnapshot.outer_mode, 'TUNE');
  assert.equal(h.state.body.stateMachineSnapshot.inner_state, 'drafting');
  assert.equal(h.state.body.cancelledPending, false);
  assert.equal(h.state.body.stateMachineSnapshot.transition_ack_pending, false);
});

test('reclassify: cancels in-flight pending and stamps an ack with rationale', async () => {
  const pending = {
    to: 'verifying',
    because: 'wrote SOP',
    proposed_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    token: mintTransitionNonce(),
  };
  const store: FakeStore = {
    snapshot: { ...DEFAULT_SNAPSHOT, outer_mode: 'BUILD', inner_state: 'drafting', pending_transition: pending },
  };
  const ctrl = makeTuningConversationController(makePrisma(store));
  const h = makeReqRes({
    params: { id: 'conv1' },
    body: { outer_mode: 'TUNE' },
  });
  await ctrl.reclassify(h.req, h.res);
  assert.equal(h.state.statusCode, 200);
  assert.equal(h.state.body.cancelledPending, true);
  assert.equal(h.state.body.stateMachineSnapshot.pending_transition, null);
  assert.equal(h.state.body.stateMachineSnapshot.transition_ack_pending, true);
  assert.match(h.state.body.stateMachineSnapshot.last_transition_reason, /Reclassified to TUNE/);
});

test('reclassify: invalid outer_mode → 400', async () => {
  const store: FakeStore = { snapshot: DEFAULT_SNAPSHOT };
  const ctrl = makeTuningConversationController(makePrisma(store));
  const h = makeReqRes({
    params: { id: 'conv1' },
    body: { outer_mode: 'POTATO' },
  });
  await ctrl.reclassify(h.req, h.res);
  assert.equal(h.state.statusCode, 400);
  assert.equal(h.state.body.error, 'INVALID_OUTER_MODE');
});

test('reclassify: same outer_mode is a no-op', async () => {
  const store: FakeStore = { snapshot: { ...DEFAULT_SNAPSHOT, outer_mode: 'BUILD' } };
  const ctrl = makeTuningConversationController(makePrisma(store));
  const h = makeReqRes({
    params: { id: 'conv1' },
    body: { outer_mode: 'BUILD' },
  });
  await ctrl.reclassify(h.req, h.res);
  assert.equal(h.state.statusCode, 200);
  assert.equal(h.state.body.noop, true);
});

test('confirmTransition: cross-tenant lookup → 404', async () => {
  const nonce = mintTransitionNonce();
  const store: FakeStore = { snapshot: DEFAULT_SNAPSHOT };
  const ctrl = makeTuningConversationController(makePrisma(store, { id: 'conv1', tenantId: 't1' }));
  const h = makeReqRes({
    tenantId: 't2',
    params: { id: 'conv1', nonce },
  });
  await ctrl.confirmTransition(h.req, h.res);
  assert.equal(h.state.statusCode, 404);
  assert.equal(h.state.body.error, 'CONVERSATION_NOT_FOUND');
});
