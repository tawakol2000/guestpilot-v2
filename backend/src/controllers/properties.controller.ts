import { Response } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../types';

const knowledgeBaseSchema = z.object({
  customKnowledgeBase: z.record(z.unknown()),
});

export function makePropertiesController(prisma: PrismaClient) {
  return {
    async list(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const properties = await prisma.property.findMany({
          where: { tenantId },
          orderBy: { name: 'asc' },
        });
        res.json(properties.map(p => ({
          id: p.id,
          hostawayListingId: p.hostawayListingId,
          name: p.name,
          address: p.address,
          listingDescription: p.listingDescription,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        })));
      } catch (err) {
        console.error('[Properties] list error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async listWithAiStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const properties = await prisma.property.findMany({
          where: { tenantId },
          orderBy: { name: 'asc' },
          include: {
            reservations: {
              select: { aiEnabled: true, aiMode: true },
            },
          },
        });
        res.json(properties.map(p => {
          const reservations = p.reservations;
          const total = reservations.length;
          const enabled = reservations.filter(r => r.aiEnabled).length;
          // Determine predominant mode
          let aiMode: string = 'off';
          if (enabled > 0) {
            const modes = reservations.filter(r => r.aiEnabled).map(r => r.aiMode);
            const counts: Record<string, number> = {};
            for (const m of modes) { counts[m] = (counts[m] || 0) + 1; }
            aiMode = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'autopilot';
          }
          return {
            id: p.id,
            name: p.name,
            address: p.address,
            aiMode: enabled === 0 ? 'off' : aiMode,
            conversationCount: total,
            aiEnabledCount: enabled,
          };
        }));
      } catch (err) {
        console.error('[Properties] listWithAiStatus error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async get(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { id } = req.params;
        const property = await prisma.property.findFirst({ where: { id, tenantId } });
        if (!property) {
          res.status(404).json({ error: 'Property not found' });
          return;
        }
        res.json(property);
      } catch (err) {
        console.error('[Properties] get error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async updateKnowledgeBase(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { id } = req.params;

        const parsed = knowledgeBaseSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.flatten() });
          return;
        }

        const property = await prisma.property.findFirst({ where: { id, tenantId } });
        if (!property) {
          res.status(404).json({ error: 'Property not found' });
          return;
        }

        const updated = await prisma.property.update({
          where: { id },
          data: { customKnowledgeBase: parsed.data.customKnowledgeBase as never },
        });

        res.json({ id: updated.id, customKnowledgeBase: updated.customKnowledgeBase, updatedAt: updated.updatedAt });
      } catch (err) {
        console.error('[Properties] updateKnowledgeBase error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  };
}
