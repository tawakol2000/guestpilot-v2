/**
 * Battle Test — Turn Helper (REAL PIPELINE)
 * Uses the production AI pipeline via send-ai-now, NOT sandbox.
 * This creates real AI logs, real escalation tasks, real SSE events.
 *
 * Flow:
 *   1. Insert GUEST message into DB
 *   2. Create PendingAiReply record (required by send-ai-now)
 *   3. Call POST /api/conversations/:id/send-ai-now on Railway
 *   4. Poll for AI response message in DB
 *   5. Fetch the AI log entry for this conversation
 *   6. Return full pipeline data (AI response + AI log with system prompt, tool calls, etc.)
 *
 * Subcommands:
 *   turn    — send a guest message and get AI response
 *   status  — update reservation status (simulate manager approval)
 *   ailog   — fetch the latest AI log for a conversation
 *
 * Usage:
 *   npx ts-node scripts/battle-test/turn.ts turn \
 *     --conversationId=<id> --message="..." --jwt=<token>
 *
 *   npx ts-node scripts/battle-test/turn.ts status \
 *     --reservationId=<id> --newStatus=CONFIRMED
 *
 *   npx ts-node scripts/battle-test/turn.ts ailog \
 *     --conversationId=<id> --jwt=<token>
 */

import { PrismaClient } from '@prisma/client';
import * as https from 'https';

const prisma = new PrismaClient();
const TENANT_ID = 'cmmth6d1r000a6bhlkb75ku4r';
const RAILWAY_BASE = 'https://guestpilot-v2-production.up.railway.app';

function parseArgs(): { subcommand: string; args: Record<string, string> } {
  const subcommand = process.argv[2] || 'turn';
  const args: Record<string, string> = {};
  for (const arg of process.argv.slice(3)) {
    const match = arg.match(/^--(\w+)=(.+)$/s);
    if (match) args[match[1]] = match[2];
  }
  return { subcommand, args };
}

