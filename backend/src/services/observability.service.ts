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
