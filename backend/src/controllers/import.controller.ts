import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../types';
import { runImport, deleteAllData } from '../services/import.service';
import { getProgress, setProgress, resetProgress } from '../services/progress.service';

export function makeImportController(prisma: PrismaClient) {
  return {
    // POST /api/import — start import in background, return immediately
    async run(req: AuthenticatedRequest, res: Response): Promise<void> {
      const { tenantId } = req;

      try {
        const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
        if (!tenant) {
          res.status(404).json({ error: 'Tenant not found' });
          return;
        }

        // Don't start if already running
        const current = getProgress(tenantId);
        if (current.phase !== 'idle' && current.phase !== 'done' && current.phase !== 'error') {
          res.status(409).json({ error: 'Import already in progress' });
          return;
        }

        const listingsOnly = req.query?.listingsOnly === 'true';
        const conversationsOnly = req.query?.conversationsOnly === 'true';
        resetProgress(tenantId);
        setProgress(tenantId, { phase: 'deleting', message: 'Starting…' });

        // Run in background — don't await
        runImport(
          tenantId,
          tenant.hostawayAccountId,
          tenant.hostawayApiKey,
          tenant.plan,
          prisma,
          { listingsOnly, conversationsOnly }
        ).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : 'Import failed';
          setProgress(tenantId, { phase: 'error', message: msg, error: msg });
          console.error('[Import] error:', err);
        });

        res.json({ started: true });
      } catch (err: unknown) {
        const e = err as { message?: string };
        res.status(500).json({ error: e?.message || 'Failed to start import' });
      }
    },

    // GET /api/import/progress — poll for current status
    async progress(req: AuthenticatedRequest, res: Response): Promise<void> {
      const { tenantId } = req;
      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { lastSyncedAt: true } });
      const progress = getProgress(tenantId);
      res.json({
        ...progress,
        lastSyncedAt: tenant?.lastSyncedAt?.toISOString() ?? null,
      });
    },

    // DELETE /api/import — wipe all data for this tenant
    async deleteAll(req: AuthenticatedRequest, res: Response): Promise<void> {
      const { tenantId } = req;
      try {
        await deleteAllData(tenantId, prisma);
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { propertyCount: 0, lastSyncedAt: null },
        });
        resetProgress(tenantId);
        res.json({ deleted: true });
      } catch (err: unknown) {
        const e = err as { message?: string };
        res.status(500).json({ error: e?.message || 'Delete failed' });
      }
    },
  };
}
