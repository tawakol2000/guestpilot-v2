/**
 * FAQ Auto-Suggest Service — Detects reusable answers in manager replies
 * and creates suggested FAQ entries for one-tap approval.
 *
 * Uses GPT-5 Nano for classification + extraction (~$0.0001 per call).
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

// ── Structured output schema for GPT-5 Nano ─────────────────────────────────

const CLASSIFY_SCHEMA = {
  name: 'faq_classify',
  strict: true,
  schema: {
    type: 'object' as const,
    properties: {
      reusable: {
        type: 'boolean' as const,
        description: 'True if the reply contains reusable property knowledge',
      },
      question: {
        type: 'string' as const,
        description: 'Generalized question, 5-20 words',
      },
      answer: {
        type: 'string' as const,
        description: 'Factual answer without personal details',
      },
      category: {
        type: 'string' as const,
        enum: [...FAQ_CATEGORIES],
        description: 'One of the 15 FAQ categories',
      },
      reason: {
        type: 'string' as const,
        description: 'Why reusable or not',
      },
    },
    required: ['reusable', 'question', 'answer', 'category', 'reason'],
    additionalProperties: false,
  },
} as const;

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

    // 2. Call GPT-5 Nano to classify + extract in ONE call
    const response = await client.chat.completions.create({
      model: 'gpt-5-nano',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Info request: ${guestMessage}\nManager reply: "${managerReply}"`,
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: CLASSIFY_SCHEMA,
      },
      store: true,
      max_completion_tokens: 256,
    });

    const raw = response.choices[0]?.message?.content;
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

    // 4. Validate category — default to 'property-neighborhood' if invalid
    const category: string = FAQ_CATEGORIES.includes(result.category as FaqCategory)
      ? result.category
      : 'property-neighborhood';

    // 5. Dedup check: existing ACTIVE entries with matching first 100 chars
    const questionFingerprint = result.question.toLowerCase().trim().substring(0, 100);
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
      (e) => e.question.toLowerCase().trim().substring(0, 100) === questionFingerprint,
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
