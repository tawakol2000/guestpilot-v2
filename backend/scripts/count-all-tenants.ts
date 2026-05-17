import * as dotenv from 'dotenv'; dotenv.config();
import { PrismaClient } from '@prisma/client';
async function main() {
  const p = new PrismaClient();
  const byTenant = await p.tuningSuggestion.groupBy({
    by: ['tenantId'],
    _count: true,
    orderBy: { _count: { tenantId: 'desc' } },
  });
  for (const r of byTenant) {
    const t = await p.tenant.findUnique({ where: { id: r.tenantId }, select: { email: true } });
    console.log(`${r._count} rows · tenant=${r.tenantId} · email=${t?.email || '?'}`);
  }
  await p.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
