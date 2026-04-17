/**
 * Shared logic for the "FAQ suggestion with no faqEntryId" create flow.
 *
 * Both the legacy accept controller and the agent's suggestion_action tool
 * can end up here. Keeping the precedence order in one place prevents the
 * two paths from computing different `finalQuestion` values for the same
 * suggestion, which would cause duplicate FAQ entries (the dedup key is the
 * question text).
 */
import type { PrismaClient } from '@prisma/client';

export type FaqScope = 'GLOBAL' | 'PROPERTY';

export interface FaqAutoCreateInputs {
  /** Free-form overrides from the caller (HTTP body or agent tool args). */
  overrides: {
    editedQuestion?: string | null;
    faqCategory?: string | null;
    faqScope?: FaqScope | null;
    faqPropertyId?: string | null;
  };
  /** The persisted TuningSuggestion columns relevant to FAQ. */
  suggestion: {
    sourceMessageId: string | null;
    beforeText: string | null;
    faqQuestion: string | null;
    faqCategory: string | null;
    faqScope: string | null;
    faqPropertyId: string | null;
  };
}

export interface FaqAutoCreateResolved {
  finalQuestion: string;
  finalCategory: string;
  finalScope: FaqScope;
  finalPropertyId: string | null;
  sourceHint: 'override' | 'persistedQuestion' | 'beforeText' | 'inferred' | 'placeholder';
}

export const DEFAULT_FAQ_CATEGORY = 'property-neighborhood';

export async function resolveFaqAutoCreateFields(
  prisma: PrismaClient,
  tenantId: string,
  inputs: FaqAutoCreateInputs
): Promise<FaqAutoCreateResolved> {
  const overrides = inputs.overrides ?? {};
  const suggestion = inputs.suggestion;

  // 1. Question precedence: HTTP/agent override → persisted question →
  //    persisted beforeText → inferred from source conversation → placeholder.
  //    Both accept paths MUST use this order or they will dedup against
  //    different keys and create duplicate FAQ rows.
  let sourceHint: FaqAutoCreateResolved['sourceHint'] = 'placeholder';
  let finalQuestion: string = '(question — please edit)';
  const overrideQ =
    typeof overrides.editedQuestion === 'string' && overrides.editedQuestion.trim()
      ? overrides.editedQuestion.trim()
      : '';
  const persistedQ =
    suggestion.faqQuestion && suggestion.faqQuestion.trim()
      ? suggestion.faqQuestion.trim()
      : '';
  const beforeQ =
    suggestion.beforeText && suggestion.beforeText.trim() ? suggestion.beforeText.trim() : '';
  if (overrideQ) {
    finalQuestion = overrideQ;
    sourceHint = 'override';
  } else if (persistedQ) {
    finalQuestion = persistedQ;
    sourceHint = 'persistedQuestion';
  } else if (beforeQ) {
    finalQuestion = beforeQ;
    sourceHint = 'beforeText';
  } else if (suggestion.sourceMessageId) {
    const srcMsg = await prisma.message.findFirst({
      where: { id: suggestion.sourceMessageId, tenantId },
      select: { conversationId: true, sentAt: true },
    });
    if (srcMsg?.conversationId && srcMsg.sentAt) {
      const priorGuest = await prisma.message.findFirst({
        where: {
          conversationId: srcMsg.conversationId,
          tenantId,
          role: 'GUEST',
          sentAt: { lte: srcMsg.sentAt },
        },
        orderBy: { sentAt: 'desc' },
        select: { content: true },
      });
      if (priorGuest?.content) {
        const inferred = priorGuest.content.trim();
        if (inferred) {
          finalQuestion = inferred.slice(0, 500);
          sourceHint = 'inferred';
        }
      }
    }
  }

  // 2. Category precedence.
  const overrideCat =
    typeof overrides.faqCategory === 'string' && overrides.faqCategory.trim()
      ? overrides.faqCategory.trim()
      : '';
  const finalCategory = overrideCat || suggestion.faqCategory || DEFAULT_FAQ_CATEGORY;

  // 3. Scope + property precedence.
  const overrideScope: FaqScope | null =
    overrides.faqScope === 'PROPERTY' || overrides.faqScope === 'GLOBAL'
      ? overrides.faqScope
      : null;
  const persistedScope: FaqScope | null =
    suggestion.faqScope === 'PROPERTY' || suggestion.faqScope === 'GLOBAL'
      ? (suggestion.faqScope as FaqScope)
      : null;
  const finalScope: FaqScope = overrideScope ?? persistedScope ?? 'GLOBAL';
  const finalPropertyId: string | null =
    finalScope === 'PROPERTY'
      ? (typeof overrides.faqPropertyId === 'string' && overrides.faqPropertyId) ||
        suggestion.faqPropertyId
      : null;

  return { finalQuestion, finalCategory, finalScope, finalPropertyId, sourceHint };
}

/**
 * Deduplication lookup for FAQ auto-create. Returns the existing row's id if
 * a row with the same (tenantId, propertyId, question) already exists —
 * matching the schema's unique index.
 */
export async function findDuplicateFaqEntry(
  prisma: PrismaClient,
  params: {
    tenantId: string;
    question: string;
    propertyId: string | null;
  }
): Promise<{ id: string } | null> {
  return prisma.faqEntry.findFirst({
    where: {
      tenantId: params.tenantId,
      question: params.question,
      propertyId: params.propertyId,
    },
    select: { id: true },
  });
}
