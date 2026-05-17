import * as dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const recentEditedMessages = await prisma.message.findMany({
    where: {
      role: 'AI',
      editedByUserId: { not: null },
      originalAiText: { not: null },
    },
    orderBy: { sentAt: 'desc' },
    take: 20,
    select: {
      id: true,
      sentAt: true,
      tenantId: true,
      content: true,
      originalAiText: true,
      channel: true,
      conversationId: true,
    },
  });
  for (const m of recentEditedMessages) {
    console.log('---');
    console.log('id:', m.id, 'at:', m.sentAt?.toISOString() ?? '(unsent)');
    console.log('tenant:', m.tenantId, 'channel:', m.channel);
    console.log('ORIGINAL:', JSON.stringify(m.originalAiText));
    console.log('FINAL   :', JSON.stringify(m.content));
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
