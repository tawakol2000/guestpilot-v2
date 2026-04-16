/**
 * Integration: sprint-04 suggestion_action(apply) on a fixture suggestion.
 * Exercises the EDIT_FAQ apply path end-to-end:
 *   - artifact write (FaqEntry.answer updated)
 *   - status flips to ACCEPTED
 *   - category-stats EMA updates
 *   - SopVariantHistory / FaqEntryHistory snapshot row written (sprint 05 §2)
 */
// MUST be first — seeds env before suggestion-action's transitive import
// graph reaches the auth middleware's eager JWT_SECRET check.
import './_env-bootstrap';

import { test, after, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { PrismaClient, TuningActionType } from '@prisma/client';
import { buildSuggestionActionTool } from '../../tuning-agent/tools/suggestion-action';
import type { ToolContext } from '../../tuning-agent/tools/types';
import { buildFixture, type IntegrationFixture } from './_fixture';

const prisma = new PrismaClient();
let fx: IntegrationFixture;
let faqId: string;
let suggestionId: string;

// Tiny stub `tool()` factory that captures the handler so we can call it
// directly without spinning the SDK.
function makeStubTool() {
  let captured: any = null;
  function tool(_name: string, _desc: string, _schema: any, handler: any) {
    captured = handler;
    return { name: _name, handler };
  }
  return { tool, getHandler: () => captured };
}

before(async () => {
  fx = await buildFixture(prisma);
  const faq = await prisma.faqEntry.create({
    data: {
      tenantId: fx.tenantId,
      propertyId: fx.propertyId,
      question: 'What time is check-in?',
      answer: 'Check-in is at 4 PM, no exceptions.',
      category: 'check-in',
      scope: 'PROPERTY',
      status: 'ACTIVE',
      source: 'MANUAL',
    },
  });
  faqId = faq.id;
  const sugg = await prisma.tuningSuggestion.create({
    data: {
      tenantId: fx.tenantId,
      sourceMessageId: fx.aiMessageId,
      actionType: TuningActionType.EDIT_FAQ,
      status: 'PENDING',
      rationale: 'FAQ answer was too rigid; soften.',
      beforeText: 'Check-in is at 4 PM, no exceptions.',
      proposedText: 'Check-in is from 3 PM. Earlier check-in subject to availability.',
      faqEntryId: faqId,
      diagnosticCategory: 'FAQ',
      diagnosticSubLabel: 'integration-checkin-tone',
      confidence: 0.78,
    },
  });
  suggestionId = sugg.id;
});

after(async () => {
  if (fx) await fx.cleanup();
  await prisma.$disconnect();
});

test('suggestion_action(apply) on EDIT_FAQ writes artifact + ACCEPTED + stats + history snapshot', async () => {
  const stub = makeStubTool();
  const ctx: ToolContext = {
    prisma,
    tenantId: fx.tenantId,
    userId: 'TEST_user',
    conversationId: null,
    lastUserSanctionedApply: true,
  };
  buildSuggestionActionTool(stub.tool as any, () => ctx);
  const handler = stub.getHandler();
  assert.ok(handler, 'tool handler captured');

  const result = await handler({
    suggestionId,
    action: 'apply',
  });

  // The MCP tool returns a CallToolResult with content[].text JSON. Parse the
  // first text block to assert on the payload.
  assert.ok(result && Array.isArray(result.content));
  const text = result.content[0]?.text ?? result.content[0]?.value;
  assert.ok(text, 'tool returned text content');
  const payload = JSON.parse(text);
  assert.equal(payload.suggestionId, suggestionId);
  assert.equal(payload.status, 'ACCEPTED');

  // Artifact write happened.
  const faq = await prisma.faqEntry.findUnique({ where: { id: faqId } });
  assert.match(String(faq?.answer), /from 3 PM/);

  // Suggestion status flipped + appliedAt set.
  const sugg = await prisma.tuningSuggestion.findUnique({ where: { id: suggestionId } });
  assert.equal(sugg?.status, 'ACCEPTED');
  assert.ok(sugg?.appliedAt);
  assert.equal(sugg?.applyMode, 'IMMEDIATE');

  // Category-stats EMA updated for FAQ.
  const stats = await prisma.tuningCategoryStats.findUnique({
    where: { tenantId_category: { tenantId: fx.tenantId, category: 'FAQ' } },
  });
  assert.ok(stats, 'category stats row created');
  assert.equal(stats?.acceptCount, 1);

  // Sprint 05 §2: FaqEntryHistory snapshot row written before the update.
  const history = await prisma.faqEntryHistory.findMany({
    where: { tenantId: fx.tenantId, targetId: faqId },
  });
  assert.equal(history.length, 1);
  const snap = history[0].previousContent as any;
  assert.equal(snap.answer, 'Check-in is at 4 PM, no exceptions.');
  assert.equal(history[0].triggeringSuggestionId, suggestionId);
});
