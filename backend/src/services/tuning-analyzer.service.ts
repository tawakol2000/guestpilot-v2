/**
 * Feature 040: Copilot Shadow Mode — Tuning Analyzer Service.
 *
 * Fire-and-forget analyzer that runs after an edited preview is sent.
 * Diagnoses the root cause(s) of the gap between the AI's original draft and
 * the admin's final text, then produces zero or more TuningSuggestion rows
 * with concrete EDIT or CREATE actions across system prompts, SOPs, SOP
 * routing, and FAQs.
 *
 * Per constitution §I Graceful Degradation, analyzer failures MUST NOT block
 * the Send response — the top-level call site always wraps this in .catch().
 *
 * Implementation lives behind a single exported `analyzePreview` function so
 * the controller can import a stable contract regardless of the analyzer's
 * internal complexity.
 */
import OpenAI from 'openai';
import { PrismaClient, TuningActionType } from '@prisma/client';
import { broadcastCritical } from './socket.service';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Model pinned per research.md Decision 4: "something smart" == main-pipeline
// model with reasoning effort high. If this turns out insufficient during the
// tuning period, bump to full gpt-5.4 by changing this constant.
const ANALYZER_MODEL = 'gpt-5.4-mini-2026-03-17';
const ANALYZER_REASONING_EFFORT = 'high' as const;

// ─── JSON schema for analyzer output (strict discriminated union) ────────────
// Matches the TuningActionType enum exactly. Every suggestion carries a
// rationale + action-type-specific payload fields. The OpenAI Responses API
// enforces this at generation time via `strict: true`.
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
        // OpenAI strict mode requires every property listed in `properties` to
        // also appear in `required`. Nullable fields carry `type: [T, 'null']`
        // so the model can emit null when a field doesn't apply to the action type.
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
          systemPromptVariant: { type: ['string', 'null'], enum: ['coordinator', 'screening', null] },
          sopCategory: { type: ['string', 'null'] },
          sopStatus: { type: ['string', 'null'], enum: ['DEFAULT', 'INQUIRY', 'CONFIRMED', 'CHECKED_IN', null] },
          sopPropertyId: { type: ['string', 'null'] },
          sopToolDescription: { type: ['string', 'null'] },
          faqEntryId: { type: ['string', 'null'] },
          faqCategory: { type: ['string', 'null'] },
          faqScope: { type: ['string', 'null'], enum: ['GLOBAL', 'PROPERTY', null] },
          faqPropertyId: { type: ['string', 'null'] },
          faqQuestion: { type: ['string', 'null'] },
          faqAnswer: { type: ['string', 'null'] },
        },
      },
    },
  },
} as const;

// Module-level Prisma reference — set by the caller once at app bootstrap.
// Keeping a stable reference here lets the fire-and-forget path run without
// needing the caller to plumb Prisma through every invocation.
let _prismaRef: PrismaClient | null = null;
export function setTuningAnalyzerPrisma(prisma: PrismaClient): void {
  _prismaRef = prisma;
}

