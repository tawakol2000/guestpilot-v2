/**
 * FAQ Maintenance Job — Runs daily to mark stale entries and expire old suggestions.
 */
import { PrismaClient } from '@prisma/client';
import { markStaleFaqEntries, expireStaleSuggestions } from '../services/faq.service';

export function startFaqMaintenanceJob(prisma: PrismaClient): NodeJS.Timeout {
  console.log('[FAQ] Maintenance job started (interval: 24h)');

  // Run once on startup (after 60s delay to let everything initialize)
  setTimeout(async () => {
    await runMaintenance(prisma);
  }, 60_000);

  // Then every 24 hours
  return setInterval(async () => {
    await runMaintenance(prisma);
  }, 24 * 60 * 60 * 1000);
}

async function runMaintenance(prisma: PrismaClient): Promise<void> {
  try {
    const tenants = await prisma.tenant.findMany({ select: { id: true } });
    let totalStale = 0;
    let totalExpired = 0;
    for (const tenant of tenants) {
      totalStale += await markStaleFaqEntries(prisma, tenant.id);
      totalExpired += await expireStaleSuggestions(prisma, tenant.id);
    }
    if (totalStale > 0 || totalExpired > 0) {
      console.log(`[FAQ] Maintenance: ${totalStale} marked stale, ${totalExpired} suggestions expired`);
    }
  } catch (err: any) {
    console.error('[FAQ] Maintenance job failed:', err.message);
  }
}
