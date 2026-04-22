import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
async function main() {
  const msgs = await p.tuningMessage.findMany({
    where: { conversation: { title: 'Studio Kitchen Sink Demo' } },
    select: { parts: true },
  });
  for (const m of msgs) {
    const ps = m.parts as any[];
    for (const part of ps) {
      if (part.type === 'data-build-plan') {
        console.log('data-build-plan:', JSON.stringify(part.data, null, 2));
      }
    }
  }
  await p.$disconnect();
}
main();
