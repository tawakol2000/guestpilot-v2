/**
 * Feature 041 sprint 03 — read endpoint for an assembled evidence bundle.
 *
 *   GET /api/evidence-bundles/:id
 *
 * Tenant-scoped. Returns the persisted `payload` blob plus the row's metadata.
 * Sprint 04's tuning agent will also read these rows via tool call; this HTTP
 * endpoint exists so the /tuning UI evidence slide-over can lazy-load.
 */
import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../types';

export function makeEvidenceBundleController(prisma: PrismaClient) {
  return {
    async get(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { id } = req.params;
        const bundle = await prisma.evidenceBundle.findFirst({
          where: { id, tenantId },
        });
        if (!bundle) {
          res.status(404).json({ error: 'EVIDENCE_BUNDLE_NOT_FOUND' });
          return;
        }
        res.json({
          id: bundle.id,
          messageId: bundle.messageId,
          triggerType: bundle.triggerType,
          createdAt: bundle.createdAt,
          payload: bundle.payload,
        });
      } catch (err) {
        console.error('[evidence-bundle] get failed:', err);
        res.status(500).json({ error: 'INTERNAL_ERROR' });
      }
    },
  };
}
