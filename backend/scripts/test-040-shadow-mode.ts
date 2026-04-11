/**
 * Feature 040 — Copilot Shadow Mode smoke test.
 *
 * Exercises the key code paths end-to-end against the live dev database:
 *   1. Schema: new columns/enums are queryable
 *   2. TenantAiConfig.shadowModeEnabled toggle read/write
 *   3. lockOlderPreviews helper
 *   4. Message with previewState=PREVIEW_PENDING create/lock/transition
 *   5. TuningSuggestion CRUD
 *
 * Cleans up any test rows it creates. Safe to re-run.
 */
import { PrismaClient, MessageRole } from '@prisma/client';
import { lockOlderPreviews } from '../src/services/shadow-preview.service';

const prisma = new PrismaClient();

function log(...args: unknown[]): void { console.log('[040-smoke]', ...args); }
function ok(label: string): void { console.log(`[040-smoke] ✓ ${label}`); }
function fail(label: string, err?: unknown): never {
  console.error(`[040-smoke] ✗ ${label}`, err);
  process.exit(1);
}

async function main(): Promise<void> {
  log('Starting Feature 040 smoke test against dev database');

  // ─── Step 1: schema smoke — new enums + columns exist ────────────────────
  try {
    // Querying with a filter on the new previewState column proves the column exists.
    await prisma.message.findMany({
      where: { previewState: 'PREVIEW_PENDING' },
      take: 1,
      select: { id: true, previewState: true, originalAiText: true, editedByUserId: true, aiApiLogId: true },
    });
    ok('Message.previewState / originalAiText / editedByUserId / aiApiLogId columns queryable');
  } catch (err) {
    fail('Message schema check', err);
  }

  try {
    await prisma.tuningSuggestion.count();
    ok('TuningSuggestion table queryable');
  } catch (err) {
    fail('TuningSuggestion table check', err);
  }

  // ─── Step 2: find a tenant to use ────────────────────────────────────────
  const tenant = await prisma.tenant.findFirst();
  if (!tenant) fail('No tenants in DB — cannot run smoke test without at least one tenant');
  log(`Using tenant ${tenant!.id} (${tenant!.email})`);

  // Preserve original shadowModeEnabled state so we can restore it at the end.
  const originalConfig = await prisma.tenantAiConfig.findUnique({
    where: { tenantId: tenant!.id },
    select: { shadowModeEnabled: true },
  });
  const originalShadowMode = originalConfig?.shadowModeEnabled ?? false;
  log(`Original shadowModeEnabled: ${originalShadowMode}`);

  // ─── Step 3: toggle shadowModeEnabled on ─────────────────────────────────
  try {
    await prisma.tenantAiConfig.upsert({
      where: { tenantId: tenant!.id },
      update: { shadowModeEnabled: true },
      create: { tenantId: tenant!.id, shadowModeEnabled: true },
    });
    const check = await prisma.tenantAiConfig.findUnique({
      where: { tenantId: tenant!.id },
      select: { shadowModeEnabled: true },
    });
    if (check?.shadowModeEnabled !== true) fail('shadowModeEnabled did not flip to true');
    ok('TenantAiConfig.shadowModeEnabled toggle write+read');
  } catch (err) {
    fail('toggle write', err);
  }

  // ─── Step 4: find an existing conversation to attach test previews to ────
  // We don't create a conversation (the model requires a Guest relation).
  // Previews we attach are UI-only (no hostawayMessageId, never delivered),
  // and we clean them up in the finally block so nothing leaks.
  const existingConv = await prisma.conversation.findFirst({
    where: { tenantId: tenant!.id },
    select: { id: true },
    orderBy: { lastMessageAt: 'desc' },
  });
  if (!existingConv) fail('No conversations found for tenant — skipping preview flow tests');
  const testConvId = existingConv!.id;
  log(`Using existing conversation ${testConvId} for preview tests (will clean up)`);
  const createdMessageIds: string[] = [];

  try {
    // ─── Step 5: create two preview messages back-to-back ─────────────────
    const preview1 = await prisma.message.create({
      data: {
        conversationId: testConvId,
        tenantId: tenant!.id,
        role: MessageRole.AI,
        content: 'Hello! This is the first preview draft. [040-SMOKE-TEST]',
        sentAt: new Date(Date.now() - 5000),
        channel: 'DIRECT',
        communicationType: 'channel',
        hostawayMessageId: '',
        previewState: 'PREVIEW_PENDING',
        originalAiText: 'Hello! This is the first preview draft. [040-SMOKE-TEST]',
      },
    });
    createdMessageIds.push(preview1.id);
    log(`Created preview 1: ${preview1.id}`);

    // ─── Step 6: lockOlderPreviews helper should lock preview1 ────────────
    // Tolerant assertion: the conversation may already have pre-existing PENDING
    // previews from earlier runs, so we only require that preview1 is present
    // in the returned locked set (not that it's the only one).
    const lockedIds = await lockOlderPreviews(prisma, tenant!.id, testConvId);
    if (!lockedIds.includes(preview1.id)) {
      fail(`lockOlderPreviews did not lock preview1: ${JSON.stringify(lockedIds)}`);
    }
    ok(`lockOlderPreviews locked preview1 (total locked: ${lockedIds.length})`);

    const preview1Locked = await prisma.message.findUnique({
      where: { id: preview1.id },
      select: { previewState: true },
    });
    if (preview1Locked?.previewState !== 'PREVIEW_LOCKED') {
      fail(`preview1 not transitioned to PREVIEW_LOCKED — got ${preview1Locked?.previewState}`);
    }
    ok('preview1 transitioned PREVIEW_PENDING → PREVIEW_LOCKED');

    // ─── Step 7: create a fresh preview2 ──────────────────────────────────
    const preview2 = await prisma.message.create({
      data: {
        conversationId: testConvId,
        tenantId: tenant!.id,
        role: MessageRole.AI,
        content: 'Hi again! Updated preview draft. [040-SMOKE-TEST]',
        sentAt: new Date(),
        channel: 'DIRECT',
        communicationType: 'channel',
        hostawayMessageId: '',
        previewState: 'PREVIEW_PENDING',
        originalAiText: 'Hi again! Updated preview draft. [040-SMOKE-TEST]',
      },
    });
    createdMessageIds.push(preview2.id);
    log(`Created preview 2: ${preview2.id}`);

    // ─── Step 8: simulate the atomic Send transition (without calling Hostaway) ──
    const transitioned = await prisma.message.updateMany({
      where: { id: preview2.id, tenantId: tenant!.id, previewState: 'PREVIEW_PENDING' },
      data: { previewState: 'PREVIEW_SENDING' },
    });
    if (transitioned.count !== 1) fail(`atomic transition affected ${transitioned.count} rows (expected 1)`);
    ok('Atomic PREVIEW_PENDING → PREVIEW_SENDING transition works');

    // Second attempt should affect 0 rows — idempotency proof.
    const second = await prisma.message.updateMany({
      where: { id: preview2.id, tenantId: tenant!.id, previewState: 'PREVIEW_PENDING' },
      data: { previewState: 'PREVIEW_SENDING' },
    });
    if (second.count !== 0) fail('idempotency check failed — second transition should have been a no-op');
    ok('Idempotency: second Send attempt is a no-op');

    // Commit: clear previewState to null and simulate Hostaway success
    await prisma.message.update({
      where: { id: preview2.id },
      data: {
        previewState: null,
        hostawayMessageId: 'fake-hostaway-id-smoke-test',
        editedByUserId: 'test-user',
      },
    });
    const committed = await prisma.message.findUnique({
      where: { id: preview2.id },
      select: { previewState: true, hostawayMessageId: true, editedByUserId: true, originalAiText: true },
    });
    if (committed?.previewState !== null) fail(`committed message previewState should be null, got ${committed?.previewState}`);
    if (committed?.hostawayMessageId !== 'fake-hostaway-id-smoke-test') fail('hostawayMessageId not set');
    if (committed?.editedByUserId !== 'test-user') fail('editedByUserId not set');
    ok('Send commit: previewState=null, hostawayMessageId+editedByUserId populated, originalAiText preserved');

    // ─── Step 9: TuningSuggestion create + query ──────────────────────────
    const suggestion = await prisma.tuningSuggestion.create({
      data: {
        tenantId: tenant!.id,
        sourceMessageId: preview2.id,
        actionType: 'EDIT_SYSTEM_PROMPT',
        rationale: 'Smoke test — coordinator prompt missing a key SOP reference.',
        systemPromptVariant: 'coordinator',
        beforeText: 'You are Omar, a helpful host assistant.',
        proposedText: 'You are Omar, a helpful host assistant. When guests ask about check-in, always consult the check-in SOP.',
        status: 'PENDING',
      },
    });
    log(`Created TuningSuggestion: ${suggestion.id}`);

    const listed = await prisma.tuningSuggestion.findMany({
      where: { tenantId: tenant!.id, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: { sourceMessage: { select: { conversationId: true } } },
    });
    if (!listed.find(s => s.id === suggestion.id)) fail('Listed suggestions did not include the one we just created');
    ok('TuningSuggestion query by tenant+status works and joins sourceMessage');

    // Update to ACCEPTED
    await prisma.tuningSuggestion.update({
      where: { id: suggestion.id },
      data: { status: 'ACCEPTED', appliedAt: new Date(), appliedPayload: { text: 'applied text' } },
    });
    ok('TuningSuggestion.appliedPayload (Json) write works');

    // Clean up the suggestion
    await prisma.tuningSuggestion.delete({ where: { id: suggestion.id } });
    ok('TuningSuggestion delete works');
  } catch (err) {
    fail('main flow', err);
  } finally {
    // Clean up any test messages we created (idempotent)
    if (createdMessageIds.length > 0) {
      await prisma.message.deleteMany({ where: { id: { in: createdMessageIds } } }).catch(() => {});
      log(`Cleaned up ${createdMessageIds.length} test messages`);
    }
    // Restore original shadowModeEnabled
    await prisma.tenantAiConfig
      .update({ where: { tenantId: tenant!.id }, data: { shadowModeEnabled: originalShadowMode } })
      .catch(() => {});
    log(`Restored shadowModeEnabled to ${originalShadowMode}`);
  }

  log('All Feature 040 smoke-test checks passed ✓');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async err => {
    console.error('Smoke test failed:', err);
    await prisma.$disconnect();
    process.exit(1);
  });
