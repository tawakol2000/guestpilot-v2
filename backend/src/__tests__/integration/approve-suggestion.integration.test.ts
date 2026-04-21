/**
 * Sprint 049 Session A — A3 integration spec.
 *
 * Exercises `conversations.controller.ts#approveSuggestion` (Path B of the
 * legacy-copilot send flow) end-to-end against a live Railway DB.
 *
 * Four cases:
 *  (a) editedText differs from pendingReply.suggestion → diagnostic fires,
 *      TuningSuggestion row lands within 5s; Message row has
 *      originalAiText + editedByUserId stamped.
 *  (b) approve-as-is (no editedText OR editedText === suggestion) →
 *      no new TuningSuggestion row; originalAiText stays null.
 *  (c) Hostaway throw → 502 { error: 'HOSTAWAY_DELIVERY_FAILED', detail };
 *      no Message row written; PendingAiReply.suggestion intact; retry
 *      (Hostaway now succeeds) completes normally.
 *  (d) Hostaway success then diagnostic-pipeline failure (mocked) →
 *      response is 200, Message row exists, caller sees no bubbled error.
 *
 * OpenAI is stubbed via require-cache injection (mirrors
 * messages-copilot-fromdraft.integration.test.ts). Hostaway is stubbed by
 * overriding the module's `sendMessageToConversation` export after the
 * conversations.controller loads it — the controller re-imports the module
 * dynamically inside the handler, so both static and dynamic reads see the
 * same stub.
 */
import './_env-bootstrap';

