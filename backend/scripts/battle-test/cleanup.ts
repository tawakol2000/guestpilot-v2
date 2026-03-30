/**
 * Battle Test — Cleanup Script
 * Removes all [TEST]-prefixed test data from the DB.
 *
 * Usage: cd backend && npx ts-node scripts/battle-test/cleanup.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const TENANT_ID = 'cmmth6d1r000a6bhlkb75ku4r';

async function main() {
  console.log('=== Battle Test Cleanup ===\n');

  // Find test guests
  const testGuests = await prisma.guest.findMany({
    where: { tenantId: TENANT_ID, name: { startsWith: '[TEST]' } },
    select: { id: true, name: true },
  });
  console.log(`Found ${testGuests.length} test guests`);

  if (testGuests.length === 0) {
    console.log('Nothing to clean up.');
    await prisma.$disconnect();
    return;
  }

  const guestIds = testGuests.map(g => g.id);

  // Find test reservations
  const testReservations = await prisma.reservation.findMany({
    where: { guestId: { in: guestIds } },
    select: { id: true },
  });
  const reservationIds = testReservations.map(r => r.id);
  console.log(`Found ${reservationIds.length} test reservations`);

  // Find test conversations
  const testConversations = await prisma.conversation.findMany({
    where: { guestId: { in: guestIds } },
    select: { id: true },
  });
  const conversationIds = testConversations.map(c => c.id);
  console.log(`Found ${conversationIds.length} test conversations`);

  // Delete in order (respecting foreign keys)
  if (conversationIds.length > 0) {
    // Delete messages
    const deletedMessages = await prisma.message.deleteMany({
      where: { conversationId: { in: conversationIds } },
    });
    console.log(`Deleted ${deletedMessages.count} messages`);

    // Delete pending AI replies
    const deletedPending = await prisma.pendingAiReply.deleteMany({
      where: { conversationId: { in: conversationIds } },
    });
    console.log(`Deleted ${deletedPending.count} pending AI replies`);

    // Delete tasks
    const deletedTasks = await prisma.task.deleteMany({
      where: { conversationId: { in: conversationIds } },
    });
    console.log(`Deleted ${deletedTasks.count} tasks`);

    // Delete conversations
    const deletedConvs = await prisma.conversation.deleteMany({
      where: { id: { in: conversationIds } },
    });
    console.log(`Deleted ${deletedConvs.count} conversations`);
  }

  // Delete reservations
  if (reservationIds.length > 0) {
    const deletedRes = await prisma.reservation.deleteMany({
      where: { id: { in: reservationIds } },
    });
    console.log(`Deleted ${deletedRes.count} reservations`);
  }

  // Delete guests
  const deletedGuests = await prisma.guest.deleteMany({
    where: { id: { in: guestIds } },
  });
  console.log(`Deleted ${deletedGuests.count} guests`);

  console.log('\n=== Cleanup Complete ===');
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('Cleanup failed:', err);
  await prisma.$disconnect();
  process.exit(1);
});
