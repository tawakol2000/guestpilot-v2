import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../types';

export function makeKnowledgeController(prisma: PrismaClient) {
  return {
    async rateMessage(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { id: messageId } = req.params;
        const { rating } = req.body as {
          rating: 'positive' | 'negative';
        };
        if (!['positive', 'negative'].includes(rating)) {
          res.status(400).json({ error: 'rating must be positive or negative' });
          return;
        }
        const msg = await prisma.message.findFirst({ where: { id: messageId, tenantId } });
        if (!msg) { res.status(404).json({ error: 'Message not found' }); return; }

        await prisma.messageRating.upsert({
          where: { messageId },
          create: { messageId, rating },
          update: { rating },
        });

        res.json({ ok: true });
      } catch (err) {
        console.error('[Knowledge] rateMessage error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

  };
}
