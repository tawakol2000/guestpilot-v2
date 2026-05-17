import * as dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // 1. Messages that mention "joining" — either AI original or human-edited.
  const msgs = await prisma.message.findMany({
    where: {
      OR: [
        { content: { contains: 'joining', mode: 'insensitive' } },
        { originalAiText: { contains: 'joining', mode: 'insensitive' } },
      ],
    },
    orderBy: { sentAt: 'desc' },
    take: 10,
    select: {
      id: true,
      sentAt: true,
      role: true,
      tenantId: true,
      content: true,
      originalAiText: true,
      editedByUserId: true,
      previewState: true,
      channel: true,
    },
  });
  console.log('## Messages mentioning "joining"\n');
  for (const m of msgs) {
    console.log('---');
    console.log('id:', m.id, 'role:', m.role, 'at:', m.sentAt?.toISOString() ?? '(unsent)');
    console.log('previewState:', m.previewState, 'editedBy:', m.editedByUserId);
    console.log('ORIGINAL:', JSON.stringify(m.originalAiText));
    console.log('FINAL   :', JSON.stringify(m.content));
  }

  // 2. PendingAiReply rows with suggestion containing "joining" (copilot edits).
  const pending = await prisma.pendingAiReply.findMany({
    where: {
      suggestion: { contains: 'joining', mode: 'insensitive' },
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { id: true, createdAt: true, suggestion: true, conversationId: true, tenantId: true },
  });
  console.log('\n## PendingAiReply.suggestion mentioning "joining"\n');
  for (const p of pending) {
    console.log('---', p.id, p.createdAt.toISOString());
    console.log(JSON.stringify(p.suggestion));
  }

  // 3. TuningSuggestion proposed text mentioning "joining"
  const suggs = await prisma.tuningSuggestion.findMany({
    where: {
      OR: [
        { proposedText: { contains: 'joining', mode: 'insensitive' } },
        { rationale: { contains: 'joining', mode: 'insensitive' } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { id: true, createdAt: true, diagnosticCategory: true, status: true, proposedText: true, sourceMessageId: true },
  });
  console.log('\n## TuningSuggestion mentioning "joining"\n');
  for (const t of suggs) {
    console.log('---', t.id, t.createdAt.toISOString(), 'cat:', t.diagnosticCategory, 'status:', t.status, 'src:', t.sourceMessageId);
    console.log(JSON.stringify(t.proposedText?.slice(0, 300)));
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
