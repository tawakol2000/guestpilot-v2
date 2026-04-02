/**
 * FAQ Knowledge System — Controller Layer
 *
 * Factory function returning Express handlers for FAQ CRUD + category stats.
 * All handlers extract tenantId from req.tenantId (set by authMiddleware).
 */
import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../types';
import { FAQ_CATEGORIES } from '../config/faq-categories';
import {
  getFaqEntries,
  createFaqEntry,
  updateFaqEntry,
  deleteFaqEntry,
  getCategoryStats,
} from '../services/faq.service';

export function makeFaqController(prisma: PrismaClient) {
  return {
    // GET / — list FAQ entries with optional filters
    async list(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const tenantId = req.tenantId;
        const { propertyId, scope, status, category } = req.query as Record<string, string | undefined>;

        const entries = await getFaqEntries(prisma, tenantId, {
          propertyId,
          scope,
          status,
          category,
        });

        res.json({ entries, total: entries.length, categories: FAQ_CATEGORIES });
      } catch (err) {
        console.error('[FAQ] list error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    // POST / — create a new FAQ entry
    async create(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const tenantId = req.tenantId;
        const { propertyId, question, answer, category, scope, source } = req.body;

        const entry = await createFaqEntry(prisma, {
          tenantId,
          propertyId,
          question,
          answer,
          category,
          scope,
          source,
        });

        res.status(201).json(entry);
      } catch (err: any) {
        if (err.field) {
          res.status(400).json({ error: err.message, field: err.field });
          return;
        }
        console.error('[FAQ] create error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    // PATCH /:id — update a FAQ entry
    async update(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const tenantId = req.tenantId;
        const { id } = req.params;
        const { status, scope, question, answer, propertyId, category } = req.body;

        const entry = await updateFaqEntry(prisma, id, tenantId, {
          status,
          scope,
          question,
          answer,
          propertyId,
          category,
        });

        res.json(entry);
      } catch (err: any) {
        if (err.status === 404) {
          res.status(404).json({ error: err.message });
          return;
        }
        if (err.field) {
          res.status(400).json({ error: err.message, field: err.field });
          return;
        }
        console.error('[FAQ] update error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    // DELETE /:id — delete a FAQ entry
    async remove(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const tenantId = req.tenantId;
        const { id } = req.params;

        await deleteFaqEntry(prisma, id, tenantId);
        res.json({ ok: true });
      } catch (err: any) {
        if (err.status === 404) {
          res.status(404).json({ error: err.message });
          return;
        }
        console.error('[FAQ] remove error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    // GET /categories — category stats (count of ACTIVE entries per category)
    async categories(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const tenantId = req.tenantId;
        const categories = await getCategoryStats(prisma, tenantId);
        res.json({ categories });
      } catch (err) {
        console.error('[FAQ] categories error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  };
}
