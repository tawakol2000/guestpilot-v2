/**
 * Studio Demo Seeder
 * ──────────────────
 *
 * Populates a local Postgres with a demo tenant + a kitchen-sink
 * TuningConversation that exercises every currently-shipped Studio
 * feature. Paired with the dev-login bypass (see backend/src/middleware/
 * auth.ts and frontend/app/dev-login) so a single URL boots you into
 * the Studio surface with the demo chat loaded.
 *
 * Usage (from repo root):
 *
 *   cd backend && npm run seed:studio-demo
 *
 * Or run the whole harness with:
 *
 *   ./scripts/demo.sh
 *
 * Idempotent: running twice upserts the tenant and replaces the demo
 * conversation + its BuildArtifactHistory ledger rows. Safe to re-run
 * after schema changes.
 *
 * The final log line prints the dev-login URL you paste into your
 * browser — bypasses the login form, opens /?tab=studio&conversationId=…
 * with the demo chat already selected.
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const prisma = new PrismaClient();

const DEMO_EMAIL = 'demo@studio.local';
const DEMO_PASSWORD = 'demo1234';
const DEMO_TITLE = 'Studio Kitchen Sink Demo';

// One fixed ISO anchor so the seeded rows have stable relative ordering.
// The conversation looks like it spanned ~45 minutes on the given day.
const T0 = new Date('2026-04-20T09:00:00.000Z').getTime();
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

type Part = Record<string, unknown>;

// ─── Helpers ───────────────────────────────────────────────────────────────

function textPart(text: string, opts: { origin?: 'ai' | 'human' | 'mixed' } = {}): Part {
  return { type: 'text', text, ...(opts.origin ? { providerMetadata: { origin: opts.origin } } : {}) };
}

function reasoningPart(text: string, durationMs = 4_200): Part {
  return {
    type: 'reasoning',
    text,
    providerMetadata: { durationMs },
  };
}

function toolCallPart(toolName: string, input: unknown, output?: unknown, id?: string): Part {
  const toolCallId = id ?? `tc_${crypto.randomBytes(6).toString('hex')}`;
  return {
    type: `tool-${toolName}`,
    toolName,
    toolCallId,
    state: output === undefined ? 'input-available' : 'output-available',
    input,
    ...(output === undefined ? {} : { output }),
  };
}

function dataPart(type: string, data: unknown, id?: string): Part {
  return { type, id: id ?? `dp_${crypto.randomBytes(6).toString('hex')}`, data };
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('[seed-studio-demo] starting…');

  // 1. Tenant — upsert by email.
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
  const tenant = await prisma.tenant.upsert({
    where: { email: DEMO_EMAIL },
    create: {
      email: DEMO_EMAIL,
      name: 'Studio Demo Tenant',
      passwordHash,
      hostawayApiKey: 'demo-api-key-not-real',
      hostawayAccountId: 'demo-account-12345',
      webhookSecret: crypto.randomBytes(16).toString('hex'),
      plan: 'FREE',
      isAdmin: true,
    },
    update: {
      passwordHash,
      name: 'Studio Demo Tenant',
      isAdmin: true,
    },
  });
  console.log(`[seed-studio-demo] tenant.id = ${tenant.id}`);

  // 2. TenantAiConfig — upsert (required by several Studio reads).
  await prisma.tenantAiConfig.upsert({
    where: { tenantId: tenant.id },
    create: {
      tenantId: tenant.id,
      agentName: 'Omar',
      agentPersonality: 'Warm, efficient, proactive.',
      customInstructions: 'Always confirm check-in time before sending door code.',
      systemPromptCoordinator: '# Coordinator prompt\n\nBe helpful, brief, and accurate.',
      systemPromptScreening: '# Screening prompt\n\nVerify passport before releasing access codes.',
    },
    update: {},
  });

  // 3. A throw-away Property so any SOP/FAQ joins resolve cleanly.
  const property = await prisma.property.upsert({
    where: { id: `demo-prop-${tenant.id}` },
    create: {
      id: `demo-prop-${tenant.id}`,
      tenantId: tenant.id,
      hostawayListingId: 'demo-listing-001',
      name: 'Sunset Lofts · Unit 3B',
      address: '123 Demo Street, Demo City',
      listingDescription: 'Cozy 1-bedroom loft in the heart of the demo district.',
    },
    update: {},
  });

  // 4. A demo SopDefinition with a couple of variants — targets for BuildArtifactHistory.
  const sop = await prisma.sopDefinition.upsert({
    where: { tenantId_category: { tenantId: tenant.id, category: 'sop-early-check-in' } },
    create: {
      tenantId: tenant.id,
      category: 'sop-early-check-in',
      toolDescription: 'Guest requests to arrive before standard check-in time.',
      variants: {
        create: [
          {
            status: 'DEFAULT',
            content: 'Offer paid early check-in at $25/hour before 3pm. Confirm in writing.',
          },
          {
            status: 'CONFIRMED',
            content: 'Paid early check-in available at $25/hour before 3pm. Payment via the link we send.',
          },
        ],
      },
    },
    update: {
      toolDescription: 'Guest requests to arrive before standard check-in time.',
    },
    include: { variants: true },
  });

  // 5. A demo FAQ entry.
  const faq = await prisma.faqEntry.upsert({
    where: { id: `demo-faq-${tenant.id}` },
    create: {
      id: `demo-faq-${tenant.id}`,
      tenantId: tenant.id,
      category: 'wifi',
      question: 'What is the WiFi password?',
      answer: 'Your WiFi credentials are in the welcome packet delivered at check-in.',
      status: 'ACTIVE',
    },
    update: {},
  });

  // 6. BuildTransaction — plan with one cancelled row (F2 demo).
  //    Idempotency: delete any prior demo txn for this tenant so the history
  //    rows + plan reset cleanly.
  await prisma.buildTransaction.deleteMany({
    where: { tenantId: tenant.id, rationale: { startsWith: '[DEMO]' } },
  });
  const txn = await prisma.buildTransaction.create({
    data: {
      tenantId: tenant.id,
      conversationId: null, // filled in later, after the TuningConversation exists
      status: 'COMPLETED',
      rationale: '[DEMO] Early-checkin rollout — 3 artifacts',
      plannedItems: [
        { type: 'sop', name: 'sop-early-check-in', rationale: 'Codify the $25/hr offer' },
        { type: 'faq', name: 'early-check-in-faq', rationale: 'One-liner guests can self-serve' },
        {
          type: 'tool_definition',
          name: 'check_paid_early_checkin_slot',
          rationale: 'Availability helper (cancelled — out of scope this week)',
        },
      ],
      // Index 2 (the tool def) is the cancelled row — demonstrates the × state in PlanChecklist.
      cancelledItemIndexes: [2],
      completedAt: at(16),
    },
  });

  // 7. Wipe + recreate the demo TuningConversation (idempotency).
  const existing = await prisma.tuningConversation.findMany({
    where: { tenantId: tenant.id, title: DEMO_TITLE },
    select: { id: true },
  });
  if (existing.length > 0) {
    await prisma.tuningConversation.deleteMany({ where: { id: { in: existing.map((e) => e.id) } } });
  }

  const convo = await prisma.tuningConversation.create({
    data: {
      tenantId: tenant.id,
      title: DEMO_TITLE,
      triggerType: 'MANUAL',
      status: 'OPEN',
      createdAt: at(0),
      updatedAt: at(42),
    },
  });
  console.log(`[seed-studio-demo] conversation.id = ${convo.id}`);

  await prisma.buildTransaction.update({
    where: { id: txn.id },
    data: { conversationId: convo.id },
  });

  // 8. TuningMessage rows — a guided tour of every shipped Studio feature.
  //    Each row touches one or more of: text, reasoning-line, tool-chain
  //    summary, data-state-snapshot, data-build-plan, data-test-pipeline-result,
  //    data-suggested-fix, data-audit-report, data-session-diff-summary,
  //    data-artifact-quote, data-advisory, typographic attribution.

  const msgs: Array<{ role: string; parts: Part[]; createdAt: Date }> = [];

  // Turn 1 — user introduces the job.
  msgs.push({
    role: 'user',
    parts: [
      textPart("Hey — let's set up the hotel AI. It's a small serviced-apartment operation, two buildings."),
    ],
    createdAt: at(0),
  });

  // Turn 1 response — reasoning line + state snapshot + intro.
  msgs.push({
    role: 'assistant',
    parts: [
      reasoningPart(
        'The tenant just introduced themselves. I should pull current state before proposing anything — no prompt yet, no SOPs beyond defaults, likely brownfield.',
        3_800,
      ),
      toolCallPart('get_current_state', { scope: 'tenant' }, {
        tenantState: 'BROWNFIELD',
        interviewProgress: { completedSlots: 2, totalSlots: 9 },
        counts: { sops: 1, faqs: 1, properties: 1 },
      }),
      dataPart('data-state-snapshot', {
        scope: 'summary',
        summary: {
          posture: 'BROWNFIELD',
          systemPromptStatus: 'DEFAULT',
          systemPromptEditCount: 1,
          sopsDefined: 1,
          sopsDefaulted: 1,
          faqsGlobal: 1,
          faqsPropertyScoped: 0,
          customToolsDefined: 0,
          propertiesImported: 1,
          lastBuildSessionAt: at(-60 * 24 * 2).toISOString(),
        },
      }),
      textPart(
        "Welcome aboard. I can see you already have one SOP and one FAQ on file, plus one listing — so the basics are already live. Before we add anything new, let me ask: what's your biggest guest-reply headache right now?",
        { origin: 'ai' },
      ),
    ],
    createdAt: at(1),
  });

  // Turn 2 — user answers.
  msgs.push({
    role: 'user',
    parts: [textPart('Early check-ins. Guests ask all the time, answers are inconsistent across my team.')],
    createdAt: at(3),
  });

  // Turn 2 response — suggested fix card.
  msgs.push({
    role: 'assistant',
    parts: [
      textPart('Good target — "inconsistent" usually means the policy lives in one manager\'s head. Let\'s write it down.', { origin: 'ai' }),
      dataPart('data-suggested-fix', {
        id: 'fix:demo-early-checkin-1',
        target: { artifact: 'sop', sopCategory: 'sop-early-check-in', sopStatus: 'DEFAULT' },
        before: 'Offer paid early check-in at $25/hour before 3pm. Confirm in writing.',
        after:
          'Offer paid early check-in at $25/hour before 3pm, rounded up to the nearest hour. Confirm in writing before the guest arrives. If the unit is still occupied, decline politely and offer luggage storage.',
        rationale:
          'Adds the "still occupied" branch and the rounding rule — both are sources of inconsistent answers today.',
        impact: 'Closes the two most common escalation triggers on the early-checkin SOP.',
        category: 'SOP_CONTENT',
        createdAt: at(4).toISOString(),
      }),
    ],
    createdAt: at(4),
  });

  // Turn 3 — user asks for a plan.
  msgs.push({
    role: 'user',
    parts: [textPart("Yeah, do the SOP rewrite, and add an FAQ version so guests can self-serve on Airbnb. Don't build a tool for it — overkill.")],
    createdAt: at(6),
  });

  // Turn 3 response — plan checklist. Mid-stream we cancel row 2 (the tool).
  msgs.push({
    role: 'assistant',
    parts: [
      reasoningPart(
        'Operator wants 2 artifacts and explicitly rejected the 3rd (tool). I will emit a plan with 3 items and pre-flag the tool row as cancelled so the × state shows in the checklist.',
        5_100,
      ),
      textPart("Got it — plan below. I've flagged the tool idea as cancelled per your call.", { origin: 'ai' }),
      dataPart('data-build-plan', {
        transactionId: txn.id,
        rationale: 'Early-checkin rollout',
        items: [
          { type: 'sop', name: 'sop-early-check-in', rationale: 'Codify the $25/hr offer with the occupied-unit branch', status: 'done' },
          { type: 'faq', name: 'early-check-in-faq', rationale: 'One-liner guests can self-serve', status: 'done' },
          {
            type: 'tool_definition',
            name: 'check_paid_early_checkin_slot',
            rationale: 'Availability helper (cancelled — operator declined)',
            status: 'cancelled',
          },
        ],
        cancelledItemIndexes: [2],
      }),
    ],
    createdAt: at(8),
  });

  // Turn 4 — user "approves".
  msgs.push({
    role: 'user',
    parts: [textPart('Approved. Run it.')],
    createdAt: at(10),
  });

  // Turn 4 response — tool chain executes.
  msgs.push({
    role: 'assistant',
    parts: [
      toolCallPart(
        'create_sop',
        {
          category: 'sop-early-check-in',
          status: 'DEFAULT',
          content:
            'Offer paid early check-in at $25/hour before 3pm, rounded up to the nearest hour. Confirm in writing before the guest arrives. If the unit is still occupied, decline politely and offer luggage storage.',
        },
        { ok: true, sopId: sop.id, variantId: sop.variants[0]?.id ?? 'v0' },
      ),
      toolCallPart(
        'create_faq',
        {
          category: 'early-check-in',
          question: 'Can I check in early?',
          answer: 'We offer paid early check-in at $25/hour before 3pm, subject to unit availability.',
        },
        { ok: true, faqId: faq.id },
      ),
      dataPart('data-build-history', {
        transactionId: txn.id,
        entries: [
          { type: 'sop', name: 'sop-early-check-in' },
          { type: 'faq', name: 'early-check-in-faq' },
        ],
      }),
      textPart('Both artifacts written. Want to verify with a test guest message?', { origin: 'ai' }),
    ],
    createdAt: at(11),
  });

  // Turn 5 — user says yes, test.
  msgs.push({
    role: 'user',
    parts: [textPart("Yeah, try: 'Hey, any chance we can come by at 11am?'")],
    createdAt: at(13),
  });

  // Turn 5 response — test_pipeline tool + result.
  msgs.push({
    role: 'assistant',
    parts: [
      toolCallPart(
        'test_pipeline',
        {
          guestMessage: 'Hey, any chance we can come by at 11am?',
          reservationStatus: 'CONFIRMED',
        },
        {
          ok: true,
          judgeScore: 0.87,
          judgePromptVersion: '058-a1',
          sourceWriteHistoryId: 'pending', // replaced below with real id
          sourceWriteLabel: 'create_sop · sop-early-check-in · DEFAULT',
        },
      ),
      dataPart('data-test-pipeline-result', {
        ok: true,
        aggregateVerdict: 'all_passed',
        ritualVersion: '058-a1',
        sourceWriteHistoryId: null,
        sourceWriteLabel: null,
        ritualCallsRemaining: 4,
        variants: [
          {
            triggerMessage: 'Hey, any chance we can come by at 11am?',
            pipelineOutput:
              "Hi Jamie! Early check-in at 11am is possible for a fee of $100 (4 hours × $25/hr). I'll confirm once the previous guest has checked out — usually by 10:30am. Sound good?",
            verdict: 'passed',
            judgeReasoning:
              'Reply applies the $25/hr policy correctly, offers written confirmation, and handles the occupied-unit branch. Could be warmer on the opening.',
            judgeScore: 0.87,
            judgePromptVersion: '058-a1',
            judgeModel: 'claude-sonnet-4-6',
            replyModel: 'gpt-5.4-mini',
            latencyMs: 2_340,
            ranAt: at(16).toISOString(),
          },
        ],
      }),
      textPart('Judge scored 0.87 — solid. One nit: the opening line could be warmer. Want me to tune the tone?', { origin: 'ai' }),
    ],
    createdAt: at(16),
  });

  // Turn 6 — user adds a human note (edit-before-send).
  msgs.push({
    role: 'user',
    parts: [
      textPart(
        "Yeah, make it start with 'Hi Jamie — great to hear from you,' instead of 'Hi Jamie!'",
        { origin: 'human' },
      ),
    ],
    createdAt: at(18),
  });

  // Turn 6 response — audit report + artifact quote.
  msgs.push({
    role: 'assistant',
    parts: [
      reasoningPart('Operator corrected the opening line. I should quote the current SOP verbatim so they can see what changed.', 2_900),
      dataPart('data-artifact-quote', {
        artifact: 'sop',
        artifactId: sop.id,
        sourceLabel: 'SOP: sop-early-check-in · DEFAULT',
        body:
          'Offer paid early check-in at $25/hour before 3pm, rounded up to the nearest hour. Confirm in writing before the guest arrives. If the unit is still occupied, decline politely and offer luggage storage.',
      }),
      dataPart('data-audit-report', {
        summary: '2 gaps across 4 artifacts',
        topFindingId: 'finding:brand-voice',
        rows: [
          { artifact: 'system_prompt', label: 'System prompt (coordinator)', status: 'warn', note: 'No brand-voice guidance set.', findingId: 'finding:brand-voice' },
          { artifact: 'sop', artifactId: sop.id, label: 'SOP: early-check-in', status: 'ok', note: 'Updated this session.' },
          { artifact: 'faq', artifactId: faq.id, label: 'FAQ: early-check-in', status: 'ok', note: 'New — consistent with SOP.' },
          { artifact: 'tool_definition', label: 'Tool: check_paid_early_checkin_slot', status: 'gap', note: 'Operator explicitly deferred this.' },
        ],
      }),
    ],
    createdAt: at(20),
  });

  // Turn 7 — user wants the brand voice update.
  msgs.push({
    role: 'user',
    parts: [textPart("Add a brand-voice note to the system prompt: 'warm but efficient, British spelling, no exclamation points outside apology lines.'")],
    createdAt: at(22),
  });

  // Turn 7 response — write_system_prompt + advisory (recent-edit).
  msgs.push({
    role: 'assistant',
    parts: [
      dataPart('data-advisory', {
        kind: 'recent-edit',
        message: 'You edited the coordinator system prompt 18 minutes ago — applying this change will bump to v2.',
        context: { lastEditAt: at(4).toISOString(), priorVersion: 1 },
      }),
      toolCallPart(
        'write_system_prompt',
        {
          variant: 'coordinator',
          append:
            '\n\n## Brand voice\n\nWarm but efficient. British spelling. No exclamation points outside apology lines.',
        },
        { ok: true, newVersion: 2, historyId: 'hist:placeholder' },
      ),
      dataPart('data-build-history', {
        transactionId: txn.id,
        entries: [{ type: 'system_prompt', name: 'coordinator' }],
      }),
      textPart(
        'Coordinator prompt now at v2. I pinned the prior version as **v1-stable** so you can roll back any time from the Versions tab.',
        { origin: 'ai' },
      ),
    ],
    createdAt: at(26),
  });

  // Turn 8 — user asks for session summary.
  msgs.push({
    role: 'user',
    parts: [textPart("Give me the tl;dr of this session so I can paste it to the team.")],
    createdAt: at(38),
  });

  // Turn 8 response — emit_session_summary + session-diff card.
  msgs.push({
    role: 'assistant',
    parts: [
      toolCallPart('emit_session_summary', { conversationId: convo.id }, { ok: true }),
      dataPart('data-session-diff-summary', {
        written: { created: 1, edited: 2, reverted: 0 },
        tested: { runs: 1, totalVariants: 1, passed: 1 },
        plans: { cancelled: 1 },
        note: '1 SOP updated, 1 FAQ created, coordinator prompt bumped to v2. 1 tool deferred.',
      }),
      textPart("Here's what landed this session. The tool-config row is a ghost — operator declined.", { origin: 'ai' }),
    ],
    createdAt: at(42),
  });

  // 9. Write TuningMessages.
  for (const m of msgs) {
    await prisma.tuningMessage.create({
      data: {
        conversationId: convo.id,
        role: m.role,
        parts: m.parts as object,
        createdAt: m.createdAt,
      },
    });
  }
  console.log(`[seed-studio-demo] wrote ${msgs.length} TuningMessage rows`);

  // 10. BuildArtifactHistory — three versions of the SOP so the Versions
  //     tab has content, with two named tags.
  await prisma.buildArtifactHistory.deleteMany({
    where: { tenantId: tenant.id, artifactType: 'sop', artifactId: sop.id },
  });
  const histV1 = await prisma.buildArtifactHistory.create({
    data: {
      tenantId: tenant.id,
      artifactType: 'sop',
      artifactId: sop.id,
      operation: 'CREATE',
      prevBody: undefined as unknown as object,
      newBody: {
        category: 'sop-early-check-in',
        status: 'DEFAULT',
        content: 'Offer paid early check-in at $25/hour before 3pm. Confirm in writing.',
      },
      actorEmail: DEMO_EMAIL,
      conversationId: convo.id,
      versionLabel: 'v1-stable',
      createdAt: at(-60 * 24 * 14), // two weeks ago
    },
  });
  const histV2 = await prisma.buildArtifactHistory.create({
    data: {
      tenantId: tenant.id,
      artifactType: 'sop',
      artifactId: sop.id,
      operation: 'UPDATE',
      prevBody: histV1.newBody as object,
      newBody: {
        category: 'sop-early-check-in',
        status: 'DEFAULT',
        content:
          'Offer paid early check-in at $25/hour before 3pm, rounded up to the nearest hour. Confirm in writing before the guest arrives. If the unit is still occupied, decline politely and offer luggage storage.',
      },
      actorEmail: DEMO_EMAIL,
      conversationId: convo.id,
      versionLabel: null,
      createdAt: at(11),
    },
  });
  const _histV3 = await prisma.buildArtifactHistory.create({
    data: {
      tenantId: tenant.id,
      artifactType: 'sop',
      artifactId: sop.id,
      operation: 'UPDATE',
      prevBody: histV2.newBody as object,
      newBody: {
        category: 'sop-early-check-in',
        status: 'DEFAULT',
        content:
          'Offer paid early check-in at $25/hour before 3pm, rounded up to the nearest hour. Confirm in writing. If the unit is still occupied, decline politely and offer luggage storage. On weekends, waive the fee for stays of 5+ nights.',
      },
      actorEmail: DEMO_EMAIL,
      conversationId: convo.id,
      versionLabel: 'weekend-override',
      createdAt: at(42),
    },
  });

  // System-prompt history — two versions so the banner's "v2" reference resolves.
  await prisma.buildArtifactHistory.deleteMany({
    where: { tenantId: tenant.id, artifactType: 'system_prompt' },
  });
  await prisma.buildArtifactHistory.create({
    data: {
      tenantId: tenant.id,
      artifactType: 'system_prompt',
      artifactId: `system-prompt-coordinator-${tenant.id}`,
      operation: 'CREATE',
      prevBody: undefined as unknown as object,
      newBody: { variant: 'coordinator', version: 1, content: '# Coordinator prompt\n\nBe helpful, brief, and accurate.' },
      actorEmail: DEMO_EMAIL,
      conversationId: convo.id,
      versionLabel: 'v1-stable',
      createdAt: at(-60 * 24 * 7),
    },
  });
  await prisma.buildArtifactHistory.create({
    data: {
      tenantId: tenant.id,
      artifactType: 'system_prompt',
      artifactId: `system-prompt-coordinator-${tenant.id}`,
      operation: 'UPDATE',
      prevBody: { variant: 'coordinator', version: 1, content: '# Coordinator prompt\n\nBe helpful, brief, and accurate.' },
      newBody: {
        variant: 'coordinator',
        version: 2,
        content:
          '# Coordinator prompt\n\nBe helpful, brief, and accurate.\n\n## Brand voice\n\nWarm but efficient. British spelling. No exclamation points outside apology lines.',
      },
      actorEmail: DEMO_EMAIL,
      conversationId: convo.id,
      versionLabel: null,
      createdAt: at(26),
    },
  });

  console.log('[seed-studio-demo] wrote BuildArtifactHistory ledger rows (3 SOP + 2 system-prompt)');

  // 11. Print the one URL you paste.
  const port = process.env.FRONTEND_PORT ?? '3000';
  const devLoginUrl = `http://localhost:${port}/dev-login?tenantId=${tenant.id}&conversationId=${convo.id}`;
  console.log('\n──────────────────────────────────────────────────────────────');
  console.log(' Demo ready. Paste this URL in your browser:');
  console.log('');
  console.log(`   ${devLoginUrl}`);
  console.log('');
  console.log(' (Requires DEV_AUTH_BYPASS=1 on the backend and NODE_ENV != production.)');
  console.log('──────────────────────────────────────────────────────────────');
}

main()
  .catch((err) => {
    console.error('[seed-studio-demo] error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
