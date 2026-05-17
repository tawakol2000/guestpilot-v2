import * as dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';

async function main() {
  const p = new PrismaClient();
  const r = await p.tuningEditQueue.deleteMany({ where: { sourceMessageId: { startsWith: 'test-' } } });
  console.log('Deleted', r.count, 'test rows');
  await p.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
