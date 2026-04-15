/**
 * Integration: evidence-bundle assembler + GET /api/evidence-bundles/:id.
 * Closes concerns C3 + C21.
 */
import { test, after, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { PrismaClient } from '@prisma/client';
import { assembleEvidenceBundle, type EvidenceBundle } from '../../services/evidence-bundle.service';
import { makeEvidenceBundleController } from '../../controllers/evidence-bundle.controller';
import { buildFixture, type IntegrationFixture } from './_fixture';

const prisma = new PrismaClient();
let fx: IntegrationFixture;

before(async () => {
  fx = await buildFixture(prisma);
});

after(async () => {
  if (fx) await fx.cleanup();
  await prisma.$disconnect();
});

test('assembleEvidenceBundle: shape covers all required sections (C3)', async () => {
  const bundle: EvidenceBundle = await assembleEvidenceBundle(
    {
      triggerType: 'EDIT_TRIGGERED',
      tenantId: fx.tenantId,
      messageId: fx.aiMessageId,
      note: 'integration-test',
    },
    prisma,
  );

  // Trigger-level fields
  assert.equal(bundle.trigger.triggerType, 'EDIT_TRIGGERED');
  assert.equal(bundle.trigger.tenantId, fx.tenantId);
  assert.equal(bundle.trigger.messageId, fx.aiMessageId);
  assert.equal(typeof bundle.assembledAt, 'string');

  // Disputed message reflects the manager-edited send
  assert.ok(bundle.disputedMessage, 'disputedMessage present');
  assert.equal(bundle.disputedMessage!.id, fx.aiMessageId);
  assert.equal(bundle.disputedMessage!.role, 'AI');
  assert.equal(bundle.disputedMessage!.editedByUserId, 'TEST_user');
  assert.match(bundle.disputedMessage!.content, /Check-in is from 3 PM/);
  assert.match(String(bundle.disputedMessage!.originalAiText), /Check-in is at 4 PM/);

  // Conversation context contains both messages, oldest first
  assert.ok(bundle.conversationContext, 'conversationContext present');
  assert.ok(bundle.conversationContext!.messages.length >= 2);

  // Entity metadata includes the property + reservation + guest we wrote
  assert.equal(bundle.entities.property?.id, fx.propertyId);
  assert.equal(bundle.entities.reservation?.id, fx.reservationId);
  assert.ok(bundle.entities.guest);

  // mainAiTrace + sopsInEffect + faqHits + priorSuggestions are arrays / objects
  // even when empty (no nulls bubbling through).
  assert.ok(typeof bundle.mainAiTrace === 'object' || bundle.mainAiTrace === null);
  assert.ok(Array.isArray(bundle.sopsInEffect));
  assert.ok(Array.isArray(bundle.faqHits));
  assert.ok(Array.isArray(bundle.priorSuggestions));
});

test('GET /api/evidence-bundles/:id: 200 on real row, 404 on missing (C21)', async () => {
  // Persist a bundle exactly as the diagnostic pipeline does.
  const bundle = await assembleEvidenceBundle(
    {
      triggerType: 'EDIT_TRIGGERED',
      tenantId: fx.tenantId,
      messageId: fx.aiMessageId,
      note: 'integration-endpoint-test',
    },
    prisma,
  );
  const persisted = await prisma.evidenceBundle.create({
    data: {
      tenantId: fx.tenantId,
      messageId: fx.aiMessageId,
      triggerType: 'EDIT_TRIGGERED',
      payload: bundle as any,
    },
    select: { id: true },
  });

  const ctrl = makeEvidenceBundleController(prisma);

  // Mock the Express request/response surface enough for the controller.
  const okJson: any = {};
  let okStatus: number | null = null;
  await ctrl.get(
    {
      tenantId: fx.tenantId,
      params: { id: persisted.id },
    } as any,
    {
      status(c: number) {
        okStatus = c;
        return this;
      },
      json(body: any) {
        Object.assign(okJson, body);
        return this;
      },
    } as any,
  );
  assert.equal(okStatus, null, 'no status() call means default 200');
  assert.equal(okJson.id, persisted.id);
  assert.equal((okJson.payload as any)?.disputedMessage?.id, fx.aiMessageId);

  // Missing row → 404.
  const missing: any = {};
  let missingStatus: number | null = null;
  await ctrl.get(
    { tenantId: fx.tenantId, params: { id: 'TEST_does_not_exist' } } as any,
    {
      status(c: number) {
        missingStatus = c;
        return this;
      },
      json(body: any) {
        Object.assign(missing, body);
        return this;
      },
    } as any,
  );
  assert.equal(missingStatus, 404);
  assert.match(String(missing.error ?? missing.detail ?? ''), /NOT_FOUND|not.?found/i);
});
