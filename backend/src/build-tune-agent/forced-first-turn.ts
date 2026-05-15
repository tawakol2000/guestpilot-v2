/**
 * Forced first-turn grounding call (sprint 046 Session A).
 *
 * On turn 1 of every BUILD/TUNE conversation we pre-compute the
 * tenant's state summary server-side, emit a `data-state-snapshot`
 * SSE part, record the invocation in `toolCallsInvoked`, and log
 * to `BuildToolCallLog`. The next SDK turn the agent is free to call
 * `get_current_state` itself (with richer scopes) based on manager
 * intent — the forced turn-1 invocation just guarantees a grounded
 * starting state and populates the frontend right-rail snapshot
 * without an extra round-trip.
 *
 * Extracted from `runtime.ts` for direct unit-testability — the full
 * `runTuningAgentTurn` drives the SDK and can't be tested without a
 * real API key.
 */
import type { PrismaClient } from '@prisma/client';
import { TUNING_AGENT_TOOL_NAMES } from './tools/names';
import { buildCurrentStatePayload } from './tools/get-current-state';
import { logToolCall } from '../services/build-tool-call-log.service';

export interface ForcedFirstTurnInput {
  prisma: PrismaClient;
  tenantId: string;
  conversationId: string;
  assistantMessageId: string;
  turn: number;
  emitDataPart: (part: {
    type: string;
    id?: string;
    data: unknown;
    transient?: boolean;
  }) => void;
  /** Appended to with the tool name on success; unchanged on failure. */
  toolCallsInvoked: string[];
}

export async function runForcedFirstTurnCall(
  input: ForcedFirstTurnInput
): Promise<void> {
  const start = Date.now();
  try {
    const payload = await buildCurrentStatePayload(
      input.prisma,
      input.tenantId,
      'summary'
    );
    input.emitDataPart({
      type: 'data-state-snapshot',
      id: `state-snapshot:${input.assistantMessageId}`,
      data: payload,
    });
    input.toolCallsInvoked.push(TUNING_AGENT_TOOL_NAMES.studio_get_tenant_index);
    void logToolCall(input.prisma, {
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      turn: input.turn,
      tool: TUNING_AGENT_TOOL_NAMES.studio_get_tenant_index,
      params: { scope: 'summary', forcedFirstTurn: true },
      durationMs: Date.now() - start,
      success: true,
    });
  } catch (err: any) {
    // Degrade gracefully — a failed forced call must never block the
    // turn (CLAUDE.md rule 2). 2026-05-15 (M8): also emit a stub
    // `data-state-snapshot` carrying an error marker so the frontend
    // right-rail can render "couldn't load" instead of staying blank.
    // The stub still lets the UI hydrate the rail layout — actual
    // counts come back on the next turn's snapshot emit.
    // eslint-disable-next-line no-console
    console.warn('[tuning-agent] forced first-turn tenant index failed:', err);
    try {
      input.emitDataPart({
        type: 'data-state-snapshot',
        id: `state-snapshot:${input.assistantMessageId}`,
        data: {
          posture: 'UNKNOWN',
          error: true,
          errorMessage: err?.message ?? String(err),
        },
      });
    } catch {
      /* writer may already be closed; swallow */
    }
    void logToolCall(input.prisma, {
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      turn: input.turn,
      tool: TUNING_AGENT_TOOL_NAMES.studio_get_tenant_index,
      params: { scope: 'summary', forcedFirstTurn: true },
      durationMs: Date.now() - start,
      success: false,
      errorMessage: err?.message ?? String(err),
    });
  }
}