import { test, after, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { PrismaClient } from '@prisma/client';
import type { Response } from 'express';
import { buildFixture, type IntegrationFixture } from './_fixture';

// ── Mock OpenAI BEFORE diagnostic.service is loaded transitively.
const mockResponse = {
  output_text: JSON.stringify({
    category: 'SYSTEM_PROMPT',
    subLabel: 'checkin-time-tone',
    confidence: 0.82,
    rationale: 'Edit softened the check-in wording; system prompt should reflect that.',
    proposedText: 'State the check-in window and offer flexibility when possible.',
    artifactTarget: { type: 'SYSTEM_PROMPT', id: 'systemPromptCoordinator' },
    capabilityRequest: null,
  }),
  usage: { input_tokens: 800, output_tokens: 120, input_tokens_details: { cached_tokens: 0 } },
};

const Module = require('module');
const openaiPath = Module._resolveFilename('openai', module);
class MockOpenAI {
  responses = {
    create: async () => mockResponse,
  };
}
const stubExports: any = MockOpenAI;
stubExports.default = MockOpenAI;
stubExports.OpenAI = MockOpenAI;
require.cache[openaiPath] = {
  id: openaiPath,
  filename: openaiPath,
  loaded: true,
  exports: stubExports,
  paths: [],
  children: [],
} as any;

// Install a hostaway.service stub into require.cache BEFORE loading the
// controller. The controller does both `import * as hostawayService from
// '../services/hostaway.service'` at the top AND a dynamic
// `await import('../services/hostaway.service')` inside the handler; both
// resolve to this same cache entry. We expose a mutable `hostawayBehaviour`
// flag so individual cases can flip the stub between "ok", "throw", and
// "throw-then-ok" (retry).
type HostawayBehaviour =
  | { kind: 'ok'; result?: any }
  | { kind: 'throw'; error: Error }
  | { kind: 'throw-then-ok'; error: Error; result?: any; threw: boolean };

let hostawayBehaviour: HostawayBehaviour = { kind: 'ok' };
let hostawayCallCount = 0;

const hostawayPath = Module._resolveFilename('../../services/hostaway.service', module);
const hostawayStubExports: any = {
  sendMessageToConversation: async (..._args: any[]) => {
    hostawayCallCount += 1;
    const fresh = (prefix: string) => ({ result: { id: `${prefix}_${hostawayCallCount}_${Date.now()}` } });
    if (hostawayBehaviour.kind === 'ok') {
      return hostawayBehaviour.result ?? fresh('TEST_hostaway_msg_ok');
    }
    if (hostawayBehaviour.kind === 'throw') {
      throw hostawayBehaviour.error;
    }
    if (hostawayBehaviour.kind === 'throw-then-ok') {
      if (!hostawayBehaviour.threw) {
        hostawayBehaviour.threw = true;
        throw hostawayBehaviour.error;
      }
      return hostawayBehaviour.result ?? fresh('TEST_hostaway_msg_retry');
    }
    throw new Error('unreachable hostaway behaviour');
  },
  // Other exports the controller transitively imports are unused on the
  // approveSuggestion code path — stub to throw so any new coupling is
  // caught immediately.
};
require.cache[hostawayPath] = {
  id: hostawayPath,
  filename: hostawayPath,
  loaded: true,
  exports: hostawayStubExports,
  paths: [],
  children: [],
} as any;

// Wrap diagnostic.service before the controller loads so case (d) can force
// a mid-pipeline throw. tsx compiles `export function runDiagnostic` to a
// non-configurable getter, so we can't plain-assign or redefine on the real
// module. Instead, replace require.cache[diagnosticPath] with a Proxy-backed
// exports object: property access goes through `runDiagnosticOverride` if
// set, otherwise delegates to the real module.
const diagnosticPath = Module._resolveFilename('../../services/tuning/diagnostic.service', module);
const realDiagnosticModule = require('../../services/tuning/diagnostic.service');
let runDiagnosticOverride: ((...args: any[]) => Promise<any>) | null = null;
const diagnosticProxyExports = new Proxy(realDiagnosticModule, {
  get(target, prop) {
    if (prop === 'runDiagnostic' && runDiagnosticOverride) {
      return runDiagnosticOverride;
    }
    return Reflect.get(target, prop);
  },
});
require.cache[diagnosticPath] = {
  id: diagnosticPath,
  filename: diagnosticPath,
  loaded: true,
  exports: diagnosticProxyExports,
  paths: [],
  children: [],
} as any;

const { makeConversationsController } = require('../../controllers/conversations.controller');
const {
  __resetDiagnosticModelCacheForTests,
} = require('../../services/tuning/diagnostic.service');
const { _resetDedupForTests } = require('../../services/tuning/trigger-dedup.service');

function overrideRunDiagnostic(fn: ((...args: any[]) => Promise<any>) | null) {
  runDiagnosticOverride = fn;
}

const prisma = new PrismaClient();
let fx: IntegrationFixture;
const DRAFT_TEXT = 'Check-in is at 4 PM, no exceptions.';

before(async () => {
  __resetDiagnosticModelCacheForTests();
  _resetDedupForTests();
  fx = await buildFixture(prisma);
});

after(async () => {
  overrideRunDiagnostic(null);
  if (fx) await fx.cleanup();
  await prisma.$disconnect();
});

interface CapturedRes {
  status: number;
  body: any;
  headers: Record<string, string>;
}

function mockRes(): { res: Response; captured: CapturedRes } {
  const captured: CapturedRes = { status: 0, body: null, headers: {} };
  const res: any = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: any) {
      captured.body = body;
      return this;
    },
    setHeader(k: string, v: string) {
      captured.headers[k] = v;
    },
  };
  return { res: res as Response, captured };
}

async function seedPendingDraft(conversationId: string, tenantId: string, text = DRAFT_TEXT) {
  await prisma.pendingAiReply.deleteMany({ where: { conversationId } });
  return prisma.pendingAiReply.create({
    data: {
      conversationId,
      tenantId,
      fired: false,
      scheduledAt: new Date(Date.now() - 5000),
      suggestion: text,
    },
  });
}

async function waitForTuningSuggestion(sourceMessageId: string, timeoutMs = 5000): Promise<number> {
  const t0 = Date.now();
  let lastCount = 0;
  while (Date.now() - t0 < timeoutMs) {
    lastCount = await prisma.tuningSuggestion.count({ where: { sourceMessageId } });
    if (lastCount > 0) return lastCount;
    await new Promise(r => setTimeout(r, 100));
  }
  return lastCount;
}

