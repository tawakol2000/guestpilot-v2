import * as dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';

async function main() {
  const p = new PrismaClient();
  const TENANT_ID = 'cmoaaynmt00001mjy7zqnb8pz';

  await p.tuningEditQueue.deleteMany({
    where: { tenantId: TENANT_ID, sourceMessageId: { startsWith: 'test-' } },
  });

  const pending = await p.tuningEditQueue.create({
    data: {
      tenantId: TENANT_ID,
      sourceMessageId: 'test-pending-' + Date.now(),
      originalText:
        "Hi Haitham, what is your nationality and who will be joining you? Please confirm so I can check eligibility.",
      editedText: "Hi Haitham, whats your nationality?",
      similarity: 0.55,
      triggerType: 'EDIT_TRIGGERED',
      channel: 'AIRBNB',
      preClassifierCategory: 'SYSTEM_PROMPT',
      preClassifierConfidence: 0.92,
      preClassifierRationale: 'Trims explanatory clause; voice/style edit.',
      preClassifierModel: 'gpt-5.4-mini-2026-03-17',
      status: 'PENDING',
    },
  });

  const polish = await p.tuningEditQueue.create({
    data: {
      tenantId: TENANT_ID,
      sourceMessageId: 'test-polish-' + Date.now(),
      originalText: "you're welcome — let me know if anything else comes up.",
      editedText: "You're welcome — let me know if anything else comes up.",
      similarity: 1.0,
      triggerType: 'EDIT_TRIGGERED',
      channel: 'AIRBNB',
      preClassifierCategory: 'NO_FIX',
      preClassifierConfidence: 0.99,
      preClassifierRationale: 'Capitalisation only; no factual change.',
      preClassifierModel: 'gpt-5.4-mini-2026-03-17',
      status: 'SKIPPED_NO_FIX',
      skipReason: 'NO_FIX (conf=0.99): Capitalisation only.',
      analyzedAt: new Date(Date.now() - 10 * 60 * 1000),
    },
  });

  console.log('Seeded pending:', pending.id);
  console.log('Seeded polish:', polish.id);
  await p.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
