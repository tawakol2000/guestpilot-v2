/**
 * Integration: diagnostic single-shot pipeline against a fixture conversation.
 * The OpenAI client is replaced via require-cache injection so no network call
 * happens. We assert the diagnostic returns (category, confidence, proposedText)
 * and persists an EvidenceBundle row.
 */
import { test, after, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { PrismaClient } from '@prisma/client';
import { buildFixture, type IntegrationFixture } from './_fixture';

// ── Mock OpenAI BEFORE the diagnostic module loads ────────────────────────
// The diagnostic service does `import OpenAI from 'openai'` and instantiates
// `new OpenAI({ apiKey })`. We patch the OpenAI constructor on the real
// module's exports (resolved via require) BEFORE the diagnostic module is
// imported, so its `new OpenAI(...)` returns a stub instance whose
// `responses.create` is deterministic.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'TEST_KEY';

const mockResponse = {
  output_text: JSON.stringify({
    category: 'SYSTEM_PROMPT',
    subLabel: 'checkin-time-tone',
    confidence: 0.81,
    rationale: 'Edit changed tone from absolute to accommodating; system prompt should reflect that.',
    proposedText: 'When asked about check-in time, state the standard window and offer to flex.',
    artifactTarget: { type: 'SYSTEM_PROMPT', id: 'systemPromptCoordinator' },
    capabilityRequest: null,
  }),
  usage: { input_tokens: 1234, output_tokens: 456, input_tokens_details: { cached_tokens: 0 } },
};

// Replace the openai package's cached module entry with our stub BEFORE the
// diagnostic module imports it. Using a fresh exports object sidesteps the
// real package's getter-based default export.
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

const {
  runDiagnostic,
  __resetDiagnosticModelCacheForTests,
} = require('../../services/tuning/diagnostic.service');

const prisma = new PrismaClient();
let fx: IntegrationFixture;

before(async () => {
  __resetDiagnosticModelCacheForTests();
  fx = await buildFixture(prisma);
});

after(async () => {
  if (fx) await fx.cleanup();
  await prisma.$disconnect();
});

test('runDiagnostic: produces (category, confidence, proposedText) + persists bundle', async () => {
  const result = await runDiagnostic(
    {
      triggerType: 'EDIT_TRIGGERED',
      tenantId: fx.tenantId,
      messageId: fx.aiMessageId,
      note: 'integration-diagnostic',
    },
    prisma,
  );

  assert.ok(result, 'diagnostic returned a result');
  assert.equal(result.category, 'SYSTEM_PROMPT');
  assert.equal(result.subLabel, 'checkin-time-tone');
  assert.ok(result.confidence > 0.5 && result.confidence <= 1);
  assert.match(String(result.proposedText), /standard window/);
  assert.equal(result.artifactTarget.type, 'SYSTEM_PROMPT');
  assert.equal(result.tenantId, fx.tenantId);
  assert.ok(result.evidenceBundleId, 'evidence bundle persisted');

  // diagMeta carries the deterministic preprocessing output
  assert.ok(typeof result.diagMeta.similarity === 'number');
  assert.ok(['MINOR', 'MODERATE', 'MAJOR', 'WHOLESALE'].includes(result.diagMeta.magnitude));

  // The evidence-bundle row exists for this tenant.
  const persisted = await prisma.evidenceBundle.findFirst({
    where: { id: result.evidenceBundleId, tenantId: fx.tenantId },
  });
  assert.ok(persisted, 'EvidenceBundle row persisted in tenant scope');
  assert.equal(persisted!.triggerType, 'EDIT_TRIGGERED');

  // Sprint 05 §3 side-effect: editMagnitudeScore stamped on Message.
  const msg = await prisma.message.findUnique({
    where: { id: fx.aiMessageId },
    select: { editMagnitudeScore: true },
  });
  assert.ok(typeof msg?.editMagnitudeScore === 'number', 'editMagnitudeScore persisted');
});
