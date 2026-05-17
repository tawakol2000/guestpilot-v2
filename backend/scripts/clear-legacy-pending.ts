/**
 * Clears legacy PENDING tuning suggestions and legacy queue rows for one
 * tenant. Run once after a major UX restructure to start from a clean slate.
 */
import * as dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';

async function main() {
  const p = new PrismaClient();
  const TENANT_ID = process.env.TENANT_ID || 'cmoaaynmt00001mjy7zqnb8pz';

  const sugg = await p.tuningSuggestion.deleteMany({
    where: { tenantId: TENANT_ID, status: 'PENDING' },
  });
  console.log(`Deleted ${sugg.count} legacy PENDING TuningSuggestion rows.`);

  const queue = await p.tuningEditQueue.deleteMany({
    where: { tenantId: TENANT_ID, status: 'SKIPPED_COOLDOWN' },
  });
  console.log(`Deleted ${queue.count} legacy SKIPPED_COOLDOWN queue rows.`);

  await p.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
