import * as dotenv from 'dotenv'; dotenv.config();
import { PrismaClient } from '@prisma/client';
async function main() {
  const p = new PrismaClient();
  const r = await p.tuningEditQueue.findFirst({ orderBy: { createdAt: 'desc' } });
  console.log('Row tenant:', r?.tenantId);
  console.log('Local logged-in tenant: cmoaaynmt00001mjy7zqnb8pz');
  await p.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
