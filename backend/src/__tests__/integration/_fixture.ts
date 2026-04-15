/**
 * Integration-test fixture builder.
 *
 * Creates a sentinel TEST tenant on the live Railway DB with the minimum
 * graph the specs need: tenant + property + reservation + conversation +
 * AI message + manager-edited content. `cleanup()` cascades the tenant so
 * every dependent row goes with it.
 *
 * Sprint 05 §7 — see ./README.md for context.
 */
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'crypto';

export interface IntegrationFixture {
  prisma: PrismaClient;
  tenantId: string;
  propertyId: string;
  reservationId: string;
  conversationId: string;
  guestMessageId: string;
  aiMessageId: string;
  /** Drop the entire tenant + every row attached to it. Idempotent. */
  cleanup: () => Promise<void>;
}

export async function buildFixture(prisma: PrismaClient): Promise<IntegrationFixture> {
  const stamp = randomBytes(6).toString('hex');
  const tenant = await prisma.tenant.create({
    data: {
      email: `TEST_integration_${stamp}@guestpilot.local`,
      name: `TEST integration ${stamp}`,
      passwordHash: 'TEST',
      hostawayApiKey: 'TEST',
      hostawayAccountId: `TEST_${stamp}`,
    },
  });

  const property = await prisma.property.create({
    data: {
      tenantId: tenant.id,
      hostawayListingId: `TEST_listing_${stamp}`,
      name: `TEST Property ${stamp}`,
      address: '1 Test St',
      listingDescription: 'Integration-test fixture property.',
    },
  });

  const guest = await prisma.guest.create({
    data: {
      tenantId: tenant.id,
      hostawayGuestId: `TEST_guest_${stamp}`,
      name: 'Test Guest',
    },
  });

  const reservation = await prisma.reservation.create({
    data: {
      tenantId: tenant.id,
      propertyId: property.id,
      guestId: guest.id,
      hostawayReservationId: `TEST_res_${stamp}`,
      checkIn: new Date(Date.now() + 7 * 86400_000),
      checkOut: new Date(Date.now() + 10 * 86400_000),
      guestCount: 2,
      channel: 'AIRBNB',
      status: 'CONFIRMED',
    },
  });

  const conversation = await prisma.conversation.create({
    data: {
      tenantId: tenant.id,
      propertyId: property.id,
      reservationId: reservation.id,
      guestId: guest.id,
      hostawayConversationId: `TEST_conv_${stamp}`,
      channel: 'AIRBNB',
      status: 'OPEN',
    },
  });

  const guestMessage = await prisma.message.create({
    data: {
      tenantId: tenant.id,
      conversationId: conversation.id,
      role: 'GUEST',
      content: 'Hi! What time can I check in?',
      sentAt: new Date(Date.now() - 60_000),
      hostawayMessageId: `TEST_gmsg_${stamp}`,
    },
  });

  // The AI's draft and the manager-edited send. originalAiText keeps the
  // pre-edit copy so the diagnostic pipeline has both sides.
  const aiMessage = await prisma.message.create({
    data: {
      tenantId: tenant.id,
      conversationId: conversation.id,
      role: 'AI',
      content: 'Check-in is from 3 PM. Please bring your passport for verification.',
      originalAiText: 'Check-in is at 4 PM, no exceptions.',
      editedByUserId: 'TEST_user',
      sentAt: new Date(),
      hostawayMessageId: `TEST_amsg_${stamp}`,
    },
  });

  return {
    prisma,
    tenantId: tenant.id,
    propertyId: property.id,
    reservationId: reservation.id,
    conversationId: conversation.id,
    guestMessageId: guestMessage.id,
    aiMessageId: aiMessage.id,
    async cleanup() {
      await prisma.tenant.delete({ where: { id: tenant.id } }).catch(() => undefined);
    },
  };
}
