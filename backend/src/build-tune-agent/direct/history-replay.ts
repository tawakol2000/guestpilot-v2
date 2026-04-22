/**
 * Sprint 059-A Stream B F1.3 — TuningMessage replay for direct-transport.
 *
 * The Claude Agent SDK persists sessions as `sdk-session-id.json` on the
 * local FS. On Railway the container disk is ephemeral (runtime.ts:405
 * comment), so on every container restart all stored sessions vanish.
 *
 * The direct-transport path does NOT use SDK session storage at all.
 * Instead it replays `TuningMessage` rows from Postgres into an Anthropic
 * `messages` array for `anthropic.messages.create({...})`. Assistant rows
 * may carry tool_use blocks; user rows may carry tool_result blocks —
 * both shapes round-trip verbatim through this module so the model sees
 * the same conversation history the SDK path would have assembled.
 *
 * This module is pure I/O + mapping. The actual Anthropic call lives in
 * `runner.ts` (F1.5).
 *
 * Out-of-scope:
 *   - Clever compaction. Spec §3 F1.3 — use a "last 50 turns" window and
 *     WARN when it truncates. A follow-up sprint lands a real compactor
 *     if staging shows the 200k context budget at risk.
 *   - Reasoning-block round-trip. Anthropic `thinking` content blocks
 *     require a `signature` that only the model's prior response carries;
 *     the stored `reasoning` parts (Vercel AI SDK shape) lack it. We drop
 *     them on replay — the next turn starts with no prior thinking, which
 *     matches the SDK path where `includePartialMessages:true` doesn't
 *     re-inject extended-thinking either.
 */
import type { PrismaClient } from '@prisma/client';

export interface AnthropicMessageHistory {
  role: 'user' | 'assistant';
  content: string | Array<Record<string, unknown>>;
}

/**
 * Vercel AI SDK v5 parts shape — loose, since we read from JSON that was
 * written by the stream bridge + onFinish event pipeline. Parts we
 * understand:
 *   - `{ type: 'text', text: string }`
 *   - `{ type: 'reasoning', text: string }` (dropped on replay)
 *   - `{ type: 'tool-<name>' | 'tool-call', toolCallId, input, output?, state? }`
 *   - `{ type: 'tool-result', toolCallId, output }`  (user-role)
 *   - `{ type: 'step-start' | 'step-end' | 'data-*' | 'source-*' | 'file' }` (dropped)
 *
 * Anything else falls through unchanged-as-dropped — we never throw on an
 * unknown part type because the runner's outer catch already handles
 * corrupt rows via the SDK-fallback path (F1.5 `history_error`).
 */
interface VercelPart {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  state?: string;
  transient?: boolean;
  [key: string]: unknown;
}

const MAX_HISTORY_TURNS = 50;

/**
 * Read all `TuningMessage` rows for the conversation and map them into an
 * Anthropic `messages` array. `createdAt ASC` ordering preserves turn
 * order. Token-budget is logged at INFO every call so operators can spot
 * conversations approaching compaction.
 *
 * Returns [] for a non-existent / empty conversation — no error. A
 * first-turn call on a brand-new conversation is the normal path.
 */
export async function loadConversationHistory(
  prisma: PrismaClient,
  conversationId: string,
): Promise<AnthropicMessageHistory[]> {
  const rows = await prisma.tuningMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    select: { role: true, parts: true },
  });

  const mapped: AnthropicMessageHistory[] = [];
  for (const row of rows) {
    const entry = rowToAnthropicMessage(row.role, row.parts);
    if (entry) mapped.push(entry);
  }

  // Last-50-turns window (spec §3 F1.3 — "keep it dumb and loggable").
  let windowed = mapped;
  if (mapped.length > MAX_HISTORY_TURNS) {
    const truncated = mapped.length - MAX_HISTORY_TURNS;
    windowed = mapped.slice(-MAX_HISTORY_TURNS);
    console.warn(
      `[history-replay] conversation=${conversationId} truncated ${truncated} turns (window=${MAX_HISTORY_TURNS}). Follow-up sprint may land a smarter compactor.`,
    );
  }

  // Token-budget log (approximation — char count / 4 as rough token estimate).
  const charCount = approxCharCount(windowed);
  console.log(
    `[history-replay] conversation=${conversationId} turns=${windowed.length} approx_chars=${charCount} approx_tokens=${Math.ceil(charCount / 4)}`,
  );

  return windowed;
}

