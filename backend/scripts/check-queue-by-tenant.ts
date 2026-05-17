import * as dotenv from 'dotenv'; dotenv.config();
import { PrismaClient } from '@prisma/client';
async function main() {
  const p = new PrismaClient();
  const TENANT_ID = 'cmoaaynmt00001mjy7zqnb8pz';
  const rows = await p.tuningEditQueue.findMany({ where: { tenantId: TENANT_ID }, orderBy: { createdAt: 'desc' }, take: 10 });
  console.log(`Found ${rows.length} rows for tenant ${TENANT_ID}`);
  for (const r of rows) {
    console.log(r.id, r.status, 'tenant:', r.tenantId, 'edited:', r.editedText.slice(0, 60));
  }
  await p.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
