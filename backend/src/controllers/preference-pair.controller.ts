/**
 * Feature 041 sprint 08 §3 — read-only viewer for the `PreferencePair` table.
 *
 * The table was pre-wired in sprint 01 (D2 DPO training signal) and first
 * written to in sprint 03 on reject / edit-then-accept. V1 never surfaced it;
 * sprint 08 adds a viewer so the manager can see what the agent learned from.
 *
 *   GET /api/tuning/preference-pairs           — paginated list (default 20, max 100)
 *   GET /api/tuning/preference-pairs/stats     — count + by-category + date range
 *   GET /api/tuning/preference-pairs/:id       — full JSON triple
 *
 * Scoped to the authenticated tenant. No writes. Degrades silently when the
 * table is empty — front-end shows an iconified empty state.
 */
import { Response } from 'express';
import { PrismaClient, TuningDiagnosticCategory } from '@prisma/client';
import { AuthenticatedRequest } from '../types';

const EXCERPT_CHARS = 200;

function excerpt(json: unknown): string {
  if (json === null || json === undefined) return '';
  if (typeof json === 'string') return json.slice(0, EXCERPT_CHARS);
  // Try common shapes first so the excerpt reads like the underlying text.
  if (typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    if (typeof obj.text === 'string') return obj.text.slice(0, EXCERPT_CHARS);
    if (typeof obj.content === 'string') return obj.content.slice(0, EXCERPT_CHARS);
    if (typeof obj.answer === 'string') return obj.answer.slice(0, EXCERPT_CHARS);
  }
  try {
    return JSON.stringify(json).slice(0, EXCERPT_CHARS);
  } catch {
    return '';
  }
}

export function makePreferencePairController(prisma: PrismaClient) {
  return {
    /** GET /api/tuning/preference-pairs?limit=20&cursor=… */
    async list(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const rawLimit = parseInt(String(req.query.limit ?? '20'), 10);
        const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 20, 1), 100);
        const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

        const rows = await prisma.preferencePair.findMany({
          where: { tenantId },
          orderBy: { createdAt: 'desc' },
          take: limit + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: {
            id: true,
            category: true,
            context: true,
            rejectedSuggestion: true,
            preferredFinal: true,
            createdAt: true,
          },
        });

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;

        res.json({
          pairs: page.map((p) => ({
            id: p.id,
            category: p.category,
            contextExcerpt: excerpt(p.context),
            rejectedExcerpt: excerpt(p.rejectedSuggestion),
            acceptedExcerpt: excerpt(p.preferredFinal),
            createdAt: p.createdAt,
          })),
          nextCursor: hasMore ? page[page.length - 1].id : null,
        });
      } catch (err) {
        console.error('[preference-pair] list failed:', err);
        res.status(500).json({ error: 'INTERNAL_ERROR' });
      }
    },

    /** GET /api/tuning/preference-pairs/stats */
    async stats(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const [total, byCatRaw, oldest, newest] = await Promise.all([
          prisma.preferencePair.count({ where: { tenantId } }),
          prisma.preferencePair.groupBy({
            where: { tenantId },
            by: ['category'],
            _count: { _all: true },
          }),
          prisma.preferencePair.findFirst({
            where: { tenantId },
            orderBy: { createdAt: 'asc' },
            select: { createdAt: true },
          }),
          prisma.preferencePair.findFirst({
            where: { tenantId },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true },
          }),
        ]);

        // Initialize every known category to 0 so the dashboard renders a
        // stable layout even when a category has zero pairs.
        const byCategory: Record<string, number> = {};
        const allCategories: TuningDiagnosticCategory[] = [
          'SOP_CONTENT',
          'SOP_ROUTING',
          'FAQ',
          'SYSTEM_PROMPT',
          'TOOL_CONFIG',
          'MISSING_CAPABILITY',
          'PROPERTY_OVERRIDE',
          'NO_FIX',
        ];
        for (const c of allCategories) byCategory[c] = 0;
        // Rows written before sprint 02 may have category=null; bucket under 'LEGACY'.
        byCategory['LEGACY'] = 0;
        for (const row of byCatRaw) {
          const key = row.category ?? 'LEGACY';
          byCategory[key] = (byCategory[key] ?? 0) + row._count._all;
        }

        res.json({
          total,
          byCategory,
          oldestAt: oldest?.createdAt ?? null,
          newestAt: newest?.createdAt ?? null,
        });
      } catch (err) {
        console.error('[preference-pair] stats failed:', err);
        res.status(500).json({ error: 'INTERNAL_ERROR' });
      }
    },

    /** GET /api/tuning/preference-pairs/:id */
    async get(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const id = req.params.id;
        if (!id) {
          res.status(400).json({ error: 'ID_REQUIRED' });
          return;
        }
        const row = await prisma.preferencePair.findFirst({
          where: { id, tenantId },
        });
        if (!row) {
          res.status(404).json({ error: 'NOT_FOUND' });
          return;
        }
        res.json({
          id: row.id,
          category: row.category,
          context: row.context,
          rejectedSuggestion: row.rejectedSuggestion,
          preferredFinal: row.preferredFinal,
          createdAt: row.createdAt,
        });
      } catch (err) {
        console.error('[preference-pair] get failed:', err);
        res.status(500).json({ error: 'INTERNAL_ERROR' });
      }
    },
  };
}
