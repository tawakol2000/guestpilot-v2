/**
 * Message Compaction Service
 * Compresses long automated HOST/AI messages (booking confirmations, check-in
 * instructions, pre-arrival info) into 2-3 sentences via gpt-5-nano so that
 * conversation history injected into the main AI call stays lean.
 *
 * Fire-and-forget: never blocks message saving. On any failure we leave
 * `compactedContent` null and the full `content` is used as fallback.
 */

import OpenAI from 'openai';
import { PrismaClient, MessageRole } from '@prisma/client';

const COMPACTION_MODEL = 'gpt-5-nano';
// Rough heuristic: 1 token ≈ 4 chars. 300-token threshold → 1200 chars.
const COMPACTION_CHAR_THRESHOLD = 1200;

const COMPACTION_PROMPT = `Compress this automated guest message into 2-3 sentences preserving:
- Any access codes, passwords, WiFi info, or door codes
- Specific times, dates, or deadlines
- Any property-specific instructions (parking, check-in procedure)
- Any amounts or fees mentioned

Drop: greetings, marketing language, generic hospitality text, repeated info.
Output plain text only, no formatting.`;

/**
 * Decide whether a message qualifies for compaction.
 * Only HOST / AI messages over the char threshold.
 */
export function shouldCompactMessage(role: MessageRole | string, content: string): boolean {
  if (!content || content.length < COMPACTION_CHAR_THRESHOLD) return false;
  return role === MessageRole.HOST || role === MessageRole.AI || role === 'HOST' || role === 'AI';
}

/**
 * Fire-and-forget compaction — never throws. If the nano call fails, the
 * `compactedContent` stays null and the AI pipeline falls back to full content.
 */
export function compactMessageAsync(
  messageId: string,
  role: MessageRole | string,
  content: string,
  prisma: PrismaClient,
): void {
  if (!shouldCompactMessage(role, content)) return;
  // Detach from caller — compaction must never block the save.
  void runCompaction(messageId, content, prisma).catch(err => {
    console.warn(`[Compaction] [${messageId}] Failed (non-fatal):`, err);
  });
}

async function runCompaction(
  messageId: string,
  content: string,
  prisma: PrismaClient,
): Promise<void> {
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await (openai.responses as any).create({
      model: COMPACTION_MODEL,
      instructions: COMPACTION_PROMPT,
      input: content,
      reasoning: { effort: 'minimal' },
      max_output_tokens: 200,
      store: false,
    });
    const compacted = (response.output_text || '').trim();
    if (!compacted) {
      console.warn(`[Compaction] [${messageId}] Empty compaction result — leaving content as-is`);
      return;
    }
    await prisma.message.update({
      where: { id: messageId },
      data: { compactedContent: compacted },
    });
    console.log(`[Compaction] [${messageId}] Compacted ${content.length} → ${compacted.length} chars`);
  } catch (err) {
    console.warn(`[Compaction] [${messageId}] Nano call failed (non-fatal):`, err);
  }
}
