import * as dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';

async function main() {
  const p = new PrismaClient();
  const TENANT_ID = 'cmoaaynmt00001mjy7zqnb8pz';
  const total = await p.tuningSuggestion.count({ where: { tenantId: TENANT_ID } });
  console.log('Total TuningSuggestion rows for', TENANT_ID, ':', total);
  const byStatus = await p.tuningSuggestion.groupBy({
    by: ['status'],
    where: { tenantId: TENANT_ID },
    _count: true,
  });
  console.log('By status:', byStatus);
  await p.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
