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

    // GET /suggestions — pending FAQ TuningSuggestions, shaped for the FAQ
    // admin page. Returns CREATE_FAQ and EDIT_FAQ rows authored by the
    // tuning-diagnostic pipeline. The same rows also appear in the Studio
    // Suggestions tab; this endpoint just gives the FAQ admin its own view
    // so managers can accept / reject / edit / "discuss in tuning" without
    // leaving FAQ context.
    async suggestions(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const tenantId = req.tenantId;
        const rows = await prisma.tuningSuggestion.findMany({
          where: {
            tenantId,
            status: 'PENDING',
            diagnosticCategory: 'FAQ',
          },
          orderBy: { createdAt: 'desc' },
          take: 100,
        });

        // For edits, join the existing FaqEntry so the UI can show before/after.
        const editFaqIds = rows
          .map((r) => r.faqEntryId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
        const existingFaqs = editFaqIds.length
          ? await prisma.faqEntry.findMany({
              where: { tenantId, id: { in: editFaqIds } },
              select: {
                id: true,
                question: true,
                answer: true,
                category: true,
                scope: true,
                propertyId: true,
              },
            })
          : [];
        const existingById = new Map(existingFaqs.map((f) => [f.id, f]));

        const suggestions = rows.map((r) => {
          const existing = r.faqEntryId ? existingById.get(r.faqEntryId) ?? null : null;
          const isEdit = Boolean(existing);
          return {
            id: r.id,
            isEdit,
            existingFaqId: existing?.id ?? null,
            existingQuestion: existing?.question ?? null,
            existingAnswer: existing?.answer ?? null,
            // Proposed values: for edits, fall back to the existing FAQ's
            // question/category/scope when the suggestion didn't override them
            // (proposedText is just the new answer).
            proposedQuestion: r.faqQuestion ?? existing?.question ?? null,
            proposedAnswer: r.faqAnswer ?? r.proposedText ?? null,
            proposedCategory: r.faqCategory ?? existing?.category ?? null,
            proposedScope: r.faqScope ?? existing?.scope ?? 'GLOBAL',
            proposedPropertyId: r.faqPropertyId ?? existing?.propertyId ?? null,
            rationale: r.rationale ?? '',
            subLabel: r.diagnosticSubLabel ?? null,
            confidence: r.confidence ?? null,
            evidenceBundleId: r.evidenceBundleId ?? null,
            conversationId: r.conversationId ?? null,
            createdAt: r.createdAt,
          };
        });

        res.json({ suggestions, total: suggestions.length });
      } catch (err) {
        console.error('[FAQ] suggestions error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  };
}
