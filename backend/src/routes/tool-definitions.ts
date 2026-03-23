/**
 * Tool Definitions REST API
 *
 * GET    /api/tools              — list all tool definitions for tenant
 * PUT    /api/tools/:id          — update (description, enabled, webhookUrl, displayName)
 * POST   /api/tools              — create custom tool
 * DELETE /api/tools/:id          — delete custom tool (type=custom only)
 * POST   /api/tools/:id/reset    — reset description to defaultDescription
 *
 * All endpoints are tenant-scoped via authMiddleware.
 */
import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import {
  getToolDefinitions,
  updateToolDefinition,
  createCustomTool,
  deleteCustomTool,
  resetDescription,
} from '../services/tool-definition.service';

export function toolDefinitionsRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.use(authMiddleware as unknown as RequestHandler);

  // GET /api/tools — list all for tenant
  router.get('/', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const tools = await getToolDefinitions(tenantId, prisma);
      res.json(tools);
    } catch (err) {
      console.error('[ToolDefinitions] GET failed:', err);
      res.status(500).json({ error: 'Failed to list tool definitions' });
    }
  });

  // PUT /api/tools/:id — update description, enabled, webhookUrl, displayName
  router.put('/:id', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const { id } = req.params;

      // Verify tool belongs to tenant
      const existing = await prisma.toolDefinition.findFirst({
        where: { id, tenantId },
      });
      if (!existing) {
        res.status(404).json({ error: 'Tool definition not found' });
        return;
      }

      // Pick only allowed fields
      const { description, enabled, webhookUrl, displayName, webhookTimeout } = req.body;
      const updates: Record<string, unknown> = {};
      if (description !== undefined) updates.description = description;
      if (enabled !== undefined) updates.enabled = Boolean(enabled);
      if (webhookUrl !== undefined) updates.webhookUrl = webhookUrl;
      if (displayName !== undefined) updates.displayName = displayName;
      if (webhookTimeout !== undefined) updates.webhookTimeout = Number(webhookTimeout);

      const tool = await updateToolDefinition(id, updates, prisma);
      res.json(tool);
    } catch (err: any) {
      if (err.field) {
        res.status(400).json({ error: err.message, field: err.field });
        return;
      }
      console.error('[ToolDefinitions] PUT failed:', err);
      res.status(500).json({ error: 'Failed to update tool definition' });
    }
  });

  // POST /api/tools — create custom tool
  router.post('/', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const { name, displayName, description, parameters, agentScope, webhookUrl, webhookTimeout } = req.body;

      if (!name || !displayName || !description || !parameters || !agentScope) {
        res.status(400).json({ error: 'Missing required fields: name, displayName, description, parameters, agentScope' });
        return;
      }

      const tool = await createCustomTool(tenantId, {
        name,
        displayName,
        description,
        parameters,
        agentScope,
        webhookUrl,
        webhookTimeout,
      }, prisma);

      res.status(201).json(tool);
    } catch (err: any) {
      if (err.field) {
        res.status(400).json({ error: err.message, field: err.field });
        return;
      }
      console.error('[ToolDefinitions] POST failed:', err);
      res.status(500).json({ error: 'Failed to create custom tool' });
    }
  });

  // DELETE /api/tools/:id — delete custom tool only
  router.delete('/:id', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const { id } = req.params;

      // Verify tool belongs to tenant
      const existing = await prisma.toolDefinition.findFirst({
        where: { id, tenantId },
      });
      if (!existing) {
        res.status(404).json({ error: 'Tool definition not found' });
        return;
      }

      await deleteCustomTool(id, prisma);
      res.json({ ok: true });
    } catch (err: any) {
      if (err.status === 403) {
        res.status(403).json({ error: err.message });
        return;
      }
      console.error('[ToolDefinitions] DELETE failed:', err);
      res.status(500).json({ error: 'Failed to delete tool definition' });
    }
  });

  // POST /api/tools/:id/reset — reset description to default
  router.post('/:id/reset', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const { id } = req.params;

      // Verify tool belongs to tenant
      const existing = await prisma.toolDefinition.findFirst({
        where: { id, tenantId },
      });
      if (!existing) {
        res.status(404).json({ error: 'Tool definition not found' });
        return;
      }

      const tool = await resetDescription(id, prisma);
      res.json(tool);
    } catch (err) {
      console.error('[ToolDefinitions] Reset failed:', err);
      res.status(500).json({ error: 'Failed to reset description' });
    }
  });

  return router;
}
