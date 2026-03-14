/**
 * One-time migration: add judgeThreshold and autoFixThreshold to TenantAiConfig.
 * Run with: npx ts-node scripts/add-threshold-columns.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Adding threshold columns to TenantAiConfig...');

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "TenantAiConfig"
    ADD COLUMN IF NOT EXISTS "judgeThreshold"   DOUBLE PRECISION NOT NULL DEFAULT 0.75,
    ADD COLUMN IF NOT EXISTS "autoFixThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.70
  `);

  console.log('Done.');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
