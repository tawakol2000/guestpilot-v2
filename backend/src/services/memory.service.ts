/**
 * Tiered conversation memory service.
 *
 * For conversations with >10 messages: keeps last 10 verbatim + compresses
 * older messages into a bullet-point summary using Claude Haiku.
 * Summary is cached in DB — only regenerated when new older messages arrive.
 *
 * For short conversations (<= 10 messages): no summary needed, return all verbatim.
 */
import OpenAI from 'openai';
import { PrismaClient } from '@prisma/client';

// Use a local type for messages to avoid Prisma import issues
interface MessageLike {
  role: string;
  content: string;
}

interface ConversationLike {
  id?: string;
  conversationSummary?: string | null;
  summaryMessageCount?: number;
}

export function formatMessages(messages: MessageLike[]): string {
  return messages
    .map(m => {
      const role = m.role === 'GUEST' ? '[GUEST]' : '[PROPERTY TEAM]';
      return `${role}: ${m.content}`;
    })
    .join('\n');
}

export function formatConversationContext(tiered: {
  recentMessagesText: string;
  summaryText: string | null;
}): string {
  if (tiered.summaryText) {
    return (
      `[CONVERSATION SUMMARY — earlier messages]\n${tiered.summaryText}\n\n` +
      `[RECENT MESSAGES]\n${tiered.recentMessagesText}`
    );
  }
  return tiered.recentMessagesText;
}

export async function buildTieredContext(params: {
  conversationId: string;
  messages: MessageLike[];
  conversation: ConversationLike;
  prisma: PrismaClient;
  openaiClient: OpenAI;
}): Promise<{
  recentMessagesText: string;
  summaryText: string | null;
  totalMessageCount: number;
}> {
  const { conversationId, messages, conversation, prisma, openaiClient } = params;

  const recentMessages = messages.slice(-10);
  const olderMessages = messages.slice(0, -10);
  const recentMessagesText = formatMessages(recentMessages);

  // No old messages — just return recent
  if (olderMessages.length === 0) {
    return {
      recentMessagesText,
      summaryText: null,
      totalMessageCount: messages.length,
    };
  }

  // Check if existing summary is still fresh
  const summaryMessageCount = conversation.summaryMessageCount ?? 0;
  const needsUpdate = summaryMessageCount < olderMessages.length;

  if (!needsUpdate && conversation.conversationSummary) {
    return {
      recentMessagesText,
      summaryText: conversation.conversationSummary,
      totalMessageCount: messages.length,
    };
  }

  // Generate fresh summary via Claude Haiku
  try {
    const historyText = formatMessages(olderMessages);
    const response = await (openaiClient.responses as any).create({
      model: 'gpt-5.4-mini-2026-03-17',
      max_output_tokens: 300,
      instructions:
        'You are a conversation summarizer for a hospitality AI system. ' +
        'Be extremely concise. Output only bullet points.',
      input: `Summarize this guest conversation history. Focus on:
- What the guest asked for or reported
- What was resolved vs still pending
- Any preferences or special needs mentioned
- Any complaints or escalation-worthy issues
Keep to 5 bullet points maximum. Be brief.

[CONVERSATION HISTORY]
${historyText}`,
      reasoning: { effort: 'none' },
      store: true,
    });

    const summary = (response.output_text || '').trim();

    // Persist summary to DB
    if (conversationId) {
      await prisma.conversation.update({
        where: { id: conversationId },
        data: {
          conversationSummary: summary,
          summaryUpdatedAt: new Date(),
          summaryMessageCount: olderMessages.length,
        },
      });
    }

    return {
      recentMessagesText,
      summaryText: summary || null,
      totalMessageCount: messages.length,
    };
  } catch (err) {
    console.error('[Memory] Failed to generate summary (non-fatal):', err);
    // Fall back to existing summary or null — never crash
    return {
      recentMessagesText,
      summaryText: conversation.conversationSummary || null,
      totalMessageCount: messages.length,
    };
  }
}
