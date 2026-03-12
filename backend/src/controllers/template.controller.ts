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
        console.error('[Templates] enhance error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  };
}
