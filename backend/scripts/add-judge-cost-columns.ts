/**
 * One-time migration: add judgeCost columns to ClassifierEvaluation.
 * Run with: npx ts-node scripts/add-judge-cost-columns.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Adding judge cost columns to ClassifierEvaluation...');

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "ClassifierEvaluation"
    ADD COLUMN IF NOT EXISTS "judgeInputTokens"  INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "judgeOutputTokens" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "judgeCost"         DOUBLE PRECISION NOT NULL DEFAULT 0
  `);

  console.log('Done.');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
