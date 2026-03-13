/**
 * Langfuse observability — fire-and-forget tracing for every Claude API call.
 * Gracefully disabled when LANGFUSE env vars are missing.
 * Never throws, never crashes the AI pipeline.
 */
import { Langfuse } from 'langfuse';

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
}

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

/** Fire-and-forget — call this without await */
export function traceAiCall(params: TraceParams): void {
  const lf = getClient();
  if (!lf) return;
  try {
    const trace = lf.trace({
      name: `ai-reply-${params.agentName}`,
      userId: params.tenantId,
      sessionId: params.conversationId,
      metadata: {
        tenantId: params.tenantId,
        conversationId: params.conversationId,
        escalated: params.escalated,
      },
    });
    if (params.ragChunks && params.ragChunks.length > 0) {
      trace.span({
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
    trace.generation({
      name: params.agentName,
      model: params.model,
      input: { tokens: params.inputTokens },
      output: params.error ? undefined : params.responseText.substring(0, 1000),
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

export async function flushObservability(): Promise<void> {
  const lf = getClient();
  if (!lf) return;
  try {
    await lf.flushAsync();
  } catch (err) {
    console.warn('[Observability] Flush failed (non-fatal):', err);
  }
}
