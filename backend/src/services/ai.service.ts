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
import { broadcastToTenant, broadcastCritical } from './socket.service';
import {
  traceAiCall,
  traceEscalation,
  runWithAiTrace,
  stampAiTrace,
  startAiSpan,
} from './observability.service';
import { searchAvailableProperties } from './property-search.service';
import { checkExtendAvailability } from './extend-stay.service';
import { getSopContent, buildToolDefinition } from './sop.service';
import { getFaqForProperty } from './faq.service';
import { evaluateEscalation } from './task-manager.service';
// memory.service imports removed — conversation history built inline
import { getTenantAiConfig } from './tenant-config.service';
import { detectEscalationSignals } from './escalation-enrichment.service';
import { createChecklist, updateChecklist, hasPendingItems, type DocumentChecklist } from './document-checklist.service';
import { getToolDefinitions } from './tool-definition.service';
import { resolveVariables, applyPropertyOverrides } from './template-variable.service';
import { BAKED_IN_SOPS_TEXT } from '../config/baked-in-sops';
import { callWebhook } from './webhook-tool.service';
import { sendPushToTenantAll } from './push.service';
import { generateOrExtendSummary } from './summary.service';
import { compactMessageAsync } from './message-compaction.service';
import { syncConversationMessages } from './message-sync.service';
import { lockOlderPreviews } from './shadow-preview.service';

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

// ─── Conversation history timestamp formatting ───────────────────────────────
// Same-day messages: [h:mm A]  —  older messages: [MMM DD, h:mm A]
// Timezone resolution: tenant.workingHoursTimezone → fallback 'Africa/Cairo'.
function formatHistoryTimestamp(sentAt: Date, now: Date, timeZone: string): string {
  try {
    const dayKey = (d: Date) => new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
    const sameDay = dayKey(sentAt) === dayKey(now);
    const timePart = new Intl.DateTimeFormat('en-US', {
      timeZone, hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(sentAt);
    if (sameDay) return `[${timePart}]`;
    const datePart = new Intl.DateTimeFormat('en-US', {
      timeZone, month: 'short', day: '2-digit',
    }).format(sentAt);
    return `[${datePart}, ${timePart}]`;
  } catch {
    return '';
  }
}

// ─── Image handling instructions (injected only when guest sends an image) ───
// Used as default when tenant hasn't customized via Configure AI
const DEFAULT_IMAGE_HANDLING = `[System: The guest sent an image. Follow these rules:]
1. Respond naturally based on what you see — don't describe the image back to the guest.
2. If the image is a passport, national ID, or marriage certificate AND pending documents exist in the PENDING DOCUMENTS section → call mark_document_received with the correct document_type and a brief note (e.g. "passport for Ahmed"). Do NOT escalate — just mark it received and confirm to the guest.
3. If the image looks like a document but is too blurry, cut off, or unreadable → tell the guest to resend a clearer photo. Do NOT mark it as received.
4. For all other images (broken items, damage, appliances, etc.) → escalate to manager with a description of what the image shows.
5. If unclear what the image is → tell the guest you're looking into it and escalate.
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

// ─── Structured output schemas (enforced by OpenAI, replaces prompt-based JSON instructions) ───

const COORDINATOR_SCHEMA = {
  type: 'json_schema' as const,
  name: 'coordinator_response',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      guest_message: { type: 'string', description: 'Reply to the guest. Empty string if no reply needed.' },
      escalation: {
        type: ['object', 'null'] as any,
        description: 'null when no escalation needed. Object with title, note, urgency when escalating.',
        properties: {
          title: { type: 'string', description: 'kebab-case escalation label' },
          note: { type: 'string', description: 'Details for Abdelrahman — guest name, unit, issue' },
          urgency: { type: 'string', enum: ['immediate', 'scheduled', 'info_request'] },
        },
        required: ['title', 'note', 'urgency'],
        additionalProperties: false,
      },
      resolveTaskId: { type: ['string', 'null'] as any, description: 'Task ID from open tasks when guest confirms issue resolved' },
      updateTaskId: { type: ['string', 'null'] as any, description: 'Task ID from open tasks when adding new details to existing escalation' },
      confidence: {
        type: 'number',
        description: 'Self-rated confidence (0-1). 0.90+ unambiguous rule/SOP match · 0.70-0.89 minor uncertainty · 0.50-0.69 material uncertainty · <0.50 high uncertainty. Be honest — low confidence routes this response for human review.',
      },
    },
    required: ['guest_message', 'escalation', 'resolveTaskId', 'updateTaskId', 'confidence'],
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
      'guest message': { type: 'string', description: 'Reply to the guest. Empty string if no reply needed.' },
      manager: {
        type: 'object',
        description: 'Manager escalation. Set needed:false when still gathering info.',
        properties: {
          needed: { type: 'boolean', description: 'true when manager action needed (booking decision, rejection). false when still gathering info.' },
          title: { type: 'string', description: 'kebab-case category from escalation categories. Empty string when not needed.' },
          note: { type: 'string', description: 'Details for Abdelrahman — guest name, nationality, party, recommendation. Empty string when not needed.' },
        },
        required: ['needed', 'title', 'note'],
        additionalProperties: false,
      },
      confidence: {
        type: 'number',
        description: 'Self-rated confidence (0-1). 0.90+ unambiguous rule/SOP match · 0.70-0.89 minor uncertainty · 0.50-0.69 material uncertainty · <0.50 high uncertainty. Be honest — low confidence routes this response for human review.',
      },
    },
    required: ['guest message', 'manager', 'confidence'],
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
  options?: { model?: string; maxTokens?: number; topK?: number; topP?: number; temperature?: number; stopSequences?: string[]; agentName?: string; tenantId?: string; conversationId?: string; ragContext?: { query: string; chunks: Array<{ content: string; category: string; similarity: number; sourceKey: string; isGlobal: boolean }>; totalRetrieved: number; durationMs: number; toolUsed?: boolean; toolName?: string; toolNames?: string[]; toolInput?: any; toolResults?: any; toolDurationMs?: number; tools?: Array<{ name: string; input: any; results: any; durationMs: number }>; openaiRequestId?: string; rateLimitRemaining?: { requests: number; tokens: number } }; openTaskCount?: number; totalMessages?: number; memorySummarized?: boolean; hasImage?: boolean; tools?: any[]; toolChoice?: any; toolHandlers?: Map<string, ToolHandler>; toolContext?: unknown; reasoningEffort?: 'none' | 'low' | 'medium' | 'high'; agentType?: string; stream?: boolean; inputTurns?: Array<{ role: 'user' | 'assistant'; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }>; outputSchema?: any }
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
        let parsedToolInput: unknown = null;
        try { parsedToolInput = JSON.parse(fnCall.arguments); } catch { parsedToolInput = fnCall.arguments; }
        // Feature 041 §1: per-tool-call span on the active AI trace (no-op
        // when tracing is disabled or when there's no active trace).
        const toolSpan = startAiSpan(`tool:${fnCall.name}`, parsedToolInput, {
          toolName: fnCall.name,
          round: toolRound,
        });
        let toolResultContent: string;
        let toolSpanError: string | null = null;
        try {
          if (handler) {
            toolResultContent = await handler(parsedToolInput as any, options.toolContext);
          } else {
            toolResultContent = JSON.stringify({ error: `Unknown tool: ${fnCall.name}`, found: false, properties: [] });
          }
        } catch (toolErr) {
          console.error(`[AI] Tool handler error for ${fnCall.name}:`, toolErr);
          toolSpanError = toolErr instanceof Error ? toolErr.message : String(toolErr);
          toolResultContent = JSON.stringify({ error: 'Tool execution failed. Please escalate to the property manager.', found: false, properties: [], should_escalate: true });
        }
        const toolDurationMs = Date.now() - toolStartMs;
        let parsedResults: any;
        try { parsedResults = JSON.parse(toolResultContent); } catch { parsedResults = toolResultContent; }
        toolSpan.end(parsedResults, { durationMs: toolDurationMs, error: toolSpanError });

        // Log tools to ragContext
        if (options?.ragContext) {
          options.ragContext.toolUsed = true;
          if (!options.ragContext.toolNames) options.ragContext.toolNames = [];
          options.ragContext.toolNames.push(fnCall.name);
          // Per-tool details array for AI Logs
          if (!options.ragContext.tools) options.ragContext.tools = [];
          options.ragContext.tools.push({
            name: fnCall.name,
            input: parsedToolInput,
            results: parsedResults,
            durationMs: toolDurationMs,
          });
          // Keep first tool in toolName for backward compat
          if (!options.ragContext.toolName) {
            options.ragContext.toolName = fnCall.name;
            options.ragContext.toolInput = parsedToolInput;
            options.ragContext.toolResults = parsedResults;
            options.ragContext.toolDurationMs = toolDurationMs;
          }
        }

        console.log(`[AI] Tool ${fnCall.name} executed in ${toolDurationMs}ms (round ${toolRound}, ${fnCalls.length} call${fnCalls.length > 1 ? 's' : ''})`);
        toolOutputs.push({ type: 'function_call_output', call_id: fnCall.call_id, output: toolResultContent });
      }

      // Send ALL tool results back — don't enforce json_schema yet (blocks further tool calls).
      // Schema is enforced on the final response after the tool loop exits.
      if (options?.stream && options?.tenantId && options?.conversationId) {
        const toolFollowUpStream = await withRetry(() =>
          (openai.responses as any).create({
            model,
            instructions: systemPrompt,
            input: toolOutputs,
            previous_response_id: response.id,
            max_output_tokens: maxTokens,
            reasoning: { effort: reasoningEffort },
            tools: options?.tools,
            tool_choice: 'auto',
            store: true,
            stream: true,
            ...(options?.tenantId ? { prompt_cache_key: `tenant-${options.tenantId}-${options.agentType || 'default'}` } : {}),
            prompt_cache_retention: '24h',
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
            tools: options?.tools,
            tool_choice: 'auto',
            store: true,
            ...(options?.tenantId ? { prompt_cache_key: `tenant-${options.tenantId}-${options.agentType || 'default'}` } : {}),
            prompt_cache_retention: '24h',
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

    // If tools were used, ensure response is valid JSON matching the schema (not enforced during tool rounds)
    if (toolRound > 0 && options?.outputSchema && response.output_text) {
      let needsSchemaEnforcement = false;
      try {
        const parsed = JSON.parse(stripCodeFences(response.output_text));
        // Validate schema shape — check that required fields have correct types
        const schemaProps = options.outputSchema?.schema?.properties;
        if (schemaProps) {
          for (const [key, def] of Object.entries(schemaProps) as [string, any][]) {
            const val = parsed[key];
            // Check nullable object fields aren't strings (e.g. escalation: "info_request" instead of object|null)
            const types = Array.isArray(def.type) ? def.type : [def.type];
            if (types.includes('object') && typeof val === 'string') {
              needsSchemaEnforcement = true;
              console.log(`[AI] Post-tool response has wrong type for "${key}": expected object|null, got string "${val}"`);
              break;
            }
            // Check required sub-fields exist on object values
            if (types.includes('object') && val && typeof val === 'object' && def.required) {
              for (const req of def.required) {
                if (!(req in val)) {
                  needsSchemaEnforcement = true;
                  console.log(`[AI] Post-tool response missing required field "${key}.${req}"`);
                  break;
                }
              }
              if (needsSchemaEnforcement) break;
            }
          }
        }
      } catch {
        needsSchemaEnforcement = true;
      }
      if (needsSchemaEnforcement) {
        console.log(`[AI] Post-tool response doesn't match schema — enforcing`);
        response = await withRetry(() =>
          (openai.responses as any).create({
            model,
            instructions: systemPrompt,
            input: `Based on all the tool results and context, generate your final response now.`,
            previous_response_id: response.id,
            max_output_tokens: maxTokens,
            reasoning: { effort: reasoningEffort },
            text: { format: options.outputSchema },
            store: true,
          })
        );
      }
    }

    // Detect truncation — reasoning tokens can exhaust max_output_tokens before visible output completes
    if (response.status === 'incomplete') {
      const reason = response.incomplete_details?.reason || 'unknown';
      console.warn(`[AI] Response incomplete (reason: ${reason}) — output may be truncated. Reasoning tokens: ${response.usage?.output_tokens_details?.reasoning_tokens ?? '?'}, max_output_tokens: ${maxTokens}`);
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
  s = s.trim();
  // Fix concatenated JSON objects: {}{}{real} → extract the last complete object
  if (s.includes('}{')) {
    const parts = s.split(/\}\s*\{/).map((p, i, arr) =>
      (i === 0 ? p + '}' : i === arr.length - 1 ? '{' + p : '{' + p + '}')
    );
    // Use the last non-empty-response object, or the last one overall
    for (let i = parts.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(parts[i]);
        const msg = parsed.guest_message || parsed['guest message'] || '';
        if (msg || i === 0) return parts[i];
      } catch { continue; }
    }
  }
  return s;
}

