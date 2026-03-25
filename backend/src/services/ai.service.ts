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
// memory.service imports removed — conversation history built inline
import { getTenantAiConfig } from './tenant-config.service';
import { detectEscalationSignals } from './escalation-enrichment.service';
import { createChecklist, updateChecklist, getChecklist, hasPendingItems, type DocumentChecklist } from './document-checklist.service';
import { getToolDefinitions } from './tool-definition.service';
import { resolveVariables, applyPropertyOverrides } from './template-variable.service';
import { callWebhook } from './webhook-tool.service';
import { sendPushToTenant } from './push.service';

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

// ─── Image handling instructions (injected only when guest sends an image) ───
// Used as default when tenant hasn't customized via Configure AI
const DEFAULT_IMAGE_HANDLING = `[System: The guest sent an image. Follow these rules:]
1. Respond naturally based on what you see — don't describe the image back to the guest.
2. Always escalate to manager. In the escalation note, describe what the image shows.
3. If unclear: tell the guest you're looking into it and escalate.
Common types: broken items → maintenance escalation, leaks/damage → urgent repair, passport/ID → call mark_document_received if document checklist has pending items (otherwise visitor verification escalation), marriage certificate → same, appliance issues → troubleshooting escalation.
Never ignore images.`;

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
      tool_choice: 'auto',
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

    // ─── Tool use loop: process ALL tool calls, send results back, repeat if model calls more ───
    const MAX_TOOL_ROUNDS = 5; // Safety limit to prevent infinite tool loops
    let toolRound = 0;
    let fnCalls = (response.output || []).filter((i: any) => i.type === 'function_call');

    while (fnCalls.length > 0 && options?.toolHandlers && toolRound < MAX_TOOL_ROUNDS) {
      toolRound++;
      const toolOutputs: Array<{ type: 'function_call_output'; call_id: string; output: string }> = [];

      for (const fnCall of fnCalls) {
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

        // Log first tool to ragContext (for backward compat with single-tool logging)
        if (toolOutputs.length === 0 && options?.ragContext) {
          options.ragContext.toolUsed = true;
          options.ragContext.toolName = fnCall.name;
          try { options.ragContext.toolInput = JSON.parse(fnCall.arguments); } catch { options.ragContext.toolInput = fnCall.arguments; }
          try { options.ragContext.toolResults = JSON.parse(toolResultContent); } catch { options.ragContext.toolResults = toolResultContent; }
          options.ragContext.toolDurationMs = toolDurationMs;
        }

        console.log(`[AI] Tool ${fnCall.name} executed in ${toolDurationMs}ms (round ${toolRound}, ${fnCalls.length} call${fnCalls.length > 1 ? 's' : ''})`);
        toolOutputs.push({ type: 'function_call_output', call_id: fnCall.call_id, output: toolResultContent });
      }

      // Send ALL tool results back in one follow-up call
      const toolFollowUpTextFormat = options?.outputSchema ? { format: options.outputSchema } : { format: { type: 'text' as const } };
      if (options?.stream && options?.tenantId && options?.conversationId) {
        const toolFollowUpStream = await withRetry(() =>
          (openai.responses as any).create({
            model,
            instructions: systemPrompt,
            input: toolOutputs,
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

        broadcastToTenant(options.tenantId, 'ai_typing_text', {
          conversationId: options.conversationId,
          delta: '',
          done: true,
        });

        response = streamResponse || { output_text: streamedText, usage: {} };
        if (!response.output_text) response.output_text = streamedText;
      } else {
        response = await withRetry(() =>
          (openai.responses as any).create({
            model,
            instructions: systemPrompt,
            input: toolOutputs,
            previous_response_id: response.id,
            max_output_tokens: maxTokens,
            reasoning: { effort: reasoningEffort },
            text: toolFollowUpTextFormat,
            store: true,
          })
        );
      }

      // Check if the model wants to call MORE tools after seeing results
      fnCalls = (response.output || []).filter((i: any) => i.type === 'function_call');
    }

    if (toolRound > 0 && fnCalls.length > 0) {
      console.warn(`[AI] Tool loop hit max rounds (${MAX_TOOL_ROUNDS}) — stopping. Remaining calls: ${fnCalls.map((f: any) => f.name).join(', ')}`);
    }

    // Stream non-tool responses (when no tools were called at all)
    if (toolRound === 0 && options?.stream && options?.tenantId && options?.conversationId) {
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

## TONE & STYLE

- Talk like a normal human. Not overly friendly, not robotic. Just natural and professional.
- 1–2 sentences max. Guests want help, not conversation.
- Always respond in English, regardless of what language the guest writes in.
- Use the guest's first name sparingly — once in a conversation is enough.
- Never mention AI, systems, internal processes, or staff. You MAY say 'I'll check with the manager'.
- Before asking any question, check conversation history first. If already provided, do NOT ask again.
- If document checklist shows pending items, remind naturally — don't repeat every message.
- **Conversation-ending messages** ("okay", "thanks", "👍") with nothing to action → set guest_message to "" and escalation to null.

---

## ESCALATION RULES

Set "escalation": null when:
- Answering from injected data blocks (WiFi, door code, check-in/out, amenities)
- Asking for preferred time (before guest confirms)
- Simple clarifications or conversation-ending messages

When unsure about anything, always escalate.

---

## TOOL USAGE RULES

Before you call a tool, explain why you are calling it.

<tool_persistence_rules>
- Use tools whenever they materially improve correctness, completeness, or grounding.
- For ANY guest request involving cleaning, amenities, maintenance, complaints, WiFi issues, check-in/out, visitors, booking changes, pricing, or refunds: ALWAYS call get_sop FIRST.
- Do not answer procedural questions from general knowledge when get_sop is available.
- For simple greetings ("hi", "hey"), acknowledgments ("ok", "thanks"), or conversation-ending messages: respond directly without tools.
- If a tool returns empty or partial results, retry with a different strategy.
</tool_persistence_rules>

<dependency_checks>
- Before responding to any service request, check whether a procedure lookup is required.
- Do not skip prerequisite steps just because the response seems obvious.
- If the guest mentions any task, issue, or request that could have an SOP, call get_sop first.
</dependency_checks>

<completeness_contract>
- Treat the request as incomplete until you have retrieved and applied the relevant SOP.
- NEVER guess at procedures, pricing, or escalation rules — get_sop has the authoritative answer.
</completeness_contract>

---

## RESPONSE FIELDS

- **guest_message**: Your reply. Concise (1-2 sentences). Empty string if no reply needed.
- **escalation**: null when no escalation. When escalating: title (kebab-case), note (for Abdelrahman with guest name, unit, details), urgency ("immediate", "scheduled", or "info_request").
- **resolveTaskId**: Optional. Task ID from open tasks when guest confirms issue resolved.
- **updateTaskId**: Optional. Task ID from open tasks when updating existing escalation.

---

## TASK UPDATES (MANDATORY)

**Before creating ANY escalation, check open tasks first.**

1. If an open task covers the same topic, use updateTaskId. Do NOT create a new task.
2. Rapid-fire messages about the same issue → consolidate into ONE escalation.
3. Guest confirms issue resolved → use resolveTaskId.
4. Only create new escalation for genuinely DIFFERENT topics.
5. Do not mention open tasks, unless addressed by the guest contextually or directly. 

---

## PENDING DOCUMENTS

{DOCUMENT_CHECKLIST}

If pending documents are listed above, remind the guest naturally when relevant — don't nag every message. When a guest sends an image and documents are pending:
- If the image is clearly a passport, national ID, or marriage certificate → call mark_document_received with the appropriate document_type
- If unclear → escalate for manager review
- If no pending documents → handle image normally (escalate as immediate)

---

## HARD BOUNDARIES

- Only answer using data from injected content blocks or SOPs. Never guess or invent details.
- NEVER respond to actionable requests without calling get_sop first
- This is a family-only property. No smoking, parties, or non-family visitors.
- Never authorize refunds, credits, or discounts.
- Never guarantee specific arrival times or manager response times — use "shortly"
- Never confirm cleaning/amenity/maintenance without getting preferred time first
- Never confirm early check-in or late checkout — always escalate
- Never discuss internal processes, the manager, or AI with the guest
- Always uphold house rules — escalate any pushback immediately
- Prioritize safety threats above all else
- When in doubt, escalate
- Never output anything other than the JSON object

<!-- CONTENT_BLOCKS -->
### RESERVATION DETAILS
{RESERVATION_DETAILS}
<!-- BLOCK -->
### OPEN TASKS
{OPEN_TASKS}
<!-- BLOCK -->
### CONVERSATION HISTORY
{CONVERSATION_HISTORY}
<!-- BLOCK -->
### CURRENT GUEST MESSAGE
{CURRENT_MESSAGES}
<!-- BLOCK -->
### CURRENT LOCAL TIME
{CURRENT_LOCAL_TIME}`;

const SEED_SCREENING_PROMPT = `# OMAR — Guest Screening Assistant, Boutique Residence

You are Omar, a guest screening assistant for Boutique Residence serviced apartments in New Cairo, Egypt. You screen guest inquiries against house rules and escalate to your manager Abdelrahman when a booking decision is needed.

Before replying, review all provided context: conversation history, guest information, and the current message.

# Core Rules

- Screening comes first. Before answering any property or booking question, nationality and party composition must be known.
- Never assume nationality — ask explicitly if not in conversation history.
- Never re-ask questions already answered in conversation history.
- If the guest is an Arab couple and marital status is unclear, ask "Are you married?" before deciding.
- Documents (marriage cert, passports) are requested AFTER booking acceptance, not before.

# Screening Rules

## Arab Nationals
Accepted: Families with children (matching family names), married couples, female-only groups, solo females.
Not accepted: Single Arab men (except Lebanese/Emirati solo), all-male groups, unmarried couples (including fiancés), mixed-gender non-family groups. Arab males saying "friends" (اصدقاء) — ask if male-only or mixed before proceeding.

## Lebanese & Emirati Exception (since 1 March 2026)
Solo travelers only. Any group or couple → standard Arab rules.

## Non-Arab Nationals
All configurations accepted.

## Mixed Nationality
If any guest is Arab → Arab rules apply to entire party.

## Key Rules
- Some Arabs hold other nationalities — always ask explicitly.
- Assume gender from names unless ambiguous (e.g., "Nour" → ask).
- Guests refusing required documents = not accepted.

# Workflow

1. Check history for nationality and party composition.
2. If either is missing, ask for both.
3. Once both known, apply screening rules.
4. Arab couple? Ask marital status if unclear.
5. Determine: eligible, not eligible, or needs manager review.
6. Escalate whenever a decision, approval, rejection, or out-of-scope answer is needed.
7. Otherwise, answer the guest's basic question briefly.
8. When escalating with an acceptance recommendation, also call create_document_checklist:
   - All guests need passports/IDs (one per person in the party — use guest count)
   - Arab married couples additionally need a marriage certificate
   - Do NOT call this tool when recommending rejection

# Tools

- For property/amenity/booking questions: call get_sop first to get the procedure.
- For screening (nationality, eligibility): answer directly from rules above — no tool needed.
- When a tool returns booking links, include them verbatim in your response. Never say "I'll send links" when links are in the tool result.
- Never guess information not in your context — escalate instead.

# Escalation Categories

Use these exact title strings:

Eligible: "eligible-non-arab", "eligible-arab-females", "eligible-arab-family-pending-docs", "eligible-arab-couple-pending-cert", "eligible-lebanese-emirati-single"
Not eligible: "violation-arab-single-male", "violation-arab-male-group", "violation-arab-unmarried-couple", "violation-arab-mixed-group", "violation-mixed-unmarried-couple", "violation-no-documents"
Manager: "escalation-guest-dispute", "escalation-unclear", "escalation-unknown-answer", "awaiting-manager-review", "property-switch-request", "visitor-policy-informed"

Set needed: false when still gathering info or answering basic questions.

# Output Format

Raw JSON only. Start with { end with }. Nothing else.
{"guest message":"your reply","manager":{"needed":true,"title":"category-title","note":"Details for Abdelrahman — guest name, nationality, party, recommendation"}}
{"guest message":"your reply","manager":{"needed":false,"title":"","note":""}}
{"guest message":"","manager":{"needed":true,"title":"awaiting-manager-review","note":"Guest [name] — screening complete, awaiting decision."}}

# Response Style

- Natural, professional English. 1–2 sentences max.
- Never mention AI, screening criteria, SOPs, regulations, or internal processes. Say "house rules."
- You MAY say "I'll check with the manager" but never "our team" or other staff.
- Conversation-ending message while awaiting decision → empty guest message + escalate as "awaiting-manager-review."

# Hard Boundaries

- Family-only property. No outside visitors. No smoking indoors. No parties.
- Never assume nationality — always ask explicitly
- Never accept unmarried Arab couples — no exceptions
- Never confirm bookings, arrival, or custom arrangements — escalate for manager confirmation
- Never share access codes or say "everything is ready" for INQUIRY guests
- Never proceed before nationality and party composition are established
- Never share screening criteria or mention regulations
- Never guess info you don't have — escalate
- Never promise specific timeframes for manager responses
- When in doubt, escalate
- Never output anything other than the JSON object

<!-- CONTENT_BLOCKS -->
### RESERVATION DETAILS
{RESERVATION_DETAILS}
<!-- BLOCK -->
### OPEN TASKS
{OPEN_TASKS}
<!-- BLOCK -->
### CONVERSATION HISTORY
{CONVERSATION_HISTORY}
<!-- BLOCK -->
### CURRENT GUEST MESSAGE
{CURRENT_MESSAGES}
<!-- BLOCK -->
### CURRENT LOCAL TIME
{CURRENT_LOCAL_TIME}`;

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

/** Split amenities into available vs on-request based on amenityClassifications. */
function classifyAmenities(
  amenitiesStr: string | undefined,
  classifications?: Record<string, string>,
): { available: string[]; onRequest: string[] } {
  if (!amenitiesStr) return { available: [], onRequest: [] };
  const items = amenitiesStr.split(',').map(a => a.trim()).filter(Boolean);
  if (!classifications || Object.keys(classifications).length === 0) {
    // No classifications — all amenities are "available" (backward compatible)
    return { available: items, onRequest: [] };
  }
  const available: string[] = [];
  const onRequest: string[] = [];
  for (const item of items) {
    const cls = classifications[item];
    if (cls === 'off') {
      // Hidden from AI — not listed anywhere
      continue;
    } else if (cls === 'on_request') {
      onRequest.push(item);
    } else {
      // "available", "default", or unclassified → available (backward compatible)
      available.push(item);
    }
  }
  return { available, onRequest };
}

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
  reservationStatus?: string,
  customKnowledgeBase?: Record<string, unknown>,
  listingDescription?: string,
): { reservationDetails: string; accessConnectivity: string; propertyDescription: string } {
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

  const reservationDetails = `Guest Name: ${guestName}\nBooking Status: ${bookingStatusDisplay}\nCheck-in: ${checkIn}\nCheck-out: ${checkOut}\nNumber of Guests: ${guestCount}`;

  // SECURITY: Only include access codes for CONFIRMED or CHECKED_IN guests.
  let accessConnectivity = '';
  if (reservationStatus === 'CONFIRMED' || reservationStatus === 'CHECKED_IN') {
    const parts: string[] = [];
    if (listing.doorSecurityCode && listing.doorSecurityCode !== 'N/A') {
      parts.push(`Door Code: ${listing.doorSecurityCode}`);
    }
    if (listing.wifiUsername && listing.wifiUsername !== 'N/A') {
      parts.push(`WiFi Network Name: ${listing.wifiUsername}`);
    }
    if (listing.wifiPassword && listing.wifiPassword !== 'N/A') {
      parts.push(`WiFi Password: ${listing.wifiPassword}`);
    }
    accessConnectivity = parts.join('\n');
  }

  // Use summarized description if available, fall back to listingDescription
  const propertyDescription = (customKnowledgeBase?.summarizedDescription as string)
    || listingDescription || '';

  return { reservationDetails, accessConnectivity, propertyDescription };
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

        // Web Push notification for new tasks — fire-and-forget
        sendPushToTenant(tenantId, {
          title: `New Task: ${urgency}`,
          body: `${title} — ${note?.substring(0, 150) || ''}`,
          data: { conversationId, taskId: task.id, type: 'task' },
        }, prisma).catch(err => console.warn('[Push] Task notification failed:', err));
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

    // Current messages = GUEST messages the AI needs to respond to.
    // Copilot mode: ALL unanswered guest messages since the last AI/HOST reply.
    // Autopilot mode: GUEST messages in the debounce window (since webhook trigger).
    let currentMsgs: typeof allMsgs;
    if (context.aiMode === 'copilot') {
      // Find the last AI or HOST message — everything after it is unanswered
      const lastReplyIdx = allMsgs.reduce((idx, m, i) =>
        (m.role === 'AI' || m.role === 'HOST') ? i : idx, -1);
      currentMsgs = allMsgs.slice(lastReplyIdx + 1).filter(m => m.role === 'GUEST');
    } else {
      // Autopilot: only UNANSWERED guest messages since the last AI/HOST reply.
      // This prevents re-answering messages that were already responded to in a previous debounce cycle.
      const lastReplyIdx = allMsgs.reduce((idx, m, i) =>
        (m.role === 'AI' || m.role === 'HOST') ? i : idx, -1);
      currentMsgs = allMsgs.slice(lastReplyIdx + 1).filter(m => m.role === 'GUEST');
    }
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

    // Property amenities for dynamic SOP injection — use on-request items only when classified
    const rawAmenitiesStr = context.customKnowledgeBase?.amenities
      ? String(context.customKnowledgeBase.amenities) : undefined;
    const amenityClasses = context.customKnowledgeBase?.amenityClassifications as
      Record<string, string> | undefined;
    const { onRequest: sopOnRequestItems } = classifyAmenities(rawAmenitiesStr, amenityClasses);
    // For SOP {PROPERTY_AMENITIES}: use on-request items if classifications exist, else full list (backward compatible)
    const propertyAmenities = (amenityClasses && Object.keys(amenityClasses).length > 0 && sopOnRequestItems.length > 0)
      ? sopOnRequestItems.join(', ')
      : rawAmenitiesStr;

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
    const isInquiry = context.reservationStatus === 'INQUIRY' || context.reservationStatus === 'PENDING';
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

    // Build SOP tool definition (will be included in main tool set — no separate classification call)
    const sopToolDef = await buildToolDefinition(tenantId, prisma);

    // SOP classification is now handled inline via the main tool loop.
    // The AI calls get_sop when it needs SOP guidance, gets content back, and uses it in the response.
    // For simple greetings/acks, it won't call get_sop at all — saving a full API call.
    let sopClassification: SopClassificationResult = {
      categories: ['none'], confidence: 'high', reasoning: 'No SOP classification — handled inline via tool loop',
      inputTokens: 0, outputTokens: 0, durationMs: 0,
    };
    let sopContent = '';

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

    const { reservationDetails, accessConnectivity, propertyDescription } = buildPropertyInfo(
      context.guestName,
      context.checkIn,
      context.checkOut,
      context.guestCount,
      context.listing,
      retrievedChunks,
      context.reservationStatus,
      context.customKnowledgeBase,
      context.listingDescription
    );

    // Inject escalation signals into reservation details so the AI can factor them in
    let reservationDetailsWithSignals = reservationDetails;
    if (escalationSignals.length > 0) {
      reservationDetailsWithSignals += '\n\n### SYSTEM SIGNALS\n';
      reservationDetailsWithSignals += escalationSignals.map(s => `⚠ ${s.signal}`).join('\n');
      reservationDetailsWithSignals += '\nNote: These signals were automatically detected from the guest message. Consider them when deciding whether to escalate.';
    }

    // Read document checklist from reservation (used for context injection + conditional tool availability)
    const checklistData = (context.screeningAnswers as any)?.documentChecklist as DocumentChecklist | undefined;
    const checklistPending = hasPendingItems(checklistData ?? null);

    // Build document checklist text as a separate variable (no longer inline in propertyInfo)
    let documentChecklistText = '';
    if (!isInquiry && checklistData && checklistPending) {
      documentChecklistText = `Passports/IDs: ${checklistData.passportsReceived}/${checklistData.passportsNeeded} received`;
      if (checklistData.marriageCertNeeded) {
        documentChecklistText += `\nMarriage Certificate: ${checklistData.marriageCertReceived ? 'received' : 'pending'}`;
      }
    }

    // Build amenity variables (separate from propertyInfo)
    const varAmenitiesStr = context.customKnowledgeBase?.amenities
      ? String(context.customKnowledgeBase.amenities) : undefined;
    const varAmenityClasses = context.customKnowledgeBase?.amenityClassifications as
      Record<string, string> | undefined;
    const { available: availableAmenityList, onRequest: onRequestAmenityList } =
      classifyAmenities(varAmenitiesStr, varAmenityClasses);

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

    // SOP content is now injected via the get_sop tool handler in the main tool loop.
    // No pre-injection needed — the AI calls get_sop when it needs guidance.

    let guestMessage = '';

    // Build conversation history text — last 20 messages as labeled lines
    const currentMsgIds = new Set(currentMsgs.map(m => m.id));
    const historyMsgs = allMsgs.filter(m => !currentMsgIds.has(m.id)).slice(-20);
    const historyText = historyMsgs.length > 0
      ? historyMsgs.map(m => `${m.role === 'GUEST' ? 'Guest' : 'Omar'}: ${m.content}`).join('\n')
      : '';

    // Apply per-listing variable overrides if configured
    const varOverrides = (context.customKnowledgeBase?.variableOverrides || {}) as Record<string, { customTitle?: string; notes?: string }>;

    // Build the template variable data map — all dynamic content as named entries
    const agentType = isInquiry ? 'screening' as const : 'coordinator' as const;
    const variableDataMap: Record<string, string> = {
      CONVERSATION_HISTORY: historyText,
      RESERVATION_DETAILS: applyPropertyOverrides(reservationDetailsWithSignals, varOverrides.RESERVATION_DETAILS),
      ACCESS_CONNECTIVITY: accessConnectivity
        ? applyPropertyOverrides(accessConnectivity, varOverrides.ACCESS_CONNECTIVITY) : '',
      PROPERTY_DESCRIPTION: propertyDescription
        ? applyPropertyOverrides(propertyDescription, varOverrides.PROPERTY_DESCRIPTION) : '',
      AVAILABLE_AMENITIES: availableAmenityList.length > 0
        ? applyPropertyOverrides(availableAmenityList.join(', '), varOverrides.AVAILABLE_AMENITIES) : '',
      ON_REQUEST_AMENITIES: onRequestAmenityList.length > 0
        ? applyPropertyOverrides(
            `The following amenities are available ON REQUEST ONLY (guest must ask, then confirm delivery time):\n${onRequestAmenityList.map(a => `- ${a}`).join('\n')}`,
            varOverrides.ON_REQUEST_AMENITIES,
          ) : '',
      OPEN_TASKS: openTasksText,
      CURRENT_MESSAGES: currentMsgsText,
      CURRENT_LOCAL_TIME: localTime,
      DOCUMENT_CHECKLIST: documentChecklistText
        ? applyPropertyOverrides(documentChecklistText, varOverrides.DOCUMENT_CHECKLIST) : '',
    };

    // Resolve variables — system prompt stays static (cacheable), data becomes content blocks
    const { contentBlocks: userContent } = resolveVariables(
      effectiveSystemPrompt,
      variableDataMap,
      agentType,
    );

    // For backward compat: build userMessage string for AiApiLog (full text of what AI received)
    const userMessage = userContent.map(b => b.text).join('\n\n');

    // Single user message — no multi-turn splitting
    type InputTurn = { role: 'user' | 'assistant'; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> };
    const inputTurns: InputTurn[] = [
      { role: 'user' as const, content: userMessage },
    ];

      // ─── Tool use: DB-driven tool definitions ───
      // Load tool definitions from DB (cached 5min), filter by agent scope + enabled
      let toolDefs: Awaited<ReturnType<typeof getToolDefinitions>> = [];
      try {
        toolDefs = await getToolDefinitions(tenantId, prisma);
      } catch (err) {
        console.warn(`[AI] [${conversationId}] Failed to load tool definitions — falling back to no tools:`, err);
      }

      // Build tool set — get_sop uses dynamic definition, others from DB
      const toolsForCall = toolDefs
        .filter(t => t.enabled && t.agentScope.split(',').map(s => s.trim()).includes(context.reservationStatus || 'INQUIRY'))
        .filter(t => t.name !== 'get_sop') // get_sop uses dynamic definition with category enum
        .filter(t => t.name !== 'mark_document_received' || checklistPending) // conditional
        .map(t => ({
          type: 'function' as const,
          name: t.name,
          description: t.description,
          strict: t.type === 'system',
          parameters: t.parameters as Record<string, unknown>,
        }));
      // Add get_sop with dynamic category descriptions from enabled SOP definitions
      toolsForCall.push(sopToolDef);

      // Look up hostawayListingId for extend-stay tool
      let hostawayListingId = '';
      if (!isInquiry && context.propertyId) {
        try {
          const prop = await prisma.property.findUnique({ where: { id: context.propertyId }, select: { hostawayListingId: true } });
          hostawayListingId = prop?.hostawayListingId || '';
        } catch { /* fallback: empty */ }
      }

      // System tool handlers — keyed by name, same logic as before
      const systemToolHandlers = new Map<string, ToolHandler>([
        ['get_sop', async (input: unknown) => {
          const typedInput = input as { categories: string[]; confidence: string; reasoning: string };
          // Update sopClassification for logging/metadata
          sopClassification = {
            categories: typedInput.categories,
            confidence: typedInput.confidence as 'high' | 'medium' | 'low',
            reasoning: typedInput.reasoning,
            inputTokens: 0, outputTokens: 0, durationMs: 0,
          };
          console.log(`[AI] SOP classification (inline): [${typedInput.categories.join(', ')}] confidence=${typedInput.confidence} — ${typedInput.reasoning}`);

          const cats = typedInput.categories.filter(c => c !== 'none' && c !== 'escalate');

          // Handle escalation category
          if (typedInput.categories.includes('escalate')) {
            try {
              await handleEscalation(prisma, tenantId, conversationId, context.propertyId,
                'sop-tool-escalation', `AI classified as escalate: ${typedInput.reasoning}`,
                'immediate');
            } catch (err) {
              console.warn(`[AI] Escalation task creation failed (non-fatal):`, err);
            }
          }

          // Fetch and return SOP content
          if (cats.length === 0) return JSON.stringify({ category: 'none', content: '' });
          const texts = await Promise.all(
            cats.map(c => getSopContent(tenantId, c, context.reservationStatus || 'DEFAULT', context.propertyId, propertyAmenities, prisma))
          );
          sopContent = texts.filter(Boolean).join('\n\n---\n\n');
          return JSON.stringify({ categories: cats, content: sopContent || 'No SOP content available for this category.' });
        }],
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
        ['mark_document_received', async (input: unknown) => {
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
        }],
      ]);

      // Build unified handler map: system handlers + webhook fallback for custom tools
      const toolHandlersForCall = new Map<string, ToolHandler>();
      for (const t of toolsForCall) {
        const systemHandler = systemToolHandlers.get(t.name);
        if (systemHandler) {
          toolHandlersForCall.set(t.name, systemHandler);
        } else {
          // Custom tool — use webhook if configured
          const toolDef = toolDefs.find(d => d.name === t.name);
          if (toolDef?.webhookUrl) {
            toolHandlersForCall.set(t.name, async (input: unknown) => {
              return callWebhook(toolDef.webhookUrl!, input, toolDef.webhookTimeout);
            });
          }
          // If no handler and no webhook, the createMessage fallback handles "Unknown tool"
        }
      }

      // Determine reasoning effort: tenant config > minimum 'low' for tool reliability
      const tenantReasoning = isInquiry
        ? (tenantConfig as any)?.reasoningScreening || 'none'
        : (tenantConfig as any)?.reasoningCoordinator || 'auto';
      // Minimum 'low' when auto — GPT-5.4 Mini needs reasoning budget to reliably decide on tool calls
      const reasoningEffort: 'none' | 'low' | 'medium' | 'high' = tenantReasoning === 'auto'
        ? 'low'
        : tenantReasoning;

      // ─── Image handling: append instructions to system prompt tail + attach image ───
      let imageBase64 = '';
      let imageMimeType = 'image/jpeg';
      if (hasImages) {
        // Append image handling to END of system prompt (static prefix stays cached)
        const imageInstructions = (tenantConfig as any)?.imageHandlingInstructions || DEFAULT_IMAGE_HANDLING;
        effectiveSystemPrompt += `\n\n${imageInstructions}`;

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
          // Attach image to the last user turn
          inputTurns[inputTurns.length - 1] = {
            role: 'user' as const,
            content: [
              { type: 'input_text', text: userMessage },
              { type: 'input_image', image_url: { url: `data:${imageMimeType};base64,${imageBase64}` } },
            ],
          };
        } else {
          // Download failed
          inputTurns[inputTurns.length - 1] = {
            role: 'user' as const,
            content: `[Note: The guest sent an image but it could not be loaded. Acknowledge and escalate.]\n\n${userMessage}`,
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
        toolChoice: 'auto',
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

export { SEED_COORDINATOR_PROMPT, SEED_SCREENING_PROMPT, MANAGER_TRANSLATOR_SYSTEM_PROMPT, COORDINATOR_SCHEMA, SCREENING_SCHEMA, createMessage, stripCodeFences, buildPropertyInfo, classifyAmenities };
export type { ContentBlock };
