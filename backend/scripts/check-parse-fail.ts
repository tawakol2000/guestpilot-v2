import * as dotenv from 'dotenv'; dotenv.config();
import { PrismaClient } from '@prisma/client';
async function main() {
  const p = new PrismaClient();
  const log = await p.aiApiLog.findUnique({
    where: { id: 'cmpb8cmr600aal1vpg2c0bf4f' },
    select: {
      id: true, createdAt: true, model: true, agentName: true,
      inputTokens: true, outputTokens: true, cachedInputTokens: true,
      durationMs: true,
      responseText: true,
    },
  });
  if (!log) {
    console.log('not found');
  } else {
    console.log('id:', log.id, 'at:', log.createdAt.toISOString(), 'agent:', log.agentName, 'model:', log.model);
    console.log('tokens:', log.inputTokens, '/', log.outputTokens, 'cached:', log.cachedInputTokens, 'durationMs:', log.durationMs);
    console.log('--- responseText length:', log.responseText?.length);
    console.log('--- responseText (full) ---');
    console.log(log.responseText);
  }
  await p.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
