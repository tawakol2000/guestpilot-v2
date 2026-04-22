/**
 * FAQ Auto-Suggest Service — Detects reusable answers in manager replies
 * and creates suggested FAQ entries for one-tap approval.
 *
 * Uses GPT-5 Nano via Responses API for classification + extraction.
 * Fire-and-forget — never blocks the manager's reply.
 */

import OpenAI from 'openai';
import { PrismaClient } from '@prisma/client';
import { FAQ_CATEGORIES, FaqCategory } from '../config/faq-categories';
import { broadcastToTenant } from './socket.service';

// ── OpenAI client singleton ─────────────────────────────────────────────────

let _client: OpenAI | null = null;
function getClient(): OpenAI | null {
  if (!_client) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return null;
    _client = new OpenAI({ apiKey: key });
  }
  return _client;
}

const SYSTEM_PROMPT = `You classify manager replies to guest questions. Determine if the reply contains reusable property knowledge (directions, amenities, policies, local info) or booking-specific information (dates, prices, guest names, reservation details). If reusable, extract a clean Q&A pair.`;

// ── Main export ─────────────────────────────────────────────────────────────

interface FaqSuggestionResult {
  id: string;
  question: string;
  answer: string;
  category: string;
  propertyId: string;
}

export async function processFaqSuggestion(
  prisma: PrismaClient,
  tenantId: string,
  conversationId: string,
  propertyId: string,
  guestMessage: string,
  managerReply: string,
): Promise<FaqSuggestionResult | null> {
  try {
    // 1. Get OpenAI client — bail if unavailable
    const client = getClient();
    if (!client) {
      console.log('[FAQ-Suggest] No OpenAI API key — skipping');
      return null;
    }

    // 2. Call GPT-5 Nano via Responses API with structured output
    const response = await (client.responses as any).create({
      model: 'gpt-5-nano',
      instructions: SYSTEM_PROMPT,
      input: `Info request: ${guestMessage}\nManager reply: "${managerReply}"`,
      text: {
        format: {
          type: 'json_schema',
          name: 'faq_classify',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              reusable: { type: 'boolean', description: 'True if the reply contains reusable property knowledge' },
              question: { type: 'string', description: 'Generalized question, 5-20 words' },
              answer: { type: 'string', description: 'Factual answer without personal details' },
              category: { type: 'string', enum: [...FAQ_CATEGORIES], description: 'One of the 15 FAQ categories' },
              reason: { type: 'string', description: 'Why reusable or not' },
            },
            required: ['reusable', 'question', 'answer', 'category', 'reason'],
            additionalProperties: false,
          },
        },
      },
      reasoning: { effort: 'minimal' },
      max_output_tokens: 256,
      store: true,
    });

    const raw = (response.output_text || '').trim();
    if (!raw) {
      console.warn('[FAQ-Suggest] Empty response from GPT-5 Nano');
      return null;
    }

    const result = JSON.parse(raw) as {
      reusable: boolean;
      question: string;
      answer: string;
      category: string;
      reason: string;
    };

    // 3. If not reusable, return null
    if (!result.reusable) {
      console.log('[FAQ-Suggest] Not reusable:', result.reason);
      return null;
    }

    // 4. Validate category — default to 'property-neighborhood' if invalid.
    // Bugfix (2026-04-22): assert the fallback category is valid at runtime
    // so a future drift in FAQ_CATEGORIES doesn't silently persist garbage.
    // Also asserts at module load (see top-of-file invariant) — but a
    // defensive check here is cheap.
    const FALLBACK_CATEGORY: FaqCategory = 'property-neighborhood' as FaqCategory;
    if (!FAQ_CATEGORIES.includes(FALLBACK_CATEGORY)) {
      console.error(
        '[FAQ-Suggest] FALLBACK_CATEGORY is no longer in FAQ_CATEGORIES — fix this constant.',
      );
    }
    const category: string = FAQ_CATEGORIES.includes(result.category as FaqCategory)
      ? result.category
      : FALLBACK_CATEGORY;

    // 5. Dedup check.
    // Bugfix (2026-04-22): unified fingerprint length to 50 chars to
    // match `faq.service.ts#getFaqForProperty` (which uses 50 for its
    // global-vs-property dedup). Previously this used 100 chars; an
    // auto-suggested FAQ that was unique-at-100 but collision-at-50
    // would survive dedup here, then get filtered out at AI call time
    // — the manager-approved entry never surfaced in get_faq results.
    const FAQ_DEDUP_FINGERPRINT_CHARS = 50;
    const questionFingerprint = result.question
      .toLowerCase()
      .trim()
      .substring(0, FAQ_DEDUP_FINGERPRINT_CHARS);
    const existingEntries = await prisma.faqEntry.findMany({
      where: {
        tenantId,
        status: 'ACTIVE',
        OR: [
          { propertyId },
          { propertyId: null },
        ],
      },
      select: { question: true },
    });

    const isDuplicate = existingEntries.some(
      (e) =>
        e.question
          .toLowerCase()
          .trim()
          .substring(0, FAQ_DEDUP_FINGERPRINT_CHARS) === questionFingerprint,
    );

    if (isDuplicate) {
      console.log('[FAQ-Suggest] Duplicate detected — skipping');
      return null;
    }

    // 6. Create FaqEntry with status SUGGESTED, source AUTO_SUGGESTED
    const entry = await prisma.faqEntry.create({
      data: {
        tenantId,
        propertyId,
        question: result.question.trim(),
        answer: result.answer.trim(),
        category,
        scope: 'PROPERTY',
        status: 'SUGGESTED',
        source: 'AUTO_SUGGESTED',
        sourceConversationId: conversationId,
      },
    });

    // 7. Broadcast Socket.IO event with property name
    const property = await prisma.property.findUnique({
      where: { id: propertyId },
      select: { name: true },
    });

    broadcastToTenant(tenantId, 'faq_suggestion', {
      conversationId,
      suggestion: {
        id: entry.id,
        question: entry.question,
        answer: entry.answer,
        category: entry.category,
        propertyId,
        propertyName: property?.name || 'Unknown Property',
      },
    });

    console.log(`[FAQ-Suggest] Created suggestion id=${entry.id} category=${category}`);

    // 8. Return the created entry
    return {
      id: entry.id,
      question: entry.question,
      answer: entry.answer,
      category: entry.category,
      propertyId,
    };
  } catch (err: any) {
    // Fire-and-forget — log errors but never throw
    console.error('[FAQ-Suggest] Error (non-fatal):', err.message);
    return null;
  }
}