function httpRequest(method: string, path: string, jwt: string, body?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const url = new URL(`${RAILWAY_BASE}${path}`);

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${jwt}`,
      'Accept': 'application/json',
    };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(data));
    }

    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method,
        headers,
        timeout: 30000,
      },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk) => (responseBody += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(responseBody));
          } catch {
            resolve({ raw: responseBody, status: res.statusCode });
          }
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    if (data) req.write(data);
    req.end();
  });
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── TURN: Send guest message and get AI response via real pipeline ──────────
async function handleTurn(args: Record<string, string>) {
  const { conversationId, message, jwt, channel } = args;

  if (!conversationId || !message || !jwt) {
    console.error(JSON.stringify({ error: 'Required: --conversationId, --message, --jwt' }));
    process.exit(1);
  }

  // Count existing messages to determine turn number
  const existingCount = await prisma.message.count({ where: { conversationId } });

  // 1. Insert GUEST message
  const guestMsg = await prisma.message.create({
    data: {
      conversationId,
      tenantId: TENANT_ID,
      role: 'GUEST',
      content: message,
      channel: (channel || 'WHATSAPP') as any,
      communicationType: channel === 'AIRBNB' ? 'channel' : 'whatsapp',
      sentAt: new Date(),
      hostawayMessageId: `battle-test-${Date.now()}`,
    },
  });

  // Update conversation
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: new Date(), unreadCount: { increment: 1 } },
  });

  // 2. Create PendingAiReply (required by send-ai-now)
  await prisma.pendingAiReply.upsert({
    where: { conversationId },
    create: {
      conversationId,
      tenantId: TENANT_ID,
      scheduledAt: new Date(), // due now
      fired: false,
    },
    update: {
      scheduledAt: new Date(),
      fired: false,
    },
  });

  // 3. Call send-ai-now (fires async on Railway, returns { ok: true })
  const sendResult = await httpRequest('POST', `/api/conversations/${conversationId}/send-ai-now`, jwt);
  if (!sendResult.ok) {
    console.error(JSON.stringify({ error: 'send-ai-now failed', details: sendResult }));
    await prisma.$disconnect();
    process.exit(1);
  }

  // 4. Poll for AI response message (the production pipeline creates it)
  let aiMessage: any = null;
  const maxWaitMs = 120000; // 2 minutes max
  const pollIntervalMs = 2000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    await sleep(pollIntervalMs);

    // Look for a new AI message after our guest message
    aiMessage = await prisma.message.findFirst({
      where: {
        conversationId,
        role: 'AI',
        sentAt: { gte: guestMsg.sentAt },
      },
      orderBy: { sentAt: 'desc' },
    });

    if (aiMessage) break;
  }

  if (!aiMessage) {
    console.error(JSON.stringify({
      error: 'AI response not received within timeout',
      guestMessageId: guestMsg.id,
      waitedMs: Date.now() - startTime,
    }));
    await prisma.$disconnect();
    process.exit(1);
  }

  // 5. Fetch the AI log for this conversation (most recent)
  const aiLog = await prisma.aiApiLog.findFirst({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },
  });

  // 6. Check for tasks created by this turn
  const recentTasks = await prisma.task.findMany({
    where: {
      conversationId,
      createdAt: { gte: guestMsg.sentAt },
    },
    orderBy: { createdAt: 'desc' },
  });

  // 7. Output full result
  const turn = Math.ceil((existingCount + 1) / 2);
  const result: any = {
    turn,
    guestMessageId: guestMsg.id,
    aiMessageId: aiMessage.id,
    guestMessage: message,
    aiResponse: aiMessage.content,
    waitMs: Date.now() - startTime,

    // From AI log (full production pipeline data)
    aiLog: aiLog ? {
      id: aiLog.id,
      agentName: aiLog.agentName,
      model: aiLog.model,
      temperature: aiLog.temperature,
      maxTokens: aiLog.maxTokens,
      systemPromptPreview: aiLog.systemPrompt.substring(0, 500),
      systemPromptLength: aiLog.systemPrompt.length,
      userContentPreview: aiLog.userContent.substring(0, 500),
      userContentLength: aiLog.userContent.length,
      responseText: aiLog.responseText,
      inputTokens: aiLog.inputTokens,
      outputTokens: aiLog.outputTokens,
      costUsd: aiLog.costUsd,
      durationMs: aiLog.durationMs,
      error: aiLog.error,
      ragContext: aiLog.ragContext,
    } : null,

    // Tasks created by this turn
    tasksCreated: recentTasks.map(t => ({
      id: t.id,
      title: t.title,
      note: t.note,
      urgency: t.urgency,
      type: t.type,
      status: t.status,
    })),
  };

  console.log(JSON.stringify(result, null, 2));
}

// ─── STATUS: Update reservation status (simulate manager approval) ───────────
async function handleStatusChange(args: Record<string, string>) {
  const { reservationId, newStatus } = args;

  if (!reservationId || !newStatus) {
    console.error(JSON.stringify({ error: 'Required: --reservationId, --newStatus' }));
    process.exit(1);
  }

  await prisma.reservation.update({
    where: { id: reservationId },
    data: { status: newStatus as any },
  });

  console.log(JSON.stringify({ ok: true, reservationId, newStatus }));
}

// ─── AILOG: Fetch full AI log for review ─────────────────────────────────────
async function handleAiLog(args: Record<string, string>) {
  const { conversationId, logId, jwt } = args;

  if (logId) {
    // Fetch specific log via API (full system prompt, not truncated)
    const log = await httpRequest('GET', `/api/ai-logs/${logId}`, jwt);
    console.log(JSON.stringify(log, null, 2));
    return;
  }

  if (!conversationId) {
    console.error(JSON.stringify({ error: 'Required: --conversationId or --logId' }));
    process.exit(1);
  }

  // Fetch all logs for this conversation
  const logs = await prisma.aiApiLog.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });

  const result = logs.map(l => ({
    id: l.id,
    agentName: l.agentName,
    model: l.model,
    systemPromptLength: l.systemPrompt.length,
    responseText: l.responseText,
    inputTokens: l.inputTokens,
    outputTokens: l.outputTokens,
    costUsd: l.costUsd,
    durationMs: l.durationMs,
    error: l.error,
    ragContext: l.ragContext,
    createdAt: l.createdAt,
  }));

  console.log(JSON.stringify(result, null, 2));
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const { subcommand, args } = parseArgs();

  switch (subcommand) {
    case 'turn':
      await handleTurn(args);
      break;
    case 'status':
      await handleStatusChange(args);
      break;
    case 'ailog':
      await handleAiLog(args);
      break;
    default:
      console.error(JSON.stringify({ error: `Unknown subcommand: ${subcommand}. Use: turn, status, ailog` }));
      process.exit(1);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(JSON.stringify({ error: err.message }));
  await prisma.$disconnect();
  process.exit(1);
});
