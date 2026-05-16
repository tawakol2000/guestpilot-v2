/**
 * End-to-end test of the copilot-edit → tuning-diagnostic flow.
 *
 * Seeds a realistic Guest / Reservation / Conversation / Message chain
 * on a target tenant where the AI's `originalAiText` differs from the
 * manager-sent `content` (i.e. the manager edited the copilot draft).
 * Then calls `runDiagnostic` directly with EDIT_TRIGGERED and prints:
 *   - the resolved evidence bundle id + size
 *   - the full DiagnosticResult (category, subLabel, confidence,
 *     rationale, proposedText, decision_trace)
 *   - the TuningSuggestion row that was written (if any)
 *   - timing + token usage
 *
 * The seeded rows are tagged with a `harness-` prefix on hostaway ids
 * so they can be cleaned up later. The script does NOT call Hostaway
 * and does NOT send any guest-facing message — it only writes to the
 * local Prisma database, mirroring the shape produced by the real
 * shadow-preview / send pipeline.
 *
 * Usage:
 *   npx tsx scripts/test-diagnostic-flow.ts <tenantId> [scenarioKey]
 *
 * Scenarios:
 *   early-checkin   (default) — manager corrects $25/hour SOP to £30 flat policy.
 *   wifi-missing             — guest asks WiFi password, AI says "I don't have
 *                              that info" → manager pastes the password directly.
 *   tone-only                — manager makes a cosmetic punctuation change.
 *   parking-routing          — AI fetched check-in SOP for a parking question.
 */
import * as dotenv from 'dotenv';
dotenv.config();
import { PrismaClient, type Prisma } from '@prisma/client';
import { runDiagnostic } from '../src/services/tuning/diagnostic.service';
import { writeSuggestionFromDiagnostic } from '../src/services/tuning/suggestion-writer.service';

const prisma = new PrismaClient();

interface Scenario {
  key: string;
  description: string;
  guestMessage: string;
  originalAiText: string;
  managerEdit: string;
  reservationStatus: 'INQUIRY' | 'PENDING' | 'CONFIRMED' | 'CHECKED_IN' | 'CHECKED_OUT' | 'CANCELLED';
  channel: 'AIRBNB' | 'BOOKING' | 'DIRECT' | 'WHATSAPP' | 'OTHER';
}

const SCENARIOS: Record<string, Scenario> = {
  'early-checkin': {
    key: 'early-checkin',
    description: 'Manager corrects $25/hour early check-in to £30 flat policy.',
    guestMessage: "Hi, any chance we could check in at 11am? Flight lands at 9.",
    originalAiText:
      "I'm sorry, our standard check-in starts at 2 PM. We can offer paid early check-in at $25 per hour before 3 PM — would you like me to set that up?",
    managerEdit:
      "Hi! 11am works — there's a £30 early check-in fee. Want me to confirm and send the payment link?",
    reservationStatus: 'CONFIRMED',
    channel: 'AIRBNB',
  },
  'wifi-missing': {
    key: 'wifi-missing',
    description: 'Guest asks WiFi password; AI says "I don\'t have that info"; manager fills in the real password.',
    guestMessage: "What's the WiFi password? I can't find it in the welcome guide.",
    originalAiText:
      "I'm sorry, I don't have that information. The host should be able to share the WiFi password with you directly — I'll let them know.",
    managerEdit:
      "Hey! The WiFi is 'SunsetLofts-3B' and the password is 'welcome2024'. It's also on the back of the router in the living room.",
    reservationStatus: 'CHECKED_IN',
    channel: 'AIRBNB',
  },
  'tone-only': {
    key: 'tone-only',
    description: 'Cosmetic edit — capitalisation + a single comma. Should classify NO_FIX.',
    guestMessage: "Thanks for the info!",
    originalAiText:
      "you're welcome — let me know if anything else comes up during your stay.",
    managerEdit:
      "You're welcome — let me know if anything else comes up during your stay.",
    reservationStatus: 'CHECKED_IN',
    channel: 'AIRBNB',
  },
  'parking-routing': {
    key: 'parking-routing',
    description: 'AI fetched the check-in SOP for a parking question. Should classify SOP_ROUTING.',
    guestMessage: "Where do we park the car when we arrive?",
    originalAiText:
      "Standard check-in is at 2 PM. We'll send you the door code an hour before. Looking forward to having you!",
    managerEdit:
      "Parking is in the underground garage — entrance on Sunset Way. Use bay 12 marked '3B'. The gate code is 4827.",
    reservationStatus: 'CONFIRMED',
    channel: 'AIRBNB',
  },
};

