/**
 * Langfuse observability — fire-and-forget tracing for the main AI pipeline.
 *
 * Feature 041 sprint 01 rework (§1 acceptance criteria): emit a single trace
 * per `generateAndSendAiReply` invocation, with nested spans for SOP
 * classification, each tool call, structured output, summary call, and
 * task-manager dedup. Attributes include tenantId, conversationId,
 * reservationId, messageId (stamped once known), systemPromptVersion, model,
 * token counts, cost, retrieval context, classifier decision.
 *
 * Scoping is handled via AsyncLocalStorage so call sites deep in the pipeline
 * (inside createMessage, summary.service, task-manager.service) attach spans
 * to the current root trace without threading a handle through every function
 * signature.
 *
 * Gracefully disabled when LANGFUSE env vars are missing. Never throws, never
 * crashes the pipeline (per CLAUDE.md critical rule #2).
 */
import { AsyncLocalStorage } from 'async_hooks';
import { Langfuse } from 'langfuse';

// ─── Shared types ────────────────────────────────────────────────────────────

export interface TraceParams {
  tenantId: string;
  conversationId: string;
  agentName: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  responseText: string;
  escalated: boolean;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  error?: string;
  ragChunks?: Array<{ content: string; category: string; similarity: number }>;
  ragDurationMs?: number;
  ragQuery?: string;
  // Context metadata
  openTaskCount?: number;
  totalMessages?: number;
  memorySummarized?: boolean;
  hasImage?: boolean;
  // Prompt content for Langfuse input/output display
  systemPrompt?: string;
  userContentPreview?: string;
}

/**
 * Attributes captured on the root trace for a single `generateAndSendAiReply`.
 * messageId is stamped later via `stampAiTrace` once the reply row is created.
 */
export interface AiTraceContext {
  tenantId: string;
  conversationId: string;
  reservationId?: string | null;
  messageId?: string | null;
  systemPromptVersion?: number | null;
  classifierDecision?: {
    categories?: string[];
    confidence?: string;
    alternatives?: string[];
  };
  // Retrieval context — populated as SOP/FAQ fetches happen.
  retrievalContext?: Record<string, unknown>;
  // Identifies which persona / agent is replying (coordinator | screening).
  agentName?: string;
  mode?: 'autopilot' | 'copilot' | 'shadow-preview';
}

// Minimal surface of a Langfuse trace we use. Kept as `any` because the SDK
// type exports shift between versions.
type LangfuseTrace = any;

// Handle returned by startAiSpan — always callable, even when Langfuse is off.
export interface AiSpanHandle {
  end(out?: unknown, extra?: Record<string, unknown>): void;
  addMetadata(patch: Record<string, unknown>): void;
}

// ─── Langfuse client (lazy, graceful) ────────────────────────────────────────

let _client: Langfuse | null = null;
let _warned = false;

function getClient(): Langfuse | null {
  if (_client) return _client;
  const { LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_HOST } = process.env;
  if (!LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY) {
    if (!_warned) {
      console.warn('[Observability] LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY missing — tracing disabled');
      _warned = true;
    }
    return null;
  }
  try {
    _client = new Langfuse({
      publicKey: LANGFUSE_PUBLIC_KEY,
      secretKey: LANGFUSE_SECRET_KEY,
      baseUrl: LANGFUSE_HOST || 'https://cloud.langfuse.com',
    });
    return _client;
  } catch (err) {
    console.warn('[Observability] Langfuse init failed:', err);
    return null;
  }
}

// ─── Root-trace scope (AsyncLocalStorage) ────────────────────────────────────

interface AiTraceHolder {
  trace: LangfuseTrace | null;
  ctx: AiTraceContext;
}

const aiTraceStore = new AsyncLocalStorage<AiTraceHolder>();

/**
 * Run `fn` with a fresh root trace scoped via AsyncLocalStorage. All nested
 * `traceAiCall` / `startAiSpan` calls inside `fn` attach as spans of the same
 * root trace. Safe to call when Langfuse is disabled — the trace is null and
 * span emitters no-op.
 */
