/**
 * FAQ Knowledge System — Service Layer
 *
 * CRUD operations + the core retrieval function for the get_faq tool.
 * All queries are tenant-scoped. Property-level entries override globals
 * when the first 50 chars of the question match (lowercased, trimmed).
 */
import { PrismaClient, FaqEntry } from '@prisma/client';
import { FAQ_CATEGORIES, FAQ_CATEGORY_LABELS, FaqCategory } from '../config/faq-categories';

/**
 * Stub for cache invalidation. Today FAQ has NO cache (every read is a
 * fresh Prisma query), so this is a no-op. Exported anyway so that
 * `lib/artifact-apply.ts#applyFaq` and `tools/suggestion-action.ts`
 * FAQ branches can call it symmetrically with their `invalidateSopCache`
 * / `invalidateToolCache` / `invalidateTenantConfigCache` siblings —
 * the moment FAQ caching is introduced, all writers already call the
 * right invalidator.
 *
 * Bugfix (2026-04-23, foot-gun prevention): a reader of artifact-apply.ts
 * sees the SOP/tool/system-prompt invalidation pattern and would
 * naturally believe the FAQ branch is buggy for omitting it; or worse,
 * a future commit adds FAQ caching and forgets to wire all six writers.
 * Symmetric callers means there's no "FAQ is special" carve-out to
 * remember.
 */
export function invalidateFaqCache(_tenantId: string): void {
  // No-op today. See doc comment above.
}

// ════════════════════════════════════════════════════════════════════════════
// §1  getFaqEntries() — list with optional filters
// ════════════════════════════════════════════════════════════════════════════

interface FaqFilters {
  propertyId?: string;
  scope?: string;
  status?: string;
  category?: string;
}

export async function getFaqEntries(
  prisma: PrismaClient,
  tenantId: string,
  filters?: FaqFilters,
): Promise<FaqEntry[]> {
  const where: Record<string, unknown> = { tenantId };
  if (filters?.propertyId) where.propertyId = filters.propertyId;
  if (filters?.scope) where.scope = filters.scope;
  if (filters?.status) where.status = filters.status;
  if (filters?.category) where.category = filters.category;

  return prisma.faqEntry.findMany({
    where: where as any,
    include: { property: { select: { id: true, name: true } } },
    orderBy: [{ category: 'asc' }, { usageCount: 'desc' }],
  });
}

// ════════════════════════════════════════════════════════════════════════════
// §2  createFaqEntry()
// ════════════════════════════════════════════════════════════════════════════

interface CreateFaqData {
  tenantId: string;
  propertyId?: string | null;
  question: string;
  answer: string;
  category: string;
  scope?: string;
  source?: string;
}

export async function createFaqEntry(
  prisma: PrismaClient,
  data: CreateFaqData,
): Promise<FaqEntry> {
  // Validate category
  if (!FAQ_CATEGORIES.includes(data.category as FaqCategory)) {
    const err = new Error(`Invalid category "${data.category}". Must be one of: ${FAQ_CATEGORIES.join(', ')}`) as any;
    err.field = 'category';
    throw err;
  }

  // Validate question + answer
  if (!data.question?.trim()) {
    const err = new Error('Question is required') as any;
    err.field = 'question';
    throw err;
  }
  if (!data.answer?.trim()) {
    const err = new Error('Answer is required') as any;
    err.field = 'answer';
    throw err;
  }

  const isAutoSuggest = data.source === 'AUTO_SUGGESTED';

  return prisma.faqEntry.create({
    data: {
      tenantId: data.tenantId,
      propertyId: data.propertyId || null,
      question: data.question.trim(),
      answer: data.answer.trim(),
      category: data.category,
      scope: (data.scope as any) || (data.propertyId ? 'PROPERTY' : 'GLOBAL'),
      status: isAutoSuggest ? 'SUGGESTED' : 'ACTIVE',
      source: isAutoSuggest ? 'AUTO_SUGGESTED' : 'MANUAL',
    },
  });
}

// ════════════════════════════════════════════════════════════════════════════
// §3  updateFaqEntry()
// ════════════════════════════════════════════════════════════════════════════

interface UpdateFaqData {
  status?: string;
  scope?: string;
  question?: string;
  answer?: string;
  propertyId?: string | null;
  category?: string;
}

