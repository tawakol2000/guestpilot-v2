import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../types';
import * as templateService from '../services/template.service';

export function makeTemplateController(prisma: PrismaClient) {
  return {
    async list(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const templates = await templateService.listTemplates(req.tenantId, prisma);
        res.json(templates);
      } catch (err) {
        console.error('[Templates] list error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async update(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { id } = req.params;
        const { body, enhancedBody } = req.body as { body?: string; enhancedBody?: string };
        const template = await templateService.updateTemplate(id, req.tenantId, { body, enhancedBody }, prisma);
        res.json(template);
      } catch (err) {
        // 2026-05-15 (auto-review): the service throws `e.status = 404`
        // when the template doesn't exist for the tenant. Without this
        // branch the caller saw a 500 instead of a 404.
        const status = (err as any)?.status;
        if (status === 404) {
          res.status(404).json({ error: 'Template not found' });
          return;
        }
        console.error('[Templates] update error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async enhance(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { id } = req.params;
        const template = await templateService.enhanceTemplate(id, req.tenantId, prisma);
        res.json(template);
      } catch (err) {
        const status = (err as any)?.status;
        const msg = (err as any)?.message ?? '';
        if (status === 404 || /not found/i.test(msg)) {
          res.status(404).json({ error: 'Template not found' });
          return;
        }
        console.error('[Templates] enhance error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  };
}
