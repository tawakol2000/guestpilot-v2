import { PrismaClient } from '@prisma/client';
import { getAiConfig } from './ai-config.service';
import { createMessage } from './ai.service';

export async function listTemplates(tenantId: string, prisma: PrismaClient) {
  return prisma.messageTemplate.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'asc' },
  });
}

export async function updateTemplate(
  id: string,
  tenantId: string,
  data: { body?: string; enhancedBody?: string },
  prisma: PrismaClient
) {
  // Bugfix (2026-04-23) — HIGH IDOR. The previous implementation
  // accepted `tenantId` but never used it; `prisma.messageTemplate.update`
  // ran with only the primary-key id guard, so any authenticated user
  // could PATCH /api/templates/:id with another tenant's MessageTemplate.id
  // and overwrite their reply-template body. Cross-tenant write of a
  // text field that gets sent to guests — customer-trust grade.
  //
  // Fix: tenant-scope the update via updateMany w/ composite where, and
  // 404 if count===0 (matches the sister patterns in faq.service.ts +
  // tool-definitions route). updateMany returns count, not the row,
  // so we re-read for the response.
  const result = await prisma.messageTemplate.updateMany({
    where: { id, tenantId },
    data,
  });
  if (result.count === 0) {
    const e: Error & { status?: number } = new Error('Template not found');
    e.status = 404;
    throw e;
  }
  // Re-fetch to return the updated row (parity with the original .update return).
  return prisma.messageTemplate.findFirst({ where: { id, tenantId } });
}

export async function enhanceTemplate(
  id: string,
  tenantId: string,
  prisma: PrismaClient
) {
  const template = await prisma.messageTemplate.findFirst({ where: { id, tenantId } });
  if (!template) throw new Error('Template not found');

  const aiCfg = getAiConfig();
  const persona = aiCfg.managerTranslator;

  const systemPrompt = `You are a professional hospitality copywriter. Rewrite the given automated message template to make it warmer, more professional, and more guest-friendly. Keep the same meaning and all placeholder variables (like {{guestName}}, {{checkInDate}}). Return ONLY the improved message text, no explanation.`;

  const userContent = [{ type: 'text' as const, text: `Original message template:\n\n${template.body}` }];

  const enhanced = await createMessage(systemPrompt, userContent, {
    model: persona.model,
    temperature: 0.7,
    maxTokens: 1024,
    agentName: 'templateEnhancer',
  });

  // 2026-04-23: this update is reachable only after the
  // findFirst({id, tenantId}) above succeeded, so it's already safe.
  // Belt-and-suspenders updateMany so a future caller swap can't
  // re-introduce the IDOR.
  await prisma.messageTemplate.updateMany({
    where: { id, tenantId },
    data: { enhancedBody: enhanced.trim() },
  });
  return prisma.messageTemplate.findFirst({ where: { id, tenantId } });
}