export async function updateFaqEntry(
  prisma: PrismaClient,
  id: string,
  tenantId: string,
  data: UpdateFaqData,
): Promise<FaqEntry> {
  const existing = await prisma.faqEntry.findFirst({ where: { id, tenantId } });
  if (!existing) {
    const err = new Error('FAQ entry not found') as any;
    err.status = 404;
    throw err;
  }

  // Validate category if provided
  if (data.category && !FAQ_CATEGORIES.includes(data.category as FaqCategory)) {
    const err = new Error(`Invalid category "${data.category}". Must be one of: ${FAQ_CATEGORIES.join(', ')}`) as any;
    err.field = 'category';
    throw err;
  }

  const updates: Record<string, unknown> = {};
  if (data.status !== undefined) updates.status = data.status;
  if (data.scope !== undefined) updates.scope = data.scope;
  if (data.question !== undefined) updates.question = data.question.trim();
  if (data.answer !== undefined) updates.answer = data.answer.trim();
  if (data.propertyId !== undefined) updates.propertyId = data.propertyId || null;
  if (data.category !== undefined) updates.category = data.category;

  return prisma.faqEntry.update({
    where: { id },
    data: updates as any,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// §4  deleteFaqEntry()
// ════════════════════════════════════════════════════════════════════════════

export async function deleteFaqEntry(
  prisma: PrismaClient,
  id: string,
  tenantId: string,
): Promise<void> {
  const existing = await prisma.faqEntry.findFirst({ where: { id, tenantId } });
  if (!existing) {
    const err = new Error('FAQ entry not found') as any;
    err.status = 404;
    throw err;
  }

  await prisma.faqEntry.delete({ where: { id } });
}

// ════════════════════════════════════════════════════════════════════════════
// §5  getFaqForProperty() — core retrieval for the get_faq tool
// ════════════════════════════════════════════════════════════════════════════

/**
 * Retrieve FAQ entries for a property + category, merging global entries.
 * Property-specific entries override globals when the first 50 chars of the
 * question match (lowercased, trimmed).
 *
 * Returns formatted Markdown string ready for the AI system prompt.
 */
export async function getFaqForProperty(
  prisma: PrismaClient,
  tenantId: string,
  propertyId: string,
  category: string,
): Promise<string> {
  const categoryLabel = FAQ_CATEGORY_LABELS[category as FaqCategory] || category;

  // Fetch property-specific ACTIVE entries for this category.
  // Bugfix (2026-04-22): include scope='PROPERTY' filter so we don't
  // accidentally pick up GLOBAL rows that have a propertyId stamped
  // (possible if a row was inserted via a path that bypassed
  // createFaqEntry's auto-scope, e.g. legacy import or out-of-sync
  // auto-suggest path). Without this filter the same row would appear
  // both as a "property entry" and as a "global entry" → duplicate
  // rendering in the AI's get_faq result.
  const propertyEntries = await prisma.faqEntry.findMany({
    where: {
      tenantId,
      propertyId,
      category,
      status: 'ACTIVE',
      scope: 'PROPERTY',
    },
  });

  // Fetch global ACTIVE entries for this category
  // scope: GLOBAL means available to all properties, regardless of which property created it
  const globalEntries = await prisma.faqEntry.findMany({
    where: {
      tenantId,
      category,
      status: 'ACTIVE',
      scope: 'GLOBAL',
    },
  });

  // Build set of property question fingerprints (first 50 chars, lowercased, trimmed)
  const propertyFingerprints = new Set(
    propertyEntries.map(e => e.question.toLowerCase().trim().substring(0, 50)),
  );

  // Filter globals: exclude where a property entry exists with the same fingerprint
  const filteredGlobals = globalEntries.filter(
    g => !propertyFingerprints.has(g.question.toLowerCase().trim().substring(0, 50)),
  );

  const merged = [...propertyEntries, ...filteredGlobals];

  if (merged.length === 0) {
    return `## FAQ: ${categoryLabel}\n\nNo FAQ entries for this category. Escalate to the manager if the guest needs this information.`;
  }

  // Increment usageCount and update lastUsedAt (fire-and-forget)
  const ids = merged.map(e => e.id);
  prisma.faqEntry.updateMany({
    where: { id: { in: ids } },
    data: {
      usageCount: { increment: 1 },
      lastUsedAt: new Date(),
    },
  }).catch(err => {
    console.warn('[FAQ] Failed to increment usageCount:', err);
  });

  // Format as Markdown
  const lines = merged.map(e => `Q: ${e.question}\nA: ${e.answer}`);
  return `## FAQ: ${categoryLabel}\n\n${lines.join('\n\n')}`;
}

// ════════════════════════════════════════════════════════════════════════════
// §6  getCategoryStats()
// ════════════════════════════════════════════════════════════════════════════

interface CategoryStat {
  id: string;
  label: string;
  count: number;
}

export async function markStaleFaqEntries(prisma: PrismaClient, tenantId: string): Promise<number> {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const result = await prisma.faqEntry.updateMany({
    where: {
      tenantId,
      status: 'ACTIVE',
      OR: [
        { lastUsedAt: { lt: ninetyDaysAgo } },
        { lastUsedAt: null, createdAt: { lt: ninetyDaysAgo } },
      ],
    },
    data: { status: 'STALE' },
  });
  if (result.count > 0) {
    console.log(`[FAQ] Marked ${result.count} stale entries for tenant ${tenantId}`);
  }
  return result.count;
}

export async function expireStaleSuggestions(prisma: PrismaClient, tenantId: string): Promise<number> {
  const fourWeeksAgo = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000);
  const result = await prisma.faqEntry.deleteMany({
    where: {
      tenantId,
      status: 'SUGGESTED',
      createdAt: { lt: fourWeeksAgo },
    },
  });
  if (result.count > 0) {
    console.log(`[FAQ] Expired ${result.count} stale suggestions for tenant ${tenantId}`);
  }
  return result.count;
}

// ════════════════════════════════════════════════════════════════════════════
// §7  getCategoryStats()
// ════════════════════════════════════════════════════════════════════════════

export async function getCategoryStats(
  prisma: PrismaClient,
  tenantId: string,
): Promise<CategoryStat[]> {
  // Count ACTIVE entries per category
  const counts = await prisma.faqEntry.groupBy({
    by: ['category'],
    where: { tenantId, status: 'ACTIVE' },
    _count: { id: true },
  });

  const countMap = new Map(counts.map(c => [c.category, c._count.id]));

  return FAQ_CATEGORIES.map(cat => ({
    id: cat,
    label: FAQ_CATEGORY_LABELS[cat],
    count: countMap.get(cat) || 0,
  }));
}
