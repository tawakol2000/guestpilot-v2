/**
 * TuningMessage replay for the OpenAI Responses API path.
 *
 * The Responses API uses a stateful conversation model when you pass
 * `previous_response_id`, but we cannot rely on that across container
 * restarts (the ID lives on OpenAI's side and we have no guarantee it'll
 * still be valid). Instead — like the direct-transport Anthropic path —
 * we always replay full message history from Postgres into the `input`
 * array on each turn.
 *
 * Responses API input shape:
 *   - role 'user' | 'assistant' messages with string content
 *   - `function_call` items for past tool invocations
 *   - `function_call_output` items for past tool results
 *
 * We mirror the legacy Anthropic mapping in `direct/history-replay.ts` so
 * the model sees the same conversation regardless of provider.
 */
import type { PrismaClient } from '@prisma/client';

export type ResponsesInputItem =
  | { type: 'message'; role: 'user' | 'assistant'; content: string }
  | { type: 'function_call'; name: string; call_id: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

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

export async function loadConversationHistoryAsResponsesInput(
  prisma: PrismaClient,
  conversationId: string,
): Promise<ResponsesInputItem[]> {
  const rows = await prisma.tuningMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    select: { role: true, parts: true },
  });

  const flat: ResponsesInputItem[] = [];
  for (const row of rows) {
    const items = rowToResponsesItems(row.role, row.parts);
    flat.push(...items);
  }

  // Sliding-window truncation that respects function_call → function_call_output
  // pairing: never drop a function_call without its output, and never leave
  // an orphan output. We approximate by counting from the end and snapping
  // to the next 'message' boundary.
  if (flat.length <= MAX_HISTORY_TURNS * 4) return flat;
  const tail = flat.slice(-(MAX_HISTORY_TURNS * 4));
  // 2026-05-15 (review pass D5): the slice point can land BETWEEN a
  // function_call and its matching function_call_output (both items live
  // on the same assistant row in flat[]). After trimming leading
  // function_call_output items, also trim a leading function_call whose
  // call_id has no matching function_call_output anywhere in the tail —
  // otherwise OpenAI rejects the next turn with a 400 "previous response
  // must include function_call_output for call_id …".
  while (tail.length > 0 && tail[0].type === 'function_call_output') {
    tail.shift();
  }
  while (tail.length > 0 && tail[0].type === 'function_call') {
    const orphanCallId = tail[0].call_id;
    const hasMatchingOutput = tail.some(
      (item, idx) =>
        idx > 0 &&
        item.type === 'function_call_output' &&
        item.call_id === orphanCallId,
    );
    if (hasMatchingOutput) break;
    tail.shift();
  }
  // 2026-05-15 (M11): symmetric trim at the TAIL. A turn that was
  // interrupted before its tool dispatched (network abort, server kill)
  // can leave a TuningMessage row whose parts include a function_call
  // whose state is not yet 'output-available' — replay emits the
  // function_call item but no matching function_call_output. OpenAI 400s
  // the next request: "no tool output for function call call_xxx". Walk
  // backward and trim any trailing function_call that has no later
  // function_call_output with the same call_id.
  while (tail.length > 0) {
    const last = tail[tail.length - 1];
    if (last.type !== 'function_call') break;
    const callId = last.call_id;
    const hasOutput = tail.some(
      (item) => item.type === 'function_call_output' && item.call_id === callId,
    );
    if (hasOutput) break;
    tail.pop();
  }
  console.warn(
    `[openai-history-replay] conversation=${conversationId} truncated to last ${tail.length} items.`,
  );
  return tail;
}

function rowToResponsesItems(role: string, parts: unknown): ResponsesInputItem[] {
  const arr = coerceParts(parts);
  if (!arr) return [];

  if (role === 'user') return userPartsToItems(arr);
  if (role === 'assistant') return assistantPartsToItems(arr);
  return [];
}

function userPartsToItems(parts: VercelPart[]): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  let textBuf = '';

  for (const part of parts) {
    if (part.transient === true) continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      textBuf += part.text;
      continue;
    }
    // tool-result on the user row → function_call_output
    if (typeof part.toolCallId === 'string') {
      const isToolResult =
        part.type === 'tool-result' ||
        (part.type?.startsWith('tool-') && part.state === 'output-available');
      if (isToolResult) {
        if (textBuf) {
          items.push({ type: 'message', role: 'user', content: textBuf });
          textBuf = '';
        }
        items.push({
          type: 'function_call_output',
          call_id: part.toolCallId,
          output: serialiseToolOutput(part.output),
        });
      }
    }
  }
  if (textBuf) {
    items.push({ type: 'message', role: 'user', content: textBuf });
  }
  return items;
}

function assistantPartsToItems(parts: VercelPart[]): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  let textBuf = '';

  for (const part of parts) {
    if (part.transient === true) continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      textBuf += part.text;
      continue;
    }
    if (part.type === 'reasoning') continue; // dropped — no signature
    if (typeof part.toolCallId === 'string') {
      // tool-call OR tool-<name> with state input-available → function_call
      const isToolCall =
        part.type === 'tool-call' ||
        (part.type?.startsWith('tool-') && part.type !== 'tool-result');
      if (isToolCall) {
        if (textBuf) {
          items.push({ type: 'message', role: 'assistant', content: textBuf });
          textBuf = '';
        }
        const name =
          typeof part.toolName === 'string'
            ? part.toolName
            : part.type?.startsWith('tool-')
              ? part.type.slice('tool-'.length)
              : 'unknown';
        items.push({
          type: 'function_call',
          name: stripMcpPrefix(name),
          call_id: part.toolCallId,
          arguments: serialiseArguments(part.input),
        });
        // Vercel AI SDK persists completed tool round-trips with BOTH
        // input AND output on the same assistant-row part (state:
        // 'output-available'). OpenAI Responses API requires every
        // function_call to be followed by a function_call_output —
        // emit it here when the output is present, otherwise the API
        // rejects the next turn with a 400.
        if (part.state === 'output-available' || part.output !== undefined) {
          items.push({
            type: 'function_call_output',
            call_id: part.toolCallId,
            output: serialiseToolOutput(part.output),
          });
        }
      }
    }
  }
  if (textBuf) {
    items.push({ type: 'message', role: 'assistant', content: textBuf });
  }
  return items;
}

function stripMcpPrefix(name: string): string {
  const m = name.match(/^mcp__[^_]+(?:_[^_]+)*__(.+)$/);
  return m ? m[1] : name;
}

function serialiseArguments(input: unknown): string {
  if (input == null) return '{}';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return '{}';
  }
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
  if (raw && typeof raw === 'object') return [raw as VercelPart];
  return null;
}
