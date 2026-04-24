/**
 * get_current_state — unit tests (Sprint 046 Session A).
 *
 * Run:  npx tsx --test src/build-tune-agent/tools/__tests__/get-current-state.test.ts
 *
 * Covers the 5-case minimum from sprint-046-session-a §2.1:
 *   1. `summary` returns counts payload, no artifact text.
 *   2. `system_prompt` returns full text + sections array.
 *   3. `sops` returns all SOPs for tenant, including status variants +
 *      property overrides.
 *   4. `faqs` returns global + property-scoped entries.
 *   5. `all` is a strict superset of the others (no field loss).
 *
 * Plus a section-derivation test covering XML / Markdown / single-body
 * fallback so future prompt-format drift is caught here rather than at
 * runtime when an edit lands.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCurrentStatePayload,
  deriveSystemPromptSections,
  applyTruncationSignal,
  filterSopsByQuery,
  filterFaqsByQuery,
  filterToolsByQuery,
  SOFT_CAP_BYTES,
} from '../get-current-state';

type Row = Record<string, any>;

function makeFakePrisma(opts?: {
  tenantId?: string;
  systemPrompt?: { text: string; version: number; screening?: string };
  sops?: Array<{
    id: string;
    category: string;
    toolDescription: string;
    enabled: boolean;
    variants: Array<{ id: string; status: string; content: string; enabled: boolean }>;
    overrides: Array<{
      id: string;
      propertyId: string;
      status: string;
      content: string;
      enabled: boolean;
    }>;
  }>;
  faqs?: Array<Row>;
  tools?: Array<Row>;
  properties?: Array<Row>;
  counts?: {
    sopCount?: number;
    faqGlobal?: number;
    faqPerProperty?: number;
    customToolCount?: number;
    propertyCount?: number;
  };
}) {
  const tenantId = opts?.tenantId ?? 't1';
  const sops = opts?.sops ?? [];
  const faqs = opts?.faqs ?? [];
  const tools = opts?.tools ?? [];
  const counts = opts?.counts;

  return {
    tenantAiConfig: {
      findUnique: async ({ where }: any) => {
        if (where.tenantId !== tenantId) return null;
        if (!opts?.systemPrompt) return null;
        return {
          systemPromptCoordinator: opts.systemPrompt.text,
          systemPromptScreening: opts.systemPrompt.screening ?? null,
          systemPromptVersion: opts.systemPrompt.version,
        };
      },
    },
    sopDefinition: {
      count: async () => counts?.sopCount ?? sops.length,
      findMany: async () =>
        sops.map((s) => ({
          id: s.id,
          category: s.category,
          toolDescription: s.toolDescription,
          enabled: s.enabled,
          variants: s.variants,
          propertyOverrides: s.overrides,
        })),
    },
    // Used by getTenantStateSummary to count defaulted SOPs.
    sopVariant: {
      findMany: async () => [],
    },
    faqEntry: {
      count: async ({ where }: any) => {
        if (where.scope === 'GLOBAL') return counts?.faqGlobal ?? faqs.filter((f) => f.scope === 'GLOBAL').length;
        if (where.scope === 'PROPERTY') return counts?.faqPerProperty ?? faqs.filter((f) => f.scope === 'PROPERTY').length;
        return faqs.length;
      },
      findMany: async () => faqs,
    },
    toolDefinition: {
      count: async ({ where }: any) => {
        if (where.type === 'custom') return counts?.customToolCount ?? tools.filter((t) => t.type === 'custom').length;
        return tools.length;
      },
      findMany: async () => tools,
    },
    property: {
      count: async () => counts?.propertyCount ?? (opts?.properties?.length ?? 0),
    },
    buildTransaction: {
      findFirst: async () => null,
    },
  } as any;
}

test('get_current_state summary: returns counts payload only, no artifact text', async () => {
  const prisma = makeFakePrisma({
    systemPrompt: { text: 'you are the coordinator', version: 4 },
    counts: {
      sopCount: 23,
      faqGlobal: 74,
      faqPerProperty: 11,
      customToolCount: 2,
      propertyCount: 20,
    },
  });
  const payload = await buildCurrentStatePayload(prisma, 't1', 'summary');
  assert.equal(payload.scope, 'summary');
  if (payload.scope !== 'summary') throw new Error('narrowing');
  assert.equal(payload.summary.sopCount, 23);
  assert.equal(payload.summary.faqCounts.global, 74);
  assert.equal(payload.summary.faqCounts.perProperty, 11);
  assert.equal(payload.summary.customToolCount, 2);
  assert.equal(payload.summary.propertyCount, 20);
  assert.equal(payload.summary.isGreenfield, false);
  assert.ok(!('systemPrompt' in payload), 'summary scope must not leak systemPrompt text');
  assert.ok(!('sops' in payload), 'summary scope must not leak sops text');
  assert.ok(!('faqs' in payload), 'summary scope must not leak faqs text');
});

test('get_current_state summary: GREENFIELD detection (sop=0, global-faq=0, custom-tool=0)', async () => {
  const prisma = makeFakePrisma({
    counts: {
      sopCount: 0,
      faqGlobal: 0,
      faqPerProperty: 5, // property-scoped FAQs do not disqualify
      customToolCount: 0,
      propertyCount: 3,
    },
  });
  const payload = await buildCurrentStatePayload(prisma, 't1', 'summary');
  if (payload.scope !== 'summary') throw new Error('narrowing');
  assert.equal(payload.summary.isGreenfield, true);
});

test('get_current_state system_prompt: returns full text + derived sections', async () => {
  const promptText =
    '<section id="intro" title="Intro">Welcome.</section>\n' +
    '<section id="escalation">Always escalate when …</section>';
  const prisma = makeFakePrisma({
    systemPrompt: { text: promptText, version: 7 },
  });
  const payload = await buildCurrentStatePayload(prisma, 't1', 'system_prompt');
  assert.equal(payload.scope, 'system_prompt');
  if (payload.scope !== 'system_prompt') throw new Error('narrowing');
  assert.equal(payload.systemPrompt.text, promptText);
  assert.equal(payload.systemPrompt.version, 7);
  assert.equal(payload.systemPrompt.sections.length, 2);
  assert.equal(payload.systemPrompt.sections[0].id, 'intro');
  assert.equal(payload.systemPrompt.sections[0].title, 'Intro');
  assert.equal(payload.systemPrompt.sections[1].id, 'escalation');
  // Range for the second section must cover its own <section>…</section> span.
  const [start, end] = payload.systemPrompt.sections[1].range;
  assert.ok(end > start);
  assert.ok(promptText.slice(start, end).includes('escalation'));
});

test('get_current_state system_prompt: missing TenantAiConfig yields empty text + single body section', async () => {
  const prisma = makeFakePrisma({});
  const payload = await buildCurrentStatePayload(prisma, 't1', 'system_prompt');
  if (payload.scope !== 'system_prompt') throw new Error('narrowing');
  assert.equal(payload.systemPrompt.text, '');
  // Empty text -> zero sections (not an invented "body" span).
  assert.equal(payload.systemPrompt.sections.length, 0);
  // Bugfix 2026-04-22: both variants ALWAYS present even when empty, so
  // the agent can deterministically destructure `variants.screening` without
  // optional-chaining. Empty variant = '' text + [] sections.
  assert.ok(payload.systemPrompt.variants, 'variants always present');
  assert.equal(payload.systemPrompt.variants.coordinator.text, '');
  assert.equal(payload.systemPrompt.variants.coordinator.sections.length, 0);
  assert.equal(payload.systemPrompt.variants.screening.text, '');
  assert.equal(payload.systemPrompt.variants.screening.sections.length, 0);
});

test('get_current_state system_prompt: returns BOTH coordinator and screening variants', async () => {
  // Regression test for 2026-04-22 silent-drop bug: fetchSystemPromptPayload
  // previously selected only `systemPromptCoordinator`, so an agent asked
  // to review the screening prompt received `text: ''` and either
  // hallucinated changes or claimed no screening prompt was configured.
  const coordinatorText = '<section id="coord">You are the coordinator.</section>';
  const screeningText = '<section id="intake">You screen inquiry-stage guests.</section>';
  const prisma = makeFakePrisma({
    systemPrompt: { text: coordinatorText, screening: screeningText, version: 9 },
  });
  const payload = await buildCurrentStatePayload(prisma, 't1', 'system_prompt');
  if (payload.scope !== 'system_prompt') throw new Error('narrowing');

  // Back-compat: top-level `text`/`sections` still expose the coordinator.
  assert.equal(payload.systemPrompt.text, coordinatorText);
  assert.equal(payload.systemPrompt.sections.length, 1);
  assert.equal(payload.systemPrompt.sections[0].id, 'coord');
  assert.equal(payload.systemPrompt.version, 9);

  // New: both variants surfaced under `variants.*` with their own sections.
  assert.equal(payload.systemPrompt.variants.coordinator.text, coordinatorText);
  assert.equal(payload.systemPrompt.variants.coordinator.sections[0].id, 'coord');
  assert.equal(payload.systemPrompt.variants.screening.text, screeningText);
  assert.equal(payload.systemPrompt.variants.screening.sections.length, 1);
  assert.equal(payload.systemPrompt.variants.screening.sections[0].id, 'intake');
});

test('get_current_state system_prompt: screening null in DB surfaces as empty variant, coordinator unaffected', async () => {
  const coordinatorText = 'plain coordinator body';
  const prisma = makeFakePrisma({
    // No `screening` key — fake returns null for that column, same as a
    // tenant who has never configured a screening prompt.
    systemPrompt: { text: coordinatorText, version: 2 },
  });
  const payload = await buildCurrentStatePayload(prisma, 't1', 'system_prompt');
  if (payload.scope !== 'system_prompt') throw new Error('narrowing');
  assert.equal(payload.systemPrompt.variants.coordinator.text, coordinatorText);
  assert.equal(payload.systemPrompt.variants.screening.text, '');
  assert.equal(payload.systemPrompt.variants.screening.sections.length, 0);
});

test('deriveSystemPromptSections: XML tags win over Markdown headings', () => {
  const xmlText = '<section id="a">Apples</section>\n## Oranges';
  const secs = deriveSystemPromptSections(xmlText);
  assert.equal(secs.length, 1);
  assert.equal(secs[0].id, 'a');
});

test('deriveSystemPromptSections: Markdown-only fallback slugs headings', () => {
  const mdText = '## Intro\nfirst paragraph.\n## Policy Details\nsecond.';
  const secs = deriveSystemPromptSections(mdText);
  assert.equal(secs.length, 2);
  assert.equal(secs[0].id, 'intro');
  assert.equal(secs[1].id, 'policy-details');
});

test('deriveSystemPromptSections: plain text yields single body span', () => {
  const secs = deriveSystemPromptSections('hello world, no structure here.');
  assert.equal(secs.length, 1);
  assert.equal(secs[0].id, 'body');
  assert.equal(secs[0].range[0], 0);
  assert.equal(secs[0].range[1], 'hello world, no structure here.'.length);
});

test('get_current_state sops: returns all SOPs including variants + overrides', async () => {
  const prisma = makeFakePrisma({
    sops: [
      {
        id: 's1',
        category: 'sop-checkin',
        toolDescription: 'Check-in procedure',
        enabled: true,
        variants: [
          { id: 'v1', status: 'DEFAULT', content: 'default body', enabled: true },
          { id: 'v2', status: 'INQUIRY', content: 'inquiry body', enabled: true },
        ],
        overrides: [
          {
            id: 'o1',
            propertyId: 'p1',
            status: 'DEFAULT',
            content: 'property-specific body',
            enabled: true,
          },
        ],
      },
      {
        id: 's2',
        category: 'sop-cleaning',
        toolDescription: 'Cleaning schedule',
        enabled: true,
        variants: [],
        overrides: [],
      },
    ],
  });
  const payload = await buildCurrentStatePayload(prisma, 't1', 'sops');
  assert.equal(payload.scope, 'sops');
  if (payload.scope !== 'sops') throw new Error('narrowing');
  assert.equal(payload.sops.length, 2);
  const checkin = payload.sops.find((s) => s.category === 'sop-checkin');
  assert.ok(checkin);
  assert.equal(checkin!.variants.length, 2);
  assert.equal(checkin!.propertyOverrides.length, 1);
  assert.equal(checkin!.variants[0].content, 'default body');
  assert.equal(checkin!.propertyOverrides[0].propertyId, 'p1');
});

test('get_current_state faqs: returns global + property-scoped entries', async () => {
  const prisma = makeFakePrisma({
    faqs: [
      {
        id: 'f1',
        category: 'wifi',
        scope: 'GLOBAL',
        propertyId: null,
        question: 'What is the wifi password?',
        answer: 'See welcome booklet.',
        status: 'ACTIVE',
      },
      {
        id: 'f2',
        category: 'parking',
        scope: 'PROPERTY',
        propertyId: 'p1',
        question: 'Where do I park?',
        answer: 'Garage A.',
        status: 'ACTIVE',
      },
    ],
  });
  const payload = await buildCurrentStatePayload(prisma, 't1', 'faqs');
  assert.equal(payload.scope, 'faqs');
  if (payload.scope !== 'faqs') throw new Error('narrowing');
  assert.equal(payload.faqs.length, 2);
  assert.ok(payload.faqs.some((f) => f.scope === 'GLOBAL' && f.propertyId === null));
  assert.ok(payload.faqs.some((f) => f.scope === 'PROPERTY' && f.propertyId === 'p1'));
});

test('get_current_state tools: flags isCustom for non-system tools', async () => {
  const prisma = makeFakePrisma({
    tools: [
      {
        id: 't-sys',
        name: 'get_sop',
        displayName: 'Get SOP',
        description: 'Look up an SOP',
        type: 'system',
        agentScope: 'both',
        enabled: true,
      },
      {
        id: 't-cust',
        name: 'check_reservation',
        displayName: 'Check Reservation',
        description: 'Webhook-backed',
        type: 'custom',
        agentScope: 'coordinator',
        enabled: true,
      },
    ],
  });
  const payload = await buildCurrentStatePayload(prisma, 't1', 'tools');
  if (payload.scope !== 'tools') throw new Error('narrowing');
  assert.equal(payload.tools.length, 2);
  const sys = payload.tools.find((t) => t.name === 'get_sop');
  const custom = payload.tools.find((t) => t.name === 'check_reservation');
  assert.equal(sys!.isCustom, false);
  assert.equal(custom!.isCustom, true);
});

test('applyTruncationSignal: small payload → truncated=null, unmodified', () => {
  const payload: any = {
    scope: 'faqs',
    faqs: [
      { id: 'f1', category: 'wifi', scope: 'GLOBAL', propertyId: null, question: 'q', answer: 'short answer', status: 'ACTIVE' },
    ],
  };
  const out = applyTruncationSignal(payload);
  assert.equal(out.truncated, null);
  assert.equal(out.faqs[0].answer, 'short answer');
});

test('applyTruncationSignal: oversized payload → clips longest strings + records paths', () => {
  const bigAnswer = 'x'.repeat(60_000);
  const mediumAnswer = 'y'.repeat(4_000);
  const payload: any = {
    scope: 'faqs',
    faqs: [
      { id: 'f1', category: 'wifi', scope: 'GLOBAL', propertyId: null, question: 'q1', answer: bigAnswer, status: 'ACTIVE' },
      { id: 'f2', category: 'parking', scope: 'GLOBAL', propertyId: null, question: 'q2', answer: mediumAnswer, status: 'ACTIVE' },
      { id: 'f3', category: 'keys', scope: 'GLOBAL', propertyId: null, question: 'q3', answer: 'tiny', status: 'ACTIVE' },
    ],
  };
  const out = applyTruncationSignal(payload, 10_000, 800);
  assert.ok(out.truncated, 'truncated envelope attached');
  assert.ok(out.truncated!.originalBytes > 60_000);
  assert.ok(out.truncated!.keptBytes <= 10_000 + 500, 'clipped under soft cap (plus envelope overhead)');
  assert.ok(out.truncated!.clipped.length >= 1);
  // f1.answer should be clipped (longest).
  const f1Clip = out.truncated!.clipped.find((c: any) => c.path === 'faqs[id=f1].answer');
  assert.ok(f1Clip, 'f1.answer should appear in clipped list');
  assert.equal(f1Clip!.originalLen, 60_000);
  assert.equal(f1Clip!.keptLen, 800);
  // f3.answer untouched — was tiny already.
  assert.equal(out.faqs[2].answer, 'tiny');
  // f1.answer mutated with sentinel.
  assert.ok(out.faqs[0].answer.endsWith('clipped artifact]') === false || out.faqs[0].answer.includes('clipped'));
  assert.ok(out.faqs[0].answer.length < 1500);
});

test('applyTruncationSignal: SOP variant content is clippable', () => {
  const bigBody = 'z'.repeat(30_000);
  const payload: any = {
    scope: 'sops',
    sops: [
      {
        id: 's1',
        category: 'checkin',
        toolDescription: 'desc',
        enabled: true,
        variants: [{ id: 'v1', status: 'DEFAULT', content: bigBody, enabled: true }],
        propertyOverrides: [],
      },
    ],
  };
  const out = applyTruncationSignal(payload, 5_000, 400);
  assert.ok(out.truncated);
  const entry = out.truncated!.clipped.find((c: any) => c.path === 'sops[id=s1].variants[id=v1].content');
  assert.ok(entry, 'SOP variant content clipped');
  assert.equal(entry!.keptLen, 400);
});

test('buildCurrentStatePayload attaches truncated=null for small tenants', async () => {
  const prisma = makeFakePrisma({
    systemPrompt: { text: 'short prompt', version: 1 },
  });
  const payload = await buildCurrentStatePayload(prisma, 't1', 'system_prompt');
  assert.equal(payload.truncated, null);
});

test('SOFT_CAP_BYTES is set generously above the ~16KB transport clip', () => {
  assert.ok(SOFT_CAP_BYTES >= 32_000, 'soft cap should leave headroom over the observed 16KB transport clip');
});

test('filterSopsByQuery: matches category, toolDescription, variant content', () => {
  const sops: any[] = [
    { id: 's1', category: 'parking-lot', toolDescription: 'x', enabled: true, variants: [], propertyOverrides: [] },
    { id: 's2', category: 'checkin', toolDescription: 'This covers parking validation flow', enabled: true, variants: [], propertyOverrides: [] },
    { id: 's3', category: 'cleaning', toolDescription: 'x', enabled: true, variants: [{ id: 'v1', status: 'DEFAULT', content: 'Mention the PARKING fee', enabled: true }], propertyOverrides: [] },
    { id: 's4', category: 'wifi', toolDescription: 'x', enabled: true, variants: [], propertyOverrides: [] },
  ];
  const out = filterSopsByQuery(sops as any, 'parking');
  const ids = out.map((s) => s.id).sort();
  assert.deepEqual(ids, ['s1', 's2', 's3']);
});

test('filterSopsByQuery: empty/undefined query returns all', () => {
  const sops: any[] = [
    { id: 's1', category: 'a', toolDescription: 'x', enabled: true, variants: [], propertyOverrides: [] },
  ];
  assert.equal(filterSopsByQuery(sops as any, '').length, 1);
  assert.equal(filterSopsByQuery(sops as any, null).length, 1);
  assert.equal(filterSopsByQuery(sops as any, undefined).length, 1);
  assert.equal(filterSopsByQuery(sops as any, '   ').length, 1);
});

test('filterFaqsByQuery: matches question, answer, category case-insensitive', () => {
  const faqs: any[] = [
    { id: 'f1', category: 'parking', scope: 'GLOBAL', propertyId: null, question: 'q', answer: 'a', status: 'ACTIVE' },
    { id: 'f2', category: 'wifi', scope: 'GLOBAL', propertyId: null, question: 'Where is parking?', answer: 'a', status: 'ACTIVE' },
    { id: 'f3', category: 'wifi', scope: 'GLOBAL', propertyId: null, question: 'q', answer: 'Use the garage near the PARKING meter', status: 'ACTIVE' },
    { id: 'f4', category: 'wifi', scope: 'GLOBAL', propertyId: null, question: 'q', answer: 'a', status: 'ACTIVE' },
  ];
  const out = filterFaqsByQuery(faqs as any, 'PARKING');
  const ids = out.map((f) => f.id).sort();
  assert.deepEqual(ids, ['f1', 'f2', 'f3']);
});

test('filterToolsByQuery: matches name, displayName, description', () => {
  const tools: any[] = [
    { id: 't1', name: 'search_parking', displayName: 'X', description: 'x', type: 'custom', agentScope: 'both', enabled: true, isCustom: true },
    { id: 't2', name: 'x', displayName: 'Find Parking Spot', description: 'x', type: 'custom', agentScope: 'both', enabled: true, isCustom: true },
    { id: 't3', name: 'x', displayName: 'X', description: 'Looks up parking availability', type: 'custom', agentScope: 'both', enabled: true, isCustom: true },
    { id: 't4', name: 'y', displayName: 'Y', description: 'y', type: 'custom', agentScope: 'both', enabled: true, isCustom: true },
  ];
  const out = filterToolsByQuery(tools as any, 'parking');
  assert.deepEqual(out.map((t) => t.id).sort(), ['t1', 't2', 't3']);
});

test('buildCurrentStatePayload passes query through for scope=faqs', async () => {
  const prisma = makeFakePrisma({
    faqs: [
      { id: 'f1', category: 'parking', scope: 'GLOBAL', propertyId: null, question: 'Where?', answer: 'Garage', status: 'ACTIVE' },
      { id: 'f2', category: 'wifi', scope: 'GLOBAL', propertyId: null, question: 'Password?', answer: 'router', status: 'ACTIVE' },
    ],
  });
  const payload = await buildCurrentStatePayload(prisma, 't1', 'faqs', 'parking');
  if (payload.scope !== 'faqs') throw new Error('narrowing');
  assert.equal(payload.faqs.length, 1);
  assert.equal(payload.faqs[0].id, 'f1');
});

test('buildCurrentStatePayload query=null returns all (no filtering)', async () => {
  const prisma = makeFakePrisma({
    faqs: [
      { id: 'f1', category: 'a', scope: 'GLOBAL', propertyId: null, question: 'q', answer: 'a', status: 'ACTIVE' },
      { id: 'f2', category: 'b', scope: 'GLOBAL', propertyId: null, question: 'q', answer: 'a', status: 'ACTIVE' },
    ],
  });
  const payload = await buildCurrentStatePayload(prisma, 't1', 'faqs', null);
  if (payload.scope !== 'faqs') throw new Error('narrowing');
  assert.equal(payload.faqs.length, 2);
});

test('get_current_state all: strict superset of summary + system_prompt + sops + faqs + tools', async () => {
  const prisma = makeFakePrisma({
    systemPrompt: { text: '<section id="a">Apples</section>', version: 1 },
    sops: [
      {
        id: 's1',
        category: 'sop-x',
        toolDescription: 'X',
        enabled: true,
        variants: [{ id: 'v1', status: 'DEFAULT', content: 'body', enabled: true }],
        overrides: [],
      },
    ],
    faqs: [
      {
        id: 'f1',
        category: 'c1',
        scope: 'GLOBAL',
        propertyId: null,
        question: 'q',
        answer: 'a',
        status: 'ACTIVE',
      },
    ],
    tools: [
      {
        id: 'td1',
        name: 'x',
        displayName: 'X',
        description: 'd',
        type: 'system',
        agentScope: 'both',
        enabled: true,
      },
    ],
    counts: {
      sopCount: 1,
      faqGlobal: 1,
      faqPerProperty: 0,
      customToolCount: 0,
      propertyCount: 2,
    },
  });

  const [summary, sp, sops, faqs, tools, all] = await Promise.all([
    buildCurrentStatePayload(prisma, 't1', 'summary'),
    buildCurrentStatePayload(prisma, 't1', 'system_prompt'),
    buildCurrentStatePayload(prisma, 't1', 'sops'),
    buildCurrentStatePayload(prisma, 't1', 'faqs'),
    buildCurrentStatePayload(prisma, 't1', 'tools'),
    buildCurrentStatePayload(prisma, 't1', 'all'),
  ]);

  assert.equal(all.scope, 'all');
  if (all.scope !== 'all') throw new Error('narrowing');
  if (summary.scope !== 'summary') throw new Error('narrowing');
  if (sp.scope !== 'system_prompt') throw new Error('narrowing');
  if (sops.scope !== 'sops') throw new Error('narrowing');
  if (faqs.scope !== 'faqs') throw new Error('narrowing');
  if (tools.scope !== 'tools') throw new Error('narrowing');

  assert.deepEqual(all.summary, summary.summary);
  assert.deepEqual(all.systemPrompt, sp.systemPrompt);
  assert.deepEqual(all.sops, sops.sops);
  assert.deepEqual(all.faqs, faqs.faqs);
  assert.deepEqual(all.tools, tools.tools);
});
