/**
 * Feature 041 sprint 04 — route-registration smoke for the tuning agent
 * chat + conversation endpoints. Mirrors the sprint-02/03 scripts: import
 * the router factory, walk its stack, assert expected (method,path) pairs.
 *
 * Usage: npx tsx scripts/test-041-sprint-04-routes.ts
 */
// MUST be the first import — seeds env defaults before any transitive
// import reaches the auth middleware's eager JWT_SECRET check.
import './_smoke-env';

import { PrismaClient } from '@prisma/client';
import { tuningChatRouter } from '../src/routes/tuning-chat';

function routesOf(router: any): Array<{ method: string; path: string }> {
  return (router.stack || [])
    .filter((l: any) => l.route)
    .flatMap((l: any) =>
      Object.keys(l.route.methods).map((m) => ({ method: m.toUpperCase(), path: l.route.path }))
    );
}

function ok(label: string) {
  console.log(`[041-sprint-04-routes] ✓ ${label}`);
}
function fail(label: string): never {
  console.error(`[041-sprint-04-routes] ✗ ${label}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const router = tuningChatRouter(prisma);
    const routes = routesOf(router);
    console.log('[041-sprint-04-routes] /api/tuning routes:', routes);

    const expect: Array<[string, string]> = [
      ['POST', '/conversations'],
      ['GET', '/conversations'],
      ['GET', '/conversations/:id'],
      ['PATCH', '/conversations/:id'],
      ['POST', '/chat'],
    ];
    for (const [method, path] of expect) {
      if (!routes.some((r) => r.method === method && r.path === path)) {
        fail(`${method} /api/tuning${path} missing`);
      }
      ok(`${method} /api/tuning${path} registered`);
    }

    // Sanity: tuning-agent module loads without errors + public API present.
    const ta = await import('../src/tuning-agent');
    for (const fn of [
      'runTuningAgentTurn',
      'assembleSystemPrompt',
      'viewMemory',
      'createMemory',
      'updateMemory',
      'deleteMemory',
      'listMemoryByPrefix',
      'isTuningAgentEnabled',
      'tuningAgentDisabledReason',
      'resolveTuningAgentModel',
    ] as const) {
      if (typeof (ta as any)[fn] !== 'function') fail(`tuning-agent missing export: ${fn}`);
    }
    if (typeof ta.DYNAMIC_BOUNDARY_MARKER !== 'string') fail('DYNAMIC_BOUNDARY_MARKER missing');
    ok('tuning-agent public API exports present');

    // Static prompt should embed the cache boundary marker.
    const prompt = ta.assembleSystemPrompt({
      tenantId: 't',
      conversationId: 'c',
      anchorMessageId: null,
      selectedSuggestionId: null,
      memorySnapshot: [],
      pending: { total: 0, countsByCategory: {}, topThree: [] },
    });
    if (!prompt.includes(ta.DYNAMIC_BOUNDARY_MARKER))
      fail('system prompt must embed DYNAMIC_BOUNDARY_MARKER');
    ok('system prompt embeds cache boundary');

    console.log('[041-sprint-04-routes] All sprint-04 route + wiring checks passed ✓');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[041-sprint-04-routes] threw:', err);
  process.exit(1);
});