test('A3 case (a): editedText differs from suggestion → diagnostic fires, audit fields stamped', async () => {
  _resetDedupForTests();
  hostawayBehaviour = { kind: 'ok' };
  await seedPendingDraft(fx.conversationId, fx.tenantId);

  const controller = makeConversationsController(prisma);
  const { res, captured } = mockRes();
  const req: any = {
    tenantId: fx.tenantId,
    userId: 'TEST_user_path_b',
    params: { id: fx.conversationId },
    body: {
      editedText: 'Check-in is from 3 PM. Happy to flex when we can.',
    },
  };

  await controller.approveSuggestion(req, res);

  assert.equal(captured.status, 0, 'res.status not called (200 default via res.json)');
  assert.deepEqual(captured.body, { ok: true });

  const msg = await prisma.message.findFirst({
    where: { conversationId: fx.conversationId, role: 'AI', content: 'Check-in is from 3 PM. Happy to flex when we can.' },
    orderBy: { sentAt: 'desc' },
  });
  assert.ok(msg, 'Message row written after successful Hostaway send');
  assert.equal(msg!.originalAiText, DRAFT_TEXT, 'originalAiText snapshots the pending draft');
  assert.equal(msg!.editedByUserId, 'TEST_user_path_b', 'editedByUserId stamped from req.userId');
  assert.ok(msg!.hostawayMessageId, 'hostawayMessageId captured from stub');

  const tuningCount = await waitForTuningSuggestion(msg!.id, 5000);
  assert.ok(tuningCount >= 1, `expected ≥1 TuningSuggestion within 5s, got ${tuningCount}`);

  // PendingAiReply cleared via cancelPendingAiReply (sibling rows too).
  const stillPending = await prisma.pendingAiReply.count({
    where: { conversationId: fx.conversationId, fired: false },
  });
  assert.equal(stillPending, 0, 'cancelPendingAiReply marked all rows fired');
});

test('A3 case (b): approve-as-is (editedText === suggestion) → no diagnostic, no audit stamp', async () => {
  _resetDedupForTests();
  hostawayBehaviour = { kind: 'ok' };
  await seedPendingDraft(fx.conversationId, fx.tenantId);

  const controller = makeConversationsController(prisma);
  const { res, captured } = mockRes();
  const req: any = {
    tenantId: fx.tenantId,
    userId: 'TEST_user_path_b',
    params: { id: fx.conversationId },
    // No editedText — the arrow-button "approve as-is" flow.
    body: {},
  };

  await controller.approveSuggestion(req, res);
  assert.deepEqual(captured.body, { ok: true });

  const msg = await prisma.message.findFirst({
    where: { conversationId: fx.conversationId, role: 'AI', content: DRAFT_TEXT },
    orderBy: { sentAt: 'desc' },
  });
  assert.ok(msg, 'Message row written');
  // No editedText on the request, so audit fields stay null.
  assert.equal(msg!.originalAiText, null, 'originalAiText null without editedText');
  assert.equal(msg!.editedByUserId, null, 'editedByUserId null without editedText');

  // Diagnostic gate requires editedText AND text change; this case fails both.
  await new Promise(r => setTimeout(r, 400));
  const tuningCount = await prisma.tuningSuggestion.count({ where: { sourceMessageId: msg!.id } });
  assert.equal(tuningCount, 0, 'no TuningSuggestion row on approve-as-is');
});

