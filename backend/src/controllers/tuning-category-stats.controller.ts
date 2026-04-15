/**
 * Feature 041 sprint 02 §6 — GET /api/tuning/category-stats.
 *
 * Returns every TuningCategoryStats row for the current tenant. Sprint 03's
 * velocity dashboard will consume this. No UI in V1 yet.
 */
import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../types';

export function makeTuningCategoryStatsController(prisma: PrismaClient) {
  return {
    async list(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const rows = await prisma.tuningCategoryStats.findMany({
          where: { tenantId },
          orderBy: { category: 'asc' },
        });
        res.json({
          stats: rows.map((r) => ({
            category: r.category,
            acceptRateEma: r.acceptRateEma,
            acceptCount: r.acceptCount,
            rejectCount: r.rejectCount,
            lastUpdatedAt: r.lastUpdatedAt,
          })),
        });
      } catch (err) {
        console.error('[TuningCategoryStats] list failed:', err);
        res.status(500).json({ error: 'INTERNAL_ERROR' });
      }
    },
  };
}
