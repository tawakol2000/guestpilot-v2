/**
 * Feature 040: Copilot Shadow Mode — Tuning Analyzer Service.
 *
 * Two-step fire-and-forget analyzer that runs after an edited preview is sent.
 *
 * Step 1 (Classification — gpt-5-nano): Receives the edit diff plus lightweight
 *   summaries (SOP category names + tool descriptions, FAQ category names, system
 *   prompt variant names). Classifies which artifact(s) need examination.
 *
 * Step 2 (Suggestion — gpt-5.4-mini reasoning:high): Loads ONLY the specific
 *   content identified in Step 1 and generates concrete EDIT/CREATE suggestions.
 *
 * This avoids the previous approach of dumping all FAQs + full system prompts
 * into a single call (~12K tokens). The two-step pipeline typically runs at
 * ~2-5K total tokens.
 *
 * Per constitution §I Graceful Degradation, analyzer failures MUST NOT block
 * the Send response — the top-level call site always wraps this in .catch().
 */
import OpenAI from 'openai';
import { PrismaClient, TuningActionType } from '@prisma/client';
import { broadcastCritical } from './socket.service';
import { FAQ_CATEGORIES, FAQ_CATEGORY_LABELS } from '../config/faq-categories';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Models ─────────────────────────────────────────────────────────────────────
const CLASSIFIER_MODEL = 'gpt-5-nano';
const ANALYZER_MODEL = 'gpt-5.4-mini-2026-03-17';
const ANALYZER_REASONING_EFFORT = 'high' as const;

// ─── Step 1 schema: classify which artifacts to examine ─────────────────────────
const CLASSIFICATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['targets'],
  properties: {
    targets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'systemPromptVariant', 'sopCategory', 'sopStatus', 'faqCategory'],
        properties: {
          type: {
            type: 'string',
            enum: [
              'system_prompt',   // load the full system prompt for this variant
              'sop_content',     // load the SOP variant content for this category+status
              'sop_routing',     // load the SOP tool description for this category
              'faq_category',    // load FAQ entries for this category
              'create_sop',      // no content to load — suggest creating a new SOP
              'create_faq',      // no content to load — suggest creating a new FAQ
            ],
          },
          systemPromptVariant: { type: ['string', 'null'] },
          sopCategory: { type: ['string', 'null'] },
          sopStatus: { type: ['string', 'null'] },
          faqCategory: { type: ['string', 'null'] },
        },
      },
    },
  },
} as const;

// ─── Step 2 schema: generate concrete suggestions ───────────────────────────────
const TUNING_ANALYZER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['suggestions'],
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'actionType',
          'rationale',
          'beforeText',
          'proposedText',
          'systemPromptVariant',
          'sopCategory',
          'sopStatus',
          'sopPropertyId',
          'sopToolDescription',
          'faqEntryId',
          'faqCategory',
          'faqScope',
          'faqPropertyId',
          'faqQuestion',
          'faqAnswer',
        ],
        properties: {
          actionType: {
            type: 'string',
            enum: [
              'EDIT_SYSTEM_PROMPT',
              'EDIT_SOP_CONTENT',
              'EDIT_SOP_ROUTING',
              'EDIT_FAQ',
              'CREATE_SOP',
              'CREATE_FAQ',
            ],
          },
          rationale: { type: 'string' },
          beforeText: { type: ['string', 'null'] },
          proposedText: { type: ['string', 'null'] },
          systemPromptVariant: { type: ['string', 'null'] },
          sopCategory: { type: ['string', 'null'] },
          sopStatus: { type: ['string', 'null'] },
          sopPropertyId: { type: ['string', 'null'] },
          sopToolDescription: { type: ['string', 'null'] },
          faqEntryId: { type: ['string', 'null'] },
          faqCategory: { type: ['string', 'null'] },
          faqScope: { type: ['string', 'null'] },
          faqPropertyId: { type: ['string', 'null'] },
          faqQuestion: { type: ['string', 'null'] },
          faqAnswer: { type: ['string', 'null'] },
        },
      },
    },
  },
} as const;