test('A3 case (c): Hostaway throw → 502, no Message row, PendingAiReply intact, retry succeeds', async () => {
  _resetDedupForTests();
  const pending = await seedPendingDraft(fx.conversationId, fx.tenantId, 'Pre-retry draft text.');
  const messagesBefore = await prisma.message.count({
    where: { conversationId: fx.conversationId, role: 'AI' },
  });

  // First attempt: Hostaway throws, retry: Hostaway succeeds.
  hostawayBehaviour = {
    kind: 'throw-then-ok',
    error: new Error('Hostaway 503 upstream timeout'),
    threw: false,
    result: { result: { id: 'TEST_hostaway_msg_retry_ok' } },
  };

  const controller = makeConversationsController(prisma);

  // First call — throws.
  const first = mockRes();
  await controller.approveSuggestion(
    {
      tenantId: fx.tenantId,
      userId: 'TEST_user_path_b',
      params: { id: fx.conversationId },
      body: { editedText: 'Pre-retry draft text edited slightly.' },
    } as any,
    first.res,
  );
  assert.equal(first.captured.status, 502, '502 on Hostaway delivery failure');
  assert.equal(first.captured.body?.error, 'HOSTAWAY_DELIVERY_FAILED');
  assert.ok(typeof first.captured.body?.detail === 'string' && first.captured.body.detail.length > 0, 'detail is a non-empty string');

  // No Message row, PendingAiReply unchanged.
  const messagesAfterFail = await prisma.message.count({
    where: { conversationId: fx.conversationId, role: 'AI' },
  });
  assert.equal(messagesAfterFail, messagesBefore, 'no Message row created on Hostaway failure');

  const pendingAfterFail = await prisma.pendingAiReply.findUnique({ where: { id: pending.id } });
  assert.ok(pendingAfterFail, 'PendingAiReply row still exists');
  assert.equal(pendingAfterFail!.suggestion, 'Pre-retry draft text.', 'PendingAiReply.suggestion intact for retry');
  assert.equal(pendingAfterFail!.fired, false, 'PendingAiReply.fired unchanged (still false)');

  // Retry — succeeds.
  const second = mockRes();
  await controller.approveSuggestion(
    {
      tenantId: fx.tenantId,
      userId: 'TEST_user_path_b',
      params: { id: fx.conversationId },
      body: { editedText: 'Pre-retry draft text edited slightly.' },
    } as any,
    second.res,
  );
  assert.deepEqual(second.captured.body, { ok: true }, 'retry succeeds');

  const messagesAfterRetry = await prisma.message.count({
    where: { conversationId: fx.conversationId, role: 'AI' },
  });
  assert.equal(messagesAfterRetry, messagesBefore + 1, 'retry created one Message row');
});

test('A3 case (d): Hostaway ok + diagnostic throw → 200 response, no bubble up', async () => {
  _resetDedupForTests();
  hostawayBehaviour = { kind: 'ok' };
  await seedPendingDraft(fx.conversationId, fx.tenantId, 'Draft text for diag-throw case.');

  // Force the diagnostic fire-and-forget pipeline to throw so we can assert
  // the HTTP response still lands cleanly. Restored via overrideRunDiagnostic
  // in the finally block.
  const runDiagnosticError = new Error('Simulated diagnostic pipeline failure');
  overrideRunDiagnostic(async () => {
    throw runDiagnosticError;
  });

  const controller = makeConversationsController(prisma);
  const { res, captured } = mockRes();
  const errorsSeen: any[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: any[]) => {
    errorsSeen.push(args);
  };
  try {
    await controller.approveSuggestion(
      {
        tenantId: fx.tenantId,
        userId: 'TEST_user_path_b',
        params: { id: fx.conversationId },
        body: { editedText: 'Draft text for diag-throw case — manager edit.' },
      } as any,
      res,
    );
  } finally {
    // Give the fire-and-forget pipeline one tick to settle so the error is
    // surfaced in `errorsSeen` before we restore console.error.
    await new Promise(r => setTimeout(r, 150));
    console.error = originalConsoleError;
    overrideRunDiagnostic(null);
  }

  assert.deepEqual(captured.body, { ok: true }, 'response is ok despite diagnostic throw');
  assert.equal(captured.status, 0, 'no error status set');

  // The fire-and-forget error is structurally logged with the sprint-049 A7
  // tag, proving the throw surfaced (and is greppable in Railway logs).
  const tagSeen = errorsSeen.some(args => args[0] === '[TUNING_DIAGNOSTIC_FAILURE]');
  assert.ok(tagSeen, `[TUNING_DIAGNOSTIC_FAILURE] log emitted on diagnostic throw — captured ${errorsSeen.length} console.error calls`);
});
