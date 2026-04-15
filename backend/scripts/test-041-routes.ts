/**
 * Feature 041 sprint 02 — lightweight route-registration smoke.
 *
 * Mirrors scripts/test-040-routes.ts. Validates that the four new /api/tuning
 * and /api/messages routes registered cleanly by importing the route factories
 * directly and walking their internal stacks. Avoids HTTP / nested-regexp
 * parsing.
 *
 * Usage: npx tsx scripts/test-041-routes.ts
 */
process.env.JWT_SECRET ||= 'test-only-stub-secret-for-route-verification';
process.env.OPENAI_API_KEY ||= 'test-only-stub-key';
import 'dotenv/config';

import { PrismaClient } from '@prisma/client';
import { tuningComplaintRouter } from '../src/routes/tuning-complaint';
import { messagesRouter } from '../src/routes/messages';

function routesOf(router: any): Array<{ method: string; path: string }> {
  return (router.stack || [])
    .filter((l: any) => l.route)
    .flatMap((l: any) =>
      Object.keys(l.route.methods).map((m) => ({ method: m.toUpperCase(), path: l.route.path }))
    );
}

function ok(label: string): void {
  console.log(`[041-routes] ✓ ${label}`);
}
function fail(label: string): never {
  console.error(`[041-routes] ✗ ${label}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const tuning = routesOf(tuningComplaintRouter(prisma));
    console.log('[041-routes] /api/tuning routes:', tuning);
    if (!tuning.some((r) => r.method === 'POST' && r.path === '/complaints'))
      fail('POST /api/tuning/complaints missing');
    if (!tuning.some((r) => r.method === 'GET' && r.path === '/category-stats'))
      fail('GET /api/tuning/category-stats missing');
    ok('POST /api/tuning/complaints registered');
    ok('GET /api/tuning/category-stats registered');

    const messages = routesOf(messagesRouter(prisma));
    console.log('[041-routes] /api/messages routes:', messages);
    if (!messages.some((r) => r.method === 'POST' && r.path === '/:id/thumbs-down'))
      fail('POST /api/messages/:id/thumbs-down missing');
    if (!messages.some((r) => r.method === 'POST' && r.path === '/:id/rate'))
      fail('POST /api/messages/:id/rate missing (regression)');
    ok('POST /api/messages/:id/thumbs-down registered');
    ok('POST /api/messages/:id/rate registered (regression check)');

    // Sanity: the tuning service modules load without errors.
    const { runDiagnostic } = await import('../src/services/tuning/diagnostic.service');
    const { writeSuggestionFromDiagnostic } = await import('../src/services/tuning/suggestion-writer.service');
    const { computeMyersDiff, semanticSimilarity, classifyEditMagnitude } = await import('../src/services/tuning/diff.service');
    const { updateCategoryStatsOnAccept } = await import('../src/services/tuning/category-stats.service');
    const { shouldProcessTrigger } = await import('../src/services/tuning/trigger-dedup.service');
    for (const [name, fn] of Object.entries({
      runDiagnostic,
      writeSuggestionFromDiagnostic,
      computeMyersDiff,
      semanticSimilarity,
      classifyEditMagnitude,
      updateCategoryStatsOnAccept,
      shouldProcessTrigger,
    })) {
      if (typeof fn !== 'function') fail(`${name} not exported as function`);
    }
    ok('all tuning service exports load as functions');

    console.log('[041-routes] All sprint-02 route + wiring checks passed ✓');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[041-routes] threw:', err);
  process.exit(1);
});
