/**
 * Shared turn-end emit helper — Sprint 049 (OpenAI A/B path).
 *
 * Both `sdk-runner.ts` (Anthropic / Claude Agent SDK) and `openai-runner.ts`
 * (OpenAI Responses API) call this at the end of every turn so the wire
 * contract is byte-identical regardless of provider.
 *
 * Emission order (mirrors the legacy inline block in sdk-runner.ts):
 *   1. data-cache-stats           — always when usage is known
 *   2. data-state-machine-snapshot — always (transient)
 *   3. data-session-diff-summary   — when tool activity occurred
 *   4. data-interview-progress     — BUILD mode + slot delta only
 *
 * Pure side-effects — never throws. The runtime can safely call this
 * inside the post-stream cleanup path without try/catch.
 */
import type { PrismaClient } from '@prisma/client';
import {
  maybeEmitSessionDiffSummary,
  maybeEmitInterviewProgress,
} from '../auto-emit';
import {
  buildCacheStatsPayload,
  type CacheStatsPayload,
} from '../prompt-cache-blocks';
import type { AgentMode } from '../system-prompt';
import type { StateMachineSnapshot } from '../state-machine';

export interface TurnEndUsage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface TurnEndInput {
  prisma: PrismaClient;
  tenantId: string;
  conversationId: string;
  assistantMessageId: string;
  mode: AgentMode;
  toolCallsInvoked: string[];
  /** Slot snapshot captured BEFORE the turn ran. Used to detect deltas. */
  preTurnSlotSnapshot: Record<string, string>;
  /** Post-turn state-machine snapshot (after computeTurnEndSnapshot). */
  endSnapshot: StateMachineSnapshot;
  /**
   * Provider-specific usage. Both providers should normalise into the
   * Anthropic-style shape so cache-stats math stays uniform.
   */
  lastUsage: TurnEndUsage | null;
  emitDataPart: (part: {
    type: string;
    id?: string;
    data: unknown;
    transient?: boolean;
  }) => void;
}

export async function emitTurnEndArtifacts(input: TurnEndInput): Promise<void> {
  if (input.lastUsage) {
    try {
      const cacheStats: CacheStatsPayload = buildCacheStatsPayload(input.lastUsage);
      input.emitDataPart({
        type: 'data-cache-stats',
        id: `cache-stats:${input.assistantMessageId}`,
        data: cacheStats,
        transient: true,
      });
    } catch {
      /* swallow — telemetry must never break the main flow */
    }
  }

  try {
    input.emitDataPart({
      type: 'data-state-machine-snapshot',
      id: `state-machine:${input.assistantMessageId}`,
      data: input.endSnapshot,
      transient: true,
    });
  } catch {
    /* swallow */
  }

  try {
    maybeEmitSessionDiffSummary({
      toolCallsInvoked: input.toolCallsInvoked,
      emitDataPart: input.emitDataPart,
      assistantMessageId: input.assistantMessageId,
    });
  } catch (err) {
    console.warn('[tuning-agent] session-summary auto-emit failed:', err);
  }

  try {
    await maybeEmitInterviewProgress({
      prisma: input.prisma,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      mode: input.mode,
      beforeSnapshot: input.preTurnSlotSnapshot,
      emitDataPart: input.emitDataPart,
      assistantMessageId: input.assistantMessageId,
    });
  } catch (err) {
    console.warn('[tuning-agent] interview-progress auto-emit failed:', err);
  }
}