export async function runWithAiTrace<T>(ctx: AiTraceContext, fn: () => Promise<T>): Promise<T> {
  const lf = getClient();
  let trace: LangfuseTrace | null = null;
  if (lf) {
    try {
      trace = lf.trace({
        name: `ai-reply:${ctx.agentName || 'main'}`,
        userId: ctx.tenantId,
        sessionId: ctx.conversationId,
        metadata: buildRootMetadata(ctx),
      });
    } catch (err) {
      console.warn('[Observability] Failed to create root trace (non-fatal):', err);
      trace = null;
    }
  }

  const holder: AiTraceHolder = { trace, ctx };
  try {
    return await aiTraceStore.run(holder, fn);
  } finally {
    // Flush fire-and-forget so late spans (summary, task-manager) have a chance
    // to batch out. Never awaited on the hot path.
    if (trace && lf) {
      try {
        // Final metadata patch — ctx may have been mutated via stampAiTrace.
        trace.update({ metadata: buildRootMetadata(holder.ctx) });
      } catch {
        /* swallow — trace may already be closed */
      }
      lf.flushAsync().catch(() => {});
    }
  }
}

function buildRootMetadata(ctx: AiTraceContext): Record<string, unknown> {
  return {
    tenantId: ctx.tenantId,
    conversationId: ctx.conversationId,
    reservationId: ctx.reservationId ?? null,
    messageId: ctx.messageId ?? null,
    systemPromptVersion: ctx.systemPromptVersion ?? null,
    agentName: ctx.agentName ?? null,
    mode: ctx.mode ?? null,
    classifierDecision: ctx.classifierDecision ?? null,
    retrievalContext: ctx.retrievalContext ?? null,
  };
}

/**
 * Mutate the current root trace's context (e.g. stamp messageId when the
 * Message row is created, or fill classifierDecision after the SOP tool call).
 * Safe no-op outside a trace scope.
 */
export function stampAiTrace(patch: Partial<AiTraceContext>): void {
  const holder = aiTraceStore.getStore();
  if (!holder) return;
  Object.assign(holder.ctx, patch);
  // Merge-preserve nested dicts where appropriate.
  if (patch.classifierDecision) {
    holder.ctx.classifierDecision = { ...holder.ctx.classifierDecision, ...patch.classifierDecision };
  }
  if (patch.retrievalContext) {
    holder.ctx.retrievalContext = { ...holder.ctx.retrievalContext, ...patch.retrievalContext };
  }
  if (holder.trace) {
    try {
      holder.trace.update({ metadata: buildRootMetadata(holder.ctx) });
    } catch {
      /* swallow */
    }
  }
}

function getCurrentTrace(): LangfuseTrace | null {
  return aiTraceStore.getStore()?.trace ?? null;
}

// ─── Span emitter (non-LLM: tool calls, retrieval, classification, etc.) ─────

const NOOP_SPAN: AiSpanHandle = {
  end() {},
  addMetadata() {},
};

/**
 * Start a non-LLM span attached to the current root trace. Returns a handle
 * the caller ends when the operation completes. Safe no-op outside a trace
 * scope or when Langfuse is disabled.
 */
export function startAiSpan(
  name: string,
  input?: unknown,
  metadata?: Record<string, unknown>
): AiSpanHandle {
  const trace = getCurrentTrace();
  if (!trace) return NOOP_SPAN;
  let span: any;
  try {
    span = trace.span({
      name,
      input,
      metadata: metadata ?? {},
      startTime: new Date(),
    });
  } catch (err) {
    console.warn(`[Observability] startAiSpan(${name}) failed (non-fatal):`, err);
    return NOOP_SPAN;
  }
  let extraMetadata: Record<string, unknown> = {};
  return {
    end(output?: unknown, extra?: Record<string, unknown>) {
      try {
        span.end({
          output,
          metadata: { ...extraMetadata, ...(extra ?? {}) },
          endTime: new Date(),
        });
      } catch {
        /* swallow — span may already be ended */
      }
    },
    addMetadata(patch: Record<string, unknown>) {
      extraMetadata = { ...extraMetadata, ...patch };
    },
  };
}

