/**
 * Battle Test — Setup Script
 * Creates 30 test conversations in the DB linked to real properties.
 * Guests are prefixed with [TEST] for frontend visibility.
 *
 * Usage: cd backend && npx ts-node scripts/battle-test/setup.ts
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();
const TENANT_ID = 'cmmth6d1r000a6bhlkb75ku4r';
const NUM_AGENTS = 30;

// Reservation status mix for realistic coverage
const STATUS_DISTRIBUTION: Array<{ status: string; count: number }> = [
  { status: 'INQUIRY', count: 5 },
  { status: 'CONFIRMED', count: 8 },
  { status: 'CHECKED_IN', count: 10 },
  { status: 'CHECKED_OUT', count: 4 },
  { status: 'CANCELLED', count: 3 },
];

// Channel mix
const CHANNELS = ['AIRBNB', 'BOOKING', 'WHATSAPP', 'DIRECT'];

// Guest name templates (Arabic + English mix)
const GUEST_NAMES = [
  'Ahmed Al-Rashid', 'Fatima Hassan', 'Mohamed Saeed', 'Layla Ibrahim',
  'Omar Khalil', 'Nour El-Din', 'Sara Mansour', 'Youssef Abdel-Aziz',
  'Hana Mostafa', 'Karim Farouk', 'Dina Salah', 'Tarek Nabil',
  'Mona Adel', 'Ali Mahmoud', 'Rania Gamal', 'Khaled Hamdi',
  'Amal Sherif', 'Bassem Tawfik', 'Noha Amin', 'Walid Osman',
  'Samira Fathy', 'Hassan Reda', 'Mariam Lotfy', 'Ehab Darwish',
  'Yasmin Helmy', 'Amr Shawky', 'Rana Fouad', 'Magdy Sami',
  'Lina Badr', 'Tamer Wagdy',
];

async function main() {
  console.log('=== Battle Test Setup ===\n');

  // Load harvested data
  const dataPath = path.join(__dirname, 'battle-test-data.json');
  if (!fs.existsSync(dataPath)) {
    console.error('ERROR: battle-test-data.json not found. Run harvest.ts first.');
    process.exit(1);
  }
  const harvestedConversations = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  console.log(`Loaded ${harvestedConversations.length} harvested conversations`);

  // Get available properties
  const properties = await prisma.property.findMany({
    where: { tenantId: TENANT_ID },
    select: { id: true, name: true, hostawayListingId: true },
  });
  console.log(`Found ${properties.length} properties\n`);

  // Build status assignments
  const statusAssignments: string[] = [];
  for (const { status, count } of STATUS_DISTRIBUTION) {
    for (let i = 0; i < count; i++) statusAssignments.push(status);
  }

  // Distribute harvested conversations across agents (~3-4 each)
  const convsPerAgent = Math.ceil(harvestedConversations.length / NUM_AGENTS);

  const agentConfigs: any[] = [];

  for (let i = 0; i < NUM_AGENTS; i++) {
    const agentNum = String(i + 1).padStart(2, '0');
    const guestName = GUEST_NAMES[i] || `Test Guest ${agentNum}`;
    const status = statusAssignments[i] || 'CONFIRMED';
    const channel = CHANNELS[i % CHANNELS.length] as any;
    const property = properties[i % properties.length];

    // Check-in/check-out dates for realistic stays
    const checkInOffset = Math.floor(Math.random() * 5) - 2; // -2 to +2 days from today
    const stayLength = 7 + Math.floor(Math.random() * 7); // 7-14 days
    const checkIn = new Date();
    checkIn.setDate(checkIn.getDate() + checkInOffset);
    const checkOut = new Date(checkIn);
    checkOut.setDate(checkOut.getDate() + stayLength);

    const guestCount = 1 + Math.floor(Math.random() * 4); // 1-4 guests

    // Create Guest
    const guest = await prisma.guest.create({
      data: {
        tenantId: TENANT_ID,
        hostawayGuestId: `battle-test-${agentNum}`,
        name: `[TEST] ${guestName}`,
        email: `test-${agentNum}@battle-test.local`,
        phone: `+20100000${agentNum}`,
        nationality: 'EG',
      },
    });

    // Create Reservation
    const reservation = await prisma.reservation.create({
      data: {
        tenantId: TENANT_ID,
        propertyId: property.id,
        guestId: guest.id,
        hostawayReservationId: `battle-test-${agentNum}`,
        checkIn: checkIn,
        checkOut: checkOut,
        guestCount,
        status: status as any,
        channel: channel,
        aiEnabled: true,
        aiMode: 'autopilot',
      },
    });

    // Create Conversation
    const conversation = await prisma.conversation.create({
      data: {
        tenantId: TENANT_ID,
        reservationId: reservation.id,
        guestId: guest.id,
        propertyId: property.id,
        channel: channel,
        status: 'OPEN',
        hostawayConversationId: `battle-test-conv-${agentNum}`,
        lastMessageAt: new Date(),
      },
    });

    // Assign harvested conversations for study
    const startIdx = i * convsPerAgent;
    const assignedConversations = harvestedConversations.slice(startIdx, startIdx + convsPerAgent);

    agentConfigs.push({
      agentId: agentNum,
      guestName: `[TEST] ${guestName}`,
      conversationId: conversation.id,
      reservationId: reservation.id,
      guestId: guest.id,
      propertyId: property.id,
      propertyName: property.name,
      reservationStatus: status,
      channel,
      checkIn: checkIn.toISOString().split('T')[0],
      checkOut: checkOut.toISOString().split('T')[0],
      guestCount,
      assignedConversations: assignedConversations.map((c: any) => ({
        guestName: c.guestName,
        status: c.status,
        channel: c.channel,
        messages: c.messages,
        guestMessageCount: c.guestMessageCount,
      })),
    });

    console.log(`Agent ${agentNum}: ${guestName} | ${status} | ${channel} | ${property.name} | ${stayLength}-day stay | ${assignedConversations.length} real convos`);
  }

  // Save agent configs
  const configPath = path.join(__dirname, 'agent-configs.json');
  fs.writeFileSync(configPath, JSON.stringify(agentConfigs, null, 2));
  console.log(`\nSaved agent configs to ${configPath}`);

  // Summary
  console.log('\n=== Setup Complete ===');
  console.log(`Created ${NUM_AGENTS} test conversations`);
  console.log('Status distribution:', JSON.stringify(
    agentConfigs.reduce((acc: any, c: any) => {
      acc[c.reservationStatus] = (acc[c.reservationStatus] || 0) + 1;
      return acc;
    }, {}),
  ));

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('Setup failed:', err);
  await prisma.$disconnect();
  process.exit(1);
});
