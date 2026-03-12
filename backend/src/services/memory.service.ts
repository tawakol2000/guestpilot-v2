/**
 * Tiered conversation memory service.
 *
 * For conversations with >10 messages: keeps last 10 verbatim + compresses
 * older messages into a bullet-point summary using Claude Haiku.
 * Summary is cached in DB — only regenerated when new older messages arrive.
 *
 * For short conversations (<= 10 messages): no summary needed, return all verbatim.
 */
import Anthropic from '@anthropic-ai/sdk';
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
  anthropicClient: Anthropic;
}): Promise<{
  recentMessagesText: string;
  summaryText: string | null;
  totalMessageCount: number;
}> {
  const { conversationId, messages, conversation, prisma, anthropicClient } = params;

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
    const response = await anthropicClient.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system:
        'You are a conversation summarizer for a hospitality AI system. ' +
        'Be extremely concise. Output only bullet points.',
      messages: [
        {
          role: 'user',
          content: `Summarize this guest conversation history. Focus on:
- What the guest asked for or reported
- What was resolved vs still pending
- Any preferences or special needs mentioned
- Any complaints or escalation-worthy issues
Keep to 5 bullet points maximum. Be brief.

[CONVERSATION HISTORY]
${historyText}`,
        },
      ],
    });

    const textBlock = response.content.find(b => b.type === 'text');
    const summary = (textBlock && textBlock.type === 'text' ? textBlock.text : '').trim();

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