/**
 * 2026-05-04 — emit a Langfuse `generation` node on the current root trace
 * for ONE internal `messages.create` round inside an agent SDK query.
 *
 * Caller convention (feature 047 spec FR-001): callers MUST pass
 * `metadata.roundIndex` (1-based, monotonic within one parent
 * `tuning-agent.query` span). The function does not enforce this — it just
 * forwards `metadata` to Langfuse — but downstream audit scripts
 * (`langfuse-cost-audit.ts`, `langfuse-trace-detail.ts`) rely on
 * `metadata.roundIndex` being present to group per-round generations under
 * the parent query span. Optional fields conventionally set in metadata:
 *   - `roundIndex: number` — required per the contract
 *   - `parentSpanId?: string` — optional explicit parent
 *   - `tenantId?: string`
 *   - `conversationId?: string`
 *   - `toolCallsInRound?: string[]` — tool names invoked in this round
 *
 * Emit cadence: callers fire ONE `logAgentGeneration` call per round, LIVE
 * (inside the SDK's `for await` loop, at the moment each `assistant`
 * message arrives with usage), NOT batched at end-of-query. See
 * `specs/047-studio-token-efficiency/contracts/observability.langfuse-generation.contract.md`.
 *
 * Safe no-op when Langfuse is disabled or no root trace is active.
 */
export interface AgentGenerationParams {
  name: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  metadata?: Record<string, unknown>;
}

/**
 * 2026-05-04 (feature 047 PR 1) — pure builder for the per-round emit
 * envelope. Used by both the SDK-transport runner (sdk-runner.ts) and the
 * direct-transport bridge (runtime-direct.ts when the MCP loop ports
 * over). Returns the params that get forwarded to logAgentGeneration —
 * no I/O, no Langfuse calls. This keeps the per-round emit testable
 * without mocking the entire Langfuse SDK.
 *
 * Convention: `roundIndex` is 1-based and monotonic within a single
 * tuning-agent.query span. Caller maintains the counter.
 */
export function buildPerRoundGenerationParams(input: {
  model: string;
  roundIndex: number;
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  toolNamesInRound?: string[];
  tenantId?: string;
  conversationId?: string;
}): AgentGenerationParams {
  return {
    name: 'tuning-agent.query',
    model: input.model,
    inputTokens: input.usage.input_tokens ?? 0,
    outputTokens: input.usage.output_tokens ?? 0,
    cacheReadTokens: input.usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: input.usage.cache_creation_input_tokens ?? 0,
    metadata: {
      roundIndex: input.roundIndex,
      ...(input.tenantId ? { tenantId: input.tenantId } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.toolNamesInRound !== undefined
        ? { toolCallsInRound: input.toolNamesInRound }
        : {}),
    },
  };
}

export function logAgentGeneration(params: AgentGenerationParams): void {
  const trace = getCurrentTrace();
  if (!trace) return;
  try {
    // 2026-05-04 — use `usageDetails` (modern Langfuse shape) instead of
    // the deprecated `usage` field. The model-pricing layer reads cache
    // tokens via these specific keys (cache_read_input_tokens,
    // cache_creation_input_tokens) to compute Anthropic cost correctly.
    // Putting them in metadata, as we did initially, leaves Langfuse
    // costing the call as if it had only the fresh input tokens visible.
    trace.generation({
      name: params.name,
      model: params.model,
      usageDetails: {
        input: params.inputTokens,
        output: params.outputTokens,
        cache_read_input_tokens: params.cacheReadTokens ?? 0,
        cache_creation_input_tokens: params.cacheCreationTokens ?? 0,
      },
      metadata: {
        ...(params.metadata ?? {}),
      },
    });
  } catch (err) {
    console.warn(`[Observability] logAgentGeneration(${params.name}) failed (non-fatal):`, err);
  }
}

