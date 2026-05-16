/**
 * merge-sop-variants.ts — one-shot migration to the 2026-05-16 single-body SOP model.
 *
 * Before:  SopDefinition → SopVariant rows per status (DEFAULT/INQUIRY/CONFIRMED/CHECKED_IN)
 *          getSopContent() picked the row matching the live reservation status.
 *
 * After:   SopDefinition → exactly ONE SopVariant row, status='DEFAULT'.
 *          The body embeds inline `### When booking is X` subsections where
 *          guidance differs by status. The AI gets the merged body plus a
 *          preamble naming the current status, and reads the matching section.
 *
 * What this script does, per tenant:
 *   1. Group every SopVariant by (sopDefinitionId).
 *   2. If the definition already has a DEFAULT body containing
 *      "### When booking is" — skip (idempotent; already merged).
 *   3. Else, build a merged body:
 *        <DEFAULT body, if any, as the unsectioned preamble>
 *
 *        ### When booking is INQUIRY
 *        <INQUIRY body if present>
 *
 *        ### When booking is CONFIRMED
 *        <CONFIRMED body if present>
 *
 *        ### When booking is CHECKED_IN
 *        <CHECKED_IN body if present>
 *
 *      Skip any status whose body is empty or whitespace-only.
 *      Skip the whole merge if only DEFAULT exists (nothing to merge).
 *   4. Upsert DEFAULT variant with the merged body.
 *   5. Delete the non-DEFAULT variant rows.
 *   6. Same logic for SopPropertyOverride (per propertyId).
 *
 * Cache invalidation: clears the in-process SOP cache for each touched tenant.
 *
 * Usage:
 *   cd backend
 *   npx tsx scripts/merge-sop-variants.ts                # all tenants, dry-run
 *   npx tsx scripts/merge-sop-variants.ts --apply        # all tenants, write changes
 *   npx tsx scripts/merge-sop-variants.ts --tenant cmXYZ # one tenant, dry-run
 *   npx tsx scripts/merge-sop-variants.ts --tenant cmXYZ --apply
 */
import { PrismaClient } from '@prisma/client';
import { invalidateSopCache } from '../src/services/sop.service';

type Row = { id: string; status: string; content: string; enabled: boolean };

const STATUS_ORDER = ['INQUIRY', 'CONFIRMED', 'CHECKED_IN'] as const;

function alreadyMerged(content: string): boolean {
  return /^###\s+When booking is\s+/m.test(content);
}

function buildMergedBody(rows: Row[]): { body: string; touched: boolean } {
  const byStatus = new Map<string, Row>();
  for (const r of rows) byStatus.set(r.status, r);

  const def = byStatus.get('DEFAULT');
  const hasNonDefault = STATUS_ORDER.some((s) => {
    const r = byStatus.get(s);
    return r && r.enabled && r.content.trim().length > 0;
  });
  if (!hasNonDefault) {
    // Only a DEFAULT (or nothing). Nothing to merge.
    return { body: def?.content ?? '', touched: false };
  }

  const parts: string[] = [];
  if (def && def.enabled && def.content.trim().length > 0) {
    parts.push(def.content.trim());
  }
  for (const s of STATUS_ORDER) {
    const r = byStatus.get(s);
    if (!r || !r.enabled) continue;
    const body = r.content.trim();
    if (!body) continue;
    parts.push(`### When booking is ${s}\n${body}`);
  }
  return { body: parts.join('\n\n'), touched: true };
}

