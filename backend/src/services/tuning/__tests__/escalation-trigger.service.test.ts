/**
 * Sprint 08 §2 — verify the escalation-trigger gating logic.
 *
 * Uses an in-memory mock Prisma to exercise the synchronous guards and the
 * dedup integration. The async diagnostic call itself is stubbed via the
 * trigger-dedup registry + mocked prisma — we assert on which DB reads fire,
 * not on the LLM output (which is side-effected through real services and
 * can't run without network).
 *
 * Invoke: npx tsx --test src/services/tuning/__tests__/escalation-trigger.service.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maybeFireEscalationTrigger } from '../escalation-trigger.service';
import { _resetDedupForTests, shouldProcessTrigger } from '../trigger-dedup.service';

interface CallLog {
  tenantAiConfigLookups: number;
  messageFindAiMessage: number;
  messageFindResolution: number;
}

function makeMockPrisma(opts: {
  shadowModeEnabled?: boolean;
  hasAiMessage?: boolean;
  hasResolutionReply?: boolean;
}) {
  const log: CallLog = {
    tenantAiConfigLookups: 0,
    messageFindAiMessage: 0,
    messageFindResolution: 0,
  };
  const prisma = {
    tenantAiConfig: {
      findUnique: async () => {
        log.tenantAiConfigLookups++;
        return opts.shadowModeEnabled === undefined
          ? null
          : { shadowModeEnabled: opts.shadowModeEnabled };
      },
    },
    message: {
      findFirst: async ({ where }: any) => {
        // Distinguish the two queries by role filter.
        if (where.role === 'AI') {
          log.messageFindAiMessage++;
          return opts.hasAiMessage ? { id: 'ai-msg-1', sentAt: new Date() } : null;
        }
        log.messageFindResolution++;
        return opts.hasResolutionReply ? { id: 'host-msg-1' } : null;
      },
    },
    // runDiagnostic internally uses prisma.evidenceBundle.create + lots more —
    // we never get there in these guard-level tests because either
    // shadowModeEnabled=false or findFirst returns null.
    evidenceBundle: {},
  };
  return { prisma, log };
}

function baseCtx(overrides: {
  type?: string;
  previousStatus?: string;
  newStatus?: string;
  conversationId?: string | null;
}) {
  // Use in-check so an explicit `null` override survives (`?? 'conv-1'` would
  // coerce it back to the default).
  const convoId = 'conversationId' in overrides ? overrides.conversationId : 'conv-1';
  return {
    tenantId: 't1',
    newStatus: overrides.newStatus ?? 'completed',
    previous: {
      id: 'task-1',
      type: overrides.type ?? 'ESCALATION',
      status: overrides.previousStatus ?? 'open',
      conversationId: convoId ?? null,
      createdAt: new Date('2026-04-10T00:00:00.000Z'),
      title: 'Guest complains about parking',
    },
  };
}

test('no-op when task type is not ESCALATION', async () => {
  _resetDedupForTests();
  const { prisma, log } = makeMockPrisma({ shadowModeEnabled: true, hasAiMessage: true, hasResolutionReply: true });
  maybeFireEscalationTrigger(prisma as any, baseCtx({ type: 'other' }));
  // Synchronous guards only — no async work spawned, no DB reads.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(log.tenantAiConfigLookups, 0);
  assert.equal(log.messageFindAiMessage, 0);
});

test('no-op when previous status is already completed (idempotent on re-mark)', async () => {
  _resetDedupForTests();
  const { prisma, log } = makeMockPrisma({ shadowModeEnabled: true, hasAiMessage: true, hasResolutionReply: true });
  maybeFireEscalationTrigger(prisma as any, baseCtx({ previousStatus: 'completed' }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(log.tenantAiConfigLookups, 0);
});

test('no-op when new status is not completed', async () => {
  _resetDedupForTests();
  const { prisma, log } = makeMockPrisma({ shadowModeEnabled: true, hasAiMessage: true, hasResolutionReply: true });
  maybeFireEscalationTrigger(prisma as any, baseCtx({ newStatus: 'in_progress' }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(log.tenantAiConfigLookups, 0);
});

test('no-op when task has no conversationId', async () => {
  _resetDedupForTests();
  const { prisma, log } = makeMockPrisma({ shadowModeEnabled: true, hasAiMessage: true, hasResolutionReply: true });
  maybeFireEscalationTrigger(prisma as any, baseCtx({ conversationId: null }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(log.tenantAiConfigLookups, 0);
});

test('no-op when tenant shadowMode is disabled', async () => {
  _resetDedupForTests();
  const { prisma, log } = makeMockPrisma({ shadowModeEnabled: false, hasAiMessage: true, hasResolutionReply: true });
  maybeFireEscalationTrigger(prisma as any, baseCtx({}));
  // Async guard — wait for the tenant config read to resolve, then exit.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(log.tenantAiConfigLookups, 1);
  assert.equal(log.messageFindAiMessage, 0);
});

test('no-op when there is no prior AI message to attribute the escalation to', async () => {
  _resetDedupForTests();
  const { prisma, log } = makeMockPrisma({ shadowModeEnabled: true, hasAiMessage: false, hasResolutionReply: true });
  maybeFireEscalationTrigger(prisma as any, baseCtx({}));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(log.messageFindAiMessage, 1);
  assert.equal(log.messageFindResolution, 0);
});

test('no-op when there is no host/manager resolution reply after escalation was opened', async () => {
  _resetDedupForTests();
  const { prisma, log } = makeMockPrisma({ shadowModeEnabled: true, hasAiMessage: true, hasResolutionReply: false });
  maybeFireEscalationTrigger(prisma as any, baseCtx({}));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(log.messageFindResolution, 1);
});

test('dedup prevents second fire within 60s for the same disputed message', async () => {
  _resetDedupForTests();
  // Prime the dedup registry as if a prior trigger already fired.
  shouldProcessTrigger('ESCALATION_TRIGGERED', 'ai-msg-1');
  const second = shouldProcessTrigger('ESCALATION_TRIGGERED', 'ai-msg-1');
  assert.equal(second, false, 'Second call within window must be rejected');
});
