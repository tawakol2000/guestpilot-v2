/**
 * Shared types for the tuning-agent tool layer.
 *
 * Tool handlers receive a `ToolContext` carrying the tenantId, optional
 * conversationId, the PrismaClient, and an optional hook that captures
 * tool outputs for the client-side UI (e.g. `propose_suggestion` streams
 * a `data-suggestion-preview` part alongside its tool return value).
 */
import type { PrismaClient } from '@prisma/client';

export interface ToolContext {
  prisma: PrismaClient;
  tenantId: string;
  conversationId: string | null;
  userId: string | null;
  /** Emits an ad-hoc client data part. Wired by the runtime; no-op in tests. */
  emitDataPart?: (part: { type: string; id?: string; data: unknown; transient?: boolean }) => void;
  /** Signals last user turn explicitly sanctioned an apply. Read by suggestion_action. */
  lastUserSanctionedApply: boolean;
}

export type Verbosity = 'concise' | 'detailed';

/**
 * Wraps a Promise handler into the MCP tool handler shape:
 * `(args, extra) => Promise<CallToolResult>`.
 */
export function asCallToolResult<T>(
  payload: T
): { content: { type: 'text'; text: string }[]; structuredContent?: any } {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return {
    content: [{ type: 'text', text }],
    structuredContent: typeof payload === 'object' ? (payload as any) : undefined,
  };
}

export function asError(message: string): {
  content: { type: 'text'; text: string }[];
  isError: boolean;
} {
  return {
    content: [{ type: 'text', text: `ERROR: ${message}` }],
    isError: true,
  };
}