async function migrateTenant(prisma: PrismaClient, tenantId: string, apply: boolean): Promise<void> {
  const defs = await prisma.sopDefinition.findMany({
    where: { tenantId },
    include: { variants: true, propertyOverrides: true },
    orderBy: { category: 'asc' },
  });

  let mergedVariants = 0;
  let mergedOverrides = 0;
  let skippedAlreadyMerged = 0;

  for (const def of defs) {
    // ── Global variants ──────────────────────────────────────────
    const defaultVariant = def.variants.find((v) => v.status === 'DEFAULT');
    if (defaultVariant && alreadyMerged(defaultVariant.content)) {
      // Already migrated; just clean up any stray status-specific rows.
      const stale = def.variants.filter((v) => v.status !== 'DEFAULT');
      if (stale.length > 0) {
        console.log(
          `[merge] ${tenantId} / ${def.category}: DEFAULT already merged; ` +
            `deleting ${stale.length} stale status variant(s) [${stale.map((s) => s.status).join(', ')}]`,
        );
        if (apply) {
          await prisma.sopVariant.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
        }
      }
      skippedAlreadyMerged++;
    } else {
      const { body, touched } = buildMergedBody(def.variants);
      if (touched) {
        console.log(`[merge] ${tenantId} / ${def.category}: merging ${def.variants.length} variant(s) → DEFAULT`);
        if (apply) {
          await prisma.sopVariant.upsert({
            where: { sopDefinitionId_status: { sopDefinitionId: def.id, status: 'DEFAULT' } },
            create: { sopDefinitionId: def.id, status: 'DEFAULT', content: body, enabled: true },
            update: { content: body, enabled: true },
          });
          const staleIds = def.variants.filter((v) => v.status !== 'DEFAULT').map((v) => v.id);
          if (staleIds.length > 0) {
            await prisma.sopVariant.deleteMany({ where: { id: { in: staleIds } } });
          }
        }
        mergedVariants++;
      }
    }

    // ── Property overrides — group by propertyId ────────────────
    const byProp = new Map<string, Row[]>();
    for (const o of def.propertyOverrides) {
      const list = byProp.get(o.propertyId) ?? [];
      list.push({ id: o.id, status: o.status, content: o.content, enabled: o.enabled });
      byProp.set(o.propertyId, list);
    }
    for (const [propertyId, rows] of byProp) {
      const defRow = rows.find((r) => r.status === 'DEFAULT');
      if (defRow && alreadyMerged(defRow.content)) {
        const stale = rows.filter((r) => r.status !== 'DEFAULT');
        if (stale.length > 0 && apply) {
          await prisma.sopPropertyOverride.deleteMany({
            where: { id: { in: stale.map((s) => s.id) } },
          });
        }
        continue;
      }
      const { body, touched } = buildMergedBody(rows);
      if (!touched) continue;
      console.log(
        `[merge] ${tenantId} / ${def.category} / prop=${propertyId}: ` +
          `merging ${rows.length} override(s) → DEFAULT`,
      );
      if (apply) {
        await prisma.sopPropertyOverride.upsert({
          where: {
            sopDefinitionId_propertyId_status: {
              sopDefinitionId: def.id,
              propertyId,
              status: 'DEFAULT',
            },
          },
          create: {
            sopDefinitionId: def.id,
            propertyId,
            status: 'DEFAULT',
            content: body,
            enabled: true,
          },
          update: { content: body, enabled: true },
        });
        const staleIds = rows.filter((r) => r.status !== 'DEFAULT').map((r) => r.id);
        if (staleIds.length > 0) {
          await prisma.sopPropertyOverride.deleteMany({ where: { id: { in: staleIds } } });
        }
      }
      mergedOverrides++;
    }
  }

  if (apply) invalidateSopCache(tenantId);

  console.log(
    `[merge] tenant ${tenantId}: ${mergedVariants} variants merged, ` +
      `${mergedOverrides} property overrides merged, ${skippedAlreadyMerged} already-merged definitions` +
      (apply ? '' : '  (dry run — no writes)'),
  );
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const tenantIdx = args.indexOf('--tenant');
  const onlyTenant = tenantIdx >= 0 ? args[tenantIdx + 1] : null;

  const prisma = new PrismaClient();
  try {
    const tenants = onlyTenant
      ? [{ id: onlyTenant }]
      : await prisma.tenant.findMany({ select: { id: true }, orderBy: { id: 'asc' } });

    console.log(
      `[merge] ${apply ? 'APPLY mode — writes will be persisted' : 'DRY RUN — no writes'}; ` +
        `${tenants.length} tenant(s) to scan`,
    );

    for (const t of tenants) {
      await migrateTenant(prisma, t.id, apply);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[merge] FAILED:', err);
  process.exit(1);
});
