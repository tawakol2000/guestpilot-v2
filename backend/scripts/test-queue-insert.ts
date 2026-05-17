import * as dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const TENANT_ID = 'cmoaaynmt00001mjy7zqnb8pz';

async function main() {
  // Clean up any prior test rows so the test is repeatable.
  await prisma.tuningEditQueue.deleteMany({
    where: { tenantId: TENANT_ID, sourceMessageId: { startsWith: 'test-' } },
  });

  // One PENDING row (manual mode mock)
  const pending = await prisma.tuningEditQueue.create({
    data: {
      tenantId: TENANT_ID,
      sourceMessageId: 'test-pending-' + Date.now(),
      originalText:
        "Thanks, Mohmoud — and who will be joining you for the 3 guests? Also please confirm your nationality so I can check eligibility.",
      editedText:
        "Thanks, Mohmoud — and who will be joining you for the 3 guests? Also please confirm your nationality.",
      similarity: 0.77,
      triggerType: 'EDIT_TRIGGERED',
      channel: 'AIRBNB',
      preClassifierCategory: 'SYSTEM_PROMPT',
      preClassifierConfidence: 0.97,
      preClassifierRationale: 'Removes self-justifying clause without changing the ask.',
      preClassifierModel: 'gpt-5.4-mini-2026-03-17',
      status: 'PENDING',
    },
  });

  // One historical row — ANALYZED with a suggestion link (NO_FIX skip)
  const analyzed1 = await prisma.tuningEditQueue.create({
    data: {
      tenantId: TENANT_ID,
      sourceMessageId: 'test-skipped-' + Date.now(),
      originalText: "you're welcome — let me know if anything else comes up during your stay.",
      editedText: "You're welcome — let me know if anything else comes up during your stay.",
      similarity: 1.0,
      triggerType: 'EDIT_TRIGGERED',
      channel: 'AIRBNB',
      preClassifierCategory: 'NO_FIX',
      preClassifierConfidence: 0.99,
      preClassifierRationale: 'Capitalisation polish; no factual change.',
      preClassifierModel: 'gpt-5.4-mini-2026-03-17',
      status: 'SKIPPED_NO_FIX',
      skipReason: 'NO_FIX (conf=0.99): Capitalisation polish; no factual change.',
      analyzedAt: new Date(Date.now() - 10 * 60 * 1000),
    },
  });

  // One FAILED row to test the danger state
  const failed = await prisma.tuningEditQueue.create({
    data: {
      tenantId: TENANT_ID,
      sourceMessageId: 'test-failed-' + Date.now(),
      originalText: "Check-in is at 2 PM.",
      editedText: "Check-in is at 11 AM.",
      similarity: 0.6,
      triggerType: 'EDIT_TRIGGERED',
      channel: 'AIRBNB',
      preClassifierCategory: 'SOP',
      preClassifierConfidence: 0.95,
      preClassifierRationale: 'Time value changed — factual SOP edit.',
      preClassifierModel: 'gpt-5.4-mini-2026-03-17',
      status: 'FAILED',
      errorMessage: 'OpenAI 503 after retries',
      analyzedAt: new Date(Date.now() - 60 * 60 * 1000),
    },
  });

  console.log('Created rows:');
  console.log(' pending:', pending.id);
  console.log(' skipped-no-fix:', analyzed1.id);
  console.log(' failed:', failed.id);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
