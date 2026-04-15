/**
 * Feature 041 sprint 01 — smoke script for the evidence bundle assembler.
 *
 * Usage:
 *   npx tsx scripts/smoke-evidence-bundle.ts <messageId>
 *   # or default: picks the most recent AI Message across all tenants
 *   npx tsx scripts/smoke-evidence-bundle.ts
 *
 * Writes the assembled bundle to stdout (JSON). This is a visual-inspection
 * tool for sprint 01 only — sprint 02 will consume the bundle via the new
 * diagnostic pipeline and won't need this script.
 */
import { PrismaClient } from '@prisma/client';
import { assembleEvidenceBundle } from '../src/services/evidence-bundle.service';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const argMessageId = process.argv[2];

    let messageId: string | null = argMessageId ?? null;
    let tenantId: string;

    if (!messageId) {
      const recent = await prisma.message.findFirst({
        where: { role: 'AI' },
        orderBy: { sentAt: 'desc' },
        select: { id: true, tenantId: true, sentAt: true, conversationId: true },
      });
      if (!recent) {
        console.error('No AI messages in the DB. Pass a messageId explicitly.');
        process.exit(1);
      }
      messageId = recent.id;
      tenantId = recent.tenantId;
      console.error(`[smoke] using most-recent AI message id=${recent.id} tenant=${recent.tenantId} sentAt=${recent.sentAt.toISOString()}`);
    } else {
      const msg = await prisma.message.findUnique({
        where: { id: messageId },
        select: { tenantId: true },
      });
      if (!msg) {
        console.error(`Message ${messageId} not found.`);
        process.exit(1);
      }
      tenantId = msg.tenantId;
    }

    const bundle = await assembleEvidenceBundle(
      {
        triggerType: 'MANUAL',
        tenantId,
        messageId: messageId!,
        messageWindow: 20,
        note: 'sprint-01 smoke test',
      },
      prisma
    );

    process.stdout.write(JSON.stringify(bundle, null, 2) + '\n');
  } catch (err) {
    console.error('[smoke] assembler threw:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
