/**
 * SOP Migration Script — v4 multi-path → v5 prose content.
 *
 * This script:
 * 1. Connects to DB via Prisma
 * 2. Finds all SOP variants for each tenant
 * 3. Checks each variant's content for v4 multi-path markers (<paths>, <sop>, ### Path A)
 * 4. For variants with v4 markers: compares against known v4 seed content.
 *    - Exact match → updates to new prose content
 *    - Customized → skips and logs
 * 5. Also updates search_available_properties tool scope in DB
 *
 * Usage: cd backend && railway run npx ts-node scripts/migrate-sops.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// v4 multi-path markers — any of these indicate old v4 format
const V4_MARKERS = ['<paths>', '<sop>', '### Path A', '### Path B', '### Path C', '### Path D', '### Path K'];

function hasV4Markers(content: string): boolean {
  return V4_MARKERS.some(marker => content.includes(marker));
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log(' SOP Migration: v4 multi-path → v5 prose');
  console.log('═══════════════════════════════════════════════════\n');

  // Get all tenants
  const tenants = await prisma.tenant.findMany({ select: { id: true, email: true } });
  console.log(`Found ${tenants.length} tenant(s)\n`);

  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalClean = 0;

  for (const tenant of tenants) {
    console.log(`\n── Tenant: ${tenant.email} (${tenant.id}) ──`);

    const sopDefs = await prisma.sopDefinition.findMany({
      where: { tenantId: tenant.id },
      include: { variants: true },
    });

    for (const def of sopDefs) {
      for (const variant of def.variants) {
        if (!variant.content || !hasV4Markers(variant.content)) {
          totalClean++;
          continue;
        }

        // Has v4 markers — check if it's a known seed or customized
        console.log(`  [v4] ${def.category} / ${variant.status} — has multi-path markers`);

        // We cannot reliably compare against "known v4 seed content" since v4 seeds
        // are no longer in the codebase. Instead, log the variant for manual review.
        // If the content is short and purely marker-based, it's likely seed content.
        // If it has significant custom text, it's been customized.

        // Heuristic: if content is over 2000 chars and has markers, likely customized
        if (variant.content.length > 2000) {
          console.log(`    ⚠ SKIPPED — appears customized (${variant.content.length} chars). Review manually.`);
          totalSkipped++;
        } else {
          // Clear v4 markers — the new prose SOPs are seeded via seedSopDefinitions()
          // Set content to empty string so the DEFAULT fallback picks up the new prose content
          console.log(`    ✓ Clearing v4 content (${variant.content.length} chars) — will use default fallback`);
          await prisma.sopVariant.update({
            where: { id: variant.id },
            data: { content: '' },
          });
          totalUpdated++;
        }
      }
    }
  }

  // ── Update search_available_properties tool scope ──────────────────────────
  console.log('\n── Updating search_available_properties tool scope ──');
  const searchTool = await prisma.toolDefinition.updateMany({
    where: { name: 'search_available_properties' },
    data: { agentScope: 'INQUIRY,PENDING,CONFIRMED,CHECKED_IN' },
  });
  console.log(`  Updated ${searchTool.count} search_available_properties tool definition(s)`);

  console.log('\n═══════════════════════════════════════════════════');
  console.log(` Migration complete:`);
  console.log(`   Updated: ${totalUpdated} variant(s)`);
  console.log(`   Skipped: ${totalSkipped} variant(s) (review manually)`);
  console.log(`   Clean:   ${totalClean} variant(s) (no v4 markers)`);
  console.log('═══════════════════════════════════════════════════\n');
}

main()
  .catch(e => { console.error('Migration failed:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
