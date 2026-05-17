import * as dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const TENANT_ID = 'cmoaaynmt00001mjy7zqnb8pz';
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000);
  console.log('since:', since.toISOString());

  const all = await prisma.tuningSuggestion.findMany({
    where: {
      tenantId: TENANT_ID,
      diagnosticCategory: 'SYSTEM_PROMPT',
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      createdAt: true,
      appliedAt: true,
      status: true,
      diagnosticCategory: true,
      systemPromptVariant: true,
    },
  });
  for (const r of all) {
    console.log(r.id, 'created:', r.createdAt.toISOString(),
      'applied:', r.appliedAt?.toISOString() ?? 'null',
      'status:', r.status,
      'variant:', r.systemPromptVariant);
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
