/**
 * AI Service
 * All OpenAI GPT-5.4 Mini API calls, system prompts, and AI logic.
 * AI service — OpenAI Responses API (GPT-5.4 Mini).
 */

import OpenAI from 'openai';
import axios from 'axios';
import { PrismaClient, MessageRole, Channel } from '@prisma/client';
import * as hostawayService from './hostaway.service';
import { getAiConfig } from './ai-config.service';
import { createTask } from './task.service';
import { broadcastToTenant } from './sse.service';
import { traceAiCall, traceEscalation } from './observability.service';
import { searchAvailableProperties } from './property-search.service';
import { checkExtendAvailability } from './extend-stay.service';
import { retrieveRelevantKnowledge } from './rag.service';
import { getSopContent, buildToolDefinition, SOP_CATEGORIES } from './sop.service';
import { evaluateAndImprove } from './judge.service';
import { evaluateEscalation } from './task-manager.service';
import { buildTieredContext, formatConversationContext } from './memory.service';
import { getTenantAiConfig } from './tenant-config.service';
import { detectEscalationSignals } from './escalation-enrichment.service';
import { createChecklist, updateChecklist, getChecklist, hasPendingItems, type DocumentChecklist } from './document-checklist.service';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Model pricing (per 1M tokens) — loaded from config for easy updates ────
import modelPricingData from '../config/model-pricing.json';
const MODEL_PRICING: Record<string, { input: number; cachedInput?: number; output: number }> = modelPricingData;

function calculateCostUsd(model: string, inputTokens: number, outputTokens: number, cachedInputTokens = 0, reasoningTokens = 0): number {
  const pricing = MODEL_PRICING[model] || { input: 0.75, cachedInput: 0.075, output: 4.50 };
  const uncachedInputTokens = inputTokens - cachedInputTokens;
  const cachedRate = pricing.cachedInput ?? pricing.input * 0.1;
  return (uncachedInputTokens / 1_000_000) * pricing.input
    + (cachedInputTokens / 1_000_000) * cachedRate
    + ((outputTokens + reasoningTokens) / 1_000_000) * pricing.output;
}

// ─── Module-level DB reference for log persistence ───────────────────────────
let _prismaRef: PrismaClient | null = null;
export function setAiServicePrisma(prisma: PrismaClient) { _prismaRef = prisma; }

// ─── Retry wrapper (rate limit 429, server errors 500/502/503) ──────────────
async function withRetry<T>(fn: () => Promise<T>, retries = 6): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const e = err as { status?: number; code?: string };
      const isRetryable = e?.status === 429 || e?.status === 500 || e?.status === 502 || e?.status === 503;
      if (isRetryable && attempt < retries) {
        // Exponential backoff with jitter: 1-60s range
        const baseDelay = Math.min(1000 * Math.pow(2, attempt), 60000);
        const jitter = baseDelay * (0.5 + Math.random() * 0.5);
        console.warn(`[AI] Retry ${attempt + 1}/${retries} after ${Math.round(jitter)}ms (status=${e?.status})`);
        await sleep(jitter);
        continue;
      }
      throw err;
    }
  }
  throw new Error('Unreachable');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

type ContentBlock = { type: 'text'; text: string };

// ─── API call log (in-memory ring buffer) ────────────────────────────────────

export interface AiApiLogEntry {
  id: string;
  timestamp: string;
  agentName?: string;
  model: string;
  temperature?: number;
  maxTokens: number;
  topK?: number;
  topP?: number;
  systemPromptPreview: string;
  systemPromptLength: number;
  contentBlocks: { type: string; textPreview?: string; textLength?: number }[];
  responseText: string;
  responseLength: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  error?: string;
  openaiRequestId?: string;
  rateLimitRemaining?: { requests: number; tokens: number };
  ragContext?: {
    query: string;
    chunks: Array<{ content: string; category: string; similarity: number; sourceKey: string; isGlobal: boolean }>;
    totalRetrieved: number;
    durationMs: number;
    classifierUsed?: boolean;
    openaiRequestId?: string;
    rateLimitRemaining?: { requests: number; tokens: number };
  } | null;
}

const AI_LOG_MAX = 50;
const aiApiLog: AiApiLogEntry[] = [];

export function getAiApiLog(): AiApiLogEntry[] {
  return [...aiApiLog];
}

export type ToolHandler = (input: unknown, context: unknown) => Promise<string>;

// ─── SOP Classification via Tool Use ────────────────────────────────────────
// Single forced tool call to classify each guest message into SOP categories.
// Replaces the 3-tier pipeline (LR classifier, intent extractor, topic state cache).
interface SopClassificationResult {
  categories: string[];
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

// SOP categories that benefit from reasoning (complex multi-step logic)
const REASONING_CATEGORIES = new Set(['sop-booking-modification', 'sop-booking-cancellation', 'payment-issues', 'escalate']);

// ─── Structured output schemas (enforced by OpenAI, replaces prompt-based JSON instructions) ───

const COORDINATOR_SCHEMA = {
  type: 'json_schema' as const,
  name: 'coordinator_response',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      guest_message: { type: 'string', description: 'Reply to the guest' },
      escalation: {
        anyOf: [
          { type: 'null' },
          {
            type: 'object',
            properties: {
              title: { type: 'string' },
              note: { type: 'string' },
              urgency: { type: 'string', enum: ['immediate', 'scheduled', 'info_request'] },
            },
            required: ['title', 'note', 'urgency'],
            additionalProperties: false,
          },
        ],
      },
      resolveTaskId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      updateTaskId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    },
    required: ['guest_message', 'escalation', 'resolveTaskId', 'updateTaskId'],
    additionalProperties: false,
  },
};

const SCREENING_SCHEMA = {
  type: 'json_schema' as const,
  name: 'screening_response',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      'guest message': { type: 'string', description: 'Reply to the guest' },
      manager: {
        type: 'object',
        properties: {
          needed: { type: 'boolean' },
          title: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['needed', 'title', 'note'],
        additionalProperties: false,
      },
    },
    required: ['guest message', 'manager'],
    additionalProperties: false,
  },
};

