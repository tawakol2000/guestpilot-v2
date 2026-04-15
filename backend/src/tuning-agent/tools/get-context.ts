/**
 * get_context — the agent's first-touch context call. Returns the selected
 * suggestion (if any), anchor message (if any), pending-queue summary, and
 * a compact recent-activity view.
 */
import { z } from 'zod/v4';
import type { tool as ToolFactory } from '@anthropic-ai/claude-agent-sdk';
import { startAiSpan } from '../../services/observability.service';
import { asCallToolResult, asError, type ToolContext } from './types';

export function buildGetContextTool(tool: typeof ToolFactory, ctx: () => ToolContext) {
  return tool(
    'get_context',
    'Current tuning conversation context: anchor message (if any), selected suggestion (if any), pending queue summary, last accepted suggestion. Call this first when a conversation opens. Verbosity "detailed" expands the recent-activity timeline.',
    {
      verbosity: z.enum(['concise', 'detailed']).optional(),
    },
    async (args) => {
      const c = ctx();
      const span = startAiSpan('tuning-agent.get_context', args);
      try {
        const detailed = args.verbosity === 'detailed';
        const [conversation, pending, lastAccepted, recentMessages] = await Promise.all([
          c.conversationId
            ? c.prisma.tuningConversation.findFirst({
                where: { id: c.conversationId, tenantId: c.tenantId },
                include: {
                  anchorMessage: {
                    select: {
                      id: true,
                      content: true,
                      role: true,
                      sentAt: true,
                      conversationId: true,
                    },
                  },
                },
              })
            : Promise.resolve(null),
          c.prisma.tuningSuggestion.findMany({
            where: { tenantId: c.tenantId, status: 'PENDING' },
            orderBy: [{ confidence: 'desc' }, { createdAt: 'desc' }],
            take: 8,
            select: {
              id: true,
              diagnosticCategory: true,
              diagnosticSubLabel: true,
              confidence: true,
              rationale: true,
              triggerType: true,
              createdAt: true,
            },
          }),
          c.prisma.tuningSuggestion.findFirst({
            where: { tenantId: c.tenantId, status: 'ACCEPTED' },
            orderBy: { appliedAt: 'desc' },
            select: {
              id: true,
              diagnosticCategory: true,
              diagnosticSubLabel: true,
              actionType: true,
              appliedAt: true,
              rationale: true,
            },
          }),
          detailed && c.conversationId
            ? c.prisma.tuningMessage.findMany({
                where: { conversationId: c.conversationId },
                orderBy: { createdAt: 'desc' },
                take: 10,
                select: { id: true, role: true, createdAt: true },
              })
            : Promise.resolve(null),
        ]);

        const countsByCategory = pending.reduce<Record<string, number>>((acc, s) => {
          const k = s.diagnosticCategory ?? 'LEGACY';
          acc[k] = (acc[k] || 0) + 1;
          return acc;
        }, {});

        const payload = {
          conversation: conversation
            ? {
                id: conversation.id,
                title: conversation.title,
                triggerType: conversation.triggerType,
                anchorMessageId: conversation.anchorMessageId,
                anchorMessage: (conversation as any).anchorMessage
                  ? {
                      id: (conversation as any).anchorMessage.id,
                      content: (conversation as any).anchorMessage.content.slice(0, 800),
                      role: (conversation as any).anchorMessage.role,
                      conversationId: (conversation as any).anchorMessage.conversationId,
                      sentAt: (conversation as any).anchorMessage.sentAt,
                    }
                  : null,
              }
            : null,
          pendingQueue: {
            total: pending.length,
            countsByCategory,
            topSuggestions: pending.slice(0, detailed ? 8 : 3).map((s) => ({
              id: s.id,
              category: s.diagnosticCategory,
              subLabel: s.diagnosticSubLabel,
              confidence: s.confidence,
              rationale: s.rationale.slice(0, detailed ? 400 : 180),
              triggerType: s.triggerType,
            })),
          },
          lastAccepted,
          recentMessages: recentMessages ?? undefined,
        };
        span.end(payload);
        return asCallToolResult(payload);
      } catch (err: any) {
        span.end({ error: String(err) });
        return asError(`get_context failed: ${err?.message ?? String(err)}`);
      }
    }
  );
}
