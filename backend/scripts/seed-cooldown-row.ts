import * as dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';

async function main() {
  const p = new PrismaClient();
  const TENANT_ID = 'cmoaaynmt00001mjy7zqnb8pz';
  await p.tuningEditQueue.deleteMany({
    where: { tenantId: TENANT_ID, sourceMessageId: { startsWith: 'test-' } },
  });

  const r = await p.tuningEditQueue.create({
    data: {
      tenantId: TENANT_ID,
      sourceMessageId: 'test-cooldown-' + Date.now(),
      originalText:
        "Hi Haitham, what is your nationality and who will be joining you? Please confirm so I can check eligibility.",
      editedText: "Hi Haitham, whats your nationality?",
      similarity: 0.55,
      triggerType: 'EDIT_TRIGGERED',
      channel: 'AIRBNB',
      preClassifierCategory: 'SYSTEM_PROMPT',
      preClassifierConfidence: 0.92,
      preClassifierRationale: 'Trims explanatory clause; voice/style edit, not content.',
      preClassifierModel: 'gpt-5.4-mini-2026-03-17',
      status: 'SKIPPED_COOLDOWN',
      skipReason:
        'pre-classifier: SYSTEM_PROMPT (conf=0.92) — SYSTEM_PROMPT/coordinator accepted at 2026-05-17T07:53:18.838Z (within 48h cooldown)',
      analyzedAt: new Date(Date.now() - 2 * 60 * 1000),
    },
  });
  console.log('Seeded:', r.id);
  await p.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