async function classifyMessageSop(
  systemPrompt: string,
  inputMessages: Array<{ role: string; content: string }>,
  options: { model?: string; tenantId?: string; conversationId?: string; agentType?: string },
  sopToolDef?: any,
): Promise<SopClassificationResult> {
  const start = Date.now();
  try {
    const response = await withRetry(() => (openai.responses as any).create({
      model: options.model || 'gpt-5.4-mini-2026-03-17',
      instructions: systemPrompt,
      input: inputMessages,
      tools: [sopToolDef],
      tool_choice: { type: 'function', name: 'get_sop' },
      reasoning: { effort: 'none' },
      max_output_tokens: 200,
      prompt_cache_key: options.tenantId ? `tenant-${options.tenantId}-${options.agentType || 'default'}` : undefined,
      prompt_cache_retention: '24h',
      store: true,
    }));

    const durationMs = Date.now() - start;
    const fnCall = (response as any).output?.find((i: any) => i.type === 'function_call');

    if (fnCall) {
      const args = JSON.parse(fnCall.arguments) as { categories: string[]; confidence: string; reasoning: string };
      console.log(`[AI] SOP classification: [${args.categories.join(', ')}] confidence=${args.confidence} (${durationMs}ms) — ${args.reasoning}`);
      return {
        categories: args.categories,
        confidence: args.confidence as 'high' | 'medium' | 'low',
        reasoning: args.reasoning,
        inputTokens: (response as any).usage?.input_tokens || 0,
        outputTokens: (response as any).usage?.output_tokens || 0,
        durationMs,
      };
    }

    console.warn(`[AI] SOP classification returned no function_call — defaulting to none`);
    return { categories: ['none'], confidence: 'low', reasoning: 'Classification returned no function_call', inputTokens: (response as any).usage?.input_tokens || 0, outputTokens: (response as any).usage?.output_tokens || 0, durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    console.error(`[AI] SOP classification failed (non-fatal):`, err);
    return { categories: ['none'], confidence: 'low', reasoning: 'Classification API call failed', inputTokens: 0, outputTokens: 0, durationMs };
  }
}

async function createMessage(
  systemPrompt: string,
  userContent: ContentBlock[],
  options?: { model?: string; maxTokens?: number; topK?: number; topP?: number; temperature?: number; stopSequences?: string[]; agentName?: string; tenantId?: string; conversationId?: string; ragContext?: { query: string; chunks: Array<{ content: string; category: string; similarity: number; sourceKey: string; isGlobal: boolean }>; totalRetrieved: number; durationMs: number; toolUsed?: boolean; toolName?: string; toolInput?: any; toolResults?: any; toolDurationMs?: number; openaiRequestId?: string; rateLimitRemaining?: { requests: number; tokens: number } }; openTaskCount?: number; totalMessages?: number; memorySummarized?: boolean; hasImage?: boolean; ragEnabled?: boolean; tools?: any[]; toolChoice?: any; toolHandlers?: Map<string, ToolHandler>; toolContext?: unknown; reasoningEffort?: 'none' | 'low' | 'medium' | 'high'; agentType?: string; stream?: boolean; inputTurns?: Array<{ role: 'user' | 'assistant'; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }>; outputSchema?: any }
): Promise<string> {
  const startMs = Date.now();
  const model = options?.model || 'gpt-5.4-mini-2026-03-17';
  const maxTokens = options?.maxTokens || 300;
  const reasoningEffort = options?.reasoningEffort || 'none';

  const logEntry: AiApiLogEntry = {
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    agentName: options?.agentName,
    model,
    temperature: options?.temperature,
    maxTokens,
    topK: options?.topK,
    topP: options?.topP,
    systemPromptPreview: systemPrompt.substring(0, 200),
    systemPromptLength: systemPrompt.length,
    contentBlocks: userContent.map(b => ({ type: 'text', textPreview: b.text, textLength: b.text.length })),
    responseText: '',
    responseLength: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    ragContext: options?.ragContext ?? null,
  };

  try {
    // Use multi-turn conversation array if provided, otherwise fall back to single-message ContentBlock
    const inputMessages: any[] = options?.inputTurns
      ? options.inputTurns
      : userContent
          .filter(b => b.type === 'text')
          .map(b => ({ role: 'user', content: (b as { type: 'text'; text: string }).text }));

    // OpenAI Responses API call
    const createParams: any = {
      model,
      instructions: systemPrompt,
      input: inputMessages,
      max_output_tokens: maxTokens,
      ...(reasoningEffort !== 'none' ? { reasoning: { effort: reasoningEffort } } : { reasoning: { effort: 'none' } }),
      ...(reasoningEffort === 'none' && options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options?.tools?.length ? { tools: options.tools, tool_choice: options.toolChoice ?? 'auto' } : {}),
      text: options?.outputSchema ? { format: options.outputSchema } : { format: { type: 'text' } },
      truncation: 'auto',
      store: true,
      ...(options?.tenantId ? { prompt_cache_key: `tenant-${options.tenantId}-${options.agentType || 'default'}` } : {}),
      prompt_cache_retention: '24h',
    };

    // ─── Helper: extract rate limit headers and request ID from response ───
    const extractOpsHeaders = (resp: any): { openaiRequestId?: string; rateLimitRemaining?: { requests: number; tokens: number } } => {
      const result: { openaiRequestId?: string; rateLimitRemaining?: { requests: number; tokens: number } } = {};
      // The Responses API may expose headers on the response object or via response.headers
      // Try multiple access patterns for forward-compatibility with SDK updates
      const headers = resp?.headers || resp?._headers;
      if (headers) {
        const requestId = typeof headers.get === 'function' ? headers.get('x-request-id') : headers['x-request-id'];
        if (requestId) result.openaiRequestId = String(requestId);
        const remainingReqs = typeof headers.get === 'function' ? headers.get('x-ratelimit-remaining-requests') : headers['x-ratelimit-remaining-requests'];
        const remainingTokens = typeof headers.get === 'function' ? headers.get('x-ratelimit-remaining-tokens') : headers['x-ratelimit-remaining-tokens'];
        if (remainingReqs !== undefined || remainingTokens !== undefined) {
          result.rateLimitRemaining = {
            requests: parseInt(String(remainingReqs || '0'), 10) || 0,
            tokens: parseInt(String(remainingTokens || '0'), 10) || 0,
          };
        }
      }
      // Fallback: some SDK versions put request ID directly on response
      if (!result.openaiRequestId && resp?.request_id) {
        result.openaiRequestId = String(resp.request_id);
      }
      return result;
    };

    let response: any = await withRetry(() =>
      (openai.responses as any).create(createParams)
    );

    // T042: Log rate limit headers and request ID from initial call
    const initialOpsHeaders = extractOpsHeaders(response);
    if (initialOpsHeaders.openaiRequestId) {
      console.log(`[AI-OPS] Request ID: ${initialOpsHeaders.openaiRequestId}`);
    }
    if (initialOpsHeaders.rateLimitRemaining) {
      console.log(`[AI-OPS] Rate limit remaining — requests: ${initialOpsHeaders.rateLimitRemaining.requests}, tokens: ${initialOpsHeaders.rateLimitRemaining.tokens}`);
    }

    // ─── Tool use loop: if model wants to call a tool, execute and send result back ───
    const fnCall = response.output?.find((i: any) => i.type === 'function_call');
    if (fnCall && options?.toolHandlers) {
      const handler = options.toolHandlers.get(fnCall.name);
      const toolStartMs = Date.now();
      let toolResultContent: string;
      try {
        const toolInput = JSON.parse(fnCall.arguments);
        if (handler) {
          toolResultContent = await handler(toolInput, options.toolContext);
        } else {
          toolResultContent = JSON.stringify({ error: `Unknown tool: ${fnCall.name}`, found: false, properties: [] });
        }
      } catch (toolErr) {
        console.error(`[AI] Tool handler error for ${fnCall.name}:`, toolErr);
        toolResultContent = JSON.stringify({ error: 'Tool execution failed. Please escalate to the property manager.', found: false, properties: [], should_escalate: true });
      }
      const toolDurationMs = Date.now() - toolStartMs;

      // Log tool usage to ragContext
      if (options?.ragContext) {
        options.ragContext.toolUsed = true;
        options.ragContext.toolName = fnCall.name;
        try { options.ragContext.toolInput = JSON.parse(fnCall.arguments); } catch { options.ragContext.toolInput = fnCall.arguments; }
        try { options.ragContext.toolResults = JSON.parse(toolResultContent); } catch { options.ragContext.toolResults = toolResultContent; }
        options.ragContext.toolDurationMs = toolDurationMs;
      }

      console.log(`[AI] Tool ${fnCall.name} executed in ${toolDurationMs}ms`);

      // Send tool result back via previous_response_id
      // T029: When streaming is enabled, stream the tool follow-up call (the final response to guest)
      const toolFollowUpTextFormat = options?.outputSchema ? { format: options.outputSchema } : { format: { type: 'text' as const } };
      if (options?.stream && options?.tenantId && options?.conversationId) {
        const toolFollowUpStream = await withRetry(() =>
          (openai.responses as any).create({
            model,
            instructions: systemPrompt,
            input: [{ type: 'function_call_output', call_id: fnCall.call_id, output: toolResultContent }],
            previous_response_id: response.id,
            max_output_tokens: maxTokens,
            reasoning: { effort: reasoningEffort },
            text: toolFollowUpTextFormat,
            store: true,
            stream: true,
          })
        );

        let streamedText = '';
        let streamResponse: any = null;
        for await (const event of toolFollowUpStream as AsyncIterable<any>) {
          if (event.type === 'response.output_text.delta') {
            streamedText += event.delta;
            broadcastToTenant(options.tenantId, 'ai_typing_text', {
              conversationId: options.conversationId,
              delta: event.delta,
              done: false,
            });
          }
          if (event.type === 'response.completed') {
            streamResponse = event.response;
          }
        }

        // Emit final done event
        broadcastToTenant(options.tenantId, 'ai_typing_text', {
          conversationId: options.conversationId,
          delta: '',
          done: true,
        });

        // Use the completed response for usage/headers
        response = streamResponse || { output_text: streamedText, usage: {} };
        if (!response.output_text) response.output_text = streamedText;

        // T042: Log ops headers from tool follow-up
        const toolOpsHeaders = extractOpsHeaders(response);
        if (toolOpsHeaders.openaiRequestId) {
          console.log(`[AI-OPS] Tool follow-up Request ID: ${toolOpsHeaders.openaiRequestId}`);
        }
        if (toolOpsHeaders.rateLimitRemaining) {
          console.log(`[AI-OPS] Tool follow-up rate limit — requests: ${toolOpsHeaders.rateLimitRemaining.requests}, tokens: ${toolOpsHeaders.rateLimitRemaining.tokens}`);
        }
      } else {
        // Non-streaming tool follow-up (existing behavior)
        response = await withRetry(() =>
          (openai.responses as any).create({
            model,
            instructions: systemPrompt,
            input: [{ type: 'function_call_output', call_id: fnCall.call_id, output: toolResultContent }],
            previous_response_id: response.id,
            max_output_tokens: maxTokens,
            reasoning: { effort: reasoningEffort },
            text: toolFollowUpTextFormat,
            store: true,
          })
        );

        // T042: Log ops headers from tool follow-up
        const toolOpsHeaders = extractOpsHeaders(response);
        if (toolOpsHeaders.openaiRequestId) {
          console.log(`[AI-OPS] Tool follow-up Request ID: ${toolOpsHeaders.openaiRequestId}`);
        }
        if (toolOpsHeaders.rateLimitRemaining) {
          console.log(`[AI-OPS] Tool follow-up rate limit — requests: ${toolOpsHeaders.rateLimitRemaining.requests}, tokens: ${toolOpsHeaders.rateLimitRemaining.tokens}`);
        }
      }
    } else if (options?.stream && options?.tenantId && options?.conversationId && !fnCall) {
      // ─── T029: Streaming for non-tool calls ───
      // Initial call was non-streaming (needed to check for tool calls first).
      // Emit the already-received full text as SSE so the frontend gets the typing effect.
      const fullText = response.output_text || '';
      if (fullText) {
        broadcastToTenant(options.tenantId, 'ai_typing_text', {
          conversationId: options.conversationId,
          delta: fullText,
          done: false,
        });
      }
      broadcastToTenant(options.tenantId, 'ai_typing_text', {
        conversationId: options.conversationId,
        delta: '',
        done: true,
      });
    }

    const responseText = response.output_text || '';

    // T042/T043: Capture final ops headers into log entry and ragContext
    const finalOpsHeaders = extractOpsHeaders(response);
    logEntry.openaiRequestId = finalOpsHeaders.openaiRequestId || initialOpsHeaders.openaiRequestId;
    logEntry.rateLimitRemaining = finalOpsHeaders.rateLimitRemaining || initialOpsHeaders.rateLimitRemaining;
    if (options?.ragContext) {
      options.ragContext.openaiRequestId = logEntry.openaiRequestId;
      options.ragContext.rateLimitRemaining = logEntry.rateLimitRemaining;
    }

    logEntry.responseText = responseText;
    logEntry.responseLength = responseText.length;
    logEntry.inputTokens = response.usage?.input_tokens ?? 0;
    logEntry.outputTokens = response.usage?.output_tokens ?? 0;
    logEntry.durationMs = Date.now() - startMs;

    const cachedInputTokens = response.usage?.input_tokens_details?.cached_tokens ?? 0;
    const reasoningTokens = response.usage?.output_tokens_details?.reasoning_tokens ?? 0;

    // Push to ring buffer
    aiApiLog.unshift(logEntry);
    if (aiApiLog.length > AI_LOG_MAX) aiApiLog.length = AI_LOG_MAX;

    // Persist to DB
    const costUsd = calculateCostUsd(model, logEntry.inputTokens, logEntry.outputTokens, cachedInputTokens, reasoningTokens);

    // Enrich ragContext with cache/reasoning metrics for analytics (T035)
    const enrichedRagContext = options?.ragContext
      ? {
          ...options.ragContext,
          cachedInputTokens,
          totalInputTokens: logEntry.inputTokens,
          reasoningTokens,
          reasoningEffort: reasoningEffort,
          costUsd,
        }
      : options?.tenantId
        ? { cachedInputTokens, totalInputTokens: logEntry.inputTokens, reasoningTokens, reasoningEffort: reasoningEffort, costUsd }
        : undefined;

    if (_prismaRef && options?.tenantId) {
      _prismaRef.aiApiLog.create({
        data: {
          tenantId: options.tenantId,
          conversationId: options.conversationId || null,
          agentName: options.agentName || '',
          model,
          temperature: options.temperature,
          maxTokens,
          systemPrompt,
          userContent: JSON.stringify(inputMessages),
          responseText,
          inputTokens: logEntry.inputTokens,
          outputTokens: logEntry.outputTokens,
          costUsd,
          durationMs: logEntry.durationMs,
          ragContext: enrichedRagContext,
        },
      }).catch(e => console.error('[AI-LOG] DB persist error:', e));
    }

    // Langfuse observability — fire-and-forget
    if (options?.tenantId && options?.conversationId) {
      const userContentPreview = inputMessages
        .map((m: any) => typeof m.content === 'string' ? m.content.substring(0, 500) : `[${m.role}]`)
        .join('\n---\n')
        .substring(0, 3000);
      traceAiCall({
        tenantId: options.tenantId,
        conversationId: options.conversationId,
        agentName: options.agentName || 'unknown',
        model,
        inputTokens: logEntry.inputTokens,
        outputTokens: logEntry.outputTokens,
        costUsd,
        durationMs: logEntry.durationMs,
        responseText,
        escalated: false,
        cacheCreationTokens: 0,
        cacheReadTokens: cachedInputTokens,
        ragChunks: options.ragContext?.chunks,
        ragDurationMs: options.ragContext?.durationMs,
        ragQuery: options.ragContext?.query,
        openTaskCount: options.openTaskCount,
        totalMessages: options.totalMessages,
        memorySummarized: options.memorySummarized,
        hasImage: options.hasImage,
        ragEnabled: options.ragEnabled,
        systemPrompt,
        userContentPreview,
      });
    }

    if (cachedInputTokens > 0) {
      console.log(`[AI-LOG] ${model} | ${logEntry.inputTokens}in/${logEntry.outputTokens}out | cached: ${cachedInputTokens} | reasoning: ${reasoningTokens} | ${logEntry.durationMs}ms | $${costUsd.toFixed(4)}`);
    } else {
      console.log(`[AI-LOG] ${model} | ${logEntry.inputTokens}in/${logEntry.outputTokens}out | ${logEntry.durationMs}ms | $${costUsd.toFixed(4)}`);
    }

    return responseText;
  } catch (err) {
    logEntry.durationMs = Date.now() - startMs;
    logEntry.error = err instanceof Error ? err.message : String(err);
    aiApiLog.unshift(logEntry);
    if (aiApiLog.length > AI_LOG_MAX) aiApiLog.length = AI_LOG_MAX;

    // Upgrade 1: Trace errors too
    if (options?.tenantId && options?.conversationId) {
      traceAiCall({
        tenantId: options.tenantId,
        conversationId: options.conversationId,
        agentName: options.agentName || 'unknown',
        model,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        durationMs: logEntry.durationMs,
        responseText: '',
        escalated: false,
        error: logEntry.error,
        ragChunks: options.ragContext?.chunks,
        ragDurationMs: options.ragContext?.durationMs,
        ragQuery: options.ragContext?.query,
      });
    }

    // Persist error to DB
    if (_prismaRef && options?.tenantId) {
      _prismaRef.aiApiLog.create({
        data: {
          tenantId: options.tenantId,
          conversationId: options.conversationId || null,
          agentName: options.agentName || '',
          model,
          temperature: options.temperature,
          maxTokens,
          systemPrompt,
          userContent: JSON.stringify(userContent.map(b => ({ type: 'text', text: b.text }))),
          responseText: '',
          inputTokens: logEntry.inputTokens,
          outputTokens: logEntry.outputTokens,
          costUsd: 0,
          durationMs: logEntry.durationMs,
          error: logEntry.error,
          ragContext: options.ragContext ?? undefined,
        },
      }).catch(e => console.error('[AI-LOG] DB persist error:', e));
    }

    throw err;
  }
}

function stripCodeFences(text: string): string {
  let s = text.trim();
  if (s.startsWith('```')) {
    const firstNewline = s.indexOf('\n');
    if (firstNewline !== -1) s = s.substring(firstNewline + 1);
  }
  if (s.endsWith('```')) s = s.substring(0, s.length - 3);
  return s.trim();
}

// ─── System Prompts ────────────────────────────────────────

const SEED_COORDINATOR_PROMPT = `# OMAR — Lead Guest Coordinator, Boutique Residence

You are Omar, the Lead Guest Coordinator for Boutique Residence serviced apartments in New Cairo, Egypt. Your manager is Abdelrahman. You handle guest requests efficiently and escalate to Abdelrahman when human action is needed.

Before responding, always reason through the request internally: analyze what the guest needs, check if it's covered by your SOPs or the injected property info, assess whether escalation is needed, and only then draft your response.

---

IMPORTANT — BATCHED MESSAGES: The guest may have sent multiple messages in sequence. All messages are presented together for context. Treat them as a single continuous conversation, not separate requests. Read all messages before responding. Address everything the guest mentioned in one natural, coherent reply. Do not number your responses or say "regarding your first message". Just respond naturally.

---

## CONTEXT YOU RECEIVE

Each request includes these sections:

1. **CONVERSATION HISTORY** — all prior messages between you and the guest. If the conversation is long, older messages appear as a bullet-point summary followed by the most recent messages verbatim. Use the summary for context continuity but rely on recent messages for the current situation.

2. **PROPERTY & GUEST INFO** — guest name, reservation dates, guest count, access codes (WiFi, door code), available amenities, and any verified knowledge retrieved from the property's knowledge base. **This is your primary source of truth for all property-specific information.**

3. **OPEN TASKS** — currently open escalation tasks for this conversation. Check these before creating duplicate escalations. If a task already covers what the guest is asking about, acknowledge that it's being handled rather than re-escalating. You can also resolve tasks when a guest confirms an issue is fixed.

4. **CURRENT GUEST MESSAGE(S)** — the message(s) you need to respond to now.

5. **CURRENT LOCAL TIME** — the property's current local time. Use this for all scheduling decisions (working hours vs after-hours).

**Data rule:** Only answer using information explicitly provided in PROPERTY & GUEST INFO or in the SOPs below. If a guest asks about something not covered in either source, tell them you'll check and escalate. Never guess or invent details.

**History rule:** Before asking the guest any question, check CONVERSATION HISTORY first. If the information was already provided (nationality, guest count, dates, preferences), do NOT ask again. Avoid repeating the same property list or information the guest has already seen.

---

## TONE & STYLE

- Talk like a normal human. Not overly friendly, not robotic. Just natural and professional — the way a competent colleague would text a guest.
- 1–2 sentences max. Guests want help, not conversation.
- Always respond in English, regardless of what language the guest writes in.
- Avoid excessive exclamation marks. Don't overuse the guest's name.
- Use the guest's first name sparingly — once in a conversation is enough.
- Never mention AI, systems, internal processes, 'our team', 'the team', or any staff to the guest. You MAY say 'I'll check with the manager' or 'I've notified the manager' — but never reference anyone else.
- Never reference JSON, output format, or underlying processes to the guest.
- Politely redirect off-topic messages back to their needs.
- **If a guest sends a conversation-ending acknowledgment** ("okay", "sure", "thanks", "👍", thumbs up, etc.) **and there's nothing left to action — set guest_message to "" and escalation to null.**

---

## KEY INFO

**Hours:**
- Check-in: 3:00 PM
- Check-out: 11:00 AM

**House Rules:**
- Family-only property
- No smoking indoors
- No parties or gatherings
- Quiet hours apply
- **Visitors:** Only immediate family members are allowed. Guest must send visitor's passport through the chat. Family names must match the guest's family name. Collect the passport image and escalate to manager for verification. Anyone not initially approved and not immediate family is not allowed.
- **Co-Guests vs Visitors:** People listed on the reservation as co-guests are NOT visitors — they are part of the booking. The visitor policy applies only to people NOT on the reservation who want to enter the unit. If a guest says their brother/spouse/child is on the booking, do NOT apply the visitor policy.
- Any pushback on house rules → escalate immediately

---

## ESCALATION LOGIC

### Set "escalation": null when:
- Answering questions from PROPERTY & GUEST INFO (WiFi, door code, check-in/out, address, amenities)
- Asking the guest for their preferred time (before they've confirmed)
- Explaining the $20 cleaning fee
- Providing early check-in/late checkout policy (when request is more than 2 days out — do NOT escalate these)
- Simple clarifications that need no action
- Guest sends a conversation-ending message ("okay", "thanks", 👍) — also set guest_message to ""

### Set "escalation" with urgency "immediate" when:
- Emergencies: fire, gas, flood, medical, safety threats
- Technical issues: WiFi not working, door code failure, broken appliances
- Noise complaints
- Guest complaints or expressed dissatisfaction
- House rule violations or pushback
- Guest sends an image (after you analyze and respond to it)
- Anything you're unsure about

### Set "escalation" with urgency "scheduled" when:
- Cleaning request — after guest confirms time and you've mentioned $20
- Amenity delivery — after guest confirms time
- Maintenance/repair — after guest confirms time
- After-hours requests — after next-day time is confirmed

### Set "escalation" with urgency "info_request" when:
- Local recommendations (restaurants, hospitals, malls, attractions)
- Reservation changes (extend stay, change dates)
- Early check-in or late checkout requests ONLY when within 2 days of the date
- Refund or discount requests — never authorize, always escalate
- Pricing inquiries beyond what's in SOPs
- Any question you don't have the answer to

---

## EXTEND STAY TOOL

You have access to a \`check_extend_availability\` tool that checks if the property is available for extended/modified dates and calculates the price.

**WHEN to use it:**
- Guest asks to extend their stay ("Can I stay 2 more nights?", "Is the apartment available until Sunday?")
- Guest asks to shorten their stay or leave early ("Can I check out a day early?")
- Guest asks to shift dates ("Can I arrive Thursday instead of Wednesday?")
- Guest asks about pricing for extra nights ("How much would 3 more nights cost?")

**WHEN NOT to use it:**
- Guest is asking about something unrelated (WiFi, check-in time, amenities)
- Guest hasn't specified dates — ask them first before calling the tool

**HOW to present results:**
- Always include the price from the tool result (total_additional_cost) in your message
- Always include the channel_instructions from the tool result — this tells the guest exactly how to proceed based on their booking channel
- If partially available, tell the guest the maximum extension and the date of the next booking
- If price is null, say you'll check pricing with the manager and escalate

**Example response:**
{"guest_message":"Great news! The apartment is available until March 27. The 2 extra nights would be approximately $300. To extend, please submit an alteration request through Airbnb and we'll approve it right away.","escalation":{"title":"stay-extension-request","note":"Guest [Name] requesting extension from Mar 25 to Mar 27 (2 extra nights, ~$300). Channel: Airbnb. Guest instructed to submit alteration request.","urgency":"scheduled"}}

---

## IMAGE HANDLING

When a guest sends an image:
1. Respond naturally based on what you see — the way a human would. Don't describe the image back to the guest (a human wouldn't say "I see a broken mirror"). Just respond with the appropriate action or acknowledgment.
2. Always escalate to manager. In the escalation note, describe what the image shows so the manager has context.
3. If the image is unclear: tell the guest you're looking into it and escalate with "Guest sent an image that requires manager review."

Common image types:
- Broken item photos = maintenance escalation
- Leak/damage photos = urgent repair escalation
- Passport/ID = if DOCUMENT CHECKLIST has pending items, call mark_document_received tool. Otherwise, visitor verification escalation.
- Marriage certificate = if DOCUMENT CHECKLIST has pending items, call mark_document_received tool. Otherwise, escalate.
- Appliance photos = troubleshooting or malfunction escalation

Never ignore images. The image is often the most important part of the message.

---

## DOCUMENT CHECKLIST

If the DOCUMENT CHECKLIST section appears in your context with pending items, ask the guest to send their documents through the chat. Ask on your first message after booking acceptance. On subsequent messages, only remind when natural — don't repeat on every message. When all documents are received, don't mention documents at all.

---

## RESPONSE FIELDS

- **guest_message**: Your reply to the guest. Keep it concise (1-2 sentences). Empty string if no reply needed (guest said "thanks", conversation ending).
- **escalation**: Set to null when no escalation needed. When escalating, include: title (kebab-case label), note (actionable note for Abdelrahman with guest name, unit, and details), urgency ("immediate", "scheduled", or "info_request").
- **resolveTaskId**: Optional. Set to a task ID from OPEN TASKS when the guest confirms an issue is resolved.
- **updateTaskId**: Optional. Set to a task ID from OPEN TASKS when updating an existing escalation with new info.

---

## EXAMPLES

**Example 1 — Simple info question:**

Guest: "What's the WiFi password?"

{"guest_message":"WiFi network is [name from property info], password is [password from property info].","escalation":null}

Read WiFi details from PROPERTY & GUEST INFO and provide directly. No filler, no "hope that helps!".

**Example 2 — Cleaning request (two-turn flow):**

Guest: "Can we get the place cleaned today?"

{"guest_message":"Sure, what time works for you? We do visits between 10am and 5pm.","escalation":null}

Guest: "Around 1pm"

{"guest_message":"Got it, housekeeping will come around 1pm. Just so you know, cleaning is $20 per session.","escalation":{"title":"cleaning-scheduled","note":"Guest [Name] in [Unit] requested cleaning at 1pm today. Confirmed. $20 charge applies.","urgency":"scheduled"}}

Fee is mentioned on confirmation, not on the first ask. Tone is casual and direct.

**Example 3 — Urgent issue:**

Guest: "There's no hot water"

{"guest_message":"Sorry about that — I'm getting someone to look into it now.","escalation":{"title":"maintenance-no-hot-water","note":"Guest [Name] in [Unit] reports no hot water. Needs maintenance ASAP.","urgency":"immediate"}}

No panic, no over-apologizing. Just acknowledge and act.

**Example 4 — Unknown item request:**

Guest: "Do you have a phone charger?"

{"guest_message":"Let me check on that and get back to you.","escalation":{"title":"amenity-request-unlisted","note":"Guest [Name] in [Unit] asking for a phone charger. Not on standard amenities list. Please confirm if available.","urgency":"info_request"}}

Never confirm availability of items not in PROPERTY & GUEST INFO.

**Example 5 — After-hours request:**

Guest: "Can someone clean the apartment?" (sent at 8pm)

{"guest_message":"I can arrange cleaning for tomorrow. What time works for you between 10am and 5pm?","escalation":null}

After 5pm, everything gets pushed to the next day. Check CURRENT LOCAL TIME.

**Example 6 — Early check-in, more than 2 days out:**

Guest: "I'm arriving at noon, can I check in before 3pm?" (check-in is far away)

{"guest_message":"Early check-in depends on whether we have guests checking out, so we can only confirm 2 days before. If you arrive early, you can leave your bags with housekeeping — and O1 Mall is a minute away if you need coffee or food.","escalation":null}

No escalation needed. Just inform the policy and offer the alternative.

**Example 7 — Task resolution:**

OPEN TASKS shows: [clm9abc123] maintenance-no-hot-water (immediate)
Guest: "Hot water is working now, thanks!"

{"guest_message":"","escalation":null,"resolveTaskId":"clm9abc123"}

Guest confirmed the issue is resolved — resolve the task and no reply needed.

---

## TASK UPDATES (MANDATORY — check before EVERY escalation)

**CRITICAL: Before creating ANY escalation, you MUST check OPEN TASKS above.**

1. If an open task covers the same topic (even worded differently), use updateTaskId to append new details. Do NOT create a new task.
2. If the guest sends multiple rapid-fire messages about the same issue, consolidate all details into ONE escalation. Never create separate tasks for each message in a burst.
3. If the guest says an issue is resolved, use resolveTaskId to close the task.
4. Only create a new escalation when the request is genuinely about a DIFFERENT topic than all open tasks.

---

## HARD BOUNDARIES

- Never authorize refunds, credits, or discounts
- Never guarantee specific arrival times — use "shortly" or "as soon as possible"
- Never promise specific timeframes for manager responses — never say 'within 15 minutes', 'in 10 minutes', or any specific time. Use 'shortly' or 'as soon as possible'.
- Never guess information you don't have — if an item, service, or detail isn't in your SOPs or PROPERTY & GUEST INFO, don't confirm it exists
- Never confirm cleaning/amenity/maintenance without getting the guest's preferred time first
- Never confirm early check-in or late checkout — always escalate
- Never discuss internal processes or the manager with the guest
- Never answer questions or accept requests you don't know the answer to — always escalate to manager if unsure
- Always uphold house rules — escalate any pushback immediately
- Prioritize safety threats above all else
- When in doubt, escalate — it's better to over-escalate than miss something important
- Never output anything other than the JSON object`;

const SEED_SCREENING_PROMPT = `# OMAR — Guest Screening Assistant, Boutique Residence

You are Omar, a guest screening assistant for Boutique Residence serviced apartments in New Cairo, Egypt. Your manager is Abdelrahman. You screen guest inquiries against house rules, answer basic property questions, and escalate to Abdelrahman when a booking decision is needed.

Before responding, always reason through the request internally: check conversation history for what's already been answered, identify what information is still missing, apply house rules, and only then draft your response.

---

## ⚠️ ABSOLUTE PRIORITY: SCREENING FIRST

Before answering ANY question — about availability, amenities, check-in times, pricing, property details, or anything else — you MUST first establish:
1. The guest's **nationality** (always ask explicitly, never assume from name)
2. **Who they are traveling with** (party composition — solo, couple, family, friends)

If EITHER piece of information is unknown (not provided in conversation history), your response MUST ask for it. You may briefly acknowledge the guest's question, but do not answer it in detail or offer to proceed with any booking.

This rule overrides all injected SOPs. Even if a booking-inquiry or amenity SOP is injected below, nationality and party composition come first.

---

## CONTEXT YOU RECEIVE

Each message contains:
- **\`### CONVERSATION HISTORY ###\`** — all previous messages between you and the guest
- **\`### PROPERTY & GUEST INFO ###\`** — guest name, booking dates, number of guests, unit details
- **\`### CURRENT GUEST MESSAGE(S) ###\`** — the guest's latest message(s)

Always check conversation history first. Do NOT re-ask questions the guest has already answered.

---

## TONE & STYLE

- Talk like a normal human. Not overly friendly, not robotic. Just natural and professional.
- 1–2 sentences max. Keep it short and focused.
- Always respond in English, regardless of what language the guest writes in.
- Avoid excessive exclamation marks. Don't overuse the guest's name.
- Use the guest's first name sparingly — once in a conversation is enough.
- Never mention AI, systems, screening criteria, or Egyptian government regulations to the guest. Say "house rules" not "regulations." You MAY say 'I'll check with the manager' but never reference 'our team' or other staff.
- Never reference JSON, output format, or internal processes to the guest.
- **If a guest sends a conversation-ending message** ("okay", "thanks", "👍") **and there's nothing left to ask or action — set guest message to "" and manager needed to true with note indicating guest is awaiting manager review.**

When declining:
- Be polite but firm. One sentence is enough.
- Don't over-explain or apologize excessively.
- Example: "Unfortunately, we can only accommodate families and married couples at this property."

---

## SCREENING RULES

### Arab Nationals:

**ACCEPTED:**
- Families (parents with children) — marriage certificate + passports required after booking is accepted, family names must match
- Married couples — marriage certificate required after booking is accepted
- Female-only groups (any size, including solo females)

**NOT ACCEPTED:**
- Single Arab men (except Lebanese and Emirati — see exception below)
- All-male Arab groups (any size)
- Arab male guests describing traveling with 'friends' (اصدقاء/أصحاب) — treat as likely all-male group. Ask: 'Just to clarify, is this a group of male friends or a mixed group?' before proceeding.
- Unmarried Arab couples (fiancés, boyfriends/girlfriends, dating partners)
- Mixed-gender Arab groups that are not family

### Lebanese & Emirati Nationals (Exception — effective 1 March 2026):

**ACCEPTED:**
- Solo traveler (male or female) — staying entirely alone in the unit

**NOT ACCEPTED:**
- Any group (male-only, female-only, or mixed) — this exception is for solo guests only
- Unmarried couples — same rule as all other Arabs applies
- If traveling with anyone else, revert to standard Arab rules above

### Non-Arab Nationals:

**ACCEPTED:**
- All configurations — families, couples, friends, solo travelers, any gender mix

### Mixed Nationality Groups:

- If ANY guest in the party is an Arab national, apply Arab rules to the ENTIRE party
- Example: British man + Egyptian woman (unmarried) = NOT accepted

### Important Rules:

- Some Arabs hold other nationalities and are treated as non-Arabs — this is why you must always ask explicitly.
- **You can assume gender from names** unless the name is ambiguous (e.g., "Nour" can be male or female — ask in that case).
- **Guests who refuse or say they cannot provide required documents** (marriage certificate/passports) = NOT accepted. Escalate with rejection recommendation.

---

## SCREENING WORKFLOW

**Step 1 — Check history:** What do you already know? Has nationality been stated? Has party composition been shared?

**Step 2 — GATE CHECK (mandatory):**
- If nationality is UNKNOWN → ask for it. Do NOT proceed to answer the guest's question.
- If party composition is UNKNOWN → ask for it. Do NOT proceed to answer the guest's question.
- You MAY ask both in one message if neither is known: "Could you share your nationality and who you'll be traveling with?"
- You MAY briefly acknowledge the guest's question but MUST follow with the screening question.

**Step 3 — Apply rules:** Once you have BOTH nationality AND party composition, apply the screening rules above.

**Step 4 — Relationship check (if needed):** If Arab couple → ask "Are you married?" before making a determination.

**Step 5 — Respond and escalate** based on the screening result.

---

## PROPERTY INFORMATION

**Hours:**
- Check-in: 3:00 PM
- Check-out: 11:00 AM

**Free Amenities (on request):**
- Baby crib, extra bed, hair dryer, kitchen blender, kids dinnerware, espresso machine
- Extra towels, extra pillows, extra blankets, hangers
- These are the ONLY available amenities. If a guest asks for an item NOT on this list, do not confirm availability. Tell them you'll check and escalate.

**House Rules (shareable with guest):**
- Family-only property
- No outside visitors permitted at any time
- No smoking indoors
- No parties or gatherings
- Quiet hours apply

**You CANNOT answer (escalate to manager):**
- Pricing questions or discounts
- Availability changes or date modifications
- Refund or cancellation policy questions
- Detailed neighborhood/location recommendations
- Special requests beyond listed amenities
- Anything you're unsure about

---

## IMAGE HANDLING

During screening, guests cannot send images before booking is accepted. However, if an image comes through:
1. Acknowledge it and check if it's a marriage certificate, passport, or ID.
2. If it's a document: tell the guest you've received it and escalate to manager for verification.
3. If it's unclear or unrelated: escalate with "Guest sent an image that requires manager review."

If a guest asks where or how to send their documents, tell them: "Once the booking is accepted, you'll be able to send the documents through the chat."

---

## ESCALATION LOGIC

### Set "needed": false when:
- You are still gathering information (asking follow-up questions)
- Answering basic property questions (check-in/out, amenities, house rules)
- Conversation is incomplete — you don't have enough info to make a determination yet

### Set "needed": true when:

**ELIGIBLE — Recommend Acceptance:**
- Non-Arab guest(s), any configuration → title: "eligible-non-arab"
- Arab female-only group or solo female → title: "eligible-arab-females"
- Arab family (certificate + passports requested) → title: "eligible-arab-family-pending-docs"
- Arab married couple (certificate requested) → title: "eligible-arab-couple-pending-cert"
- Lebanese or Emirati solo traveler (male or female) → title: "eligible-lebanese-emirati-single"

**NOT ELIGIBLE — Recommend Rejection:**
- Single Arab male → title: "violation-arab-single-male"
- All-male Arab group → title: "violation-arab-male-group"
- Unmarried Arab couple → title: "violation-arab-unmarried-couple"
- Mixed-gender Arab group (not family) → title: "violation-arab-mixed-group"
- Mixed nationality unmarried couple (Arab rules apply) → title: "violation-mixed-unmarried-couple"
- Guest refuses or cannot provide required documents → title: "violation-no-documents"

**REQUIRES MANAGER:**
- Guest challenges or argues about rules → title: "escalation-guest-dispute"
- Guest asks about visitors (after informing them of the rule) → title: "visitor-policy-informed"
- Ambiguous or unclear situation → title: "escalation-unclear"
- Question beyond your knowledge → title: "escalation-unknown-answer"
- Guest sends conversation-ending message while awaiting booking decision → title: "awaiting-manager-review"
- Guest interested in a suggested alternative property → title: "property-switch-request", note includes target property name, guest dates, reason/amenity, urgency: "scheduled"

---

## PROPERTY SEARCH TOOL

You have access to a \`search_available_properties\` tool that can find alternative properties in our portfolio.

**WHEN to use it:**
- Guest asks about an amenity this property DOES NOT have ("Is there a pool?", "Do you have parking?")
- Guest expresses a wish for something missing ("I wish there was a gym", "We need more space for 8 people")
- Guest explicitly asks about other options or wants to switch

**WHEN NOT to use it:**
- Guest asks about an amenity this property ALREADY HAS — just confirm it from your property info
- Guest is making casual conversation — don't aggressively push alternatives
- Guest is asking about pricing — you cannot quote prices, direct them to the booking link

**HOW to present results:**
- The tool result contains a \`suggested_message\` field with pre-formatted property names and booking links. You MUST copy this text into your guest message. Do NOT rewrite it, do NOT invent your own property names, and do NOT drop the URLs.
- Add a brief intro before the suggested_message (e.g., "We have X properties with pools available for your dates:").
- Never quote specific prices — the booking link shows live pricing.
- NEVER say "I don't have links" or "let me check" — the links ARE in the tool result. Use them.

**Example — tool returns suggested_message:**
Tool result: {"found":true,"count":2,"suggested_message":"1. 2-Bedroom Apartment with Pool (sleeps 4) — Book here: https://www.airbnb.com/rooms/123\\n2. 2-Bedroom Apartment with Pool (sleeps 4) — Book here: https://www.airbnb.com/rooms/456"}

Your response:
{"guest message":"We have 2 properties with pools for your dates (March 22–25):\\n\\n1. 2-Bedroom Apartment with Pool (sleeps 4) — Book here: https://www.airbnb.com/rooms/123\\n2. 2-Bedroom Apartment with Pool (sleeps 4) — Book here: https://www.airbnb.com/rooms/456","manager":{"needed":false,"title":"","note":""}}

The guest MUST receive the link in the FIRST message that mentions the property. Do not make them ask for links separately.

**When guest wants to book a suggested property:**
- Tell them to book directly through the link provided, and to cancel/decline this current inquiry.
- You CANNOT confirm or switch bookings yourself — the guest must book through the link.
- Escalate to manager with title "property-switch-request" so the team knows.
- Do NOT ask for screening info again at this point — just direct them to the link.

**Example — guest wants to book a suggested property:**
{"guest message":"You can book that one directly here: https://www.airbnb.com/rooms/123456\\n\\nJust decline or cancel this current inquiry and book through that link. Let me know if you need anything else!","manager":{"needed":true,"title":"property-switch-request","note":"Guest wants to switch to [property name]. Directed to book via link. Current inquiry should be cancelled."}}

**If no results:** Politely say none of our properties have that feature for their dates. Offer to escalate for manual assistance.

---

## DOCUMENT CHECKLIST TOOL

When you escalate with a booking acceptance recommendation, also call the \`create_document_checklist\` tool to record what documents the guest will need to submit after acceptance. Base it on what you learned during screening:
- All guests need passport/ID (one per person in the party — use the guest count)
- Arab married couples additionally need a marriage certificate
Do NOT call this tool when recommending rejection.

---

## RESPONSE FIELDS

- **guest message**: Your reply to the guest. Keep it concise (1-2 sentences). Empty string if no reply needed.
- **manager.needed**: true when you need the manager to act (booking decision, rejection, escalation). false when still gathering info.
- **manager.title**: kebab-case category label (e.g., "eligible-non-arab", "violation-arab-unmarried-couple", "booking-links-needed"). Empty string when not needed.
- **manager.note**: Detailed note for Abdelrahman with guest name, unit, nationality, party details, and your recommendation. Empty string when not needed.

---

## HARD BOUNDARIES

- Never assume nationality from names — always ask explicitly
- Never accept unmarried Arab couples — no exceptions, including fiancés
- Never confirm a booking yourself — always escalate to manager
- Never confirm personalized arrival plans, share access codes, or say "everything is ready" for Inquiry guests — booking must be accepted first. General info (check-in is 3 PM) is okay.
- Never offer to "proceed with the reservation" before nationality and party composition are established
- Never share screening criteria or mention government regulations with the guest
- Never guess information you don't have — if it's not in your SOPs or property info, escalate
- Never discuss internal processes, the manager, or AI with the guest
- Always request marriage certificate/passports AFTER booking acceptance, not before
- When in doubt, escalate
- Never output anything other than the JSON object`;

const MANAGER_TRANSLATOR_SYSTEM_PROMPT = `## SYSTEM INSTRUCTIONS - MANAGER REPLY TRANSLATOR BOT

You are Omar, the Lead Guest Coordinator for Boutique Residence. Your specific role in THIS conversation is to translate internal manager instructions into warm, professional guest-facing messages.

## CRITICAL CONTEXT

What you're receiving:
- The input message is from your manager, Abdelrahman - NOT from the guest
- This is an internal instruction/answer to a guest question you previously escalated
- The guest is waiting for your response

Your task:
- Transform Abdelrahman's internal note into a polished, guest-ready message
- Use conversation history to maintain context and flow
- Respond as if YOU (Omar) are directly answering the guest

What you're NOT doing:
- Do NOT mention "the manager said" or "I asked my team"
- Do NOT escalate back to the manager (this IS the manager's answer)
- Do NOT add your own information unless it's basic courtesy

## TONE & STYLE

Tone: professional, concierge-level hospitality
Length: 1-2 sentences maximum (3 sentences only if providing instructions)
Format:
- Be direct and helpful
- Use bullet points ONLY for step-by-step instructions
- Avoid unnecessary "fluff" or over-apologizing
- Avoid using exclamation marks

## TRANSLATION EXAMPLES

Example 1: Simple answer

Manager instruction: "12345"
Guest context: Previously asked for Netflix password

Your response:
"The Netflix password is 12345."

Example 2: Informative answer

Manager instruction: "tell them the nearest pharmacy is Al Ezaby on road 90, 5 min walk"
Guest context: Asked where to buy medicine

Your response:
"The nearest pharmacy is Al Ezaby Pharmacy on Road 90, just a 5-minute walk from the apartment. Feel free to reach out if you need the exact location"

Example 3: Instructions with steps

Manager instruction: "yes they can late checkout until 2pm, charge them $30 extra"
Guest context: Asked for late checkout

Your response:
"Late checkout until 2:00 PM is available for an additional $30. Let me know if you'd like to arrange this."`;

// ─── Context builder helpers ──────────────────────────────────────────────────

// Upgrade 5a: Grounded property info — AI only answers from verified data
function buildPropertyInfo(
  guestName: string,
  checkIn: string,
  checkOut: string,
  guestCount: number,
  listing: {
    name?: string;
    internalListingName?: string;
    personCapacity?: number;
    roomType?: string;
    bedroomsNumber?: number;
    bathroomsNumber?: number;
    address?: string;
    city?: string;
    doorSecurityCode?: string;
    wifiUsername?: string;
    wifiPassword?: string;
  },
  retrievedChunks?: Array<{ content: string; category: string }>,
  reservationStatus?: string
): string {
  // Compute human-readable booking status
  const bookingStatusDisplay = (() => {
    if (!reservationStatus) return 'Unknown';
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const ci = new Date(checkIn); ci.setHours(0, 0, 0, 0);
    const co = new Date(checkOut); co.setHours(0, 0, 0, 0);
    switch (reservationStatus) {
      case 'INQUIRY': return 'Inquiry (pre-booking)';
      case 'CONFIRMED':
        if (ci.getTime() === today.getTime()) return 'Confirmed (Checking in today)';
        if (ci > today) return 'Confirmed (Upcoming)';
        return 'Confirmed';
      case 'CHECKED_IN':
        if (co.getTime() === today.getTime()) return 'Checked In (Checking out today)';
        return 'Checked In';
      case 'CHECKED_OUT': return 'Checked Out';
      case 'CANCELLED': return 'Cancelled';
      default: return reservationStatus;
    }
  })();

  let info = `## PROPERTY DATA — AUTHORITATIVE SOURCE
CRITICAL INSTRUCTION: You MUST only answer questions using data explicitly listed in this section.
If a guest asks about something not listed here, respond with "Let me check on that for you" and set escalate to true.
NEVER use general hotel, apartment, or hospitality knowledge to fill information gaps. If it is not listed below, it does not exist.

### RESERVATION DETAILS
Guest Name: ${guestName}
Booking Status: ${bookingStatusDisplay}
Check-in: ${checkIn}
Check-out: ${checkOut}
Number of Guests: ${guestCount}
`;

  // SECURITY: Only include access codes for CONFIRMED or CHECKED_IN guests.
  // Allowlist approach — any other status (INQUIRY, CANCELLED, CHECKED_OUT, unknown) is blocked.
  if (reservationStatus === 'CONFIRMED' || reservationStatus === 'CHECKED_IN') {
    info += '\n### ACCESS & CONNECTIVITY\n';
    if (listing.doorSecurityCode && listing.doorSecurityCode !== 'N/A') {
      info += `Door Code: ${listing.doorSecurityCode}\n`;
    }
    if (listing.wifiUsername && listing.wifiUsername !== 'N/A') {
      info += `WiFi Network Name: ${listing.wifiUsername}\n`;
    }
    if (listing.wifiPassword && listing.wifiPassword !== 'N/A') {
      info += `WiFi Password: ${listing.wifiPassword}\n`;
    }
  }

  if (retrievedChunks && retrievedChunks.length > 0) {
    info += '\n### RELEVANT PROCEDURES & KNOWLEDGE\n';
    info += "The following was retrieved based on the guest's current question:\n";
    for (const chunk of retrievedChunks) {
      info += `[${chunk.category}] ${chunk.content}\n`;
    }
  }

  return info;
}

// ─── Content block builder from template ─────────────────────────────────────

function buildContentBlocks(
  template: string | undefined,
  vars: Record<string, string>
): ContentBlock[] {
  if (!template) {
    // Fallback: hardcoded default content blocks
    return [
      { type: 'text', text: `### CONVERSATION HISTORY ###\n${vars.conversationHistory || ''}` },
      { type: 'text', text: `### PROPERTY & GUEST INFO ###\n\n${vars.propertyInfo || ''}` },
      { type: 'text', text: `### CURRENT GUEST MESSAGE(S) ###\n${vars.currentMessages || ''}\n\n### CURRENT LOCAL TIME###\n${vars.localTime || ''}` },
    ];
  }

  // Split template on ### headers and interpolate {{variables}}
  const sections = template.split(/(?=### )/).filter(s => s.trim());
  return sections.map(section => {
    let text = section;
    for (const [key, value] of Object.entries(vars)) {
      text = text.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
    }
    return { type: 'text' as const, text };
  });
}

// ─── Escalation handler — creates Task + private [MANAGER] message ───────────

async function handleEscalation(
  prisma: PrismaClient,
  tenantId: string,
  conversationId: string,
  propertyId: string | undefined,
  title: string,
  note: string,
  urgency: string,
  updateTaskId?: string | null,
  resolveTaskId?: string | null,
  guestMessage?: string
): Promise<void> {
  try {
    let task;

    // Resolve old task if requested — independent of new task creation so the
    // AI can close one task and open another in the same response.
    // T018: Verify task belongs to tenant before mutating.
    if (resolveTaskId) {
      const resolveTarget = await prisma.task.findFirst({
        where: { id: resolveTaskId, tenantId },
      });
      if (!resolveTarget) {
        console.warn(`[AI] resolveTaskId ${resolveTaskId} not found for tenant ${tenantId} — skipping`);
      } else {
        const resolved = await prisma.task.update({
          where: { id: resolveTaskId },
          data: { status: 'completed', completedAt: new Date() },
        });
        broadcastToTenant(tenantId, 'task_updated', { conversationId, task: resolved });
      }
    }

    if (updateTaskId) {
      const updateTarget = await prisma.task.findFirst({
        where: { id: updateTaskId, tenantId },
      });
      if (!updateTarget) {
        console.warn(`[AI] updateTaskId ${updateTaskId} not found for tenant ${tenantId} — skipping`);
      } else {
        task = await prisma.task.update({
          where: { id: updateTaskId },
          data: { title, note, urgency },
        });
        broadcastToTenant(tenantId, 'task_updated', { conversationId, task });
      }
    } else if (title) {
      // Task Manager: check if this escalation duplicates an existing open task
      const openTasks = await prisma.task.findMany({
        where: { conversationId, status: 'open' },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });

      const tmResult = await evaluateEscalation({
        tenantId,
        conversationId,
        newEscalation: { title, note, urgency },
        openTasks: openTasks.map(t => ({
          id: t.id, title: t.title, note: t.note, urgency: t.urgency, createdAt: t.createdAt,
        })),
        guestMessage: guestMessage || '',
      });

      console.log(`[AI] Task Manager: ${tmResult.action}${tmResult.taskId ? ` → ${tmResult.taskId}` : ''} (${tmResult.reason})`);

      if (tmResult.action === 'update' && tmResult.taskId) {
        // Append note to existing task (preserve history)
        const existingTask = openTasks.find(t => t.id === tmResult.taskId);
        const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Cairo' });
        let updatedNote = (existingTask?.note || '') + `\n[Update ${timeStr}] ${note}`;
        // Cap at 2000 chars — trim oldest [Update] entries if exceeded
        if (updatedNote.length > 2000) {
          const lines = updatedNote.split('\n');
          while (updatedNote.length > 2000 && lines.length > 2) {
            // Remove the second line (first [Update] entry, keep [Original])
            const idx = lines.findIndex((l, i) => i > 0 && l.startsWith('[Update'));
            if (idx > 0) lines.splice(idx, 1);
            else break;
            updatedNote = lines.join('\n');
          }
        }
        task = await prisma.task.update({
          where: { id: tmResult.taskId },
          data: { note: updatedNote, urgency },
        });
        broadcastToTenant(tenantId, 'task_updated', { conversationId, task });
      } else if (tmResult.action === 'resolve' && tmResult.taskId) {
        // Close existing task
        task = await prisma.task.update({
          where: { id: tmResult.taskId },
          data: { status: 'completed', completedAt: new Date() },
        });
        broadcastToTenant(tenantId, 'task_updated', { conversationId, task });
      } else if (tmResult.action === 'skip') {
        // Log and return — no task action
        console.log(`[AI] Task Manager: skipped redundant escalation for conv ${conversationId}`);
        return;
      } else {
        // CREATE (default) — existing behavior
        task = await createTask(prisma, {
          tenantId,
          conversationId,
          propertyId,
          title,
          note,
          urgency,
          source: 'ai',
        });
        broadcastToTenant(tenantId, 'new_task', { conversationId, task });
      }

      // Auto-create knowledge suggestion for info_request escalations
      if (urgency === 'info_request') {
        await prisma.knowledgeSuggestion.create({
          data: {
            tenantId,
            propertyId,
            conversationId,
            question: note,
            answer: '',
            status: 'pending',
            source: 'ai_identified',
          },
        }).catch(err => console.warn('[AI] Could not create knowledge suggestion:', err));
        broadcastToTenant(tenantId, 'knowledge_suggestion', { conversationId });
      }
    }

    // Save AI private note and broadcast it so it shows in chat
    // Skip for bare resolves (no new/updated task)
    if (note && task) {
      const privateMsg = await prisma.message.create({
        data: {
          conversationId,
          tenantId,
          role: MessageRole.AI_PRIVATE,
          content: note,
          sentAt: new Date(),
          channel: 'OTHER',
          communicationType: 'internal',
        },
      });
      broadcastToTenant(tenantId, 'message', {
        conversationId,
        message: { role: 'AI_PRIVATE', content: note, sentAt: privateMsg.sentAt.toISOString(), channel: 'OTHER', imageUrls: [] },
        lastMessageRole: 'AI_PRIVATE',
        lastMessageAt: privateMsg.sentAt.toISOString(),
      });
    }

    console.log(`[AI] [${conversationId}] Escalation handled: ${title}`);
  } catch (err) {
    console.error(`[AI] [${conversationId}] Failed to handle escalation:`, err);
  }
}

// ─── Main AI reply generation ─────────────────────────────────────────────────

export interface AiReplyContext {
  tenantId: string;
  conversationId: string;
  propertyId?: string;
  windowStartedAt?: Date;  // start of debounce window — used to filter "current" messages
  hostawayConversationId: string;
  hostawayApiKey: string;
  hostawayAccountId: string;
  guestName: string;
  checkIn: string;
  checkOut: string;
  guestCount: number;
  reservationStatus: string;
  listing: {
    name?: string;
    internalListingName?: string;
    personCapacity?: number;
    roomType?: string;
    bedroomsNumber?: number;
    bathroomsNumber?: number;
    address?: string;
    city?: string;
    doorSecurityCode?: string;
    wifiUsername?: string;
    wifiPassword?: string;
  };
  customKnowledgeBase?: Record<string, unknown>;
  listingDescription?: string;
  aiMode?: string;
  channel?: string;  // AIRBNB | BOOKING | DIRECT | OTHER | WHATSAPP — used for channel-aware tool results
  reservationId?: string;
  screeningAnswers?: Record<string, unknown>;
}

export async function generateAndSendAiReply(
  context: AiReplyContext,
  prisma: PrismaClient
): Promise<void> {
  const { tenantId, conversationId, hostawayConversationId, hostawayApiKey, hostawayAccountId } = context;

  console.log(`[AI] [${conversationId}] Generating AI reply...`);

  try {
    // Upgrade 6d: Fetch per-tenant AI configuration (cached, 5min TTL)
    const tenantConfig = await getTenantAiConfig(tenantId, prisma).catch(() => null);

    // Fetch ALL message history from local DB (not Hostaway API)
    const aiCfg = getAiConfig();
    const dbMessages = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { sentAt: 'asc' },
    });
    // Exclude manager private messages from AI context
    const allMsgs = dbMessages.filter(
      m => !m.content.startsWith('[MANAGER]') && m.role !== 'AI_PRIVATE' && m.role !== 'MANAGER_PRIVATE'
    );

    // Build conversation as proper multi-turn {role, content} array for the Responses API.
    // The model was trained on this format — it understands speaker turns natively.
    // truncation: "auto" handles overflow automatically with 400K context window.
    const conversationTurns: Array<{ role: 'user' | 'assistant'; content: string }> = allMsgs.map(m => ({
      role: (m.role === 'GUEST' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.content,
    }));

    // Current messages = GUEST messages received during THIS debounce window.
    // Small 2-minute buffer needed because Hostaway timestamps messages when the guest
    // sent them, but our windowStartedAt is when the webhook arrived (can be seconds later).
    // Without buffer: sentAt < windowStartedAt → "No guest messages" → AI skips.
    const WEBHOOK_TIMING_BUFFER_MS = 2 * 60 * 1000; // 2 minutes — enough for webhook delay, not so much to pull old messages
    const windowStartedAt = context.windowStartedAt;
    const windowStart = windowStartedAt
      ? new Date(windowStartedAt.getTime() - WEBHOOK_TIMING_BUFFER_MS)
      : null;
    const currentMsgs = windowStart
      ? allMsgs.filter(m => m.role === 'GUEST' && m.sentAt >= windowStart)
      : allMsgs.slice(-1).filter(m => m.role === 'GUEST');
    const currentMsgsText = currentMsgs
      .map(m => `Guest: ${m.content}`)
      .join('\n');

    if (!currentMsgsText.trim()) {
      console.log(`[AI] [${conversationId}] No guest messages in current window — skipping`);
      return;
    }

    // Fetch open tasks for context injection
    const openTasks = await prisma.task.findMany({
      where: { conversationId, status: 'open' },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });
    const openTasksText = openTasks.length > 0
      ? openTasks.map(t => {
          const notePreview = t.note ? `\n  → ${t.note}` : '';
          return `[${t.id}] ${t.title} (${t.urgency})${notePreview}`;
        }).join('\n')
      : 'No open tasks.';

    // Fetch approved knowledge base for this property
    const approvedKnowledge = await prisma.knowledgeSuggestion.findMany({
      where: {
        tenantId,
        status: 'approved',
        OR: [{ propertyId: context.propertyId || null }, { propertyId: null }],
      },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    });
    const knowledgeText = approvedKnowledge.length > 0
      ? approvedKnowledge.map(k => `Q: ${k.question}\nA: ${k.answer}`).join('\n\n')
      : 'No additional Q&A available.';

    const localTime = new Date().toLocaleString('en-US', { timeZone: 'Africa/Cairo' });

    // Property amenities string for dynamic SOP injection
    const propertyAmenities = context.customKnowledgeBase?.amenities
      ? String(context.customKnowledgeBase.amenities) : undefined;

    // Upgrade 5c: RAG — retrieve relevant property knowledge for this query.
    // When multiple messages are batched (guest sent several in debounce window),
    // concatenate ALL of them for classification. The old approach (last message only)
    // missed context: "Can I get cleaning?" + "at 10am please" → only classified "at 10am please".
    const ragQuery = currentMsgs.length > 0
      ? currentMsgs.map((m: { content: string }) => m.content).join(' ')
      : '';
    const ragStart = Date.now();
    // Pass conversationId + recent messages for low-tier intent extraction fallback (T013)
    const recentForRag = allMsgs.slice(-10).map(m => ({
      role: m.role === 'GUEST' ? 'guest' : 'host',
      content: m.content,
    }));
    // ─── Property knowledge retrieval (embeddings + reranking only, no SOP routing) ───
    const ragResult = tenantConfig?.ragEnabled !== false && context.propertyId
      ? await retrieveRelevantKnowledge(
          tenantId, context.propertyId, ragQuery, prisma, 8,
          context.reservationStatus === 'INQUIRY' ? 'screeningAI' : 'guestCoordinator',
          conversationId, recentForRag,
          propertyAmenities
        ).catch(() => ({ chunks: [] as Array<{ content: string; category: string; similarity: number; sourceKey: string; propertyId: string | null }>, topSimilarity: 0, tier: 'property' as const }))
      : { chunks: [] as Array<{ content: string; category: string; similarity: number; sourceKey: string; propertyId: string | null }>, topSimilarity: 0, tier: 'property' as const };
    const retrievedChunks = ragResult.chunks;
    const ragDurationMs = Date.now() - ragStart;

    // ─── SOP Classification via Tool Use ────────────────────────────────────
    // Single forced get_sop tool call replaces the 3-tier pipeline.
    // AI classifies the message, we retrieve the matching SOP content.
    const isInquiry = context.reservationStatus === 'INQUIRY';
    const agentName = isInquiry ? 'screeningAI' : 'guestCoordinator';
    const personaCfg = isInquiry ? aiCfg.screeningAI : aiCfg.guestCoordinator;
    // Migrate legacy model names to GPT-5.4 Mini (tenants may have old values in DB)
    const rawModel = tenantConfig?.model || personaCfg.model;
    const effectiveModel = rawModel?.startsWith('claude-') ? 'gpt-5.4-mini-2026-03-17' : rawModel;

    // Build input messages for classification (OpenAI Responses API format)
    // Build classification input — clearly separate history from new messages
    const classCurrentIds = new Set(currentMsgs.map(m => m.id));
    const classHistory = allMsgs.slice(-10).filter(m => !classCurrentIds.has(m.id));
    const classHistoryText = classHistory.map(m => `${m.role === 'GUEST' ? 'GUEST' : 'HOST'}: ${m.content}`).join('\n');
    const classNewText = currentMsgs.map(m => `GUEST: ${m.content}`).join('\n');
    const classificationInput = [{
      role: 'user',
      content: `CONVERSATION HISTORY:\n${classHistoryText}\n\n--- NEW MESSAGE${currentMsgs.length > 1 ? 'S' : ''} TO CLASSIFY ---\n${classNewText}\n\nCLASSIFY THE NEW MESSAGE${currentMsgs.length > 1 ? 'S' : ''} ABOVE.`,
    }];

    // Build tool definition from DB (cached 5min per tenant)
    const sopToolDef = await buildToolDefinition(tenantId, prisma);

    // Use DB-backed prompt for classification too (same prompt the AI will use for the reply)
    const classificationPrompt = isInquiry
      ? (tenantConfig?.systemPromptScreening || personaCfg.systemPrompt)
      : (tenantConfig?.systemPromptCoordinator || personaCfg.systemPrompt);
    const sopClassification = await classifyMessageSop(
      classificationPrompt,
      classificationInput,
      { model: effectiveModel, tenantId, conversationId, agentType: isInquiry ? 'screening' : 'coordinator' },
      sopToolDef,
    );

    // Fetch SOP content for classified categories (skip none, escalate gets SOP if paired with other categories)
    const sopCategories = sopClassification.categories.filter(c => c !== 'none' && c !== 'escalate');
    const sopTexts = await Promise.all(
      sopCategories.map(c => getSopContent(tenantId, c, context.reservationStatus || 'DEFAULT', context.propertyId, propertyAmenities, prisma))
    );
    const sopContent = sopTexts.filter(Boolean).join('\n\n---\n\n');

    // Handle escalation category
    if (sopClassification.categories.includes('escalate')) {
      try {
        await handleEscalation(prisma, tenantId, conversationId, context.propertyId,
          'sop-tool-escalation', `AI classified as escalate: ${sopClassification.reasoning}`,
          'immediate');
        console.log(`[AI] [${conversationId}] Escalation triggered by SOP classification: ${sopClassification.reasoning}`);
      } catch (err) {
        console.warn(`[AI] Escalation task creation failed (non-fatal):`, err);
      }
    }

    // Handle SOP retrieval failure (in-memory map — only fails on code bugs)
    if (sopCategories.length > 0 && sopTexts.length === 0) {
      try {
        await handleEscalation(prisma, tenantId, conversationId, context.propertyId,
          'sop-retrieval-failure', `SOP content missing for categories: [${sopCategories.join(', ')}]`,
          'info_request');
        console.warn(`[AI] [${conversationId}] SOP retrieval failure — no content for [${sopCategories.join(', ')}]`);
      } catch (err) {
        console.warn(`[AI] SOP failure escalation task creation failed:`, err);
      }
    }

    // —— Escalation enrichment (post-routing) ——————————————
    const escalationSignals = detectEscalationSignals(ragQuery);
    if (escalationSignals.length > 0) {
      console.log(`[AI] Escalation signals: ${escalationSignals.map(s => s.signal).join(', ')}`);
    }

    const ragContext: any = {
      query: ragQuery,
      chunks: retrievedChunks.map((c: any) => ({
        content: c.content,
        category: c.category,
        similarity: c.similarity,
        sourceKey: c.sourceKey || '',
        isGlobal: !c.propertyId,
      })),
      totalRetrieved: retrievedChunks.length,
      durationMs: ragDurationMs,
      topSimilarity: ragResult.topSimilarity,
      // SOP Tool Classification
      sopToolUsed: true,
      sopCategories: sopClassification.categories,
      sopConfidence: sopClassification.confidence,
      sopReasoning: sopClassification.reasoning,
      sopVariantStatus: context.reservationStatus || 'DEFAULT',
      sopClassificationTokens: { input: sopClassification.inputTokens, output: sopClassification.outputTokens },
      sopClassificationDurationMs: sopClassification.durationMs,
      // Escalation
      escalationSignals: escalationSignals.map(s => s.signal),
    };

    let propertyInfo = buildPropertyInfo(
      context.guestName,
      context.checkIn,
      context.checkOut,
      context.guestCount,
      context.listing,
      retrievedChunks,
      context.reservationStatus
    );

    // Inject escalation signals into prompt so the AI can factor them in
    if (escalationSignals.length > 0) {
      propertyInfo += '\n### SYSTEM SIGNALS\n';
      propertyInfo += escalationSignals.map(s => `⚠ ${s.signal}`).join('\n');
      propertyInfo += '\nNote: These signals were automatically detected from the guest message. Consider them when deciding whether to escalate.\n';
    }

    // Read document checklist from reservation (used for context injection + conditional tool availability)
    const checklistData = (context.screeningAnswers as any)?.documentChecklist as DocumentChecklist | undefined;
    const checklistPending = hasPendingItems(checklistData ?? null);

    // Inject document checklist if pending (only for coordinator — CONFIRMED/CHECKED_IN)
    if (!isInquiry && checklistData && checklistPending) {
      propertyInfo += '\n### DOCUMENT CHECKLIST ###\n';
      propertyInfo += `Passports/IDs: ${checklistData.passportsReceived}/${checklistData.passportsNeeded} received\n`;
      if (checklistData.marriageCertNeeded) {
        propertyInfo += `Marriage Certificate: ${checklistData.marriageCertReceived ? 'received' : 'pending'}\n`;
      }
    }

    // Check for image attachments in current window messages (from DB imageUrls field)
    const hasImages = currentMsgs.some(m => m.imageUrls && m.imageUrls.length > 0);

    // Upgrade 6d: Overlay tenant-specific settings onto persona config
    // (isInquiry, agentName, personaCfg, effectiveModel defined above in SOP classification block)
    const effectiveTemperature = tenantConfig?.temperature ?? personaCfg.temperature;
    const effectiveMaxTokens = tenantConfig?.maxTokens || personaCfg.maxTokens;
    const effectiveAgentName = tenantConfig?.agentName || agentName;

    // DB-backed system prompts (editable via Configure AI), fallback to JSON config
    let effectiveSystemPrompt = isInquiry
      ? (tenantConfig?.systemPromptScreening || personaCfg.systemPrompt)
      : (tenantConfig?.systemPromptCoordinator || personaCfg.systemPrompt);
    // Replace agent name in system prompt if customized
    if (tenantConfig?.agentName && tenantConfig.agentName !== 'Omar') {
      effectiveSystemPrompt = effectiveSystemPrompt.replace(/\bOmar\b/g, tenantConfig.agentName);
    }
    // Append custom instructions if configured
    if (tenantConfig?.customInstructions) {
      effectiveSystemPrompt += `\n\n## TENANT-SPECIFIC INSTRUCTIONS\nThe following instructions are specific to this property and override general guidelines where they conflict:\n${tenantConfig.customInstructions}`;
    }

    // Inject SOP content from tool classification into system prompt
    if (sopContent) {
      effectiveSystemPrompt += `\n\n## STANDARD OPERATING PROCEDURE\nFollow this procedure for the guest's current request:\n${sopContent}`;
    } else if (sopClassification.categories.includes('none')) {
      // No SOP needed — respond from general knowledge
    } else if (sopCategories.length > 0) {
      // SOP retrieval failed (content missing) — AI responds from general knowledge
      effectiveSystemPrompt += `\n\n## NOTE\nSOP temporarily unavailable. Respond helpfully based on your general knowledge and system instructions.`;
    }

    let guestMessage = '';

    // Build single user message with conversation history + context + current guest message(s).
    // Last 20 messages as labeled text, not separate user/assistant blocks.
    const currentMsgIds = new Set(currentMsgs.map(m => m.id));
    const historyMsgs = allMsgs.filter(m => !currentMsgIds.has(m.id)).slice(-20);
    const historyText = historyMsgs.length > 0
      ? historyMsgs.map(m => `${m.role === 'GUEST' ? 'Guest' : 'Omar'}: ${m.content}`).join('\n')
      : 'No previous messages.';

    const userMessage = [
      `### CONVERSATION HISTORY ###\n${historyText}`,
      `### PROPERTY & GUEST INFO ###\n\n${propertyInfo}`,
      `### OPEN TASKS ###\n${openTasksText}`,
      `### KNOWLEDGE BASE ###\n${knowledgeText}`,
      `### CURRENT GUEST MESSAGE(S) ###\n${currentMsgsText}`,
      `### CURRENT LOCAL TIME ###\n${localTime}`,
    ].join('\n\n');

    // Single user message — no multi-turn splitting
    type InputTurn = { role: 'user' | 'assistant'; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> };
    const inputTurns: InputTurn[] = [
      { role: 'user' as const, content: userMessage },
    ];

    // Single code path for text and text+image
    const userContent = buildContentBlocks(personaCfg.contentBlockTemplate, {
        conversationHistory: '', propertyInfo, currentMessages: currentMsgsText,
        localTime, openTasks: openTasksText, knowledgeBase: knowledgeText,
      });

      // ─── Tool use: per-agent tools ───
      // Screening agent (INQUIRY): property search tool
      // Guest coordinator (CONFIRMED/CHECKED_IN): extend-stay tool
      // Build per-agent tool lists
      const screeningTools: any[] = [
        {
          type: 'function',
          name: 'search_available_properties',
          description: 'Search for alternative properties in the same city that match specific criteria and are available for the guest\'s dates. Use this when a guest asks about amenities or features this property doesn\'t have, wants to see other options, or expresses a preference for different property attributes (size, view, amenities). Do NOT use this when the guest is asking about amenities this property already has.',
          strict: true,
          parameters: {
            type: 'object' as const,
            properties: {
              amenities: { type: 'array', items: { type: 'string' }, description: 'Amenities or features the guest is looking for, e.g. [\'pool\', \'parking\', \'sea view\']. Use simple English terms.' },
              min_capacity: { type: ['number', 'null'], description: 'Minimum number of guests the property should accommodate. Only include if the guest mentioned needing more space or has a specific group size.' },
              reason: { type: 'string', description: 'Brief reason for the search, e.g. \'guest asked for pool\'. Used for logging.' },
            },
            required: ['amenities', 'reason', 'min_capacity'],
            additionalProperties: false,
          },
        },
        {
          type: 'function',
          name: 'create_document_checklist',
          description: 'Create a document checklist for this booking. Call this when you have determined the guest is eligible and are about to escalate to the manager with an acceptance recommendation. Records what documents the guest will need to submit after booking acceptance. Do NOT call this when recommending rejection.',
          strict: true,
          parameters: {
            type: 'object' as const,
            properties: {
              passports_needed: { type: 'number', description: 'Number of passport/ID documents needed (one per guest in the party)' },
              marriage_certificate_needed: { type: 'boolean', description: 'Whether a marriage certificate is required (true for Arab married couples)' },
              reason: { type: 'string', description: 'Brief note, e.g. \'Egyptian married couple, 2 guests\'' },
            },
            required: ['passports_needed', 'marriage_certificate_needed', 'reason'],
            additionalProperties: false,
          },
        },
      ];

      const coordinatorTools: any[] = [
        {
          type: 'function',
          name: 'check_extend_availability',
          description: 'Check if the guest\'s current property is available for extended or modified dates, and calculate the price for additional nights. Use this when a guest asks to extend their stay, shorten their stay, change dates, or asks how much extra nights would cost. Do NOT use for unrelated questions.',
          strict: true,
          parameters: {
            type: 'object' as const,
            properties: {
              new_checkout: { type: 'string', description: 'The requested new checkout date in YYYY-MM-DD format.' },
              new_checkin: { type: ['string', 'null'], description: 'The requested new check-in date in YYYY-MM-DD format. Only needed if the guest wants to arrive earlier or later.' },
              reason: { type: 'string', description: 'Brief reason, e.g. \'guest wants 2 more nights\'. Used for logging.' },
            },
            required: ['new_checkout', 'reason', 'new_checkin'],
            additionalProperties: false,
          },
        },
        // mark_document_received — only when checklist has pending items
        ...(checklistPending ? [{
          type: 'function',
          name: 'mark_document_received',
          description: 'Mark a document as received after the guest sends it through the chat. Call this when you see an image that is clearly a government-issued ID (passport, national ID, driver\'s license) or marriage certificate. Do NOT call this for unclear images — escalate those instead.',
          strict: true,
          parameters: {
            type: 'object' as const,
            properties: {
              document_type: { type: 'string', enum: ['passport', 'marriage_certificate'], description: 'Type of document received' },
              notes: { type: 'string', description: 'Brief description, e.g. \'passport for Mohamed\' or \'marriage certificate\'' },
            },
            required: ['document_type', 'notes'],
            additionalProperties: false,
          },
        }] : []),
      ];

      const toolsForCall = isInquiry ? screeningTools : coordinatorTools;

      // Look up hostawayListingId for extend-stay tool
      let hostawayListingId = '';
      if (!isInquiry && context.propertyId) {
        try {
          const prop = await prisma.property.findUnique({ where: { id: context.propertyId }, select: { hostawayListingId: true } });
          hostawayListingId = prop?.hostawayListingId || '';
        } catch { /* fallback: empty */ }
      }

      const toolHandlersForCall: Map<string, ToolHandler> = isInquiry ? new Map([
        ['search_available_properties', async (input: unknown) => {
          const typedInput = input as { amenities: string[]; min_capacity?: number; reason?: string };
          const currentAddress = context.listing?.address || context.customKnowledgeBase?.address as string || '';
          const cityParts = currentAddress.split(',').map(s => s.trim()).filter(Boolean);
          const currentCity = cityParts[cityParts.length - 1] || cityParts[0] || '';
          return searchAvailableProperties(typedInput, {
            tenantId,
            currentPropertyId: context.propertyId || '',
            checkIn: context.checkIn,
            checkOut: context.checkOut,
            channel: context.channel || 'DIRECT',
            hostawayAccountId: context.hostawayAccountId,
            hostawayApiKey: context.hostawayApiKey,
            currentCity,
          });
        }],
        ['create_document_checklist', async (input: unknown) => {
          const typedInput = input as { passports_needed: number; marriage_certificate_needed: boolean; reason: string };
          if (!context.reservationId) return JSON.stringify({ error: 'No reservation linked', created: false });
          try {
            const cl = await createChecklist(context.reservationId, {
              passportsNeeded: typedInput.passports_needed,
              marriageCertNeeded: typedInput.marriage_certificate_needed,
              reason: typedInput.reason,
            }, prisma);
            return JSON.stringify({ created: true, passportsNeeded: cl.passportsNeeded, marriageCertNeeded: cl.marriageCertNeeded });
          } catch (err: any) {
            console.warn(`[AI] create_document_checklist failed (non-fatal):`, err.message);
            return JSON.stringify({ error: err.message, created: false });
          }
        }],
      ]) : new Map([
        ['check_extend_availability', async (input: unknown) => {
          return checkExtendAvailability(input, {
            listingId: hostawayListingId,
            currentCheckIn: context.checkIn,
            currentCheckOut: context.checkOut,
            channel: context.channel || 'DIRECT',
            numberOfGuests: context.guestCount,
            hostawayAccountId: context.hostawayAccountId,
            hostawayApiKey: context.hostawayApiKey,
          });
        }],
        ...(checklistPending ? [['mark_document_received', async (input: unknown) => {
          const typedInput = input as { document_type: 'passport' | 'marriage_certificate'; notes: string };
          if (!context.reservationId) return JSON.stringify({ error: 'No reservation linked' });
          try {
            const updated = await updateChecklist(context.reservationId, {
              documentType: typedInput.document_type,
              notes: typedInput.notes,
            }, prisma);
            return JSON.stringify({
              passportsReceived: updated.passportsReceived,
              passportsNeeded: updated.passportsNeeded,
              marriageCertReceived: updated.marriageCertReceived,
              marriageCertNeeded: updated.marriageCertNeeded,
              allComplete: !hasPendingItems(updated),
            });
          } catch (err: any) {
            console.warn(`[AI] mark_document_received failed (non-fatal):`, err.message);
            return JSON.stringify({ error: err.message });
          }
        }] as [string, ToolHandler]] : []),
      ]);

      // Determine reasoning effort: tenant config > SOP-based auto > none
      const tenantReasoning = isInquiry
        ? (tenantConfig as any)?.reasoningScreening || 'none'
        : (tenantConfig as any)?.reasoningCoordinator || 'auto';
      const reasoningEffort: 'none' | 'low' | 'medium' | 'high' = tenantReasoning === 'auto'
        ? (sopClassification.categories.some(c => REASONING_CATEGORIES.has(c)) ? 'low' : 'none')
        : tenantReasoning;

      // ─── Image handling: download and attach to last inputTurns entry ───
      let imageBase64 = '';
      let imageMimeType = 'image/jpeg';
      if (hasImages) {
        const msgWithImage = currentMsgs.find((m: { imageUrls: string[] }) => m.imageUrls && m.imageUrls.length > 0);
        const imageUrl = msgWithImage?.imageUrls?.[0];
        if (imageUrl) {
          try {
            const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer' });
            imageBase64 = Buffer.from(imgRes.data as ArrayBuffer).toString('base64');
            const ct = (imgRes.headers['content-type'] || 'image/jpeg') as string;
            if (ct.includes('png')) imageMimeType = 'image/png';
            else if (ct.includes('gif')) imageMimeType = 'image/gif';
            else if (ct.includes('webp')) imageMimeType = 'image/webp';
          } catch (err) {
            console.warn(`[AI] [${conversationId}] Could not download image:`, err);
          }
        }

        if (imageBase64) {
          // Attach image to the last user turn in OpenAI Responses API format
          inputTurns[inputTurns.length - 1] = {
            role: 'user' as const,
            content: [
              { type: 'input_text', text: userMessage },
              { type: 'input_image', image_url: { url: `data:${imageMimeType};base64,${imageBase64}` } },
            ],
          };
        } else {
          // Download failed — tell the AI an image was sent but couldn't be loaded
          inputTurns[inputTurns.length - 1] = {
            role: 'user' as const,
            content: `[System: The guest sent an image but it could not be loaded. Acknowledge this and escalate to manager.]\n\n${userMessage}`,
          };
        }
      }

      const rawResponse = await createMessage(effectiveSystemPrompt, userContent, {
        model: effectiveModel,
        temperature: effectiveTemperature,
        maxTokens: effectiveMaxTokens,
        agentName: effectiveAgentName,
        tenantId,
        conversationId,
        ragContext,
        openTaskCount: openTasks.length,
        totalMessages: allMsgs.length,
        memorySummarized: false,
        hasImage: hasImages,
        ragEnabled: tenantConfig?.ragEnabled !== false,
        tools: toolsForCall,
        toolHandlers: toolHandlersForCall,
        reasoningEffort,
        agentType: isInquiry ? 'screening' : 'coordinator',
        stream: true,
        inputTurns,
        outputSchema: isInquiry ? SCREENING_SCHEMA : COORDINATOR_SCHEMA,
      });

      console.log(`[AI] [${conversationId}] Raw response: ${rawResponse.substring(0, 200)}`);

      try {
        if (isInquiry) {
          const parsed = JSON.parse(rawResponse) as {
            'guest message': string;
            manager?: { needed: boolean; title: string; note: string };
          };
          guestMessage = parsed['guest message'] || '';
          // Handle screening escalation
          if (parsed.manager?.needed) {
            await handleEscalation(prisma, tenantId, conversationId, context.propertyId, parsed.manager.title, parsed.manager.note, 'info_request');
            traceEscalation({
              tenantId, conversationId, agentName: effectiveAgentName,
              escalationType: parsed.manager.title, escalationUrgency: 'info_request',
              escalationNote: parsed.manager.note,
            });
          }
        } else {
          const parsed = JSON.parse(rawResponse) as {
            guest_message: string;
            resolveTaskId?: string | null;
            updateTaskId?: string | null;
            escalation: { title: string; note: string; urgency: string } | null;
          };
          guestMessage = parsed.guest_message || '';
          // T019: Validate AI output escalation fields before use
          if (parsed.escalation) {
            const validUrgencies = ['immediate', 'scheduled', 'info_request'];
            if (!validUrgencies.includes(parsed.escalation.urgency)) {
              parsed.escalation.urgency = 'immediate';
            }
            if (parsed.escalation.title) {
              parsed.escalation.title = parsed.escalation.title.slice(0, 200);
            }
            if (parsed.escalation.note) {
              parsed.escalation.note = parsed.escalation.note.slice(0, 2000);
            }
          }
          // Handle task resolve/update even when escalation is null
          if (parsed.escalation) {
            await handleEscalation(
              prisma, tenantId, conversationId, context.propertyId,
              parsed.escalation.title, parsed.escalation.note, parsed.escalation.urgency,
              parsed.updateTaskId, parsed.resolveTaskId, ragQuery
            );
            traceEscalation({
              tenantId, conversationId, agentName: effectiveAgentName,
              escalationType: parsed.escalation.title, escalationUrgency: parsed.escalation.urgency,
              escalationNote: parsed.escalation.note,
              taskResolved: parsed.resolveTaskId || undefined,
              taskUpdated: parsed.updateTaskId || undefined,
            });
          } else if (parsed.resolveTaskId || parsed.updateTaskId) {
            await handleEscalation(
              prisma, tenantId, conversationId, context.propertyId,
              '', '', 'immediate',
              parsed.updateTaskId, parsed.resolveTaskId
            );
            traceEscalation({
              tenantId, conversationId, agentName: effectiveAgentName,
              escalationType: 'task-update', escalationUrgency: 'immediate',
              escalationNote: '',
              taskResolved: parsed.resolveTaskId || undefined,
              taskUpdated: parsed.updateTaskId || undefined,
            });
          }
        }
      } catch {
        console.error(`[AI] [${conversationId}] JSON parse failed`);
        // T030: Escalate on JSON parse failure so manager can follow up manually
        await handleEscalation(
          prisma, tenantId, conversationId, context.propertyId,
          'ai-parse-failure',
          `AI response failed JSON parsing. Raw response snippet: ${rawResponse?.substring(0, 200)}`,
          'immediate'
        );
        broadcastToTenant(tenantId, 'ai_typing_clear', { conversationId });
        return;
      }

    // SOP tool classification is already logged in ragContext — no override detection needed

    if (!guestMessage.trim()) {
      console.log(`[AI] [${conversationId}] Empty guest message — not sending`);
      // Clear the typing bubble on the frontend
      broadcastToTenant(tenantId, 'ai_typing_clear', { conversationId });
      return;
    }

    // Copilot mode: hold suggestion for host approval
    if (context.aiMode === 'copilot') {
      const pendingReply = await prisma.pendingAiReply.findFirst({
        where: { conversationId, fired: false },
        orderBy: { createdAt: 'desc' },
      });
      if (pendingReply) {
        await prisma.pendingAiReply.update({
          where: { id: pendingReply.id },
          data: { suggestion: guestMessage },
        });
      }
      broadcastToTenant(tenantId, 'ai_suggestion', { conversationId, suggestion: guestMessage });
      console.log(`[AI] [${conversationId}] Copilot mode — suggestion held for host approval`);
      return;
    }

    // Send via Hostaway — use the channel of the most recent GUEST message from full history
    const lastGuestMsg = allMsgs.filter(m => m.role === 'GUEST').at(-1);
    const lastMsgChannel = lastGuestMsg?.channel ?? Channel.OTHER;
    const communicationType = lastMsgChannel === Channel.WHATSAPP ? 'whatsapp' : 'channel';
    const sentAt = new Date();

    // T031: Write-ahead delivery — save to DB FIRST, then send via Hostaway
    const savedMessage = await prisma.message.create({
      data: {
        conversationId,
        tenantId,
        role: MessageRole.AI,
        content: guestMessage,
        sentAt,
        channel: lastMsgChannel,
        communicationType,
        hostawayMessageId: '',
      },
    });

    // Update conversation lastMessageAt
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: sentAt },
    });

    // Push AI message to browser in real-time
    broadcastToTenant(tenantId, 'message', {
      conversationId,
      message: { role: 'AI', content: guestMessage, sentAt: sentAt.toISOString(), channel: String(lastMsgChannel), imageUrls: [] },
      lastMessageRole: 'AI',
      lastMessageAt: sentAt.toISOString(),
    });

    // T031: Now send via Hostaway + T033: Escalate on delivery failure
    try {
      const sendResult = await hostawayService.sendMessageToConversation(
        hostawayAccountId, hostawayApiKey, hostawayConversationId, guestMessage, communicationType
      );
      console.log(`[AI] [${conversationId}] Sent reply via Hostaway`);

      // Update DB record with Hostaway message ID if returned
      const hostawayMsgId = (sendResult as any)?.result?.id;
      if (hostawayMsgId) {
        await prisma.message.update({
          where: { id: savedMessage.id },
          data: { hostawayMessageId: String(hostawayMsgId) },
        }).catch(err => console.warn(`[AI] [${conversationId}] Failed to update hostawayMessageId:`, err));
      }
    } catch (sendErr) {
      // T033: Message is saved in DB but not delivered — escalate to manager
      console.error(`[AI] [${conversationId}] Hostaway send failed:`, sendErr);
      await handleEscalation(
        prisma, tenantId, conversationId, context.propertyId,
        'message-delivery-failure',
        `AI reply saved but Hostaway delivery failed. Error: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}. Message preview: "${guestMessage.substring(0, 150)}"`,
        'immediate'
      );
    }

    // Fire-and-forget: LLM-as-judge evaluation
    // NEVER awaited — runs in background after response is already sent
    if (!isInquiry) {
      evaluateAndImprove({
        tenantId,
        conversationId,
        guestMessage: ragQuery,
        sopCategories: sopClassification.categories,
        sopConfidence: sopClassification.confidence,
        sopReasoning: sopClassification.reasoning,
        aiResponse: guestMessage,
      }, prisma).catch(err =>
        console.warn('[AI] Judge evaluation failed (non-fatal):', err)
      );
    }

    console.log(`[AI] [${conversationId}] Done`);
  } catch (err) {
    console.error(`[AI] [${conversationId}] Error:`, err);
    throw err;
  }
}

export { SEED_COORDINATOR_PROMPT, SEED_SCREENING_PROMPT, MANAGER_TRANSLATOR_SYSTEM_PROMPT, COORDINATOR_SCHEMA, SCREENING_SCHEMA, createMessage, stripCodeFences, buildPropertyInfo };
export type { ContentBlock };
