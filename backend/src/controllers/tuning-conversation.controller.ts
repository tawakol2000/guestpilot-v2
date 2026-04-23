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

        // Bugfix (2026-04-23): was returning only 5 fields, but the
        // frontend's TuningConversationSummary type (used by the
        // Studio left-rail + startNew flow) also reads `status`,
        // `updatedAt`, and `messageCount`. Callers were falling back
        // to hardcoded defaults ('OPEN', null, 0). Return the full
        // summary shape so there's no drift between POST / GET / list.
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
            status: true,
            createdAt: true,
            updatedAt: true,
            _count: { select: { messages: true } },
          },
        });

        res.status(201).json({
          conversation: {
            id: conv.id,
            title: conv.title,
            anchorMessageId: conv.anchorMessageId,
            triggerType: conv.triggerType,
            status: conv.status,
            messageCount: conv._count.messages,
            createdAt: conv.createdAt,
            updatedAt: conv.updatedAt,
          },
        });
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
        //
        // Sprint 09 follow-up: join to TuningConversation and filter by
        // tenantId so the scan doesn't iterate every TuningMessage in the
        // database. The outer `where.id = { in: ids }` already narrows the
        // result to tenant-scoped conversations, but the raw query itself
        // should not cross tenants.
        if (q) {
          // Escape ILIKE wildcards in the user-supplied query string. Without
          // this, a search for "100%" becomes "%100%%" and matches far more
          // rows than intended; `_` similarly matches any single char. Not
          // an SQLi vector (parameterised), but a user-visible correctness
          // bug — `%`, `_`, and `\` all need escaping.
          const escaped = q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
          const ids = await prisma.$queryRawUnsafe<{ conversationId: string }[]>(
            `SELECT DISTINCT m."conversationId"
             FROM "TuningMessage" m
             INNER JOIN "TuningConversation" c ON c.id = m."conversationId"
             WHERE c."tenantId" = $2 AND m."parts"::text ILIKE $1 ESCAPE '\\'
             LIMIT 500`,
            `%${escaped}%`,
            tenantId
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

        // Bugfix (2026-04-23): the include previously fetched the
        // anchorMessage with no tenant filter. If data corruption or a
        // historic race ever landed a TuningConversation pointing at
        // another tenant's Message, this GET would leak that message
        // body cross-tenant. Filter the relation explicitly — Prisma
        // returns null when the join doesn't match the filter, which
        // the response mapper below already treats as "no anchor."
        const conv = await prisma.tuningConversation.findFirst({
          where: { id, tenantId },
          include: {
            messages: { orderBy: { createdAt: 'asc' } },
            anchorMessage: {
              where: { tenantId },
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

        // Bugfix (2026-04-23): align PATCH response shape with
        // list/GET/create so the frontend gets a complete
        // TuningConversationSummary and doesn't have to merge with
        // hardcoded fallbacks. Also adds tenantId to the update's
        // where clause as defence-in-depth (findFirst above already
        // validated tenant scope).
        const updated = await prisma.tuningConversation.update({
          where: { id, tenantId },
          data,
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
        res.json({
          conversation: {
            id: updated.id,
            title: updated.title,
            anchorMessageId: updated.anchorMessageId,
            triggerType: updated.triggerType,
            status: updated.status,
            messageCount: updated._count.messages,
            createdAt: updated.createdAt,
            updatedAt: updated.updatedAt,
          },
        });
      } catch (err) {
        console.error('[tuning-conversation] patch failed:', err);
        res.status(500).json({ error: 'INTERNAL_ERROR' });
      }
    },
  };
}
