/**
 * Conversation Summary Service
 * Generates and extends compact summaries of conversation history.
 * Runs asynchronously (fire-and-forget) after AI responses — never blocks the pipeline.
 * Uses the cheapest model (gpt-5-nano) to minimize cost.
 */

import OpenAI from 'openai';
import { PrismaClient } from '@prisma/client';

const SUMMARY_MODEL = 'gpt-5-nano';
const MAX_SUMMARY_WORDS = 150;
const WINDOW_SIZE = 10;

const SUMMARIZE_PROMPT = `You are summarizing a guest conversation for a hotel AI assistant named Omar.

Extract ONLY the following critical context:
- Guest identity: who they are, who they're booking for (e.g. "booking for brother Ahmed"), nationality nuances (e.g. "Egyptian with British passport")
- Special arrangements: preferences that affect service (e.g. "pregnant wife, needs quiet room")
- Expressed dissatisfaction: complaints or negative experiences (e.g. "apartment wasn't clean on arrival")
- Key decisions: important commitments or agreements made

EXCLUDE routine, resolved exchanges:
- Routine cleaning/amenity scheduling that was completed
- WiFi password or door code exchanges (already in reservation details)
- Check-in/checkout logistics that went smoothly
- Routine acknowledgments ("thanks", "ok", "got it")
- Resolved escalations where the issue was fully addressed

INCLUDE even if the topic seems routine:
- Complaints or dissatisfaction about ANY topic (including cleaning, amenities, WiFi)
- Unresolved issues where the guest is still waiting
- Promises made by Omar that haven't been fulfilled yet
- Any negative emotional tone, frustration, or repeated requests

Output a plain text summary in third person. Maximum ${MAX_SUMMARY_WORDS} words. No bullet points, no headers, no formatting. If there is nothing critical to summarize, output "No critical context."`;

const EXTEND_PROMPT = `You are updating a conversation summary for a hotel AI assistant. You have the existing summary and new messages that were not previously covered.

Merge the new information into the existing summary. Keep critical context:
- Guest identity, special arrangements, preferences, key decisions

EXCLUDE routine, resolved exchanges:
- Routine cleaning/amenity scheduling that was completed
- WiFi password or door code exchanges (already in reservation details)
- Check-in/checkout logistics that went smoothly
- Routine acknowledgments ("thanks", "ok", "got it")
- Resolved escalations where the issue was fully addressed

INCLUDE even if the topic seems routine:
- Complaints or dissatisfaction about ANY topic (including cleaning, amenities, WiFi)
- Unresolved issues where the guest is still waiting
- Promises made by Omar that haven't been fulfilled yet
- Any negative emotional tone, frustration, or repeated requests

Output the updated summary as plain text. Maximum ${MAX_SUMMARY_WORDS} words. No bullet points, no headers, no formatting.`;

/**
 * Generate or extend a conversation summary. Fire-and-forget — never throws.
 * Call this after the AI response is sent, not before.
 */
