/**
 * Tuning conversation CRUD.
 *
 *   POST   /api/tuning/conversations        — create a TuningConversation.
 *                                             Body: { anchorMessageId?, triggerType?, initialMessage?, title? }
 *   GET    /api/tuning/conversations        — list for the tenant (pagination + q).
 *   GET    /api/tuning/conversations/:id    — fetch with messages.
 *   PATCH  /api/tuning/conversations/:id    — rename / archive.
 *
 * All tenant-scoped via authMiddleware.
 */
import { Response } from 'express';
import { PrismaClient, TuningConversationTriggerType } from '@prisma/client';
import { AuthenticatedRequest } from '../types';

const VALID_TRIGGERS: readonly TuningConversationTriggerType[] = [
  'MANUAL',
  'EDIT_TRIGGERED',
  'REJECT_TRIGGERED',
  'COMPLAINT_TRIGGERED',
  'THUMBS_DOWN_TRIGGERED',
  'CLUSTER_TRIGGERED',
  'ESCALATION_TRIGGERED',
];

function deriveTitleFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;
  return trimmed.slice(0, 80);
}

export function makeTuningConversationController(prisma: PrismaClient) {
  return {
    async create(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const userId = (req as any).userId ?? null;
        const body = (req.body ?? {}) as {
          anchorMessageId?: string | null;
          triggerType?: string;
          initialMessage?: string;
          title?: string;
        };

        const trig = body.triggerType && VALID_TRIGGERS.includes(body.triggerType as TuningConversationTriggerType)
          ? (body.triggerType as TuningConversationTriggerType)
          : 'MANUAL';

        // Validate anchor message belongs to tenant, if provided.
        let anchorMessageId: string | null = null;
        if (body.anchorMessageId) {
          const msg = await prisma.message.findFirst({
            where: { id: body.anchorMessageId, tenantId },
            select: { id: true },
          });
          if (!msg) {
            res.status(404).json({ error: 'ANCHOR_MESSAGE_NOT_FOUND' });
            return;
          }
          anchorMessageId = msg.id;
        }

        const title = body.title ?? deriveTitleFromText(body.initialMessage) ?? null;

        const conv = await prisma.tuningConversation.create({
          data: {
            tenantId,
            userId,
            triggerType: trig,
            anchorMessageId,
            title,
            status: 'OPEN',
          },
          select: {
            id: true,
            title: true,
            anchorMessageId: true,
            triggerType: true,
            createdAt: true,
          },
        });

        res.status(201).json({ conversation: conv });
      } catch (err) {
        console.error('[tuning-conversation] create failed:', err);
        res.status(500).json({ error: 'INTERNAL_ERROR' });
      }
    },

    async list(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const limit = Math.max(1, Math.min(100, parseInt(String(req.query.limit || '30'), 10) || 30));
        const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
        const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

        const where: any = { tenantId };

        // Substring search over TuningMessage.parts content. Keep it simple
        // via raw query to avoid Json path-quirks on older Postgres.
        if (q) {
          const ids = await prisma.$queryRawUnsafe<{ conversationId: string }[]>(
            'SELECT DISTINCT "conversationId" FROM "TuningMessage" WHERE "parts"::text ILIKE $1 LIMIT 500',
            `%${q}%`
          );
          where.id = { in: ids.map((r) => r.conversationId) };
        }

        const rows = await prisma.tuningConversation.findMany({
          where,
          orderBy: { updatedAt: 'desc' },
          take: limit + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: {
            id: true,
            title: true,
            anchorMessageId: true,
            triggerType: true,
            status: true,
            createdAt: true,
            updatedAt: true,
            _count: { select: { messages: true } },
          },
        });

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;

        res.json({
          conversations: page.map((c) => ({
            id: c.id,
            title: c.title,
            anchorMessageId: c.anchorMessageId,
            triggerType: c.triggerType,
            status: c.status,
            messageCount: c._count.messages,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
          })),
          nextCursor: hasMore ? page[page.length - 1].id : null,
        });
      } catch (err) {
        console.error('[tuning-conversation] list failed:', err);
        res.status(500).json({ error: 'INTERNAL_ERROR' });
      }
    },

    async get(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { id } = req.params;

        const conv = await prisma.tuningConversation.findFirst({
          where: { id, tenantId },
          include: {
            messages: { orderBy: { createdAt: 'asc' } },
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
        });

        if (!conv) {
          res.status(404).json({ error: 'CONVERSATION_NOT_FOUND' });
          return;
        }

        res.json({
          conversation: {
            id: conv.id,
            title: conv.title,
            anchorMessageId: conv.anchorMessageId,
            anchorMessage: conv.anchorMessage,
            triggerType: conv.triggerType,
            status: conv.status,
            sdkSessionId: conv.sdkSessionId,
            createdAt: conv.createdAt,
            updatedAt: conv.updatedAt,
            messages: conv.messages.map((m) => ({
              id: m.id,
              role: m.role,
              parts: m.parts,
              createdAt: m.createdAt,
            })),
          },
        });
      } catch (err) {
        console.error('[tuning-conversation] get failed:', err);
        res.status(500).json({ error: 'INTERNAL_ERROR' });
      }
    },

    async patch(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { id } = req.params;
        const body = (req.body ?? {}) as { title?: string | null; status?: string };

        const conv = await prisma.tuningConversation.findFirst({
          where: { id, tenantId },
          select: { id: true },
        });
        if (!conv) {
          res.status(404).json({ error: 'CONVERSATION_NOT_FOUND' });
          return;
        }

        const data: any = {};
        if (typeof body.title === 'string' || body.title === null) data.title = body.title;
        if (typeof body.status === 'string') data.status = body.status;
        if (Object.keys(data).length === 0) {
          res.status(400).json({ error: 'NO_UPDATES' });
          return;
        }

        const updated = await prisma.tuningConversation.update({
          where: { id },
          data,
          select: { id: true, title: true, status: true, updatedAt: true },
        });
        res.json({ conversation: updated });
      } catch (err) {
        console.error('[tuning-conversation] patch failed:', err);
        res.status(500).json({ error: 'INTERNAL_ERROR' });
      }
    },
  };
}