async function main() {
  const tenantId = process.argv[2];
  const scenarioKey = (process.argv[3] ?? 'early-checkin') as keyof typeof SCENARIOS;
  if (!tenantId || !SCENARIOS[scenarioKey]) {
    console.error('Usage: tsx scripts/test-diagnostic-flow.ts <tenantId> [scenarioKey]');
    console.error('Scenarios:', Object.keys(SCENARIOS).join(', '));
    process.exit(1);
  }

  const scenario = SCENARIOS[scenarioKey];
  console.log(`\n=== Scenario: ${scenario.key} ===`);
  console.log(scenario.description);
  console.log('');

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true },
  });
  if (!tenant) {
    console.error(`Tenant ${tenantId} not found`);
    process.exit(1);
  }
  console.log(`Tenant: ${tenant.name} (${tenant.id})`);

  // ─── 1. Property (use existing or create harness placeholder) ───────────
  let property = await prisma.property.findFirst({
    where: { tenantId },
    orderBy: { createdAt: 'asc' },
  });
  if (!property) {
    property = await prisma.property.create({
      data: {
        tenantId,
        hostawayListingId: `harness-listing-${Date.now()}`,
        name: 'Sunset Lofts · Unit 3B',
        address: '12 Sunset Way, London',
        listingDescription: 'Modern 1-bed loft.',
        customKnowledgeBase: {},
      },
    });
    console.log(`Created property ${property.id}`);
  } else {
    console.log(`Using existing property ${property.id} (${property.name})`);
  }

  // ─── 2. Guest ───────────────────────────────────────────────────────────
  const guestUid = `harness-guest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const guest = await prisma.guest.create({
    data: {
      tenantId,
      hostawayGuestId: guestUid,
      name: 'Harness Test Guest',
      email: '',
      phone: '',
      nationality: '',
    },
  });

  // ─── 3. Reservation ─────────────────────────────────────────────────────
  const now = new Date();
  const checkIn = new Date(now.getTime() + 24 * 60 * 60_000);
  const checkOut = new Date(now.getTime() + 4 * 24 * 60 * 60_000);
  const reservation = await prisma.reservation.create({
    data: {
      tenantId,
      propertyId: property.id,
      guestId: guest.id,
      hostawayReservationId: `harness-res-${Date.now().toString(36)}`,
      checkIn,
      checkOut,
      guestCount: 2,
      channel: scenario.channel as any,
      status: scenario.reservationStatus as any,
      aiEnabled: true,
      aiMode: 'autopilot',
      screeningAnswers: {},
    },
  });

  // ─── 4. Conversation ────────────────────────────────────────────────────
  const conversation = await prisma.conversation.create({
    data: {
      tenantId,
      reservationId: reservation.id,
      guestId: guest.id,
      propertyId: property.id,
      channel: scenario.channel as any,
      status: 'OPEN',
      lastMessageAt: now,
    },
  });

  // ─── 5. Guest message ───────────────────────────────────────────────────
  const guestSentAt = new Date(now.getTime() - 5 * 60_000);
  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      tenantId,
      role: 'GUEST' as any,
      content: scenario.guestMessage,
      channel: scenario.channel as any,
      sentAt: guestSentAt,
      source: 'system',
    },
  });

  // ─── 6. AI message (the disputed reply) ─────────────────────────────────
  //
  // Mirror the shape the shadow-preview controller writes on Send:
  //   - role: AI
  //   - content: final text (the manager's edit)
  //   - originalAiText: AI's original draft (preserved for audit)
  //   - editedByUserId: non-null marker so the analyzer knows it was edited
  //   - previewState: null (no longer a preview, has been sent)
  const aiMessage = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      tenantId,
      role: 'AI' as any,
      content: scenario.managerEdit,
      originalAiText: scenario.originalAiText,
      editedByUserId: 'harness-test-user',
      channel: scenario.channel as any,
      sentAt: now,
      source: 'ai',
    },
  });
  console.log(`Created AI message ${aiMessage.id}`);
  console.log(`  Conversation: ${conversation.id}`);
  console.log(`  Reservation: ${reservation.id} (status=${scenario.reservationStatus})`);
  console.log('');

  // ─── 7. Run the diagnostic ──────────────────────────────────────────────
  console.log('--- Running diagnostic (k=3 self-consistency, model=gpt-5.4 reasoning=high) ---');
  const t0 = Date.now();
  const result = await runDiagnostic(
    {
      triggerType: 'EDIT_TRIGGERED',
      tenantId,
      messageId: aiMessage.id,
      note: 'Harness-triggered edit — manager rewrote the AI draft before sending.',
    },
    prisma,
  );
  const t1 = Date.now();
  console.log(`Elapsed: ${((t1 - t0) / 1000).toFixed(1)}s`);
  console.log('');

  if (!result) {
    console.log('[result] null (OpenAI not configured, all samples failed, or insufficient evidence).');
  } else {
    console.log('=== Diagnostic result ===');
    console.log(`Category   : ${result.category}`);
    console.log(`SubLabel   : ${result.subLabel}`);
    console.log(`Confidence : ${result.confidence}`);
    console.log(`Rationale  : ${result.rationale}`);
    console.log(`Target     : ${JSON.stringify(result.artifactTarget)}`);
    console.log(`ProposedText length: ${result.proposedText?.length ?? 0} chars`);
    if (result.proposedText) {
      console.log(`--- ProposedText preview (first 600 chars) ---`);
      console.log(result.proposedText.slice(0, 600));
      console.log('---');
    }
    console.log('');
    console.log('Decision trace (one line per category):');
    for (const entry of result.decisionTrace) {
      console.log(`  ${entry.verdict.padEnd(10)} ${entry.category.padEnd(20)} ${entry.reason}`);
    }
    console.log('');

    // ─── 8. Write the TuningSuggestion ────────────────────────────────────
    console.log('--- Writing TuningSuggestion ---');
    try {
      const written = await writeSuggestionFromDiagnostic(result, {}, prisma);
      console.log(`Written: ${JSON.stringify(written, null, 2)}`);
    } catch (err: any) {
      console.warn(`Write failed: ${err?.message ?? String(err)}`);
    }

    // ─── 9. Fetch the persisted TuningSuggestion row ──────────────────────
    const suggestion = await prisma.tuningSuggestion.findFirst({
      where: { tenantId, evidenceBundleId: result.evidenceBundleId },
      orderBy: { createdAt: 'desc' },
    });
    if (suggestion) {
      console.log('');
      console.log('=== Persisted TuningSuggestion row ===');
      console.log(`  id              : ${suggestion.id}`);
      console.log(`  category        : ${suggestion.category}`);
      console.log(`  subLabel        : ${suggestion.subLabel}`);
      console.log(`  status          : ${suggestion.status}`);
      console.log(`  actionType      : ${suggestion.actionType}`);
      console.log(`  sopCategory     : ${suggestion.sopCategory}`);
      console.log(`  faqEntryId      : ${suggestion.faqEntryId}`);
      console.log(`  toolName        : ${suggestion.toolName}`);
      console.log(`  confidence      : ${suggestion.confidence}`);
      console.log(`  rationale       : ${suggestion.rationale?.slice(0, 200)}…`);
    } else {
      console.log('No TuningSuggestion row created (likely NO_FIX or write-skipped).');
    }
  }

  console.log('');
  console.log('=== Seed ids (for inspection / cleanup) ===');
  console.log(JSON.stringify(
    {
      tenantId,
      propertyId: property.id,
      reservationId: reservation.id,
      conversationId: conversation.id,
      aiMessageId: aiMessage.id,
      evidenceBundleId: result?.evidenceBundleId ?? null,
      diagnosticCategory: result?.category ?? null,
    },
    null,
    2,
  ));
}

main()
  .catch((err) => {
    console.error('test-diagnostic-flow failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
