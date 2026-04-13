import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { AuthenticatedRequest } from '../types';

const updateNameSchema = z.object({
  name: z.string().min(1, 'Name must be at least 1 character').max(100, 'Name must be at most 100 characters'),
});

function tenantToProfile(tenant: { id: string; email: string; name: string | null; plan: string; createdAt: Date; lastSyncedAt: Date | null }) {
  return {
    id: tenant.id,
    email: tenant.email,
    name: tenant.name,
    plan: tenant.plan,
    createdAt: tenant.createdAt.toISOString(),
    lastSyncedAt: tenant.lastSyncedAt?.toISOString() ?? null,
  };
}

export function meRouter(prisma: PrismaClient): Router {
  const router = Router();
  const auth = authMiddleware as unknown as RequestHandler;

  // GET /api/me — return current tenant's profile
  router.get('/', auth, async (req: any, res) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true, email: true, name: true, plan: true, createdAt: true, lastSyncedAt: true },
      });
      if (!tenant) {
        res.status(404).json({ error: 'Tenant not found' });
        return;
      }
      res.json(tenantToProfile(tenant));
    } catch (err) {
      console.error('[Me] get error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PATCH /api/me — update tenant profile (currently: name only)
  router.patch('/', auth, async (req: any, res) => {
    try {
      const { tenantId } = req as AuthenticatedRequest;
      const parsed = updateNameSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.flatten() });
        return;
      }
      const tenant = await prisma.tenant.update({
        where: { id: tenantId },
        data: { name: parsed.data.name },
        select: { id: true, email: true, name: true, plan: true, createdAt: true, lastSyncedAt: true },
      });
      res.json(tenantToProfile(tenant));
    } catch (err) {
      console.error('[Me] update error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
