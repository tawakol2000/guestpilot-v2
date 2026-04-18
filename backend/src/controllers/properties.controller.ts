import { Response } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../types';

const knowledgeBaseSchema = z.object({
  customKnowledgeBase: z.record(z.unknown()),
});

// Feature 043 — HH:MM (24h) validator; null/empty-string clears the threshold.
const hhmm = z
  .string()
  .regex(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/, 'must be HH:MM (24-hour)')
  .or(z.literal(''))
  .nullable()
  .optional();

const autoAcceptThresholdsSchema = z.object({
  autoAcceptLateCheckoutUntil: hhmm,
  autoAcceptEarlyCheckinFrom: hhmm,
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
          customKnowledgeBase: p.customKnowledgeBase,
          // Feature 043 — per-property auto-accept thresholds
          autoAcceptLateCheckoutUntil: p.autoAcceptLateCheckoutUntil,
          autoAcceptEarlyCheckinFrom: p.autoAcceptEarlyCheckinFrom,
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

    // Feature 043 — update the per-property auto-accept thresholds. Empty
    // string or null clears a threshold (= fall back to tenant default = off).
    async updateAutoAcceptThresholds(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { id } = req.params;

        const parsed = autoAcceptThresholdsSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.flatten() });
          return;
        }

        const property = await prisma.property.findFirst({ where: { id, tenantId } });
        if (!property) {
          res.status(404).json({ error: 'Property not found' });
          return;
        }

        const data: {
          autoAcceptLateCheckoutUntil?: string | null;
          autoAcceptEarlyCheckinFrom?: string | null;
        } = {};
        if (parsed.data.autoAcceptLateCheckoutUntil !== undefined) {
          data.autoAcceptLateCheckoutUntil = parsed.data.autoAcceptLateCheckoutUntil || null;
        }
        if (parsed.data.autoAcceptEarlyCheckinFrom !== undefined) {
          data.autoAcceptEarlyCheckinFrom = parsed.data.autoAcceptEarlyCheckinFrom || null;
        }

        const updated = await prisma.property.update({
          where: { id },
          data,
          select: {
            id: true,
            autoAcceptLateCheckoutUntil: true,
            autoAcceptEarlyCheckinFrom: true,
            updatedAt: true,
          },
        });

        res.json(updated);
      } catch (err) {
        console.error('[Properties] updateAutoAcceptThresholds error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  };
}
