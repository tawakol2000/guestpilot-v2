/**
 * Document Checklist REST endpoints for manual override.
 * GET  /api/conversations/:id/checklist — returns checklist or null
 * PUT  /api/conversations/:id/checklist — manual update from manager
 */

import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { getChecklist, manualUpdateChecklist } from '../services/document-checklist.service';

export function documentChecklistRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.use(authMiddleware as unknown as RequestHandler);

  // GET /api/conversations/:id/checklist
  router.get('/:id/checklist', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const { id } = req.params;

      const conversation = await prisma.conversation.findFirst({
        where: { id, tenantId },
        select: { reservationId: true },
      });
      if (!conversation) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }

      const checklist = await getChecklist(conversation.reservationId, prisma);
      res.json({ checklist });
    } catch (err) {
      console.error('[DocChecklist] GET error:', err);
      res.status(500).json({ error: 'Failed to get checklist' });
    }
  });

  // PUT /api/conversations/:id/checklist
  router.put('/:id/checklist', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const { id } = req.params;
      const { passportsReceived, marriageCertReceived } = req.body;

      const conversation = await prisma.conversation.findFirst({
        where: { id, tenantId },
        select: { reservationId: true },
      });
      if (!conversation) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }

      const updated = await manualUpdateChecklist(
        conversation.reservationId,
        { passportsReceived, marriageCertReceived },
        prisma
      );
      res.json({ checklist: updated });
    } catch (err: any) {
      console.error('[DocChecklist] PUT error:', err);
      res.status(err.message?.includes('not found') ? 404 : 500).json({ error: err.message || 'Failed to update checklist' });
    }
  });

  return router;
}