/**
 * Persist an assistant turn as a single `TuningMessage` row. Wrapped in
 * `prisma.$transaction` so concurrent calls on the same conversationId do
 * not interleave content — each call takes the lock, writes one row,
 * releases. Row-ordering is enforced by `createdAt` (unique monotonic per
 * row — Postgres clock resolution is microseconds, and the transaction
 * guarantees no interleaved writes within this process).
 *
 * `content` accepts either a plain string (simple text turn) or an array
 * of Anthropic content blocks (text + tool_use); the stored `parts` JSON
 * is normalised back into Vercel AI SDK shape so
 * `tuning-chat.controller.ts` / `build-controller.ts` and the frontend
 * renderer continue to read it the same way.
 */
export async function persistAssistantTurn(
  prisma: PrismaClient,
  conversationId: string,
  assistantMessage: {
    content: string | Array<Record<string, unknown>>;
  },
): Promise<void> {
  const parts = anthropicContentToVercelParts(assistantMessage.content);
  await prisma.$transaction(async (tx) => {
    await tx.tuningMessage.create({
      data: {
        conversationId,
        role: 'assistant',
        // `parts` column is Json. `InputJsonValue` is the Prisma type but
        // the plain array satisfies it at runtime — the `as any` keeps
        // this module independent of `Prisma.InputJsonValue` so tests can
        // inject a fake prisma without the full Prisma namespace.
        parts: parts as any,
      },
    });
  });
}

// ─── internal helpers ──────────────────────────────────────────────────

function rowToAnthropicMessage(
  role: string,
  parts: unknown,
): AnthropicMessageHistory | null {
  const arr = coerceParts(parts);
  if (!arr) return null;

  if (role === 'user') {
    return userRowToAnthropic(arr);
  }
  if (role === 'assistant') {
    return assistantRowToAnthropic(arr);
  }
  // 'tool' or 'system' — we never persist those via the direct path, so
  // skip on read. A stray 'system' row would otherwise corrupt the
  // message array (Anthropic's top-level `system` param is separate).
  return null;
}

function userRowToAnthropic(
  parts: VercelPart[],
): AnthropicMessageHistory | null {
  const contentBlocks: Array<Record<string, unknown>> = [];
  let plainText = '';
  let hasBlocks = false;

  for (const part of parts) {
    if (part.transient === true) continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      if (hasBlocks) {
        contentBlocks.push({ type: 'text', text: part.text });
      } else {
        plainText += part.text;
      }
      continue;
    }
    if (part.type === 'tool-result' && typeof part.toolCallId === 'string') {
      // Flatten any plainText seen so far into a block.
      if (plainText && !hasBlocks) {
        contentBlocks.push({ type: 'text', text: plainText });
        plainText = '';
      }
      hasBlocks = true;
      contentBlocks.push({
        type: 'tool_result',
        tool_use_id: part.toolCallId,
        content: serialiseToolOutput(part.output),
      });
      continue;
    }
    // `tool-<name>` with state `output-available` on user rows is the
    // Vercel SDK's persistence form of a tool_result. Map it the same.
    if (
      part.type?.startsWith('tool-') &&
      part.type !== 'tool-call' &&
      typeof part.toolCallId === 'string' &&
      part.state === 'output-available'
    ) {
      if (plainText && !hasBlocks) {
        contentBlocks.push({ type: 'text', text: plainText });
        plainText = '';
      }
      hasBlocks = true;
      contentBlocks.push({
        type: 'tool_result',
        tool_use_id: part.toolCallId,
        content: serialiseToolOutput(part.output),
      });
      continue;
    }
    // Everything else (data-*, source-*, file, step-*) is dropped on the
    // user side — not wire-representable on Anthropic's user turn.
  }

  if (hasBlocks) {
    if (plainText) contentBlocks.push({ type: 'text', text: plainText });
    return { role: 'user', content: contentBlocks };
  }
  if (!plainText) return null;
  return { role: 'user', content: plainText };
}