// ─── System Prompts ────────────────────────────────────────

const SEED_COORDINATOR_PROMPT = `# OMAR — Lead Guest Coordinator, Boutique Residence

You are Omar, the Lead Guest Coordinator for Boutique Residence serviced apartments in New Cairo, Egypt. You handle guest requests for confirmed and checked-in guests, and escalate to your manager when human action is needed.

<critical_rule>
For any service request or operational question, retrieve the relevant SOP before responding. Only answer from SOPs, FAQs, and injected property data — not from general knowledge. When uncertain, escalate.
</critical_rule>

<tools>
Answer directly when the information is already in the reservation details or conversation history — no tool call needed.

Tool priority for guest questions (follow this order):
1. get_sop → first call for any service request, operational question, or procedure. Most answers live here.
2. get_faq → only if get_sop doesn't cover it and you would otherwise escalate as info_request.
3. Escalate as info_request → only after both fail.

Direct-trigger tools (skip the priority chain):
- check_extend_availability → guest wants to extend, shorten, or change stay dates.
- search_available_properties → guest lists multiple requirements or asks what's available. Scores this property and alternatives together.
- mark_document_received → guest sends image of passport/ID/marriage certificate and documents are pending.

When a tool returns booking links or channel-specific instructions, include them verbatim.
</tools>

<escalation>
Set escalation to null when:
- Answering from SOPs, FAQs, or injected property data.
- Asking the guest for preferred time or clarification.
- Conversation-ending messages with nothing to action.

Urgency levels when escalating:
- immediate: safety threats, active complaints, urgent issues, unclear images.
- scheduled: cleaning, maintenance, amenity delivery, check-in/out changes.
- info_request: questions not answered by SOPs or FAQs (try get_faq first).

Safety threats take priority — escalate immediately without tool calls.
</escalation>

<task_management>
Before creating any new escalation, check open tasks first.

1. Same topic as an open task → use updateTaskId. Do not create a duplicate.
2. Rapid-fire messages about the same issue → consolidate into one update.
3. Guest confirms issue resolved → use resolveTaskId.
4. Only create new escalation for genuinely different topics.
5. Do not mention open tasks unless the guest brings them up.
</task_management>

<documents>
{DOCUMENT_CHECKLIST}

Image handling:
- Documents pending + clear passport/ID/marriage cert → call mark_document_received.
- Documents pending + unclear image → escalate for review.
- No documents pending → escalate image as immediate.
</documents>

<rules>
- 1–2 sentences max. Natural, warm but concise.
- Check conversation history before asking — do not re-ask what the guest already provided.
- Always English. Use the guest's first name only in your first reply to them. After that, do not use their name.
- You may say "I'll check with the manager."
- Do not add follow-up questions unless you need information to proceed.
- Do not reference SOPs, internal systems, or staff names to the guest.
- Conversation-ending messages ("ok", "thanks", "👍") with nothing to action → empty guest_message, escalation null.
- If pending documents exist, remind naturally when relevant — not every message.
- If asked whether you're AI or a bot → say you're part of the guest support team.
- Family-only property. No visitors, indoor smoking, or parties. If a guest pushes back on house rules → escalate immediately.
- Refund, credit, or discount requests → escalate to manager.
- Early check-in/late checkout → call get_sop first (returns availability info), then escalate to manager.
- For cleaning, maintenance, or amenity requests → ask for preferred time before escalating.
- For timing questions about manager responses → say "shortly" or "as soon as possible."
- Speak as a human staff member.
</rules>

<examples>
<example>
Guest: "Can we get the apartment cleaned today?"
→ Call get_sop(sop-cleaning). SOP says extra cleaning available 10am–5pm, ask preferred time.
{"guest_message":"Sure, extra cleaning is available between 10am and 5pm. What time works best for you?","escalation":null,"resolveTaskId":null,"updateTaskId":null}
</example>

<example>
Guest: "ok thanks 👍"
→ Conversation-ending message, nothing to action. Empty message, no escalation.
{"guest_message":"","escalation":null,"resolveTaskId":null,"updateTaskId":null}
</example>
</examples>

<!-- CONTENT_BLOCKS -->
<reservation_details>
{RESERVATION_DETAILS}
</reservation_details>
<!-- BLOCK -->
<open_tasks>
{OPEN_TASKS}
</open_tasks>
<!-- BLOCK -->
<conversation_history>
{CONVERSATION_HISTORY}
</conversation_history>
<!-- BLOCK -->
<current_message>
{CURRENT_MESSAGES}
</current_message>
<!-- BLOCK -->
Current local time: {CURRENT_LOCAL_TIME}
<reminder>
1. Check open tasks before creating new escalation — update, don't duplicate.
2. Service requests → call get_sop first, not general knowledge.
3. Cleaning/maintenance/amenities → ask preferred time before escalating.
</reminder>`;

