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
  return prisma.messageTemplate.update({
    where: { id },
    data,
  });
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

  return prisma.messageTemplate.update({
    where: { id },
    data: { enhancedBody: enhanced.trim() },
  });
}
