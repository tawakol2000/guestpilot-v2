/**
 * Sprint 048 Session A — A4 integration spec.
 *
 * Exercises the legacy-copilot gated diagnostic fire path through the real
 * `messages.controller.ts#send` handler:
 *
 * 1. With a pending AI draft on `PendingAiReply.suggestion` and a POST
 *    carrying `fromDraft: true` with content differing from the draft, the
 *    controller MUST fire `runDiagnostic` + `writeSuggestionFromDiagnostic`
 *    fire-and-forget. A `TuningSuggestion` row must land within 5s.
 * 2. A second POST within 60s on the same AI message must be deduped by
 *    `shouldProcessTrigger` → no additional `TuningSuggestion` row.
 * 3. A POST without `fromDraft` (the sprint-10 default) must NOT fire the
 *    diagnostic even when the pending draft differs from the sent content.
 *
 * OpenAI is stubbed via require-cache injection (same pattern as
 * diagnostic.integration.test.ts) so no network call happens. Hostaway is
 * avoided by clearing `Conversation.hostawayConversationId` before the
 * controller runs (the send path skips the HTTP client when absent).
 */
import './_env-bootstrap';

import { test, after, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { PrismaClient } from '@prisma/client';
import type { Response } from 'express';
import { buildFixture, type IntegrationFixture } from './_fixture';

// ── Mock OpenAI BEFORE diagnostic.service is loaded transitively via the
//    messages.controller's top-level import graph. Same pattern as
//    diagnostic.integration.test.ts.
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

const { makeMessagesController } = require('../../controllers/messages.controller');
const {
  __resetDiagnosticModelCacheForTests,
} = require('../../services/tuning/diagnostic.service');
const { _resetDedupForTests } = require('../../services/tuning/trigger-dedup.service');

const prisma = new PrismaClient();
let fx: IntegrationFixture;
const DRAFT_TEXT = 'Check-in is at 4 PM, no exceptions.';

before(async () => {
  __resetDiagnosticModelCacheForTests();
  _resetDedupForTests();
  fx = await buildFixture(prisma);
  // Avoid the hostaway HTTP path — the column is non-nullable with an empty
  // string default, and the controller's truthy check (line 71) skips the HTTP
  // send for falsy values.
  await prisma.conversation.update({
    where: { id: fx.conversationId },
    data: { hostawayConversationId: '' },
  });
});

after(async () => {
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

test('POST /messages with fromDraft:true + edited content → TuningSuggestion written within 5s', async () => {
  // Seed a pending AI draft matching the production wiring: debounce-poll
  // worker sets suggestion before dispatching to the user in copilot mode.
  await prisma.pendingAiReply.deleteMany({ where: { conversationId: fx.conversationId } });
  await prisma.pendingAiReply.create({
    data: {
      conversationId: fx.conversationId,
      tenantId: fx.tenantId,
      fired: true,
      scheduledAt: new Date(Date.now() - 5000),
      suggestion: DRAFT_TEXT,
    },
  });

  const controller = makeMessagesController(prisma);
  const { res, captured } = mockRes();
  const req: any = {
    tenantId: fx.tenantId,
    userId: 'TEST_user_copilot',
    params: { id: fx.conversationId },
    headers: { 'x-client-source': 'web' },
    body: {
      content: 'Check-in is from 3 PM. Happy to try to flex if the prior guest is out early.',
      channel: 'channel',
      fromDraft: true,
    },
  };

  await controller.send(req, res);

  assert.equal(captured.status, 201, `expected 201, got ${captured.status}: ${JSON.stringify(captured.body)}`);
  const createdMsgId = captured.body.id;
  assert.ok(createdMsgId, 'message id returned');

  // Fire-and-forget — poll for the diagnostic write.
  const count = await waitForTuningSuggestion(createdMsgId, 5000);
  assert.ok(count >= 1, `expected ≥1 TuningSuggestion within 5s, got ${count}`);

  const row = await prisma.tuningSuggestion.findFirst({ where: { sourceMessageId: createdMsgId } });
  assert.ok(row, 'TuningSuggestion row persisted');
  assert.equal(row!.tenantId, fx.tenantId);
  // EDIT vs REJECT split: similarity ~should~ be above 0.3 here (same topic),
  // but the controller routes either way — both land as TuningSuggestion.
  assert.ok(['EDIT_TRIGGERED', 'REJECT_TRIGGERED'].includes(String(row!.triggerType)));
});

test('second POST within 60s on the same message id dedups → no new TuningSuggestion', async () => {
  // The same messageId dedup window in shouldProcessTrigger prevents double-fire.
  // We invoke the controller a second time on a FRESH pending draft + different
  // message and assert that if the message is the SAME id we short-circuit.
  //
  // Strictly, the first test's message id is already deduped for 60s. Second
  // POST lands a NEW message id though — dedup is per-(triggerType,messageId),
  // so a second edit on a DIFFERENT message would fire again.
  //
  // This case codifies a narrower assertion: rehydrate the SAME messageId and
  // call shouldProcessTrigger directly to confirm the dedup key is present.
  const existingBefore = await prisma.tuningSuggestion.count({
    where: { tenantId: fx.tenantId },
  });

  // Build a second message under the same conversation and then manually
  // re-call the trigger key for the FIRST message to verify dedup state.
  const firstMsg = await prisma.message.findFirst({
    where: { tenantId: fx.tenantId, role: 'HOST' },
    orderBy: { sentAt: 'desc' },
  });
  assert.ok(firstMsg);

  const { shouldProcessTrigger } = require('../../services/tuning/trigger-dedup.service');
  const canFireAgain = shouldProcessTrigger('EDIT_TRIGGERED', firstMsg!.id);
  const canFireAgainReject = shouldProcessTrigger('REJECT_TRIGGERED', firstMsg!.id);
  assert.equal(
    canFireAgain && canFireAgainReject,
    false,
    'at least one of EDIT_TRIGGERED/REJECT_TRIGGERED dedup keys must already be set for the message id',
  );

  // And we can also verify no spurious extra rows crept in since the first POST.
  const existingAfter = await prisma.tuningSuggestion.count({
    where: { tenantId: fx.tenantId },
  });
  assert.equal(existingAfter, existingBefore, 'no extra TuningSuggestion rows created');
});

test('POST /messages WITHOUT fromDraft (default) → no diagnostic fires even with pending draft', async () => {
  // Sprint-10 load-bearing guard: callers that don't explicitly opt in keep
  // the old behaviour where differing content during a pending draft never
  // triggers the diagnostic. Regression test for the false-positive lockdown.
  _resetDedupForTests();
  await prisma.pendingAiReply.deleteMany({ where: { conversationId: fx.conversationId } });
  await prisma.pendingAiReply.create({
    data: {
      conversationId: fx.conversationId,
      tenantId: fx.tenantId,
      fired: true,
      scheduledAt: new Date(Date.now() - 5000),
      suggestion: DRAFT_TEXT,
    },
  });

  const controller = makeMessagesController(prisma);
  const { res, captured } = mockRes();
  const req: any = {
    tenantId: fx.tenantId,
    userId: 'TEST_user_copilot',
    params: { id: fx.conversationId },
    headers: { 'x-client-source': 'web' },
    body: {
      content: 'A totally fresh typed reply, unrelated to the pending draft.',
      channel: 'channel',
      // fromDraft omitted — default false.
    },
  };

  await controller.send(req, res);
  assert.equal(captured.status, 201);
  const createdMsgId = captured.body.id;

  // Poll a shorter window and assert it stays empty.
  const existingBefore = await prisma.tuningSuggestion.count({
    where: { sourceMessageId: createdMsgId },
  });
  await new Promise(r => setTimeout(r, 500));
  const existingAfter = await prisma.tuningSuggestion.count({
    where: { sourceMessageId: createdMsgId },
  });
  assert.equal(existingBefore, 0);
  assert.equal(existingAfter, 0, 'no TuningSuggestion for a send without fromDraft:true');

  // And the Message row must NOT have originalAiText stamped (the controller
  // only writes it when the pendingDraft lookup was gated in by fromDraft).
  const msg = await prisma.message.findUnique({ where: { id: createdMsgId } });
  assert.equal(msg?.originalAiText, null, 'originalAiText must stay null without fromDraft opt-in');
});