// Module-level Prisma reference.
let _prismaRef: PrismaClient | null = null;
export function setTuningAnalyzerPrisma(prisma: PrismaClient): void {
  _prismaRef = prisma;
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

/** Parse JSON from a Responses API response, trying output_text then output array. */
function extractResponseJson<T>(response: any): T | null {
  const outputText: string | undefined = response?.output_text;
  if (outputText) {
    try { return JSON.parse(outputText); } catch {}
  }
  if (Array.isArray(response?.output)) {
    for (const item of response.output) {
      if (item?.type === 'message' && Array.isArray(item.content)) {
        for (const block of item.content) {
          if (block?.type === 'output_text' && typeof block.text === 'string') {
            try { return JSON.parse(block.text); } catch {}
          }
        }
      }
    }
  }
  return null;
}

// ─── Main entry point ───────────────────────────────────────────────────────────

export async function analyzePreview(messageId: string): Promise<void> {
  if (!_prismaRef) {
    console.warn('[tuning-analyzer] prisma not set — skipping');
    return;
  }
  const prisma = _prismaRef;

  try {
    const message = await prisma.message.findUnique({
      where: { id: messageId },
      include: {
        conversation: {
          include: {
            property: true,
            messages: { orderBy: { sentAt: 'desc' }, take: 10 },
          },
        },
      },
    });

    if (!message) {
      console.warn(`[tuning-analyzer] [${messageId}] message not found — skipping`);
      return;
    }

    if (!message.originalAiText || message.originalAiText === message.content) {
      return;
    }

    // ─── Load lightweight context for classification ─────────────────────

    // SOP categories: name + tool description (no content)
    const sopDefs = await prisma.sopDefinition.findMany({
      where: { tenantId: message.tenantId },
      select: { category: true, toolDescription: true },
    });
    const sopSummary = sopDefs
      .map(d => `- ${d.category}: ${d.toolDescription.substring(0, 120)}`)
      .join('\n');

    // FAQ categories: just the fixed category names
    const faqCategorySummary = FAQ_CATEGORIES
      .map(c => `- ${c}: ${FAQ_CATEGORY_LABELS[c]}`)
      .join('\n');

    // Conversation history (last 10, oldest first)
    const conversationHistory = message.conversation.messages
      .slice()
      .reverse()
      .map(m => `[${m.role}] ${m.content.substring(0, 200)}`)
      .join('\n');

    // Tool trace from AiApiLog (if available)
    const aiApiLog = message.aiApiLogId
      ? await prisma.aiApiLog.findUnique({ where: { id: message.aiApiLogId } }).catch(() => null)
      : null;
    const ragContext = (aiApiLog?.ragContext as any) || {};
    const toolTrace = ragContext?.toolNames || ragContext?.toolName
      ? `Tools used: ${(ragContext.toolNames || [ragContext.toolName]).join(', ')}`
      : 'no tools used';
    const sopClassification = ragContext?.sopCategories
      ? `SOP classified as: ${ragContext.sopCategories.join(', ')}`
      : '';

    // ─── Step 1: Classification (cheap, gpt-5-nano) ─────────────────────

    const classificationPrompt = `You are a root-cause classifier for an AI guest-services platform.

A human operator edited an AI-generated reply before sending it. Your job is to classify which AI artifacts (system prompts, SOPs, FAQ entries) are likely the root cause, so we can load ONLY the relevant content for deeper analysis.

## Edit diff
ORIGINAL AI DRAFT:
${message.originalAiText}

OPERATOR'S FINAL TEXT:
${message.content}

## Recent conversation (last 10 messages)
${conversationHistory}

## AI generation context
${toolTrace}
${sopClassification}

## Available SOP categories (name: description)
${sopSummary || 'no SOPs configured'}

## Available FAQ categories
${faqCategorySummary}

## System prompt variants
- coordinator: Main agent prompt for confirmed/checked-in guests
- screening: Screening agent prompt for inquiry/pending guests

Based on the edit, identify 1-3 targets to examine. For each target, specify which type and the relevant category/variant.
- If the AI's tone or approach was wrong → system_prompt
- If the AI used wrong SOP content → sop_content (specify category + status)
- If the AI routed to the wrong SOP → sop_routing (specify category)
- If the AI gave wrong factual info that should be in FAQ → faq_category (specify category)
- If a needed SOP doesn't exist → create_sop
- If a needed FAQ doesn't exist → create_faq
- If the edit was purely cosmetic (whitespace, emoji, minor rewording), return an empty targets array.`;

    const classifyResponse = await (openai as any).responses.create({
      model: CLASSIFIER_MODEL,
      input: [{ role: 'user', content: classificationPrompt }],
      text: {
        format: {
          type: 'json_schema',
          name: 'tuning_classification',
          strict: true,
          schema: CLASSIFICATION_SCHEMA,
        },
      },
    });

    const classification = extractResponseJson<{ targets: Array<Record<string, unknown>> }>(classifyResponse);
    if (!classification || !Array.isArray(classification.targets) || classification.targets.length === 0) {
      console.log(`[tuning-analyzer] [${messageId}] classifier returned no targets — edit likely cosmetic`);
      return;
    }

    console.log(`[tuning-analyzer] [${messageId}] classified ${classification.targets.length} target(s):`,
      classification.targets.map(t => `${t.type}${t.sopCategory ? ':' + t.sopCategory : ''}${t.faqCategory ? ':' + t.faqCategory : ''}${t.systemPromptVariant ? ':' + t.systemPromptVariant : ''}`).join(', ')
    );

    // ─── Step 2: Load targeted content ──────────────────────────────────

    const contextSections: string[] = [];

    for (const target of classification.targets) {
      switch (target.type) {
        case 'system_prompt': {
          const variant = target.systemPromptVariant as string || 'coordinator';
          const config = await prisma.tenantAiConfig.findUnique({
            where: { tenantId: message.tenantId },
            select: { systemPromptCoordinator: true, systemPromptScreening: true },
          });
          const prompt = variant === 'screening'
            ? config?.systemPromptScreening
            : config?.systemPromptCoordinator;
          if (prompt) {
            contextSections.push(`## System prompt (${variant})\n${prompt.substring(0, 6000)}`);
          }
          break;
        }
        case 'sop_content': {
          const cat = target.sopCategory as string;
          const status = target.sopStatus as string || 'DEFAULT';
          if (!cat) break;
          const sopDef = await prisma.sopDefinition.findFirst({
            where: { tenantId: message.tenantId, category: cat },
            include: { variants: { where: { status } } },
          });
          if (sopDef?.variants?.[0]) {
            contextSections.push(`## SOP content: ${cat} @ ${status}\n${sopDef.variants[0].content.substring(0, 3000)}`);
          }
          // Also check property override if conversation has a property
          if (sopDef && message.conversation.propertyId) {
            const override = await prisma.sopPropertyOverride.findFirst({
              where: { sopDefinitionId: sopDef.id, propertyId: message.conversation.propertyId, status },
            });
            if (override) {
              contextSections.push(`## SOP property override: ${cat} @ ${status} (property ${message.conversation.propertyId})\n${override.content.substring(0, 2000)}`);
            }
          }
          break;
        }
        case 'sop_routing': {
          const cat = target.sopCategory as string;
          if (!cat) break;
          const sopDef = await prisma.sopDefinition.findFirst({
            where: { tenantId: message.tenantId, category: cat },
            select: { toolDescription: true, category: true },
          });
          if (sopDef) {
            contextSections.push(`## SOP routing: ${cat}\nTool description: ${sopDef.toolDescription}`);
          }
          break;
        }
        case 'faq_category': {
          const cat = target.faqCategory as string;
          if (!cat) break;
          const entries = await prisma.faqEntry.findMany({
            where: {
              tenantId: message.tenantId,
              category: cat,
              status: 'ACTIVE',
              OR: [
                { scope: 'GLOBAL' },
                ...(message.conversation.propertyId ? [{ propertyId: message.conversation.propertyId }] : []),
              ],
            },
            take: 30,
          });
          if (entries.length > 0) {
            const faqText = entries
              .map(f => `- [${f.id}] Q: ${f.question}\n  A: ${f.answer.substring(0, 200)}`)
              .join('\n');
            contextSections.push(`## FAQ entries: ${cat} (${entries.length} entries)\n${faqText}`);
          }
          break;
        }
        // create_sop and create_faq don't need to load existing content
      }
    }

    // ─── Step 2: Generate suggestions (smart, reasoning:high) ───────────

    const suggestionSystemPrompt = `You are a Tuning Analyzer for an AI guest-services platform.

A human operator edited an AI-generated reply before sending it to a guest. Based on the classification step, we loaded the specific artifacts that are likely the root cause.

Produce 0-6 concrete suggestions. For EDIT_* actions, include beforeText (current content) and proposedText (your replacement). For CREATE_* actions, include the new-artifact fields. Every suggestion MUST include a concise rationale.

If the loaded content looks correct and the edit was minor/cosmetic, return an empty suggestions array.`;

    const suggestionUserPrompt = `## Original AI draft
${message.originalAiText}

## Operator's final text
${message.content}

## Classified root causes
${classification.targets.map(t => `- ${t.type}${t.sopCategory ? ' (' + t.sopCategory + ')' : ''}${t.faqCategory ? ' (' + t.faqCategory + ')' : ''}${t.systemPromptVariant ? ' (' + t.systemPromptVariant + ')' : ''}`).join('\n')}

${contextSections.length > 0 ? '## Loaded artifact content\n' + contextSections.join('\n\n') : '## No artifact content loaded — suggest CREATE actions if appropriate.'}

Generate suggestions per the schema.`;

    const suggestResponse = await (openai as any).responses.create({
      model: ANALYZER_MODEL,
      reasoning: { effort: ANALYZER_REASONING_EFFORT },
      input: [
        { role: 'system', content: suggestionSystemPrompt },
        { role: 'user', content: suggestionUserPrompt },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'tuning_suggestions',
          strict: true,
          schema: TUNING_ANALYZER_SCHEMA,
        },
      },
    });

    const parsed = extractResponseJson<{ suggestions: Array<Record<string, unknown>> }>(suggestResponse);

    if (!parsed || !Array.isArray(parsed.suggestions) || parsed.suggestions.length === 0) {
      console.log(`[tuning-analyzer] [${messageId}] no suggestions produced`);
      return;
    }

    // ─── Validate + insert suggestions ──────────────────────────────────

    const created: { id: string }[] = [];
    await prisma.$transaction(async tx => {
      for (const raw of parsed!.suggestions) {
        const actionType = raw.actionType as TuningActionType | undefined;
        if (!actionType) continue;
        const rationale = typeof raw.rationale === 'string' ? raw.rationale.trim() : '';
        if (!rationale) continue;

        // Defensive required-field checks per data-model.md §3 required-field matrix.
        if (actionType === 'EDIT_SYSTEM_PROMPT' && (!raw.systemPromptVariant || !raw.proposedText)) continue;
        if (actionType === 'EDIT_SOP_CONTENT' && (!raw.sopCategory || !raw.sopStatus || !raw.proposedText)) continue;
        if (actionType === 'EDIT_SOP_ROUTING' && (!raw.sopCategory || !raw.sopToolDescription)) continue;
        if (actionType === 'EDIT_FAQ' && (!raw.faqEntryId || !raw.proposedText)) continue;
        if (actionType === 'CREATE_SOP' && (!raw.sopCategory || !raw.sopStatus || !raw.sopToolDescription || !raw.proposedText)) continue;
        if (actionType === 'CREATE_FAQ' && (!raw.faqCategory || !raw.faqScope || !raw.faqQuestion || !raw.faqAnswer)) continue;

        // Verify model-supplied faqEntryId actually exists for this tenant. If the
        // model hallucinated or mangled the cuid, try to recover by matching on
        // question text (beforeText or faqQuestion) before giving up.
        let resolvedFaqEntryId = raw.faqEntryId as string | null;
        if (actionType === 'EDIT_FAQ' && resolvedFaqEntryId) {
          const exists = await tx.faqEntry.findFirst({
            where: { id: resolvedFaqEntryId, tenantId: message.tenantId },
            select: { id: true },
          });
          if (!exists) {
            const probeQuestion = typeof raw.beforeText === 'string'
              ? raw.beforeText.replace(/^Q:\s*/i, '').split('\n')[0].trim()
              : typeof raw.faqQuestion === 'string' ? raw.faqQuestion.trim() : '';
            const recovered = probeQuestion
              ? await tx.faqEntry.findFirst({
                  where: { tenantId: message.tenantId, question: probeQuestion },
                  select: { id: true },
                })
              : null;
            if (!recovered) {
              console.warn(`[tuning-analyzer] [${message.id}] dropping EDIT_FAQ with unresolved faqEntryId=${resolvedFaqEntryId}`);
              continue;
            }
            resolvedFaqEntryId = recovered.id;
          }
        }

        const row = await tx.tuningSuggestion.create({
          data: {
            tenantId: message.tenantId,
            sourceMessageId: message.id,
            sourceAiApiLogId: message.aiApiLogId,
            actionType,
            rationale,
            beforeText: (raw.beforeText as string | null) ?? null,
            proposedText: (raw.proposedText as string | null) ?? null,
            systemPromptVariant: (raw.systemPromptVariant as string | null) ?? null,
            sopCategory: (raw.sopCategory as string | null) ?? null,
            sopStatus: (raw.sopStatus as string | null) ?? null,
            sopPropertyId: (raw.sopPropertyId as string | null) ?? null,
            sopToolDescription: (raw.sopToolDescription as string | null) ?? null,
            faqEntryId: resolvedFaqEntryId ?? null,
            faqCategory: (raw.faqCategory as string | null) ?? null,
            faqScope: (raw.faqScope as string | null) ?? null,
            faqPropertyId: (raw.faqPropertyId as string | null) ?? null,
            faqQuestion: (raw.faqQuestion as string | null) ?? null,
            faqAnswer: (raw.faqAnswer as string | null) ?? null,
          },
          select: { id: true },
        });
        created.push(row);
      }
    });

    if (created.length === 0) {
      console.log(`[tuning-analyzer] [${messageId}] suggestions produced but none passed validation`);
      return;
    }

    broadcastCritical(message.tenantId, 'tuning_suggestion_created', {
      sourceMessageId: message.id,
      suggestionIds: created.map(c => c.id),
      conversationId: message.conversationId,
    });

    console.log(`[tuning-analyzer] [${messageId}] created ${created.length} suggestion(s)`);
  } catch (err) {
    const asErr = err instanceof Error ? err : new Error(String(err));
    console.error(
      `[tuning-analyzer] [${messageId}] analyzer run failed: ${asErr.message}`,
      { name: asErr.name, stack: asErr.stack?.split('\n').slice(0, 6).join('\n') }
    );
  }
}
