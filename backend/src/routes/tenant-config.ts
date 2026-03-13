/**
 * Per-tenant AI config routes.
 * GET /api/tenant-config  — returns current tenant's TenantAiConfig
 * PUT /api/tenant-config  — updates config with validation
 *
 * Separate from the existing /api/ai-config routes (which handle persona version history).
 */
import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { getTenantAiConfig, updateTenantAiConfig } from '../services/tenant-config.service';

export function tenantConfigRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.use(authMiddleware as unknown as RequestHandler);

  // GET /api/tenant-config
  router.get('/', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const config = await getTenantAiConfig(tenantId, prisma);
      res.json(config);
    } catch (err) {
      console.error('[TenantConfig] GET failed:', err);
      res.status(500).json({ error: 'Failed to get tenant config' });
    }
  });

  // PUT /api/tenant-config
  router.put('/', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      // Normalize legacy plural field name sent by frontend
      const body = { ...req.body };
      if ('memorySummariesEnabled' in body && !('memorySummaryEnabled' in body)) {
        body.memorySummaryEnabled = body.memorySummariesEnabled;
        delete body.memorySummariesEnabled;
      }
      const config = await updateTenantAiConfig(tenantId, body, prisma);
      res.json(config);
    } catch (err: any) {
      if (err.field) {
        res.status(400).json({ error: err.message, field: err.field, message: err.message });
        return;
      }
      console.error('[TenantConfig] PUT failed:', err);
      res.status(500).json({ error: 'Failed to update tenant config' });
    }
  });

  return router;
}