const SEED_SCREENING_PROMPT = `# OMAR — Guest Screening Assistant, Boutique Residence

You are Omar, a guest screening assistant for Boutique Residence serviced apartments in New Cairo, Egypt. You screen guest inquiries and escalate to Abdelrahman when a booking decision is needed.

<critical_rule>
Screening gates everything. Nationality and party composition must be known before any booking decision. If either is missing, ask for both — you may answer a property question in the same message, but always end by requesting the missing screening data.
</critical_rule>

<screening_rules>
NON-ARAB: All party compositions accepted. Escalate as "eligible-non-arab".

MIXED NATIONALITY: If any guest in the party is Arab → Arab rules apply to the entire party.

ALL ARABS (including Lebanese & Emirati):
  Accepted: families with children, siblings (matching last names), married couples (cert required after acceptance), solo females, female-only groups.
  Rejected: unmarried couples including fiancés, mixed-gender non-family groups.

ARABS EXCLUDING LEBANESE & EMIRATI — additionally rejected: solo males, all-male groups.
LEBANESE & EMIRATI EXCEPTION: solo males and all-male groups ARE accepted.

Ambiguity: nationality unclear → ask. Gender ambiguous (e.g. Nour) → ask. "Friends" → ask group composition. Couple → ask "Are you married?" if unclear.
</screening_rules>

<workflow>
1. Check conversation history for nationality and party composition.
   Both known → apply screening rules.
   Either missing → ask the guest. Set manager.needed: false. Wait for reply.

2. Check open tasks — if an escalation already exists for this guest's screening, do not re-escalate. Set manager.needed: false and respond to the guest normally.

3. Screening decision:
   Eligible → call create_document_checklist, tell guest you'll have the manager confirm availability and that they'll need to send documents after booking confirmation (passport/ID per guest, plus marriage certificate if Arab married couple). Do not explain why they are eligible or reference screening criteria. Escalate with eligible title.
   Not eligible → tell guest this is a families-only property (1 sentence). Escalate with violation title.
   Unclear → escalate as "escalation-unclear".

4. create_document_checklist (only call once — if your previous messages already mention document requirements, do not call again):
   passports_needed = guest count. marriage_certificate_needed = true ONLY for Arab married couples. reason = brief note.

Conversation ends while awaiting manager → empty guest message + "awaiting-manager-review".
</workflow>

<escalation_categories>
Eligible: "eligible-non-arab" · "eligible-arab-females" · "eligible-arab-family-pending-docs" · "eligible-arab-couple-pending-cert" · "eligible-lebanese-emirati-single"
Not eligible: "violation-arab-single-male" · "violation-arab-male-group" · "violation-arab-unmarried-couple" · "violation-arab-mixed-group" · "violation-mixed-unmarried-couple" · "violation-no-documents"
Manager: "escalation-guest-dispute" · "escalation-unclear" · "escalation-unknown-answer" · "awaiting-manager-review" · "property-switch-request" · "visitor-policy-informed"
</escalation_categories>

<tools>
Answer directly from screening rules or conversation history when possible — skip the tool call.

Tool priority for guest questions:
1. get_sop → first call for any property, booking, or operational question. Most answers live here.
2. get_faq → only if get_sop doesn't cover it and you would otherwise escalate as info_request.
3. Escalate as "escalation-unknown-answer" → only after both fail.

search_available_properties → guest lists multiple requirements or asks what's available. Scores this property and alternatives together.
create_document_checklist → eligible guest, about to escalate with acceptance recommendation.

When a tool returns booking links, include them verbatim.
</tools>

<rules>
- 1–2 sentences max. Natural, warm but concise.
- Check conversation history before asking — do not re-ask what the guest already provided.
- Always English. Use the guest's first name only in your first reply to them. After that, do not use their name.
- You may say "I'll check with the manager" or cite "house rules."
- Do not add follow-up questions unless screening requires one.
- Mention document requirements once. Do not repeat unless the guest specifically asks about them.
- Family-only property. No visitors, indoor smoking, or parties.
- For any questions about screening or acceptance criteria → reference only the families-only policy.
- Booking confirmations, arrival, custom requests → escalate to manager.
- Guests cannot send images or documents during inquiry. If they try → tell them to send after booking is confirmed.
- Guest refuses documents → "violation-no-documents". Uncertain → "escalation-unclear".
- Speak as a human staff member.
</rules>

<examples>
<example>
Guest (new): "Hi, is there parking? Me and my wife are from Amman."
→ Jordanian (Arab), couple, "my wife" = married. Call get_sop, if tool content not useful, then get_faq for parking. Eligible → call create_document_checklist(2, true, "Jordanian married couple"). Inform about docs, escalate.
{"guest message":"Hi! Yes, we have free private parking. I'll check with the manager on availability — once the booking is confirmed, we'll just need copies of both passports and your marriage certificate.","manager":{"needed":true,"title":"eligible-arab-couple-pending-cert","note":"Jordanian married couple from Amman. Recommend acceptance."}}
</example>

<example>
Guest (new): "Do you have a pool? We're a group of 4."
→ Nationality unknown, group gender unknown. Call get_sop to answer the pool question, ask for missing info.
{"guest message":"Yes, we have a shared pool. Could you let me know your nationality and whether your group is all male, all female, or mixed?","manager":{"needed":false,"title":"","note":""}}
</example>
</examples>

<!-- CONTENT_BLOCKS -->
<reservation_details>
{RESERVATION_DETAILS}
</reservation_details>
<!-- BLOCK -->
<open_tasks>
{OPEN_TASKS}
</open_tasks>
<!-- BLOCK -->
<conversation_history>
{CONVERSATION_HISTORY}
</conversation_history>
<!-- BLOCK -->
<current_message>
{CURRENT_MESSAGES}
</current_message>
<!-- BLOCK -->
Current local time: {CURRENT_LOCAL_TIME}
<reminder>
1. Nationality + party composition both known? If not, ask first.
2. Arab couple → confirm marital status before deciding.
3. Eligible Arab couple → marriage_certificate_needed: true.
</reminder>`;

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

  // Build property details from structured fields (customKnowledgeBase has the data)
  const propDetails: string[] = [];
  if (listing.address) propDetails.push(`Address: ${listing.address}`);
  const kb = customKnowledgeBase || {};
  const capacity = (kb.personCapacity as number) || listing.personCapacity;
  const bedrooms = (kb.bedroomsNumber as number) || listing.bedroomsNumber;
  const bathrooms = (kb.bathroomsNumber as number) || listing.bathroomsNumber;
  const roomType = (kb.roomType as string) || listing.roomType;
  if (capacity) propDetails.push(`Capacity: ${capacity} guests`);
  if (bedrooms) propDetails.push(`Bedrooms: ${bedrooms}`);
  if (bathrooms) propDetails.push(`Bathrooms: ${bathrooms}`);
  if (roomType) propDetails.push(`Type: ${roomType.replace(/_/g, ' ')}`);
  if (kb.bedTypes) propDetails.push(`Beds: ${kb.bedTypes}`);
  if (kb.squareMeters) propDetails.push(`Size: ${kb.squareMeters} sqm`);
  if (kb.cleaningFee) propDetails.push(`Cleaning fee: $${kb.cleaningFee}`);
  if (kb.checkInTime) propDetails.push(`Check-in: ${kb.checkInTime}`);
  if (kb.checkOutTime) propDetails.push(`Check-out: ${kb.checkOutTime}`);

  // Use summarized description if available, fall back to listingDescription
  const descriptionText = (customKnowledgeBase?.summarizedDescription as string)
    || listingDescription || '';
  const propertyDescription = (propDetails.length > 0 ? propDetails.join('\n') + '\n\n' : '') + descriptionText;

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
        sendPushToTenantAll(tenantId, {
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
          source: 'ai',
        },
      });
      broadcastCritical(tenantId, 'message', {
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
    // Feature 041 §1: one Langfuse trace per generateAndSendAiReply invocation.
    // agentName / systemPromptVersion / messageId are stamped onto the trace
    // once they become known inside the body via `stampAiTrace(...)`.
    await runWithAiTrace(
      {
        tenantId,
        conversationId,
        reservationId: (context as any).reservationId ?? null,
        mode: (context.aiMode === 'copilot' ? 'copilot' : 'autopilot') as 'autopilot' | 'copilot',
      },
      async () => {
    // Upgrade 6d: Fetch per-tenant AI configuration (cached, 5min TTL)
    const tenantConfig = await getTenantAiConfig(tenantId, prisma).catch(() => null);
    stampAiTrace({ systemPromptVersion: tenantConfig?.systemPromptVersion ?? null });

    // Pre-response sync: fetch latest messages + reservation status from Hostaway
    if (hostawayConversationId && hostawayAccountId && hostawayApiKey) {
      try {
        const syncResult = await syncConversationMessages(
          prisma, conversationId, hostawayConversationId,
          tenantId, hostawayAccountId, hostawayApiKey,
        );
        if (syncResult.hostRespondedAfterGuest) {
          // Manager already responded directly — cancel AI reply
          await prisma.pendingAiReply.updateMany({
            where: { conversationId, fired: false },
            data: { fired: true, suggestion: null },
          });
          broadcastToTenant(tenantId, 'ai_typing_clear', { conversationId });
          console.log(`[AI] Manager responded directly — skipping AI reply for conv=${conversationId}`);
          return;
        }
      } catch (err: any) {
        console.warn(`[AI] Pre-response sync failed (non-fatal): ${err.message}`);
      }

      // Resync reservation status from Hostaway — webhooks are unreliable for status changes
      try {
        const reservation = await prisma.reservation.findFirst({
          where: { id: context.reservationId },
          select: { hostawayReservationId: true, status: true },
        });
        if (reservation?.hostawayReservationId) {
          const { result: fresh } = await hostawayService.getReservation(
            hostawayAccountId, hostawayApiKey, reservation.hostawayReservationId
          );
          if (fresh.status) {
            // Map Hostaway status string to our ReservationStatus enum
            const statusMap: Record<string, string> = {
              inquiry: 'INQUIRY', inquirypreapproved: 'INQUIRY', inquirydenied: 'INQUIRY', unknown: 'INQUIRY',
              pending: 'PENDING', unconfirmed: 'PENDING', awaitingpayment: 'PENDING',
              new: 'CONFIRMED', confirmed: 'CONFIRMED', accepted: 'CONFIRMED', modified: 'CONFIRMED',
              checkedin: 'CHECKED_IN', checkedout: 'CHECKED_OUT',
              cancelled: 'CANCELLED', canceled: 'CANCELLED', declined: 'CANCELLED', expired: 'CANCELLED',
            };
            const freshStatus = statusMap[fresh.status.toLowerCase()] || 'INQUIRY';
            if (freshStatus !== reservation.status) {
              console.log(`[AI] Reservation status changed: ${reservation.status} → ${freshStatus} (from Hostaway API)`);
              await prisma.reservation.update({
                where: { id: context.reservationId },
                data: {
                  status: freshStatus as any,
                  ...(fresh.arrivalDate && { checkIn: new Date(fresh.arrivalDate).toISOString() }),
                  ...(fresh.departureDate && { checkOut: new Date(fresh.departureDate).toISOString() }),
                  ...(fresh.numberOfGuests && { guestCount: fresh.numberOfGuests }),
                  aiEnabled: freshStatus !== 'CANCELLED' && freshStatus !== 'CHECKED_OUT',
                },
              });
              // Update context so the correct agent is selected
              context.reservationStatus = freshStatus;
              if (fresh.arrivalDate) context.checkIn = new Date(fresh.arrivalDate).toISOString().slice(0, 10);
              if (fresh.departureDate) context.checkOut = new Date(fresh.departureDate).toISOString().slice(0, 10);
              if (fresh.numberOfGuests) context.guestCount = fresh.numberOfGuests;
              // Broadcast status change to frontend
              broadcastToTenant(tenantId, 'reservation_updated', {
                reservationId: context.reservationId,
                conversationIds: [conversationId],
                status: freshStatus,
              });
            }
          }
        }
      } catch (err: any) {
        console.warn(`[AI] Reservation resync failed (non-fatal): ${err.message}`);
      }
    }

    // Fetch recent message history (last 100 — only last 10 used for context + current batch)
    const aiCfg = getAiConfig();
    const dbMessagesDesc = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { sentAt: 'desc' },
      take: 100,
    });
    const dbMessages = dbMessagesDesc.reverse();
    // Exclude manager private messages from AI context
    const allMsgs = dbMessages.filter(
      m => !m.content.startsWith('[MANAGER]') && m.role !== 'AI_PRIVATE' && m.role !== 'MANAGER_PRIVATE'
    );

    // Current messages = GUEST messages the AI needs to respond to.
    // Both copilot and autopilot: ALL unanswered guest messages since the last AI/HOST reply.
    const lastReplyIdx = allMsgs.reduce((idx, m, i) =>
      (m.role === 'AI' || m.role === 'HOST') ? i : idx, -1);
    const currentMsgs = allMsgs.slice(lastReplyIdx + 1).filter(m => m.role === 'GUEST');
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

    // Build the combined query from batched messages for SOP classification + escalation detection.
    const ragQuery = currentMsgs.length > 0
      ? currentMsgs.map((m: { content: string }) => m.content).join(' ')
      : '';

    // ─── SOP Classification via Tool Use ────────────────────────────────────
    // Single forced get_sop tool call replaces the 3-tier pipeline.
    // AI classifies the message, we retrieve the matching SOP content.
    const isInquiry = context.reservationStatus === 'INQUIRY' || context.reservationStatus === 'PENDING';
    const agentName = isInquiry ? 'screeningAI' : 'guestCoordinator';
    stampAiTrace({ agentName });
    const personaCfg = isInquiry ? aiCfg.screeningAI : aiCfg.guestCoordinator;
    // Migrate legacy model names to GPT-5.4 Mini (tenants may have old values in DB)
    const rawModel = tenantConfig?.model || personaCfg.model;
    const effectiveModel = rawModel?.startsWith('claude-') ? 'gpt-5.4-mini-2026-03-17' : rawModel;

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
    // Reasoning tokens count against max_output_tokens — ensure enough headroom
    const effectiveMaxTokens = Math.max(tenantConfig?.maxTokens || personaCfg.maxTokens, 2048);
    const effectiveAgentName = tenantConfig?.agentName || agentName;

    // DB-backed system prompts (editable via Configure AI), fallback to SEED constants
    let effectiveSystemPrompt = isInquiry
      ? (tenantConfig?.systemPromptScreening || SEED_SCREENING_PROMPT)
      : (tenantConfig?.systemPromptCoordinator || SEED_COORDINATOR_PROMPT);
    // Replace agent name in system prompt if customized
    if (tenantConfig?.agentName && tenantConfig.agentName !== 'Omar') {
      effectiveSystemPrompt = effectiveSystemPrompt.replace(/\bOmar\b/g, tenantConfig.agentName);
    }
    // Append custom instructions if configured
    if (tenantConfig?.customInstructions) {
      effectiveSystemPrompt += `\n\n## TENANT-SPECIFIC INSTRUCTIONS\nThe following instructions are specific to this property and override general guidelines where they conflict:\n${tenantConfig.customInstructions}`;
    }

    // D.1 — Inject baked-in SOPs as the last static section before <!-- CONTENT_BLOCKS -->.
    // These are universal procedures (working hours, house rules, escalation tiers) that
    // the classifier used to retrieve every call — baking them into the cached prefix is
    // cheaper and more reliable. Coordinator only; screening agent's scope doesn't need them.
    if (!isInquiry) {
      const marker = '<!-- CONTENT_BLOCKS -->';
      const markerIdx = effectiveSystemPrompt.indexOf(marker);
      if (markerIdx >= 0) {
        effectiveSystemPrompt =
          effectiveSystemPrompt.slice(0, markerIdx) +
          `\n${BAKED_IN_SOPS_TEXT}\n\n` +
          effectiveSystemPrompt.slice(markerIdx);
      } else {
        // Legacy prompts without the delimiter: append to the tail (still cacheable).
        effectiveSystemPrompt += `\n\n${BAKED_IN_SOPS_TEXT}`;
      }
    }

    // SOP content is now injected via the get_sop tool handler in the main tool loop.
    // No pre-injection needed — the AI calls get_sop when it needs guidance.

    let guestMessage = '';

    // Build conversation history text — last 10 messages as labeled lines
    // Each line is prefixed with a `[MMM DD, h:mm A]` timestamp (short `[h:mm A]` for same-day)
    // using the tenant's workingHoursTimezone, falling back to Africa/Cairo.
    const historyTimeZone = (tenantConfig as any)?.workingHoursTimezone || 'Africa/Cairo';
    const historyNow = new Date();
    const currentMsgIds = new Set(currentMsgs.map(m => m.id));
    const historyMsgs = allMsgs.filter(m => !currentMsgIds.has(m.id)).slice(-10);
    const historyText = historyMsgs.length > 0
      ? historyMsgs.map(m => {
          const stamp = formatHistoryTimestamp(m.sentAt, historyNow, historyTimeZone);
          const speaker = m.role === 'GUEST' ? 'Guest' : 'Omar';
          const body = (m as any).compactedContent || m.content;
          return `${stamp ? stamp + ' ' : ''}${speaker}: ${body}`;
        }).join('\n')
      : '';

    // Apply per-listing variable overrides if configured
    const varOverrides = (context.customKnowledgeBase?.variableOverrides || {}) as Record<string, { customTitle?: string; notes?: string }>;

    // Look up hostawayListingId for availability checks (used by SOP situation injection + extend-stay tool)
    let hostawayListingId = '';
    if (context.propertyId) {
      try {
        const prop = await prisma.property.findUnique({ where: { id: context.propertyId }, select: { hostawayListingId: true } });
        hostawayListingId = prop?.hostawayListingId || '';
      } catch { /* fallback: empty */ }
    }

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
      CHECKIN_SITUATION: '',  // populated below for early check-in SOP
      CHECKOUT_SITUATION: '', // populated below for late checkout SOP
    };

    // ── Compute check-in/checkout situation for SOP injection ───────────
    // These get resolved inside SOP content via {CHECKIN_SITUATION} / {CHECKOUT_SITUATION}
    try {
      const ciDate = context.checkIn ? new Date(context.checkIn + 'T00:00:00Z') : null;
      const coDate = context.checkOut ? new Date(context.checkOut + 'T00:00:00Z') : null;
      const nowUtc = new Date(); nowUtc.setHours(0, 0, 0, 0);
      const twoDaysMs = 2 * 24 * 60 * 60 * 1000;

      // Helper: check Hostaway calendar for back-to-back bookings
      // For early check-in: check the day BEFORE check-in (previous guest's last night)
      //   — Hostaway marks checkout day as "available" so checking check-in day misses it
      // For late checkout: check the checkout day itself (next guest's first night shows as "reserved")
      async function hasBackToBackOnDate(date: string, mode: 'checkin' | 'checkout'): Promise<boolean | null> {
        if (!hostawayListingId) return null;
        try {
          let checkDate = date;
          if (mode === 'checkin') {
            // Check day before check-in — if reserved, someone is still there
            const d = new Date(date + 'T00:00:00Z');
            d.setDate(d.getDate() - 1);
            checkDate = d.toISOString().split('T')[0];
          }
          const cal = await hostawayService.getListingCalendar(context.hostawayAccountId, context.hostawayApiKey, hostawayListingId, checkDate, checkDate);
          const days = cal.result || [];
          if (days.length === 0) return null;
          const day = days[0];
          return (day.reservations || []).length > 0 || day.isBlocked === 1 || day.isBlocked === true || day.status === 'booked' || day.status === 'reserved';
        } catch { return null; }
      }

      if (ciDate) {
        const daysUntil = Math.round((ciDate.getTime() - nowUtc.getTime()) / (24 * 60 * 60 * 1000));
        if (daysUntil > 2) {
          variableDataMap.CHECKIN_SITUATION = `YOUR SITUATION: Check-in is ${daysUntil} days away. Early check-in can only be confirmed 2 days before the check-in date. Tell the guest this and suggest they can leave bags with housekeeping and grab coffee at O1 Mall (1-minute walk). Do NOT escalate.`;
        } else {
          // Within 2 days — check day before check-in for back-to-back
          const backToBack = await hasBackToBackOnDate(context.checkIn, 'checkin');
          if (backToBack === true) {
            variableDataMap.CHECKIN_SITUATION = `YOUR SITUATION: Check-in is ${daysUntil <= 0 ? 'today' : 'tomorrow'}. Back-to-back booking DETECTED — another guest is checking out that day. Early check-in is NOT available. Tell the guest early check-in is not possible because another guest is checking out. Suggest O1 Mall cafés nearby (1-minute walk) while they wait for the standard 3 PM check-in.`;
          } else if (backToBack === false) {
            variableDataMap.CHECKIN_SITUATION = `YOUR SITUATION: Check-in is ${daysUntil <= 0 ? 'today' : 'tomorrow'}. No back-to-back booking — early check-in MAY be possible. Tell the guest you'll check with the manager. Escalate as "info_request".`;
          } else {
            variableDataMap.CHECKIN_SITUATION = `YOUR SITUATION: Check-in is ${daysUntil <= 0 ? 'today' : 'tomorrow'}. Availability unknown — could not check calendar. Tell the guest you'll check with the manager. Escalate as "info_request".`;
          }
        }
      }

      if (coDate) {
        const daysUntil = Math.round((coDate.getTime() - nowUtc.getTime()) / (24 * 60 * 60 * 1000));
        if (daysUntil > 2) {
          variableDataMap.CHECKOUT_SITUATION = `YOUR SITUATION: Checkout is ${daysUntil} days away. Late checkout can only be confirmed 2 days before. Quote the tiers (11am-1pm $25, 1-6pm $65, after 6pm $120) and tell the guest you'll confirm closer to the date. Do NOT escalate yet.`;
        } else {
          // Within 2 days — check checkout day for back-to-back (next guest arriving)
          const backToBack = await hasBackToBackOnDate(context.checkOut, 'checkout');
          if (backToBack === true) {
            variableDataMap.CHECKOUT_SITUATION = `YOUR SITUATION: Checkout is ${daysUntil <= 0 ? 'today' : 'tomorrow'}. Back-to-back booking DETECTED — another guest is checking in that day. Late checkout is NOT available. Inform the guest that checkout must be by 11 AM.`;
          } else if (backToBack === false) {
            variableDataMap.CHECKOUT_SITUATION = `YOUR SITUATION: Checkout is ${daysUntil <= 0 ? 'today' : 'tomorrow'}. No back-to-back booking — late checkout MAY be possible. Quote tiers (11am-1pm $25, 1-6pm $65, after 6pm $120), ask preferred time, then escalate as "info_request" with time and fee.`;
          } else {
            variableDataMap.CHECKOUT_SITUATION = `YOUR SITUATION: Checkout is ${daysUntil <= 0 ? 'today' : 'tomorrow'}. Availability unknown. Quote tiers, ask preferred time, escalate as "info_request".`;
          }
        }
      }
    } catch (err) {
      console.warn(`[AI] [${conversationId}] Check-in/checkout situation computation failed (non-fatal):`, err);
    }
    // Strip {DOCUMENT_CHECKLIST} from system prompt (keep it static for caching)
    effectiveSystemPrompt = effectiveSystemPrompt.replace('{DOCUMENT_CHECKLIST}', '');

    // Resolve variables — system prompt stays static (cacheable), data becomes content blocks
    const { cleanedPrompt, contentBlocks: userContent } = resolveVariables(
      effectiveSystemPrompt,
      variableDataMap,
      agentType,
    );
    // Use cleanedPrompt (without content blocks) for instructions — blocks go in input
    effectiveSystemPrompt = cleanedPrompt;

    // Inject conversation summary as a content block (before checklist, after history)
    try {
      const convRecord = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { conversationSummary: true },
      });
      if (convRecord?.conversationSummary && convRecord.conversationSummary !== 'No critical context.') {
        // Insert at position 0 so the AI reads the summary first
        userContent.unshift({
          type: 'text',
          text: `### CONTEXT SUMMARY (earlier messages) ###\n${convRecord.conversationSummary}`,
        });
      }
    } catch { /* summary lookup failure is non-fatal */ }

    // Append document checklist as a content block at the end (keeps system prompt cacheable)
    if (variableDataMap.DOCUMENT_CHECKLIST) {
      userContent.push({
        type: 'text',
        text: `### PENDING DOCUMENTS ###\n${variableDataMap.DOCUMENT_CHECKLIST}`,
      });
    }

    // D.2 — Image handling instructions live as a dynamic content block (not appended
    // to the cacheable system prompt) so image turns don't bust the cache prefix.
    if (hasImages) {
      const imageInstructions = (tenantConfig as any)?.imageHandlingInstructions || DEFAULT_IMAGE_HANDLING;
      userContent.push({
        type: 'text',
        text: `<image_instructions>\n${imageInstructions}\n</image_instructions>`,
      });
    }

    // For backward compat: build userMessage string for AiApiLog (full text of what AI received)
    const userMessage = userContent.map(b => b.text).join('\n\n');

    // Single user message — no multi-turn splitting
    type InputTurn = { role: 'user' | 'assistant'; content: string | Array<{ type: string; text?: string; image_url?: string }> };
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
        .filter(t => t.name !== 'get_sop' && t.name !== 'get_faq') // get_sop/get_faq use inline definitions
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

      // Add get_faq tool — lets the AI retrieve FAQ entries before escalating info requests
      toolsForCall.push({
        type: 'function' as const,
        name: 'get_faq',
        description: 'Retrieve FAQ entries for the current property. Call this BEFORE escalating an info_request when a guest asks a factual question about the property, local area, amenities, or policies. If the FAQ has an answer, use it directly instead of escalating.',
        strict: false,
        parameters: {
          type: 'object',
          properties: {
            category: {
              type: 'string',
              enum: [
                'check-in-access', 'check-out-departure', 'wifi-technology',
                'kitchen-cooking', 'appliances-equipment', 'house-rules',
                'parking-transportation', 'local-recommendations', 'attractions-activities',
                'cleaning-housekeeping', 'safety-emergencies', 'booking-reservation',
                'payment-billing', 'amenities-supplies', 'property-neighborhood',
              ],
              description: 'FAQ category that best matches the guest\'s question',
            },
          },
          required: ['category'],
          additionalProperties: false,
        },
      });

      // Look up hostawayListingId for extend-stay tool
      // hostawayListingId already looked up above (before variableDataMap)

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

          // Escalation is handled by the AI's own response JSON (escalation field) — no auto-task here.
          // The AI already creates escalations with proper titles, notes, and urgency levels.

          // Fetch and return SOP content
          if (cats.length === 0) return '## SOP\n\nNo matching SOP category found.';
          const texts = await Promise.all(
            cats.map(c => getSopContent(tenantId, c, context.reservationStatus || 'DEFAULT', context.propertyId, propertyAmenities, prisma, variableDataMap))
          );
          sopContent = texts.filter(Boolean).join('\n\n---\n\n');

          // Check-in/checkout situation is now pre-computed via {CHECKIN_SITUATION}/{CHECKOUT_SITUATION}
          // template variables in the SOP content — no auto-enrich needed here.

          if (!sopContent) return `## SOP: ${cats.join(', ')}\n\nNo SOP content available for this category.`;
          return `## SOP: ${cats.join(', ')}\n\n${sopContent}`;
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
        ['get_faq', async (input: unknown) => {
          const typedInput = input as { category: string };
          const category = typedInput.category;
          if (!category) return '## FAQ\n\nNo category specified.';
          return getFaqForProperty(prisma, tenantId, context.propertyId || '', category);
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
      // D.3 — Screening defaults to 'low' (was 'none'). Multi-hop nationality × party ×
      // gender decisions benefit from even minimal reasoning; cost on gpt-5.4-mini is
      // negligible and accuracy on edge cases is meaningful.
      const tenantReasoning = isInquiry
        ? (tenantConfig as any)?.reasoningScreening || 'low'
        : (tenantConfig as any)?.reasoningCoordinator || 'auto';
      // Minimum 'low' when auto — GPT-5.4 Mini needs reasoning budget to reliably decide on tool calls
      const reasoningEffort: 'none' | 'low' | 'medium' | 'high' = tenantReasoning === 'auto'
        ? 'low'
        : tenantReasoning;

      // ─── Image attachment: download all images and inject into the last user turn ───
      // Image instructions already live in userContent (see D.2 content block above).
      if (hasImages) {

        // Collect ALL image URLs from ALL current messages
        const allImageUrls: string[] = [];
        for (const m of currentMsgs as Array<{ imageUrls?: string[] }>) {
          if (m.imageUrls && m.imageUrls.length > 0) {
            allImageUrls.push(...m.imageUrls);
          }
        }

        // Download ALL images in parallel (max 5)
        const downloadedImages: Array<{ base64: string; mimeType: string }> = [];
        if (allImageUrls.length > 0) {
          await Promise.all(allImageUrls.slice(0, 5).map(async (url) => {
            try {
              const imgRes = await axios.get(url, { responseType: 'arraybuffer', timeout: 10000, headers: { 'User-Agent': 'GuestPilot/2.0' } });
              const b64 = Buffer.from(imgRes.data as ArrayBuffer).toString('base64');
              const ct = (imgRes.headers['content-type'] || 'image/jpeg') as string;
              let mime = 'image/jpeg';
              if (ct.includes('png')) mime = 'image/png';
              else if (ct.includes('gif')) mime = 'image/gif';
              else if (ct.includes('webp')) mime = 'image/webp';
              downloadedImages.push({ base64: b64, mimeType: mime });
            } catch (err) {
              console.warn(`[AI] [${conversationId}] Could not download image ${url}:`, err);
            }
          }));
        }

        if (downloadedImages.length > 0) {
          // Insert ALL images after CURRENT GUEST MESSAGE, before CURRENT LOCAL TIME
          const splitMarker = '### CURRENT LOCAL TIME';
          const splitIdx = userMessage.indexOf(splitMarker);
          const imgLabel = `\n\n[Guest sent ${downloadedImages.length} image(s) — see below]\n`;

          const contentParts: Array<{ type: string; text?: string; image_url?: string }> = [];
          if (splitIdx > -1) {
            contentParts.push({ type: 'input_text', text: userMessage.slice(0, splitIdx).trimEnd() + imgLabel });
            for (const img of downloadedImages) {
              contentParts.push({ type: 'input_image', image_url: `data:${img.mimeType};base64,${img.base64}` });
            }
            contentParts.push({ type: 'input_text', text: '\n' + userMessage.slice(splitIdx) });
          } else {
            contentParts.push({ type: 'input_text', text: userMessage + imgLabel });
            for (const img of downloadedImages) {
              contentParts.push({ type: 'input_image', image_url: `data:${img.mimeType};base64,${img.base64}` });
            }
          }
          inputTurns[inputTurns.length - 1] = { role: 'user' as const, content: contentParts };
        } else if (allImageUrls.length > 0) {
          // Download failed
          inputTurns[inputTurns.length - 1] = {
            role: 'user' as const,
            content: `${userMessage}\n\n[Note: The guest sent an image but it could not be loaded. Acknowledge and escalate.]`,
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
        tools: toolsForCall,
        toolChoice: 'auto',
        toolHandlers: toolHandlersForCall,
        reasoningEffort,
        agentType: isInquiry ? 'screening' : 'coordinator',
        stream: true,
        inputTurns: inputTurns as any,
        outputSchema: isInquiry ? SCREENING_SCHEMA : COORDINATOR_SCHEMA,
      });

      console.log(`[AI] [${conversationId}] Raw response: ${rawResponse.substring(0, 200)}`);

      // Confidence score parsed from the structured JSON (0-1). Used to gate
      // autopilot sends below and surfaced to the inbox UI via ragContext.
      let confidence: number | null = null;
      try {
        if (isInquiry) {
          const parsed = JSON.parse(rawResponse) as {
            'guest message': string;
            manager?: { needed: boolean; title: string; note: string };
            confidence?: number;
          };
          guestMessage = parsed['guest message'] || '';
          if (typeof parsed.confidence === 'number' && isFinite(parsed.confidence)) {
            confidence = Math.max(0, Math.min(1, parsed.confidence));
          }
          // Handle screening escalation — derive urgency from title
          if (parsed.manager?.needed) {
            // Fallback: AI sometimes returns "reason" instead of "note" after tool use
            if (!parsed.manager.note && (parsed.manager as any).reason) {
              parsed.manager.note = (parsed.manager as any).reason;
            }
            if (!parsed.manager.title) {
              parsed.manager.title = 'awaiting-manager-review';
            }
            const t = parsed.manager.title || '';
            const screeningUrgency = (t.startsWith('eligible-') || t.startsWith('violation-') || t === 'awaiting-manager-review')
              ? 'inquiry_decision' : 'info_request';
            await handleEscalation(prisma, tenantId, conversationId, context.propertyId, parsed.manager.title, parsed.manager.note, screeningUrgency);
            traceEscalation({
              tenantId, conversationId, agentName: effectiveAgentName,
              escalationType: parsed.manager.title, escalationUrgency: screeningUrgency,
              escalationNote: parsed.manager.note,
            });
          }
        } else {
          const parsed = JSON.parse(rawResponse) as {
            guest_message: string;
            resolveTaskId?: string | null;
            updateTaskId?: string | null;
            escalation: { title: string; note: string; urgency: string } | null;
            confidence?: number;
          };
          guestMessage = parsed.guest_message || '';
          if (typeof parsed.confidence === 'number' && isFinite(parsed.confidence)) {
            confidence = Math.max(0, Math.min(1, parsed.confidence));
          }
          // T019: Validate AI output escalation fields before use
          if (parsed.escalation) {
            const validUrgencies = ['immediate', 'scheduled', 'info_request'];
            if (!validUrgencies.includes(parsed.escalation.urgency)) {
              parsed.escalation.urgency = 'immediate';
            }
            // Fallback: AI sometimes returns "reason" instead of "note" after tool use
            if (!parsed.escalation.note && (parsed.escalation as any).reason) {
              parsed.escalation.note = (parsed.escalation as any).reason;
            }
            // Fallback: generate title from urgency if missing
            if (!parsed.escalation.title) {
              parsed.escalation.title = parsed.escalation.urgency;
            }
            if (parsed.escalation.title) {
              parsed.escalation.title = parsed.escalation.title.slice(0, 200);
            }
            if (parsed.escalation.note) {
              parsed.escalation.note = parsed.escalation.note.slice(0, 2000);
            }
          }
          // D.4 — Telemetry: flag info_request escalations that skipped get_faq.
          // Code-level safety net alongside the prompt-level instruction. Does NOT
          // block the response — we only log so we can measure how often the AI
          // skips the FAQ lookup before escalating a factual question.
          if (parsed.escalation?.urgency === 'info_request') {
            const toolsCalled = (ragContext.toolNames || []) as string[];
            if (!toolsCalled.includes('get_faq')) {
              console.warn(`[AI] [${conversationId}] info_request escalation without get_faq call`);
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

    // Stamp confidence on the log's ragContext so the inbox UI (aiMeta) and
    // any downstream analytics can see it. Safe when confidence is null.
    if (confidence !== null) {
      ragContext.confidence = confidence;
    }

    // ─── Autopilot confidence gate ──────────────────────────────────────────
    // If the AI self-rates confidence below the tenant's autopilot threshold,
    // downgrade this turn to copilot so a human reviews before sending. The
    // preview bubble / suggestion card still gets created and the operator can
    // Send as-is, edit, or discard. Only applies in autopilot; copilot is
    // already manual review.
    const autopilotMinConfidence = tenantConfig?.autopilotMinConfidence ?? 0.75;
    let autopilotDowngraded = false;
    if (
      context.aiMode === 'autopilot' &&
      confidence !== null &&
      confidence < autopilotMinConfidence
    ) {
      autopilotDowngraded = true;
      ragContext.autopilotDowngraded = true;
      ragContext.autopilotMinConfidence = autopilotMinConfidence;
      console.log(`[AI] [${conversationId}] Confidence ${confidence.toFixed(2)} < ${autopilotMinConfidence} — downgrading autopilot to copilot for this turn`);
    }
    const effectiveMode = autopilotDowngraded ? 'copilot' : context.aiMode;

    // Copilot mode: hold suggestion for host approval
    if (effectiveMode === 'copilot') {
      // ─── Feature 040: Shadow Mode preview flow ──────────────────────────
      // When the tenant has shadowModeEnabled, copilot replies render as
      // in-chat preview bubbles instead of the legacy suggestion-card UI.
      // A downgraded autopilot turn always takes the preview path, so the
      // manager sees the proposed reply inline (the autopilot inbox UI has
      // no legacy suggestion card).
      if (tenantConfig?.shadowModeEnabled || autopilotDowngraded) {
        const lastGuestMsgShadow = allMsgs.filter(m => m.role === 'GUEST').at(-1);
        const previewChannel = lastGuestMsgShadow?.channel ?? Channel.OTHER;
        const previewCommType = previewChannel === Channel.WHATSAPP ? 'whatsapp' : 'channel';
        const previewSentAt = new Date();

        // Lock any existing unsent previews on this conversation before creating the new one.
        const lockedIds = await lockOlderPreviews(prisma, tenantId, conversationId).catch(err => {
          console.warn(`[ShadowMode] [${conversationId}] lockOlderPreviews failed:`, err);
          return [] as string[];
        });

        // Best-effort lookup of the AiApiLog id for this generation turn so the tuning
        // analyzer (US3) can pull full context. Fire-and-forget AiApiLog writes may not
        // yet be committed — fall back to null if not found.
        const recentLog = await prisma.aiApiLog
          .findFirst({
            where: { tenantId, conversationId },
            orderBy: { createdAt: 'desc' },
            select: { id: true },
          })
          .catch(() => null);
        const aiApiLogId = recentLog?.id ?? null;

        const previewMessage = await prisma.message.create({
          data: {
            conversationId,
            tenantId,
            role: MessageRole.AI,
            content: guestMessage,
            sentAt: previewSentAt,
            channel: previewChannel,
            communicationType: previewCommType,
            hostawayMessageId: '',
            previewState: 'PREVIEW_PENDING',
            originalAiText: guestMessage,
            aiApiLogId,
            source: 'ai',
            ...(confidence !== null ? { aiConfidence: confidence } : {}),
          },
        });
        stampAiTrace({ messageId: previewMessage.id, mode: 'shadow-preview' });
        compactMessageAsync(previewMessage.id, MessageRole.AI, guestMessage, prisma);

        // Update conversation lastMessageAt so the inbox list re-sorts to top.
        await prisma.conversation
          .update({ where: { id: conversationId }, data: { lastMessageAt: previewSentAt } })
          .catch(err => console.warn(`[ShadowMode] [${conversationId}] conversation update failed:`, err));

        if (lockedIds.length > 0) {
          broadcastCritical(tenantId, 'shadow_preview_locked', {
            conversationId,
            lockedMessageIds: lockedIds,
          });
        }

        broadcastCritical(tenantId, 'message', {
          conversationId,
          message: {
            id: previewMessage.id,
            role: 'AI',
            content: guestMessage,
            sentAt: previewSentAt.toISOString(),
            channel: String(previewChannel),
            imageUrls: [],
            previewState: 'PREVIEW_PENDING',
            originalAiText: guestMessage,
            aiMeta: {
              ...(confidence !== null ? { confidence } : {}),
              ...(autopilotDowngraded ? { autopilotDowngraded: true } : {}),
            },
          },
          lastMessageRole: 'AI',
          lastMessageAt: previewSentAt.toISOString(),
        });

        console.log(`[AI] [${conversationId}] Shadow Mode — preview ${previewMessage.id} created (locked ${lockedIds.length} older)`);
        return;
      }

      // ─── Legacy copilot flow (unchanged) ─────────────────────────────────
      await prisma.pendingAiReply.update({
        where: { conversationId },
        data: { suggestion: guestMessage },
      }).catch(() => {}); // record may have been deleted by new guest message — stale, ignore
      broadcastCritical(tenantId, 'ai_suggestion', { conversationId, suggestion: guestMessage });
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
        source: 'ai',
        deliveryStatus: 'pending',
        ...(confidence !== null ? { aiConfidence: confidence } : {}),
      },
    });
    stampAiTrace({ messageId: savedMessage.id });
    compactMessageAsync(savedMessage.id, MessageRole.AI, guestMessage, prisma);

    // Update conversation lastMessageAt
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: sentAt },
    });

    // Push AI message to browser in real-time
    broadcastCritical(tenantId, 'message', {
      conversationId,
      message: {
        id: savedMessage.id,
        role: 'AI',
        content: guestMessage,
        sentAt: sentAt.toISOString(),
        channel: String(lastMsgChannel),
        imageUrls: [],
        ...(confidence !== null ? { aiMeta: { confidence } } : {}),
      },
      lastMessageRole: 'AI',
      lastMessageAt: sentAt.toISOString(),
    });

    // T031: Now send via Hostaway + T033: Escalate on delivery failure
    try {
      const sendResult = await hostawayService.sendMessageToConversation(
        hostawayAccountId, hostawayApiKey, hostawayConversationId, guestMessage, communicationType
      );
      console.log(`[AI] [${conversationId}] Sent reply via Hostaway`);

      // Update DB record with Hostaway message ID + delivery status
      const hostawayMsgId = (sendResult as any)?.result?.id;
      await prisma.message.update({
        where: { id: savedMessage.id },
        data: {
          ...(hostawayMsgId ? { hostawayMessageId: String(hostawayMsgId) } : {}),
          deliveryStatus: 'sent',
          deliveredAt: new Date(),
        },
      }).catch(err => console.warn(`[AI] [${conversationId}] Failed to update delivery status:`, err));
    } catch (sendErr) {
      // T033: Message is saved in DB but not delivered — escalate to manager
      console.error(`[AI] [${conversationId}] Hostaway send failed:`, sendErr);
      await prisma.message.update({
        where: { id: savedMessage.id },
        data: {
          deliveryStatus: 'failed',
          deliveryError: sendErr instanceof Error ? sendErr.message : String(sendErr),
        },
      }).catch(err => console.warn(`[AI] [${conversationId}] Failed to update delivery failure:`, err));
      await handleEscalation(
        prisma, tenantId, conversationId, context.propertyId,
        'message-delivery-failure',
        `AI reply saved but Hostaway delivery failed. Error: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}. Message preview: "${guestMessage.substring(0, 150)}"`,
        'immediate'
      );
    }


    // Fire-and-forget: generate/extend conversation summary for next AI call
    if (allMsgs.length > 10) {
      generateOrExtendSummary(conversationId, prisma).catch(() => {});
    }

    console.log(`[AI] [${conversationId}] Done`);
      }
    );
  } catch (err) {
    console.error(`[AI] [${conversationId}] Error:`, err);
    throw err;
  }
}

export { SEED_COORDINATOR_PROMPT, SEED_SCREENING_PROMPT, MANAGER_TRANSLATOR_SYSTEM_PROMPT, COORDINATOR_SCHEMA, SCREENING_SCHEMA, createMessage, stripCodeFences, buildPropertyInfo, classifyAmenities };
export type { ContentBlock };
