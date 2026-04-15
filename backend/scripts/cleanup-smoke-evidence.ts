/**
 * Sprint 05 §9 (concern C15) — clean stale smoke EvidenceBundle rows.
 *
 * Scope: rows produced by `scripts/smoke-diagnostic.ts`. Those rows are
 * identifiable two ways:
 *   (a) `payload->'trigger'->>'note'` equals 'sprint-02 smoke-diagnostic'
 *       (the historic note from sprint 02's smoke runs)
 *   (b) `payload->'trigger'->>'note'` starts with 'integration-' or
 *       'sprint-' (covers sprint 05's diagnostic re-runs against Railway)
 *
 * Also drops any TuningSuggestion + CapabilityRequest rows whose
 * diagnosticSubLabel / title is prefixed with 'smoke-' (the sub-label
 * convention the smoke script stamps).
 *
 * Usage:
 *   npx tsx scripts/cleanup-smoke-evidence.ts [--dry-run]
 *
 * Always read-only counts first; only destructive when --apply is passed.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaClient();
  try {
    // Counts first — read-only audit.
    const smokeBundles: Array<{ id: string; note: string | null; createdAt: Date }> =
      await prisma.$queryRawUnsafe(`
        SELECT id, payload->'trigger'->>'note' as note, "createdAt"
        FROM "EvidenceBundle"
        WHERE payload->'trigger'->>'note' = 'sprint-02 smoke-diagnostic'
           OR payload->'trigger'->>'note' LIKE 'integration-%'
           OR payload->'trigger'->>'note' LIKE 'sprint-%'
        ORDER BY "createdAt" DESC
      `);

    const smokeSuggestions = await prisma.tuningSuggestion.findMany({
      where: { diagnosticSubLabel: { startsWith: 'smoke-' } },
      select: { id: true, diagnosticSubLabel: true, createdAt: true },
    });

    const smokeCaps = await prisma.capabilityRequest.findMany({
      where: { title: { startsWith: 'smoke-' } },
      select: { id: true, title: true, createdAt: true },
    });

    console.log(JSON.stringify({
      stage: 'audit',
      smokeEvidenceBundles: smokeBundles.length,
      smokeTuningSuggestions: smokeSuggestions.length,
      smokeCapabilityRequests: smokeCaps.length,
      sample: smokeBundles.slice(0, 5),
    }, null, 2));

    if (!apply) {
      console.log('\n[DRY RUN] Pass --apply to delete the rows listed above.');
      return;
    }

    // Suggestions first (FK references to EvidenceBundle would set null on cascade
    // but cleaner to drop them in this order).
    const suggDel = await prisma.tuningSuggestion.deleteMany({
      where: { diagnosticSubLabel: { startsWith: 'smoke-' } },
    });
    const capDel = await prisma.capabilityRequest.deleteMany({
      where: { title: { startsWith: 'smoke-' } },
    });
    const bundleIds = smokeBundles.map(b => b.id);
    const bundleDel = bundleIds.length
      ? await prisma.evidenceBundle.deleteMany({ where: { id: { in: bundleIds } } })
      : { count: 0 };

    console.log(JSON.stringify({
      stage: 'apply',
      deletedTuningSuggestions: suggDel.count,
      deletedCapabilityRequests: capDel.count,
      deletedEvidenceBundles: bundleDel.count,
    }, null, 2));
  } catch (err) {
    console.error('[cleanup-smoke-evidence] failed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
