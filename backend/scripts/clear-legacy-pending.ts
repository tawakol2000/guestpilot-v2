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

  // 2026-05-17: operator wanted ALL legacy TuningSuggestion rows gone, not
  // just PENDING. Wipes the whole list for the tenant so the panel starts
  // fresh. Accepted/rejected history is also discarded — the operator
  // accepted that tradeoff explicitly.
  const sugg = await p.tuningSuggestion.deleteMany({
    where: { tenantId: TENANT_ID },
  });
  console.log(`Deleted ${sugg.count} TuningSuggestion rows.`);

  const queue = await p.tuningEditQueue.deleteMany({
    where: { tenantId: TENANT_ID, status: 'SKIPPED_COOLDOWN' },
  });
  console.log(`Deleted ${queue.count} legacy SKIPPED_COOLDOWN queue rows.`);

  await p.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
