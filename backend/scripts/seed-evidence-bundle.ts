/**
 * Seed a realistic EvidenceBundle row for the Studio TUNE harness.
 *
 * The Studio agent's `studio_get_evidence_index` + `studio_get_evidence_section`
 * tools read the assembled bundle payload directly. They don't require a
 * paired Reservation / Conversation / Message chain — only the bundle JSON
 * needs to be coherent. We seed a self-contained bundle whose
 * `disputedMessage` + `sopsInEffect` mirror a real correction so the agent
 * can produce a structured `data-suggested-fix` end-to-end.
 *
 * Usage:
 *   npx tsx scripts/seed-evidence-bundle.ts <tenantId> [sopVariantIdToSnapshot]
 *
 * Prints the new bundleId on stdout so the harness can be invoked as:
 *   npx tsx scripts/studio-test-harness.ts <tenantId> "...bundleId=<id>..." "" openai TUNE
 */
import * as dotenv from 'dotenv';
dotenv.config();
import { PrismaClient, type Prisma } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const tenantId = process.argv[2];
  const sopVariantId = process.argv[3]; // optional — defaults to first early-check-in DEFAULT variant
  if (!tenantId) {
    console.error('Usage: tsx scripts/seed-evidence-bundle.ts <tenantId> [sopVariantId]');
    process.exit(1);
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true },
  });
  if (!tenant) {
    console.error(`Tenant ${tenantId} not found`);
    process.exit(1);
  }

  // Snapshot whichever SOP variant we're going to claim was "in effect" at
  // bundle assembly time. If the caller didn't pass one, find the early-
  // check-in SOP's DEFAULT variant — that matches the scenario this seed is
  // built around.
  const sopVariant = sopVariantId
    ? await prisma.sopVariant.findFirst({
        where: { id: sopVariantId, sopDefinition: { tenantId } },
        include: { sopDefinition: { select: { id: true, category: true } } },
      })
    : await prisma.sopVariant.findFirst({
        where: {
          sopDefinition: { tenantId, category: 'sop-early-check-in' },
          status: 'DEFAULT',
        },
        include: { sopDefinition: { select: { id: true, category: true } } },
      });

  if (!sopVariant) {
    console.error('No SOP variant found to snapshot — pass an explicit sopVariantId or seed an early-check-in SOP first.');
    process.exit(1);
  }

  const property = await prisma.property.findFirst({
    where: { tenantId },
    select: { id: true, name: true, address: true, hostawayListingId: true, listingDescription: true, customKnowledgeBase: true },
  });

  const now = new Date();

  // Realistic disputed exchange: guest asks for 11am check-in. AI cites the
  // current ($25/hour) SOP. Manager edits to the new (£30 flat) policy.
  // Bundle anchors a TUNE turn that should classify SOP_CONTENT and emit
  // a `data-suggested-fix` proposing the SOP rewrite.
  const bundlePayload = {
    assembledAt: now.toISOString(),
    trigger: {
      triggerType: 'EDIT_TRIGGERED',
      tenantId,
      messageId: null,
      resolvedAt: now.toISOString(),
      note: "Manager edited AI's early-check-in reply: changed quote from hourly $25 to flat £30 between 11am-2pm.",
    },
    disputedMessage: {
      id: 'seed-msg-early-checkin-001',
      content:
        "Hi! 11am works — there's a £30 early check-in fee. Want me to confirm and send the payment link?",
      originalAiText:
        "I'm sorry, our standard check-in starts at 2 PM. We can offer paid early check-in at $25 per hour before 3 PM — would you like me to set that up?",
      editedByUserId: 'seed-manager',
      sentAt: now.toISOString(),
      role: 'AI',
      channel: 'AIRBNB',
      previewState: 'SENT',
    },
    conversationContext: {
      conversationId: 'seed-convo-early-checkin-001',
      channel: 'AIRBNB',
      status: 'OPEN',
      summary: 'Confirmed guest asking about an 11am arrival; manager pricing rule differs from the live SOP.',
      summaryUpdatedAt: now.toISOString(),
      messages: [
        {
          id: 'seed-msg-guest-001',
          role: 'GUEST',
          content: 'Hi! Any chance we could check in at 11am tomorrow? Flight lands at 9.',
          sentAt: new Date(now.getTime() - 6 * 60_000).toISOString(),
        },
        {
          id: 'seed-msg-early-checkin-001',
          role: 'AI',
          content:
            "Hi! 11am works — there's a £30 early check-in fee. Want me to confirm and send the payment link?",
          sentAt: now.toISOString(),
        },
      ],
    },
    entities: {
      property: property
        ? {
            id: property.id,
            hostawayListingId: property.hostawayListingId ?? 'demo-listing-001',
            name: property.name ?? 'Sunset Lofts · Unit 3B',
            address: property.address ?? '12 Sunset Way, London',
            listingDescription: property.listingDescription ?? 'Modern 1-bed loft.',
            customKnowledgeBase: property.customKnowledgeBase ?? {},
          }
        : null,
      reservation: {
        id: 'seed-res-001',
        hostawayReservationId: 'demo-res-001',
        checkIn: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
        checkOut: new Date(now.getTime() + 4 * 24 * 60 * 60_000).toISOString(),
        guestCount: 2,
        channel: 'AIRBNB',
        status: 'CONFIRMED',
        aiMode: 'autopilot',
        screeningAnswers: {},
      },
      guest: {
        id: 'seed-guest-001',
        hostawayGuestId: 'demo-guest-001',
        name: 'Alex Rivera',
        email: 'alex@example.com',
        phone: '',
        nationality: '',
      },
    },
    mainAiTrace: {
      aiApiLogId: null,
      agentName: 'coordinator',
      model: 'gpt-5.4-mini-2026-03-17',
      inputTokens: 4200,
      outputTokens: 180,
      costUsd: 0.012,
      durationMs: 4100,
      error: null,
      ragContext: {
        sopCategory: 'sop-early-check-in',
        sopVariantId: sopVariant.id,
        faqIds: [],
        toolsUsed: ['get_sop'],
      },
      createdAt: now.toISOString(),
    },
    langfuseTrace: null,
    langfuseTraceRef: {
      sessionId: 'seed-session-001',
      messageIdHint: 'seed-msg-early-checkin-001',
      traceId: null,
      fetched: false,
      error: null,
    },
    sopsInEffect: [
      {
        category: sopVariant.sopDefinition.category,
        toolDescription: 'Policy for early check-in requests',
        variants: [
          {
            id: sopVariant.id,
            status: sopVariant.status,
            content: sopVariant.content,
            enabled: sopVariant.enabled,
          },
        ],
        propertyOverrides: [],
      },
    ],
    faqsInEffect: [],
    classifierDetail: {
      sopCategory: sopVariant.sopDefinition.category,
      sopHit: true,
      confidence: 0.88,
    },
    toolCalls: [
      {
        index: 0,
        name: 'get_sop',
        durationMs: 180,
        args: { category: 'sop-early-check-in' },
        result: { sopVariantId: sopVariant.id, status: 'DEFAULT' },
      },
    ],
  };

  const created = await prisma.evidenceBundle.create({
    data: {
      tenantId,
      messageId: null,
      triggerType: 'EDIT_TRIGGERED',
      payload: bundlePayload as unknown as Prisma.InputJsonValue,
    },
    select: { id: true, createdAt: true },
  });

  console.log(
    JSON.stringify(
      {
        bundleId: created.id,
        createdAt: created.createdAt.toISOString(),
        tenantId,
        sopVariantId: sopVariant.id,
        sopCategory: sopVariant.sopDefinition.category,
        propertyName: property?.name ?? null,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((err) => {
    console.error('seed-evidence-bundle failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