function assistantRowToAnthropic(
  parts: VercelPart[],
): AnthropicMessageHistory | null {
  const contentBlocks: Array<Record<string, unknown>> = [];

  for (const part of parts) {
    if (part.transient === true) continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      contentBlocks.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'reasoning') {
      // Drop — see module header. Replaying `thinking` without a
      // signature would be rejected by the model.
      continue;
    }
    if (part.type === 'tool-call' && typeof part.toolCallId === 'string') {
      contentBlocks.push({
        type: 'tool_use',
        id: part.toolCallId,
        name: typeof part.toolName === 'string' ? part.toolName : 'unknown',
        input: part.input ?? {},
      });
      continue;
    }
    // Vercel v5 persistence shape: `tool-<name>` with `state: 'input-available'`
    // or `'output-available'`. `input-available` means the model's tool_use
    // is recorded but the result hasn't come back yet; for replay we want
    // the `tool_use` itself on the assistant row.
    if (
      part.type?.startsWith('tool-') &&
      part.type !== 'tool-call' &&
      typeof part.toolCallId === 'string'
    ) {
      const toolName = part.type.slice('tool-'.length);
      contentBlocks.push({
        type: 'tool_use',
        id: part.toolCallId,
        name: typeof part.toolName === 'string' ? part.toolName : toolName,
        input: part.input ?? {},
      });
      continue;
    }
    // Drop data-*, source-*, file, step-*, etc.
  }

  if (contentBlocks.length === 0) return null;
  // If every block is text, collapse to a plain string — matches the
  // shape the Anthropic SDK's serialiser produces naturally.
  if (contentBlocks.every((b) => b.type === 'text')) {
    const joined = contentBlocks.map((b) => String(b.text ?? '')).join('');
    return { role: 'assistant', content: joined };
  }
  return { role: 'assistant', content: contentBlocks };
}

function anthropicContentToVercelParts(
  content: string | Array<Record<string, unknown>>,
): VercelPart[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  const out: VercelPart[] = [];
  for (const block of content) {
    const type = block?.type;
    if (type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: block.text });
      continue;
    }
    if (type === 'tool_use' && typeof block.id === 'string') {
      out.push({
        type: 'tool-call',
        toolCallId: block.id,
        toolName: typeof block.name === 'string' ? block.name : 'unknown',
        input: block.input ?? {},
      });
      continue;
    }
    if (type === 'thinking' && typeof block.thinking === 'string') {
      out.push({ type: 'reasoning', text: block.thinking });
      continue;
    }
    // Unknown block shapes are preserved as-is so the DB round-trip is
    // lossless even for block types we haven't taught this mapper about.
    out.push({ type: 'text', text: JSON.stringify(block) });
  }
  return out;
}

function coerceParts(raw: unknown): VercelPart[] | null {
  if (Array.isArray(raw)) return raw as VercelPart[];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as VercelPart[]) : null;
    } catch {
      return null;
    }
  }
  // Some Prisma JSON columns hydrate as objects rather than strings when
  // the driver auto-parses. A single-part object is plausible.
  if (raw && typeof raw === 'object') {
    return [raw as VercelPart];
  }
  return null;
}

function serialiseToolOutput(output: unknown): string {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function approxCharCount(messages: AnthropicMessageHistory[]): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      total += m.content.length;
      continue;
    }
    for (const block of m.content) {
      for (const value of Object.values(block)) {
        if (typeof value === 'string') total += value.length;
        else if (value != null) total += JSON.stringify(value).length;
      }
    }
  }
  return total;
}
