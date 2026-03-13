import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { makeKnowledgeController } from '../controllers/knowledge.controller';
import { seedTenantSops } from '../services/rag.service';
import { AuthenticatedRequest } from '../types';

export function knowledgeRouter(prisma: PrismaClient): Router {
  const router = Router();
  const ctrl = makeKnowledgeController(prisma);
  router.use(authMiddleware as unknown as RequestHandler);

  // POST /api/knowledge/seed-sops — seed tenant-level SOP chunks for RAG
  router.post('/seed-sops', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const inserted = await seedTenantSops(tenantId, prisma);
      res.json({ ok: true, inserted });
    } catch (err) {
      console.error('[Knowledge] seed-sops failed:', err);
      res.status(500).json({ error: 'Failed to seed SOPs' });
    }
  });

  // GET /api/knowledge/chunks?propertyId=xxx — view ingested RAG vector chunks (no embedding)
  router.get('/chunks', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const { propertyId } = req.query as { propertyId?: string };
      const chunks = await prisma.propertyKnowledgeChunk.findMany({
        where: { tenantId, ...(propertyId ? { propertyId } : {}) },
        select: { id: true, propertyId: true, content: true, category: true, sourceKey: true, createdAt: true, updatedAt: true },
        orderBy: { createdAt: 'desc' },
        take: 500,
      });
      res.json(chunks);
    } catch (err) {
      console.error('[Knowledge] chunks query failed:', err);
      res.status(500).json({ error: 'Failed to fetch chunks' });
    }
  });

  // PATCH /api/knowledge/chunks/:id — update content and/or category of a chunk
  router.patch('/chunks/:id', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const { id } = req.params as { id: string };
      const { content, category } = req.body as { content?: string; category?: string };

      const rows = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM "PropertyKnowledgeChunk"
        WHERE id = ${id} AND "tenantId" = ${tenantId}
      `;
      if (rows.length === 0) {
        res.status(404).json({ error: 'Chunk not found' });
        return;
      }

      await prisma.$executeRaw`
        UPDATE "PropertyKnowledgeChunk"
        SET content = ${content ?? null}, category = ${category ?? null}, "updatedAt" = now()
        WHERE id = ${id} AND "tenantId" = ${tenantId}
      `;
      res.json({ ok: true });
    } catch (err) {
      console.error('[Knowledge] chunk update failed:', err);
      res.status(500).json({ error: 'Failed to update chunk' });
    }
  });

  // DELETE /api/knowledge/chunks/:id — delete a chunk
  router.delete('/chunks/:id', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const { id } = req.params as { id: string };

      const rows = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM "PropertyKnowledgeChunk"
        WHERE id = ${id} AND "tenantId" = ${tenantId}
      `;
      if (rows.length === 0) {
        res.status(404).json({ error: 'Chunk not found' });
        return;
      }

      await prisma.$executeRaw`
        DELETE FROM "PropertyKnowledgeChunk"
        WHERE id = ${id} AND "tenantId" = ${tenantId}
      `;
      res.json({ ok: true });
    } catch (err) {
      console.error('[Knowledge] chunk delete failed:', err);
      res.status(500).json({ error: 'Failed to delete chunk' });
    }
  });

  router.get('/', ((req, res) => ctrl.list(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.post('/', ((req, res) => ctrl.create(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.post('/detect-gaps', ((req, res) => ctrl.detectGaps(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.post('/bulk-import', ((req, res) => ctrl.bulkImport(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.patch('/:id', ((req, res) => ctrl.update(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.delete('/:id', ((req, res) => ctrl.remove(req as unknown as AuthenticatedRequest, res)) as RequestHandler);

  return router;
}
