// Probe script — dump what Hostaway actually has for conversation 42659360
// and its underlying reservation. Usage: npx ts-node scripts/probe-hostaway-conv.ts
import { PrismaClient } from '@prisma/client';
import {
  getConversation,
  listConversationMessages,
  getReservation,
} from '../src/services/hostaway.service';

const HOSTAWAY_CONV_ID = '42659360';

async function main() {
  const prisma = new PrismaClient();
  try {
    // Find the local conversation + tenant to get Hostaway creds.
    const conv = await prisma.conversation.findFirst({
      where: { hostawayConversationId: HOSTAWAY_CONV_ID },
      include: {
        tenant: { select: { id: true, hostawayAccountId: true, hostawayApiKey: true } },
        guest: true,
        reservation: true,
        messages: { orderBy: { sentAt: 'asc' }, select: { id: true, role: true, content: true, sentAt: true } },
      },
    });

    if (!conv) {
      console.log(`No local conversation found for hostawayConversationId=${HOSTAWAY_CONV_ID}`);
      return;
    }

    console.log('── Local DB record ──');
    console.log('convId:', conv.id);
    console.log('tenantId:', conv.tenantId);
    console.log('status:', conv.status);
    console.log('channel:', conv.channel);
    console.log('guest.name:', conv.guest?.name);
    console.log('guest.email:', conv.guest?.email);
    console.log('guest.phone:', conv.guest?.phone);
    console.log('reservation.id:', conv.reservation?.id);
    console.log('reservation.hostawayReservationId:', conv.reservation?.hostawayReservationId);
    console.log('reservation.status:', conv.reservation?.status);
    console.log('reservation.checkIn:', conv.reservation?.checkIn);
    console.log('reservation.checkOut:', conv.reservation?.checkOut);
    console.log('messages.count:', conv.messages.length);

    const accountId = conv.tenant.hostawayAccountId;
    const apiKey = conv.tenant.hostawayApiKey;
    if (!accountId || !apiKey) {
      console.log('Tenant has no Hostaway creds — cannot probe Hostaway.');
      return;
    }

    console.log('\n── Hostaway: getConversation ──');
    try {
      const hConv = await getConversation(accountId, apiKey, HOSTAWAY_CONV_ID);
      console.log(JSON.stringify(hConv, null, 2).slice(0, 4000));
    } catch (err: any) {
      console.log('getConversation failed:', err.message);
    }

    console.log('\n── Hostaway: listConversationMessages ──');
    try {
      const hMsgs = await listConversationMessages(accountId, apiKey, HOSTAWAY_CONV_ID);
      console.log('count:', Array.isArray(hMsgs) ? hMsgs.length : 'n/a');
      console.log(JSON.stringify(hMsgs, null, 2).slice(0, 2000));
    } catch (err: any) {
      console.log('listConversationMessages failed:', err.message);
    }

    if (conv.reservation?.hostawayReservationId) {
      console.log('\n── Hostaway: getReservation ──');
      try {
        const hRes = await getReservation(accountId, apiKey, conv.reservation.hostawayReservationId);
        console.log(JSON.stringify(hRes, null, 2).slice(0, 4000));
      } catch (err: any) {
        console.log('getReservation failed:', err.message);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(err => {
  console.error('probe failed:', err);
  process.exit(1);
});
