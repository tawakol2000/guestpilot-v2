/**
 * FAQ Maintenance Job — Runs daily to mark stale entries and expire old suggestions.
 */
import { PrismaClient } from '@prisma/client';
import { markStaleFaqEntries, expireStaleSuggestions } from '../services/faq.service';

export function startFaqMaintenanceJob(prisma: PrismaClient): NodeJS.Timeout {
  console.log('[FAQ] Maintenance job started (interval: 24h)');

  // 2026-05-15 M9: track + clear the startup setTimeout on shutdown.
  // Previously: a SIGTERM in the first 60s after boot (rapid Railway
  // deploys) would let the setTimeout fire after Prisma had been
  // disconnected, producing an unhandled rejection from inside
  // runMaintenance. `unref()` lets the process exit while waiting on
  // this timer; the matching interval below is what server.ts clears.
  const startupHandle = setTimeout(async () => {
    await runMaintenance(prisma);
  }, 60_000);
  if (typeof startupHandle.unref === 'function') startupHandle.unref();

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
