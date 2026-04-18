/**
 * One-off diagnostic: print the raw Hostaway reservation payload for a given
 * guest name / hostaway conversation id. Used to confirm what channelName /
 * channelId Hostaway actually returns for an Airbnb reservation that shows up
 * as "Other" in our UI.
 *
 *   npx ts-node scripts/debug-hostaway-reservation.ts
 *
 * Configure via env or edit the constants below.
 */

import { PrismaClient } from '@prisma/client';
import { getReservation } from '../src/services/hostaway.service';
import { mapHostawayChannel } from '../src/lib/channel-mapper';

const TENANT_ID = process.env.DEBUG_TENANT_ID || 'cmmth6d1r000a6bhlkb75ku4r';
const HOSTAWAY_CONV_ID = process.env.DEBUG_HOSTAWAY_CONV_ID || '42843471';
const GUEST_NAME_CONTAINS = process.env.DEBUG_GUEST_NAME || 'Azam';

async function main() {
  const prisma = new PrismaClient();

  const tenant = await prisma.tenant.findUnique({
    where: { id: TENANT_ID },
    select: { id: true, name: true, hostawayAccountId: true, hostawayApiKey: true },
  });
  if (!tenant?.hostawayAccountId || !tenant?.hostawayApiKey) {
    console.error(`Tenant ${TENANT_ID} missing Hostaway creds`);
    process.exit(1);
  }
  console.log(`Tenant: ${tenant.name} (${tenant.id})`);

  // Find the reservation via Hostaway conv id OR guest name match
  const byConv = await prisma.conversation.findFirst({
    where: { tenantId: TENANT_ID, hostawayConversationId: HOSTAWAY_CONV_ID },
    include: { reservation: true, guest: true },
  });
  const byName = byConv
    ? null
    : await prisma.reservation.findFirst({
        where: { tenantId: TENANT_ID, guest: { name: { contains: GUEST_NAME_CONTAINS } } },
        include: { guest: true },
      });

  const hwResId = byConv?.reservation?.hostawayReservationId ?? byName?.hostawayReservationId;
  if (!hwResId) {
    console.error(`Could not resolve a Hostaway reservation id for conv=${HOSTAWAY_CONV_ID} / name~=${GUEST_NAME_CONTAINS}`);
    process.exit(2);
  }

  const dbChannel = byConv?.reservation?.channel ?? byName?.channel;
  const guestName = byConv?.guest?.name ?? byName?.guest?.name;
  console.log(`DB: hostawayReservationId=${hwResId} channel=${dbChannel} guest="${guestName}"`);

  console.log(`\nFetching raw reservation from Hostaway...`);
  const { result } = await getReservation(tenant.hostawayAccountId, tenant.hostawayApiKey, hwResId);

  const keysOfInterest = [
    'id', 'channelId', 'channelName', 'source', 'reservationSource',
    'integrationName', 'integrationId', 'channel', 'platform',
    'status', 'guestName', 'guestPhone', 'phone',
    'guestEmail', 'guestCountry',
    'guestFirstName', 'guestLastName',
    'arrivalDate', 'departureDate',
  ];
  console.log(`\nKeys of interest:`);
  for (const k of keysOfInterest) {
    if (k in (result as any)) {
      console.log(`  ${k} = ${JSON.stringify((result as any)[k])}`);
    }
  }

  console.log(`\nMapped by our helper: ${mapHostawayChannel((result as any).channelName, (result as any).channelId)}`);

  console.log(`\nAll top-level keys present on payload:`);
  console.log('  ' + Object.keys(result as any).sort().join(', '));

  await prisma.$disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(99);
});
