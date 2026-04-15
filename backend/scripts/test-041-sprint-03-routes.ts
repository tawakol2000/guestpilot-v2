/**
 * Feature 041 sprint 03 — route-registration smoke for the tuning surface.
 *
 * Verifies the new additive routes registered cleanly. Doesn't perform HTTP
 * — imports each router factory and walks its internal stack the same way
 * scripts/test-041-routes.ts does for sprint 02.
 *
 * Usage: npx tsx scripts/test-041-sprint-03-routes.ts
 */
process.env.JWT_SECRET ||= 'test-only-stub-secret-for-route-verification';
process.env.OPENAI_API_KEY ||= 'test-only-stub-key';
import 'dotenv/config';

import { PrismaClient } from '@prisma/client';
import {
  tuningDashboardsRouter,
  tuningHistoryRouter,
  evidenceBundleRouter,
  capabilityRequestsRouter,
} from '../src/routes/tuning-surface';
import { tuningSuggestionRouter } from '../src/routes/tuning-suggestion';

function routesOf(router: any): Array<{ method: string; path: string }> {
  return (router.stack || [])
    .filter((l: any) => l.route)
    .flatMap((l: any) =>
      Object.keys(l.route.methods).map((m) => ({
        method: m.toUpperCase(),
        path: l.route.path,
      })),
    );
}

function ok(label: string): void {
  console.log(`[041-sprint-03-routes] ✓ ${label}`);
}
function fail(label: string): never {
  console.error(`[041-sprint-03-routes] ✗ ${label}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const dashboards = routesOf(tuningDashboardsRouter(prisma));
    if (!dashboards.some((r) => r.method === 'GET' && r.path === '/coverage'))
      fail('GET /api/tuning/coverage missing');
    if (!dashboards.some((r) => r.method === 'GET' && r.path === '/graduation-metrics'))
      fail('GET /api/tuning/graduation-metrics missing');
    ok('GET /api/tuning/coverage registered');
    ok('GET /api/tuning/graduation-metrics registered');

    const history = routesOf(tuningHistoryRouter(prisma));
    if (!history.some((r) => r.method === 'GET' && r.path === '/history'))
      fail('GET /api/tuning/history missing');
    if (!history.some((r) => r.method === 'POST' && r.path === '/history/rollback'))
      fail('POST /api/tuning/history/rollback missing');
    ok('GET /api/tuning/history registered');
    ok('POST /api/tuning/history/rollback registered');

    const bundle = routesOf(evidenceBundleRouter(prisma));
    if (!bundle.some((r) => r.method === 'GET' && r.path === '/:id'))
      fail('GET /api/evidence-bundles/:id missing');
    ok('GET /api/evidence-bundles/:id registered');

    const caps = routesOf(capabilityRequestsRouter(prisma));
    if (!caps.some((r) => r.method === 'GET' && r.path === '/'))
      fail('GET /api/capability-requests missing');
    if (!caps.some((r) => r.method === 'PATCH' && r.path === '/:id'))
      fail('PATCH /api/capability-requests/:id missing');
    ok('GET /api/capability-requests registered');
    ok('PATCH /api/capability-requests/:id registered');

    const suggestions = routesOf(tuningSuggestionRouter(prisma));
    if (!suggestions.some((r) => r.method === 'POST' && r.path === '/:id/accept-tool-config'))
      fail('POST /api/tuning-suggestions/:id/accept-tool-config missing');
    if (!suggestions.some((r) => r.method === 'POST' && r.path === '/:id/accept'))
      fail('POST /api/tuning-suggestions/:id/accept missing (regression)');
    if (!suggestions.some((r) => r.method === 'POST' && r.path === '/:id/reject'))
      fail('POST /api/tuning-suggestions/:id/reject missing (regression)');
    ok('POST /api/tuning-suggestions/:id/accept-tool-config registered');
    ok('POST /api/tuning-suggestions/:id/accept registered (regression)');
    ok('POST /api/tuning-suggestions/:id/reject registered (regression)');

    // Sanity: new service modules load without throwing.
    const { recordPreferencePair } = await import('../src/services/tuning/preference-pair.service');
    if (typeof recordPreferencePair !== 'function')
      fail('recordPreferencePair not exported as function');
    ok('preference-pair service exports load as functions');

    console.log('[041-sprint-03-routes] All sprint-03 route + wiring checks passed ✓');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[041-sprint-03-routes] threw:', err);
  process.exit(1);
});
