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
import { getTenantAiConfig, updateTenantAiConfig, invalidateTenantConfigCache } from '../services/tenant-config.service';
import { SEED_COORDINATOR_PROMPT, SEED_SCREENING_PROMPT } from '../services/ai.service';
import { makeReplyTemplatesController } from '../controllers/reply-templates.controller';
import { makeDocHandoffController } from '../controllers/doc-handoff.controller';
import { AuthenticatedRequest } from '../types';

export function tenantConfigRouter(prisma: PrismaClient): Router {
  const router = Router();
  const replyTemplatesCtrl = makeReplyTemplatesController(prisma);
  const docHandoffCtrl = makeDocHandoffController(prisma);
  router.use(authMiddleware as unknown as RequestHandler);

  // ─── Feature 043: per-tenant reply templates ───
  router.get('/reply-templates', ((req, res) => replyTemplatesCtrl.list(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.put('/reply-templates/:escalationType/:decision', ((req, res) => replyTemplatesCtrl.upsert(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.delete('/reply-templates/:escalationType/:decision', ((req, res) => replyTemplatesCtrl.remove(req as unknown as AuthenticatedRequest, res)) as RequestHandler);

  // ─── Feature 044: doc-handoff settings + recent sends audit ───
  router.get('/doc-handoff', ((req, res) => docHandoffCtrl.getSettings(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.put('/doc-handoff', ((req, res) => docHandoffCtrl.putSettings(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.get('/doc-handoff/recent-sends', ((req, res) => docHandoffCtrl.listRecentSends(req as unknown as AuthenticatedRequest, res)) as RequestHandler);

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

  // POST /api/tenant-config/reset-prompts — restore seed defaults
  router.post('/reset-prompts', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const config = await prisma.tenantAiConfig.update({
        where: { tenantId },
        data: {
          systemPromptCoordinator: SEED_COORDINATOR_PROMPT,
          systemPromptScreening: SEED_SCREENING_PROMPT,
          systemPromptVersion: { increment: 1 },
        },
      });
      invalidateTenantConfigCache(tenantId);
      res.json(config);
    } catch (err) {
      console.error('[TenantConfig] Reset prompts failed:', err);
      res.status(500).json({ error: 'Failed to reset system prompts' });
    }
  });

  return router;
}
