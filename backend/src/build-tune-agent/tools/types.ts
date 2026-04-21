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
  /** Sprint 053-A D2 — populated when known; written into BuildArtifactHistory.actorEmail. */
  actorEmail?: string | null;
  /** Emits an ad-hoc client data part. Wired by the runtime; no-op in tests. */
  emitDataPart?: (part: { type: string; id?: string; data: unknown; transient?: boolean }) => void;
  /** Signals last user turn explicitly sanctioned an apply. Read by suggestion_action. */
  lastUserSanctionedApply: boolean;
  /**
   * Sprint 045 Gate 3 — per-turn tracker for tools that should run at
   * most once per agent turn. Currently only `test_pipeline` uses it
   * (to prevent a second identical-input call in the same turn from
   * burning budget on a cache-warm repeat). Populated by the runtime
   * per turn; tool handlers set and check their own keys.
   */
  turnFlags?: Record<string, boolean>;
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