/**
 * Analyze a sent shadow preview and produce tuning suggestions.
 *
 * Fire-and-forget contract: the caller invokes this with .catch(() => {}) so
 * any failure here MUST NOT propagate. Callers never await for success —
 * they only rely on the promise chain for error logging.
 */
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
            messages: { orderBy: { sentAt: 'desc' }, take: 40 },
          },
        },
      },
    });

    if (!message) {
      console.warn(`[tuning-analyzer] [${messageId}] message not found — skipping`);
      return;
    }

    if (!message.originalAiText || message.originalAiText === message.content) {
      // Unedited send — nothing to learn from.
      return;
    }

    // Load the AiApiLog row for this generation turn (if linked) for full context.
    const aiApiLog = message.aiApiLogId
      ? await prisma.aiApiLog.findUnique({ where: { id: message.aiApiLogId } }).catch(() => null)
      : null;

    // Load all FAQ entries reachable for the conversation's property.
    const faqEntries = await prisma.faqEntry.findMany({
      where: {
        tenantId: message.tenantId,
        status: 'ACTIVE',
        OR: [
          { scope: 'GLOBAL' },
          ...(message.conversation.propertyId ? [{ propertyId: message.conversation.propertyId }] : []),
        ],
      },
      take: 200,
    });

    // Build the analyzer prompt.
    const conversationHistory = message.conversation.messages
      .reverse() // oldest first
      .map(m => `[${m.role}] ${m.content}`)
      .join('\n');

    const systemPromptUsed = (aiApiLog?.systemPrompt || '').toString();
    const ragContext = (aiApiLog?.ragContext as any) || {};
    const toolCallTrace = Array.isArray(ragContext?.tools)
      ? JSON.stringify(ragContext.tools, null, 2).substring(0, 4000)
      : 'no tool trace available';
    const sopContextSummary = ragContext?.sopClassification
      ? JSON.stringify(ragContext.sopClassification, null, 2).substring(0, 2000)
      : 'no SOP classification recorded';
    const faqSummary = faqEntries
      .map(f => `- [${f.id}] (${f.category}) Q: ${f.question} | A: ${f.answer.substring(0, 200)}`)
      .join('\n')
      .substring(0, 8000);

    const analyzerSystemPrompt = `You are a Tuning Analyzer for an AI guest-services platform.

Your job: when a human operator edits an AI-generated reply before sending it to a guest, diagnose WHY the AI's original draft fell short, then propose concrete changes to the AI flow (system prompts, SOPs, SOP classifier routing, and FAQ entries) so the AI would have produced output closer to the operator's edit next time.

Possible root causes:
- System prompt guidance is unclear or missing
- The wrong SOP was selected by the classifier (routing issue)
- The selected SOP's content is incomplete or incorrect
- An FAQ entry is unclear, wrong, or unreachable by the classifier
- A needed SOP or FAQ entry does not exist at all

Output 0-6 suggestions in the response schema. A single edit may produce multiple suggestions if several root causes are at play. Every suggestion MUST include a concise rationale. For EDIT_* actions, include beforeText (current content) and proposedText (your replacement). For CREATE_* actions, include the new-artifact fields (faqQuestion/faqAnswer for CREATE_FAQ; sopCategory/sopStatus/sopToolDescription/proposedText for CREATE_SOP).

If the edit was purely cosmetic (whitespace, punctuation, emoji) and does not reflect a meaningful improvement, return an empty suggestions array.`;

    const analyzerUserPrompt = `## Original AI draft (what the AI produced)
${message.originalAiText}

## Final sent text (operator's edit)
${message.content}

## Conversation history (oldest first, last 40 messages)
${conversationHistory}

## System prompt used for this generation
${systemPromptUsed.substring(0, 10000)}

## SOPs consulted during generation
${sopContextSummary}

## Tool-call trace
${toolCallTrace}

## Available FAQ entries (id, category, question, answer preview)
${faqSummary || 'no FAQ entries available for this property'}

Diagnose the root cause(s) and return suggestions per the schema.`;

    const response = await (openai as any).responses.create({
      model: ANALYZER_MODEL,
      reasoning: { effort: ANALYZER_REASONING_EFFORT },
      input: [
        { role: 'system', content: analyzerSystemPrompt },
        { role: 'user', content: analyzerUserPrompt },
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

    // Extract the JSON payload from the Responses API output.
    let parsed: { suggestions: Array<Record<string, unknown>> } | null = null;
    const outputText: string | undefined = (response as any)?.output_text;
    if (outputText) {
      try {
        parsed = JSON.parse(outputText);
      } catch (err) {
        console.warn(`[tuning-analyzer] [${messageId}] failed to parse output_text:`, err);
      }
    }
    if (!parsed && Array.isArray((response as any)?.output)) {
      for (const item of (response as any).output) {
        if (item?.type === 'message' && Array.isArray(item.content)) {
          for (const block of item.content) {
            if (block?.type === 'output_text' && typeof block.text === 'string') {
              try {
                parsed = JSON.parse(block.text);
                break;
              } catch {
                // continue
              }
            }
          }
        }
        if (parsed) break;
      }
    }

    if (!parsed || !Array.isArray(parsed.suggestions) || parsed.suggestions.length === 0) {
      console.log(`[tuning-analyzer] [${messageId}] no suggestions produced`);
      return;
    }

    // Validate + insert suggestions.
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
            faqEntryId: (raw.faqEntryId as string | null) ?? null,
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

    // Broadcast so the Tuning tab can live-update.
    broadcastCritical(message.tenantId, 'tuning_suggestion_created', {
      sourceMessageId: message.id,
      suggestionIds: created.map(c => c.id),
      conversationId: message.conversationId,
    });

    console.log(`[tuning-analyzer] [${messageId}] created ${created.length} suggestion(s)`);
  } catch (err) {
    // Fire-and-forget: never rethrow. Log with full detail so bugs like
    // strict-schema violations surface in Railway logs instead of vanishing.
    const asErr = err instanceof Error ? err : new Error(String(err));
    console.error(
      `[tuning-analyzer] [${messageId}] analyzer run failed: ${asErr.message}`,
      { name: asErr.name, stack: asErr.stack?.split('\n').slice(0, 6).join('\n') }
    );
  }
}
