import * as dotenv from 'dotenv'; dotenv.config();
import { PrismaClient } from '@prisma/client';
async function main() {
  const p = new PrismaClient();
  const rows = await p.tuningEditQueue.findMany({ orderBy: { createdAt: 'desc' }, take: 10 });
  for (const r of rows) {
    console.log(r.id, r.status, r.createdAt.toISOString(), 'edited:', r.editedText.slice(0, 60));
  }
  await p.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