export async function generateOrExtendSummary(
  conversationId: string,
  prisma: PrismaClient,
  /**
   * Optional tenantId scope. If omitted, the function reads the
   * conversation's `tenantId` first and scopes all subsequent queries
   * to it. Bugfix (2026-04-22): previously every query trusted the
   * conversationId alone, so a future caller passing a cross-tenant ID
   * (e.g. an admin endpoint, or a worker that shares conversationIds
   * across tenants) could silently overwrite tenant A's summary with
   * messages from tenant B. Conversation summaries are subsequently
   * injected into AI system prompts, making any leak a prompt-injection
   * vector. Defence-in-depth tenant scope on every query closes this.
   */
  tenantId?: string,
): Promise<void> {
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // If the caller didn't supply a tenantId, derive it from the row
    // and use it as the scope for subsequent queries. We use findFirst
    // (not findUnique) to combine the conversationId + tenantId filter
    // when the caller did supply a tenantId.
    const conversation = await prisma.conversation.findFirst({
      where: tenantId
        ? { id: conversationId, tenantId }
        : { id: conversationId },
      select: { conversationSummary: true, summaryMessageCount: true, tenantId: true },
    });
    if (!conversation) return;
    const scopedTenantId = tenantId ?? conversation.tenantId;

    // Fetch recent messages for summary (last 200 is more than enough for context)
    const allMessagesDesc = await prisma.message.findMany({
      where: { conversationId, tenantId: scopedTenantId },
      orderBy: { sentAt: 'desc' },
      take: 200,
      select: { role: true, content: true },
    });
    const allMessages = allMessagesDesc.reverse();
    const contextMessages = allMessages.filter(
      m => m.role !== 'AI_PRIVATE' && m.role !== 'MANAGER_PRIVATE' && !m.content.startsWith('[MANAGER]')
    );

    const totalCount = contextMessages.length;

    // No summary needed if conversation fits in the window
    if (totalCount <= WINDOW_SIZE) {
      console.log(`[Summary] [${conversationId}] Skipped — ${totalCount} messages fit in window`);
      return;
    }

    // Check if existing summary already covers all messages outside the window
    const messagesOutsideWindow = totalCount - WINDOW_SIZE;
    if (conversation.summaryMessageCount >= messagesOutsideWindow) {
      console.log(`[Summary] [${conversationId}] Skipped — summary is current (covers ${conversation.summaryMessageCount}/${messagesOutsideWindow})`);
      return;
    }

    // Messages that need to be summarized (everything before the window)
    const messagesToSummarize = contextMessages.slice(0, messagesOutsideWindow);

    let summaryText: string;

    if (!conversation.conversationSummary) {
      // Generate from scratch — summarize all messages before the window
      const transcript = messagesToSummarize
        .map(m => `${m.role === 'GUEST' ? 'Guest' : 'Omar'}: ${m.content}`)
        .join('\n');

      const response = await (openai.responses as any).create({
        model: SUMMARY_MODEL,
        instructions: SUMMARIZE_PROMPT,
        input: transcript,
        reasoning: { effort: 'minimal' },
        max_output_tokens: 300,
        store: true,
      });

      summaryText = (response.output_text || '').trim();
      console.log(`[Summary] [${conversationId}] Generated new summary (${messagesOutsideWindow} messages → ${summaryText.split(/\s+/).length} words)`);
    } else {
      // Extend existing summary with newly scrolled-out messages
      const newMessages = contextMessages.slice(conversation.summaryMessageCount, messagesOutsideWindow);
      if (newMessages.length === 0) return;

      const newTranscript = newMessages
        .map(m => `${m.role === 'GUEST' ? 'Guest' : 'Omar'}: ${m.content}`)
        .join('\n');

      const response = await (openai.responses as any).create({
        model: SUMMARY_MODEL,
        instructions: EXTEND_PROMPT,
        input: `EXISTING SUMMARY:\n${conversation.conversationSummary}\n\nNEW MESSAGES:\n${newTranscript}`,
        reasoning: { effort: 'minimal' },
        max_output_tokens: 300,
        store: true,
      });

      summaryText = (response.output_text || '').trim();
      console.log(`[Summary] [${conversationId}] Extended summary (+${newMessages.length} messages → ${summaryText.split(/\s+/).length} words)`);
    }

    // Enforce word limit
    const words = summaryText.split(/\s+/);
    if (words.length > MAX_SUMMARY_WORDS) {
      // Truncate at nearest sentence boundary within limit
      const truncated = words.slice(0, MAX_SUMMARY_WORDS).join(' ');
      const lastPeriod = truncated.lastIndexOf('.');
      summaryText = lastPeriod > 0 ? truncated.substring(0, lastPeriod + 1) : truncated;
    }

    // Store summary. updateMany is required to add the tenantId guard
    // (Prisma's `update` only accepts a unique where; updateMany lets us
    // include the scope predicate). If the conversation no longer
    // belongs to scopedTenantId (race with a delete), count=0 and we
    // silently skip — better than a cross-tenant overwrite.
    await prisma.conversation.updateMany({
      where: { id: conversationId, tenantId: scopedTenantId },
      data: {
        conversationSummary: summaryText,
        summaryUpdatedAt: new Date(),
        summaryMessageCount: messagesOutsideWindow,
      },
    });
  } catch (err) {
    console.warn(`[Summary] [${conversationId}] Failed (non-fatal):`, err);
  }
}