// ─── Generation tracing (existing call-site: createMessage → traceAiCall) ────
// When a root trace is active, the generation is nested under it. When no root
// trace exists (e.g. legacy callers, standalone jobs), fall back to the
// previous behavior of creating a standalone trace+generation so we never lose
// a data point.

export function traceAiCall(params: TraceParams): void {
  const lf = getClient();
  if (!lf) return;
  try {
    const traceInput = params.systemPrompt
      ? [
          { role: 'system', content: params.systemPrompt.substring(0, 3000) },
          { role: 'user', content: params.userContentPreview || '(content blocks)' },
        ]
      : params.userContentPreview || `[${params.inputTokens} input tokens]`;
    const traceOutput = params.error ? `ERROR: ${params.error}` : params.responseText;

    const parent: any = getCurrentTrace();
    const target: any = parent
      ? parent // attach as a child of the active root trace
      : lf.trace({
          name: `ai-reply-${params.agentName}`,
          userId: params.tenantId,
          sessionId: params.conversationId,
          input: traceInput,
          output: traceOutput,
          metadata: {
            tenantId: params.tenantId,
            conversationId: params.conversationId,
            escalated: params.escalated,
            openTaskCount: params.openTaskCount ?? 0,
            totalMessages: params.totalMessages ?? 0,
            memorySummarized: params.memorySummarized ?? false,
            hasImage: params.hasImage ?? false,
          },
        });

    if (params.ragChunks && params.ragChunks.length > 0) {
      target.span({
        name: 'rag-retrieval',
        metadata: {
          query: params.ragQuery,
          chunksRetrieved: params.ragChunks.length,
          topScore: Math.max(...params.ragChunks.map(c => c.similarity)),
          chunks: params.ragChunks.slice(0, 5),
          durationMs: params.ragDurationMs,
        },
      });
    }

    target.generation({
      name: params.agentName,
      model: params.model,
      input: traceInput,
      output: traceOutput,
      usage: {
        input: params.inputTokens,
        output: params.outputTokens,
        unit: 'TOKENS',
      },
      metadata: {
        costUsd: params.costUsd,
        durationMs: params.durationMs,
        cacheCreationTokens: params.cacheCreationTokens ?? 0,
        cacheReadTokens: params.cacheReadTokens ?? 0,
        error: params.error,
      },
    });
  } catch (err) {
    console.warn('[Observability] Trace failed (non-fatal):', err);
  }
}

/** Log escalation outcome. Attaches to the active root trace as an event when
 * one exists; otherwise creates a standalone trace keyed by conversation so
 * escalations are never dropped. */
export function traceEscalation(params: {
  tenantId: string;
  conversationId: string;
  agentName: string;
  escalationType: string;
  escalationUrgency: string;
  escalationNote: string;
  taskResolved?: string;
  taskUpdated?: string;
}): void {
  const lf = getClient();
  if (!lf) return;
  try {
    const parent: any = getCurrentTrace();
    const target: any = parent
      ? parent
      : lf.trace({
          name: `escalation-${params.agentName}`,
          userId: params.tenantId,
          sessionId: params.conversationId,
          metadata: {
            tenantId: params.tenantId,
            conversationId: params.conversationId,
            escalationType: params.escalationType,
            escalationUrgency: params.escalationUrgency,
            escalationNote: params.escalationNote.substring(0, 500),
            taskResolved: params.taskResolved || null,
            taskUpdated: params.taskUpdated || null,
          },
        });
    target.event({
      name: 'escalation',
      metadata: {
        type: params.escalationType,
        urgency: params.escalationUrgency,
        note: params.escalationNote.substring(0, 500),
        taskResolved: params.taskResolved || null,
        taskUpdated: params.taskUpdated || null,
      },
    });
  } catch (err) {
    console.warn('[Observability] Escalation trace failed (non-fatal):', err);
  }
}

export async function flushObservability(): Promise<void> {
  const lf = getClient();
  if (!lf) return;
  try {
    await lf.flushAsync();
  } catch (err) {
    console.warn('[Observability] Flush failed (non-fatal):', err);
  }
}
