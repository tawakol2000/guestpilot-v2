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
import { traceAiCall, traceEscalation } from './observability.service';
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
import { callWebhook } from './webhook-tool.service';
import { sendPushToTenant } from './push.service';
import { generateOrExtendSummary } from './summary.service';
import { syncConversationMessages } from './message-sync.service';

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
      reasoning: { type: 'string', description: 'Internal reasoning: what the guest is asking, which SOP applies, what path to take, what the right response is. Under 80 words. Not shown to guest.' },
      action: { type: 'string', enum: ['reply', 'ask', 'offer', 'escalate', 'none'], description: 'Discrete action: reply=direct answer, ask=clarifying question, offer=propose alternative, escalate=create escalation, none=conversation-ending acknowledgment with empty guest_message.' },
      sop_step: { type: ['string', 'null'] as any, description: 'SOP path taken, format {sop_name}:{path_identifier}. Example: cleaning_checked_in:path_a_awaiting_time. Null if no SOP consulted.' },
      guest_message: { type: 'string', description: 'Reply to the guest. Empty string for action=none.' },
      escalation: {
        type: ['object', 'null'] as any,
        description: 'Required when action=escalate. Null for all other actions.',
        properties: {
          title: { type: 'string', description: 'kebab-case slug, max 6 words' },
          note: { type: 'string', description: 'Structured note: Guest: [name, unit] / Situation: [1 sentence] / Guest wants: [verbatim] / Context: [2-3 facts] / Suggested action: [recommendation] / Urgency reason: [why this level]' },
          urgency: { type: 'string', enum: ['immediate', 'scheduled', 'info_request'] },
        },
        required: ['title', 'note', 'urgency'],
        additionalProperties: false,
      },
      resolveTaskId: { type: ['string', 'null'] as any, description: 'Task ID from open tasks when guest confirms issue resolved' },
      updateTaskId: { type: ['string', 'null'] as any, description: 'Task ID from open tasks when adding new details to existing escalation' },
    },
    required: ['reasoning', 'action', 'sop_step', 'guest_message', 'escalation', 'resolveTaskId', 'updateTaskId'],
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
      reasoning: { type: 'string', description: 'Internal thinking: what the guest asked, what screening info we have, what\'s missing, which path applies, what action to take. Under 80 words. Not shown to guest.' },
      nationality_known: { type: 'boolean', description: 'True if guest nationality is clearly stated in conversation history (any language — English, Arabic, Arabizi). Inference from names alone is NOT enough. False if unknown or ambiguous.' },
      composition_known: { type: 'boolean', description: 'True if party composition is clearly stated: number of guests AND their relationship (family, couple, siblings, solo, group with gender). "We are 4 people" alone is false. "Me, my wife and 2 kids" is true.' },
      action: { type: 'string', enum: ['reply', 'ask', 'screen_eligible', 'screen_violation', 'escalate_info_request', 'escalate_unclear', 'awaiting_manager'], description: 'reply=direct answer. ask=clarifying/screening question. screen_eligible=passes screening. screen_violation=fails screening. escalate_info_request=needs manager info. escalate_unclear=ambiguous screening. awaiting_manager=waiting for manager decision, empty guest_message.' },
      sop_step: { type: ['string', 'null'] as any, description: 'Path taken, format screening:{path_id} or {sop_name}:{path_id}. Null if no specific path followed.' },
      guest_message: { type: 'string', description: 'Reply to the guest. Empty string only when action=awaiting_manager.' },
      manager: {
        type: 'object',
        description: 'Manager escalation. needed=false for reply and ask. needed=true for all other actions.',
        properties: {
          needed: { type: 'boolean', description: 'true when manager action needed. false for reply and ask.' },
          title: { type: 'string', description: 'Kebab-case title from fixed vocabulary. Empty when needed=false.' },
          note: { type: 'string', description: 'Details in English: nationality, party composition, reasoning, recommendation. Empty when needed=false.' },
        },
        required: ['needed', 'title', 'note'],
        additionalProperties: false,
      },
    },
    required: ['reasoning', 'nationality_known', 'composition_known', 'action', 'sop_step', 'guest_message', 'manager'],
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

        // Log tools to ragContext
        if (options?.ragContext) {
          options.ragContext.toolUsed = true;
          if (!options.ragContext.toolNames) options.ragContext.toolNames = [];
          options.ragContext.toolNames.push(fnCall.name);
          // Per-tool details array for AI Logs
          if (!options.ragContext.tools) options.ragContext.tools = [];
          let parsedInput: any;
          try { parsedInput = JSON.parse(fnCall.arguments); } catch { parsedInput = fnCall.arguments; }
          let parsedResults: any;
          try { parsedResults = JSON.parse(toolResultContent); } catch { parsedResults = toolResultContent; }
          options.ragContext.tools.push({
            name: fnCall.name,
            input: parsedInput,
            results: parsedResults,
            durationMs: toolDurationMs,
          });
          // Keep first tool in toolName for backward compat
          if (!options.ragContext.toolName) {
            options.ragContext.toolName = fnCall.name;
            options.ragContext.toolInput = parsedInput;
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

You are Omar, Lead Guest Coordinator for Boutique Residence — serviced apartments in New Cairo, Egypt. Your manager is Abdelrahman. You handle communication with confirmed and checked-in guests across WhatsApp, Airbnb, Booking.com, and direct channels.

Your objective is to resolve guest needs in as few messages as possible while the guest feels heard, informed, and respected. Every response must either (a) fully answer the guest, (b) ask one clarifying question, or (c) acknowledge and escalate. Nothing in between.

## Operating rules (these apply to every response)

Always answer from context. Use only information from injected reservation details, pre-computed context variables, conversation history, SOP content, and tool results. When information is missing, say so and escalate as info_request.
Always preserve the family-only policy. Only immediate family members are permitted as visitors. Pushback escalates immediately.
Always refer financial decisions to the manager. Refunds, discounts, credits, and payment authorizations are the manager's decision.
Always use non-committal timing language. Use "shortly" or "within the hour" rather than specific times.
Always escalate early check-in and late checkout requests. These require manager approval.
Always treat safety as the highest priority. Safety overrides tone, length, and SOP procedures.
Stay in role as Omar. Never mention AI, automation, systems, databases, or any staff except "the manager".

<grounding>
- Only answer from reservation details, conversation history, tool results, and retrieved SOPs/FAQs. If information isn't available from these sources, you don't know it — don't guess.
- Conversation history is authoritative — never ask for information the guest already provided.
- When you can't verify something the guest needs, say so and escalate as info_request.
</grounding>

## Output contract

Return JSON matching the enforced schema. Fill reasoning FIRST — think before responding.

- **reasoning** (mandatory, first) — internal thinking: what's asked, what context you have, which SOP applies, what path to take. Under 80 words. Not shown to guest.
- **action** — the discrete action you're taking: reply, ask, offer, escalate, or none.
- **sop_step** — which SOP path you followed, format {sop_name}:{path_id}. Null if no SOP consulted.
- **guest_message** — your reply. Empty string for action=none.
- **escalation** — required when action=escalate. Null for all other actions. Contains {title, note, urgency}.
- **resolveTaskId** — open task ID when the guest confirms an existing issue is resolved.
- **updateTaskId** — open task ID when adding details to an existing escalation instead of creating a duplicate.

## How to read SOPs and produce output

When get_sop returns SOP content, it contains:
- A description of what the SOP covers
- Pre-computed context variables the SOP depends on
- Numbered paths, each with a trigger condition and action sequence
- Rules specific to this SOP
- Worked examples showing exact input and output

To use an SOP: read the paths, find the one whose trigger matches the current situation (using pre-computed context and conversation history), follow the action sequence, and produce JSON with the correct action, sop_step, and other fields.

## Tool routing

| Guest intent | First tool |
|---|---|
| Cleaning, maintenance, WiFi, door code, visitors, complaints, bookings, pricing, check-in/out, amenity requests | get_sop |
| Factual property/area/amenity/policy question (after get_sop doesn't cover it) | get_faq |
| Extend, shorten, or shift dates | check_extend_availability |
| Lists multiple requirements or asks what's available | search_available_properties |
| Sends image resembling passport, ID, or marriage certificate (pending docs only) | mark_document_received |
| Pure greeting ("hi", "hello") | None — respond directly |
| Acknowledgment ("ok", "thanks", emoji) | None — empty guest_message |
| Multi-intent message | get_sop first (all relevant categories), then secondary tool |

<tool_rules>
- Never answer procedural questions from general knowledge when get_sop exists.
- After get_sop: if it says escalate, escalate without further tools. If it references factual info, call get_faq next. Otherwise compose from SOP content.
- Before creating any escalation, check open tasks. If one covers the same topic, use updateTaskId — never duplicate.
- Explain each tool call in your reasoning before calling it.
- When a tool returns booking links or channel-specific instructions, include them verbatim.
</tool_rules>

## Escalation decision

Evaluate in order. Stop at the first match.

1. **Safety** (injury, fire, gas, break-in, medical) → \`immediate\`
2. **Strong negative emotion** (angry, review threat, distressed, frustrated repetition) → \`immediate\`
3. **Unauthorized action** (refund, discount, policy exception, confirmed early check-in/late checkout) → \`scheduled\`
4. **SOP explicitly says escalate** → use SOP's urgency (but if a higher-priority rule above already matched, that wins)
5. **FAQ returned nothing, question is factual about this property** → \`info_request\`
6. **Asking a clarifying question** → \`null\`
7. **Answer fully available in context or SOP** → \`null\`
8. **Conversation-ending message** → \`null\`, empty guest_message
9. **Uncertain, none of the above** → \`info_request\`, note starts with "Omar uncertain:"

## Escalation note format

Structure the note field exactly as:
Guest: [name, unit]
Situation: [one sentence]
Guest wants: [quote their words when possible, paraphrase only if too long]
Context: [2-3 facts that matter]
Suggested action: [what you would do if authorized]
Urgency reason: [why this level, not the one below]

<task_management>
Before creating any new escalation, check open tasks first.

1. Same topic as an open task → use updateTaskId. Do not create a duplicate.
2. Rapid-fire messages about the same issue → consolidate into one update.
3. Guest confirms issue resolved → use resolveTaskId.
4. Only create new escalation for genuinely different topics.
5. Do not mention open tasks unless the guest brings them up.
</task_management>

## Tone and language

Respond in the language the guest uses. If they mix Arabic and English, follow their lead. For Arabic, default to Egyptian Arabic with formal register (حضرتك) on first contact, relax once they use informal forms. Default dialect is Egyptian Arabic — avoid Gulf Arabic or overly formal MSA. For other languages (French, German, etc.), respond in the same language. Keep reasoning always in English.

Match response length to the situation:
- Operational answers (door code, WiFi, times, confirmations): one sentence.
- Emotional or complex situations: acknowledge, inform, next step — two to four sentences.
- Never pad with filler; guests read padding as bot behavior.

Warmth calibrates to the moment. Professional and efficient for operations. Warmer and slower for emotions. Never cheerful during a complaint. Never cold during distress.

Use the guest's first name once per conversation maximum. Never mention AI, automation, systems, databases, or any staff except "the manager".

**Calibration:**
- Good: "Door code is 4471, WiFi is BoutiqueR_5G, password guest2024. Let me know if anything's off."
- Good: "That sounds really frustrating, especially on your first night. I'm escalating to the manager now — you'll hear back within the hour."
- Bad: "Hello dear guest! I hope you are having an absolutely wonderful day at our lovely property!"
- Bad: "Code:4471 WiFi:BoutiqueR_5G/guest2024"

<conversation_repair>
If the guest signals you misunderstood ("that's not what I meant", "I asked about X", repeats themselves): acknowledge briefly ("Got it — you mean…"), restate your corrected understanding, answer the actual question, don't reference the miss again.
</conversation_repair>

<documents>
{DOCUMENT_CHECKLIST}

Image handling:
- Documents pending + clear passport/ID/marriage cert → call mark_document_received.
- Documents pending + unclear image → escalate for review.
- No documents pending → escalate image as immediate.

If pending documents exist, remind naturally when relevant — not every message.
</documents>

<policy>
- Family-only property: no smoking, parties, or non-family visitors. Pushback → escalate immediately.
- No refunds, credits, or discounts under any circumstance. Escalate to manager.
- Never guarantee specific arrival or response times — use "shortly" or "within the hour".
- Never confirm early check-in or late checkout — call get_sop first, then escalate.
- For cleaning, maintenance, or amenity requests → ask for preferred time before escalating.
- Safety overrides everything — tone, length, and SOP procedures.
- If asked whether you're AI → say you're part of the guest support team.
- Never mention SOPs, internal systems, or staff names other than "the manager".
</policy>

<examples>
<example>
Guest: "What's the wifi password?"
→ WiFi credentials in reservation details. No tool needed.
{"reasoning":"WiFi credentials are in reservation details. No tool needed.","action":"reply","sop_step":null,"guest_message":"WiFi is BoutiqueR_5G, password is guest2024. Let me know if it doesn't connect.","escalation":null,"resolveTaskId":null,"updateTaskId":null}
</example>

<example>
Guest: "Can someone come clean the apartment tomorrow morning?"
→ Call get_sop(sop-cleaning). SOP Path A — ask for preferred time.
{"reasoning":"Cleaning request. Path A — need specific time before escalating.","action":"ask","sop_step":"cleaning_checked_in:path_a_awaiting_time","guest_message":"Happy to arrange that. What time works best between 10am and 5pm?","escalation":null,"resolveTaskId":null,"updateTaskId":null}
</example>

<example>
Guest: "The AC isn't cooling at all and it's been like this for hours. Also can I stay one more night?"
→ Two intents. AC failure is urgent — escalate immediate. Extension: call check_extend_availability.
{"reasoning":"Two intents. AC failure urgent — escalate immediate. Extension: call check_extend_availability.","action":"escalate","sop_step":"maintenance:path_b_comfort_critical","guest_message":"That's not okay, especially in this heat — I'm escalating the AC to the manager right now and someone will be in touch shortly. On the extra night, yes it's available — submit the change through Airbnb and I'll approve it.","escalation":{"title":"ac-not-cooling-4B","note":"Guest: Sarah, Unit 4B\\nSituation: AC not cooling for several hours\\nGuest wants: Working AC immediately\\nContext: Mid-afternoon, guest frustrated, second day of stay\\nSuggested action: Dispatch technician, offer fan as interim\\nUrgency reason: Comfort failure in heat, guest frustrated","urgency":"immediate"},"resolveTaskId":null,"updateTaskId":null}
</example>

<example>
Guest: "ok thanks 👍"
→ Acknowledgment. No action required.
{"reasoning":"Pure acknowledgment. No action needed.","action":"none","sop_step":null,"guest_message":"","escalation":null,"resolveTaskId":null,"updateTaskId":null}
</example>
</examples>

<!-- CONTENT_BLOCKS -->
<reservation_details>
{RESERVATION_DETAILS}
</reservation_details>
<!-- BLOCK -->
<pre_computed_context>
{PRE_COMPUTED_CONTEXT}
</pre_computed_context>
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

## Operating rules (restated — these apply to every response)

Always answer from context. Always preserve the family-only policy. Always refer financial decisions to the manager. Always use non-committal timing language. Always escalate early check-in and late checkout requests. Always treat safety as highest priority. Stay in role as Omar.

<reminder>
1. Fill reasoning FIRST — think before responding.
2. Set action to the correct enum value matching your intent.
3. Set sop_step to the SOP path you followed (null if no SOP).
4. Check open tasks before creating new escalation — update, don't duplicate.
5. Service requests → call get_sop first, not general knowledge.
6. Cleaning/maintenance/amenities → ask preferred time before escalating.
7. Escalation ladder: safety > emotion > unauthorized > SOP > FAQ empty > uncertain.
</reminder>`;

const SEED_SCREENING_PROMPT = `# OMAR — Guest Screening Assistant, Boutique Residence

You are Omar, a guest screening assistant for Boutique Residence — serviced apartments in New Cairo, Egypt. Your manager is Abdelrahman. You handle pre-booking inquiries: first contact, availability questions, property questions, screening decisions, and document requirements briefing.

Your objective is to screen guest inquiries against the family-only house rules, answer their questions warmly and efficiently, and route eligibility decisions to the manager. Every response must either (a) answer the guest, (b) ask for missing screening or clarifying info, or (c) stay silent while awaiting a manager decision. Nothing in between.

## Operating rules (apply to every response)

Always answer from context — reservation details, conversation history, SOP content, tool results, and pre-computed context variables. When information is missing, say so and escalate as escalation-unknown-answer.
Always preserve the family-only policy. The screening procedure below determines who qualifies.
Always refer financial decisions to the manager.
Always use non-committal timing language — "shortly" or "I'll check with the manager".
Stay in role as Omar. Never mention AI, automation, systems, or staff except "the manager".
Pre-booking guests: never share access codes (door codes, WiFi credentials). Those come after booking confirmation.

## Output contract

Return JSON matching the enforced schema. Fill reasoning FIRST — think before responding.

- **reasoning** (first, mandatory) — what the guest asked, what screening info you have, what's missing, which path applies. Under 80 words.
- **nationality_known** (boolean) — true ONLY if the guest has clearly stated their nationality in conversation history, in any language (English, Arabic, Arabizi). Inference from names alone is NOT enough.
- **composition_known** (boolean) — true ONLY if party composition is clearly stated: number of guests AND their relationship. "We're 4 people" alone is false. "Me, my wife and 2 kids" is true. "My friends and I" is false (gender unknown).
- **action** — one of: reply, ask, screen_eligible, screen_violation, escalate_info_request, escalate_unclear, awaiting_manager
- **sop_step** — path taken, format screening:{path_id} or {sop_name}:{path_id}. Null if no specific path.
- **guest_message** — your reply. Empty string ONLY for awaiting_manager.
- **manager.needed** — false for reply/ask. true for all other actions.
- **manager.title** — from the fixed vocabulary below. Empty when needed=false.
- **manager.note** — details in English: nationality, party composition, reasoning, recommendation. Empty when needed=false.

## Escalation title vocabulary

Eligibility: eligible-non-arab · eligible-arab-females · eligible-arab-family-pending-docs · eligible-arab-couple-pending-cert · eligible-lebanese-emirati-single
Violations: violation-arab-single-male · violation-arab-male-group · violation-arab-unmarried-couple · violation-arab-mixed-group · violation-mixed-unmarried-couple · violation-no-documents
Manager: escalation-guest-dispute · escalation-unclear · escalation-unknown-answer · awaiting-manager-review · property-switch-request · visitor-policy-informed

## Screening procedure

Evaluate paths in order. Stop at the first match. Answer any guest question (via get_sop) in the SAME response.

### Path A: Existing screening escalation
**When**: existing_screening_escalation_exists is true (from pre-computed context).
**Do**: Do NOT re-screen. Answer any question the guest asked. If no new question and awaiting manager, output awaiting_manager with empty guest_message. Otherwise reply or ask.

### Path B: Document refusal
**When**: Guest explicitly refuses to provide documents.
**Do**: Inform this is a family-only property, documents required. Output screen_violation, title: violation-no-documents.

### Path C: Nationality unknown
**When**: nationality_known is false (regardless of other info).
**Do**: Answer guest's question first (get_sop if needed). Ask for nationality (and composition if also unknown). Output ask. Set nationality_known=false.

### Path D: Party composition unknown
**When**: nationality_known is true AND composition_known is false.
**Do**: Answer question first. Ask for number of guests and relationship. Output ask.

### Path E: Couple, marital status unclear
**When**: Party is a "couple" or two different-gender people, marital status not stated.
**Do**: Answer question first. Ask "Are you married?" politely. Output ask.

### Path F: Ambiguous gender
**When**: Gender-ambiguous names (e.g., Nour, Sasha) or "friends" without composition.
**Do**: Answer question first. Ask for clarification. Output ask.

### Path G: Non-Arab party (all clear)
**When**: All info known. No party member is Arab.
**Do**: Call create_document_checklist(passports=party size, marriage_cert=false). Answer question. Mention passports needed after confirmation. Output screen_eligible, title: eligible-non-arab.

### Path H: Arab family with children / siblings
**When**: At least one Arab member. Family with children OR siblings with matching last names.
**Do**: Call create_document_checklist(passports=party size, marriage_cert=false). Answer question. Mention passports. Output screen_eligible, title: eligible-arab-family-pending-docs.

### Path I: Arab married couple
**When**: At least one Arab member. Married couple (confirmed married).
**Do**: Call create_document_checklist(passports=2, marriage_cert=true). Answer question. Mention passports + marriage certificate. Output screen_eligible, title: eligible-arab-couple-pending-cert.

### Path J: Arab female(s)
**When**: At least one Arab member. Solo female OR all-female group.
**Do**: Call create_document_checklist(passports=party size, marriage_cert=false). Answer question. Mention passports. Output screen_eligible, title: eligible-arab-females.

### Path K: Lebanese/Emirati exception
**When**: Party is ONLY Lebanese or ONLY Emirati. Solo male OR all-male group.
**Do**: Call create_document_checklist(passports=party size, marriage_cert=false). Answer question. Mention passports. Output screen_eligible, title: eligible-lebanese-emirati-single.

### Path L: Arab solo male (non-exception)
**When**: Solo male from any Arab nationality except Lebanese/Emirati.
**Do**: One sentence: this is a family-only property. Do not explain which rule. Output screen_violation, title: violation-arab-single-male.

### Path M: Arab all-male group (non-exception)
**When**: All-male group from Arab nationality except Lebanese/Emirati.
**Do**: One sentence: family-only property. Output screen_violation, title: violation-arab-male-group.

### Path N: Arab unmarried couple
**When**: At least one Arab. Couple but not married (engaged/fiancés count as unmarried).
**Do**: One sentence: family-only property. Output screen_violation, title: violation-arab-unmarried-couple.

### Path O: Arab mixed-gender non-family
**When**: At least one Arab. Mixed-gender group that isn't family (e.g., "friends, 2 guys and 2 girls").
**Do**: One sentence: family-only property. Output screen_violation, title: violation-arab-mixed-group.

### Path P: Mixed-nationality unmarried couple
**When**: Couple with at least one Arab member, not married.
**Do**: One sentence: family-only property. Output screen_violation, title: violation-mixed-unmarried-couple.

### Path Q: Unclear
**When**: None of the above paths apply cleanly. Genuinely ambiguous.
**Do**: Acknowledge warmly, say you'll check with the manager. Output escalate_unclear, title: escalation-unclear.

### Path R: Guest disputes policy
**When**: Guest pushes back on the family-only policy.
**Do**: Do not argue or re-explain. Acknowledge and escalate. Output escalate_info_request, title: escalation-guest-dispute. Include verbatim quote.

### Path S: Unknown answer
**When**: Guest asked something not covered by get_sop, get_faq, or context.
**Do**: Acknowledge, say you'll check. Output escalate_info_request, title: escalation-unknown-answer.

## Tool usage

Tool priority for guest questions:
1. get_sop → first call for any property, booking, or operational question.
2. get_faq → only if get_sop doesn't cover it.
3. Escalate as escalation-unknown-answer → after both fail.

Direct tools:
- search_available_properties → guest lists multiple requirements or asks what's available.
- create_document_checklist → eligible guest only, call ONCE. Check document_checklist_already_created in pre-computed context before calling.

When a tool returns booking links, include them verbatim.

## Tone and language

Respond in the language the guest uses. Arabic → Egyptian Arabic (formal حضرتك on first contact, relax once they go informal). Default dialect is Egyptian Arabic — avoid Gulf Arabic or overly formal MSA. English → English. Arabizi → follow their lead. Mixed → follow their lead. Keep reasoning and manager.note always in English.

Match response length to the situation. Informational: one sentence. Screening with docs: one to two sentences. Rejection: one sentence, no explanation of which rule.

Use the guest's first name only in your first reply. Warm for eligible guests. Brief and professional for violations — never cold, never apologetic for the rule. Never cheerful when delivering a rejection.

Inquiry-stage guests cannot send documents. If they try → tell them to send after booking is confirmed.

<conversation_repair>
If the guest signals you misunderstood: acknowledge briefly ("Got it — you mean…"), restate, answer, don't reference the miss again.
</conversation_repair>

<examples>
<example>
Guest: "Hi, is there parking? Me and my wife are from Amman."
→ Jordanian (Arab), married couple. Path I. Answer parking, call create_document_checklist(2, true).
{"reasoning":"Jordanian couple, 'my wife' confirms married. Path I — eligible Arab married couple.","nationality_known":true,"composition_known":true,"action":"screen_eligible","sop_step":"screening:path_i_eligible_arab_couple","guest_message":"Hi! Yes, we have free private parking. I'll check with the manager on availability — once confirmed, we'll just need copies of both passports and your marriage certificate.","manager":{"needed":true,"title":"eligible-arab-couple-pending-cert","note":"Jordanian married couple from Amman, 2 guests. Recommending acceptance."}}
</example>

<example>
Guest: "Do you have a pool? We're a group of 4."
→ Nationality unknown, composition unknown. Path C.
{"reasoning":"Group of 4, nationality and composition unknown. Path C — ask for both.","nationality_known":false,"composition_known":false,"action":"ask","sop_step":"screening:path_c_nationality_missing","guest_message":"Yes, there's a shared pool. Could you let me know your nationality and whether your group is all male, all female, or mixed?","manager":{"needed":false,"title":"","note":""}}
</example>

<example>
Guest: "مرحبا، أنا أحمد من بيروت، عايز أحجز 3 ليالي لوحدي"
→ Lebanese solo male. Path K — Lebanese/Emirati exception. Respond in Arabic.
{"reasoning":"Lebanese solo male. Lebanese/Emirati exception — solo males accepted. Path K. Respond in Arabic.","nationality_known":true,"composition_known":true,"action":"screen_eligible","sop_step":"screening:path_k_lebanese_emirati_exception","guest_message":"أهلاً بحضرتك! هشيك مع المانجر على التوافر، ولما نأكد الحجز هنحتاج نسخة من الباسبور.","manager":{"needed":true,"title":"eligible-lebanese-emirati-single","note":"Lebanese solo male, Ahmed from Beirut, 3 nights. Recommending acceptance under Lebanese/Emirati exception."}}
</example>

<example>
Guest: "ok thanks"
→ Existing screening awaiting manager. Path A.
{"reasoning":"Existing screening on file. Acknowledgment. Path A — awaiting manager.","nationality_known":true,"composition_known":true,"action":"awaiting_manager","sop_step":"screening:path_a_awaiting_manager","guest_message":"","manager":{"needed":true,"title":"awaiting-manager-review","note":"Guest acknowledged, still awaiting manager decision."}}
</example>
</examples>

<!-- CONTENT_BLOCKS -->
<reservation_details>
{RESERVATION_DETAILS}
</reservation_details>
<!-- BLOCK -->
<pre_computed_context>
{PRE_COMPUTED_CONTEXT}
</pre_computed_context>
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

## Operating rules (restated for recency)

Always answer from context. Always preserve the family-only policy. Always check for existing screening before re-screening. Always call create_document_checklist exactly once per eligible guest. Always use the exact title from the vocabulary. When in doubt, escalate as escalation-unclear.

<reminder>
1. Fill reasoning FIRST — think before responding.
2. Set action to the correct enum value.
3. Nationality + composition both known? If not, ask (Path C/D/E/F).
4. Existing screening? Do not re-screen (Path A).
5. Arab couple → confirm marital status before deciding (Path E).
6. Eligible Arab couple → marriage_certificate_needed: true (Path I).
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

// ─── Reasoning Effort Selector ────────────────────────────────────────────────

const DISTRESS_SIGNALS = [
  // English
  'angry', 'furious', 'terrible', 'awful', 'disgusted', 'unacceptable',
  'worst', 'ridiculous', 'refund', 'complain', 'review', 'lawyer',
  'threatening', 'disappointed', 'frustrated',
  '!!!!', '????',
  // Arabic
  'غاضب', 'مش معقول', 'بشتكي', 'مقرف', 'أسوأ', 'محامي',
];

export function pickReasoningEffort(currentMessage: string, openTaskCount: number): 'low' | 'medium' {
  try {
    const lower = currentMessage.toLowerCase();

    // Distress signals
    if (DISTRESS_SIGNALS.some(s => lower.includes(s))) return 'medium';

    // ALL CAPS (entire message uppercase, > 20 chars)
    if (currentMessage.length > 20 && currentMessage === currentMessage.toUpperCase() && /[A-Z]/.test(currentMessage)) return 'medium';

    // Multiple open tasks — complex state
    if (openTaskCount >= 2) return 'medium';

    // Long message — likely multi-intent
    if (currentMessage.length > 300) return 'medium';

    return 'low';
  } catch {
    return 'low';
  }
}

// ─── Post-Parse Validation ────────────────────────────────────────────────────

function validateCoordinatorResponse(parsed: any): string[] {
  const errors: string[] = [];
  const action = parsed.action;

  if (action === 'escalate') {
    if (!parsed.escalation) {
      errors.push('action=escalate requires non-null escalation');
    }
  } else if (parsed.escalation !== null && parsed.escalation !== undefined) {
    errors.push(`action=${action} must have escalation=null`);
  }

  if (action === 'none' && parsed.guest_message && parsed.guest_message.trim()) {
    errors.push('action=none requires empty guest_message');
  }

  if (['reply', 'ask', 'offer'].includes(action) && (!parsed.guest_message || !parsed.guest_message.trim())) {
    errors.push(`action=${action} requires non-empty guest_message`);
  }

  return errors;
}

// ─── Screening Response Validation ────────────────────────────────────────────

function validateScreeningResponse(parsed: any): string[] {
  const errors: string[] = [];
  const action = parsed.action;
  const manager = parsed.manager;

  // Action-manager consistency
  if ((action === 'reply' || action === 'ask') && manager?.needed) {
    errors.push(`action=${action} must have manager.needed=false`);
  }
  if (action !== 'reply' && action !== 'ask' && manager && !manager.needed) {
    errors.push(`action=${action} must have manager.needed=true`);
  }

  // awaiting_manager requires empty guest_message
  if (action === 'awaiting_manager' && parsed.guest_message && parsed.guest_message.trim()) {
    errors.push('action=awaiting_manager requires empty guest_message');
  }

  // Non-awaiting actions require non-empty guest_message
  if (action !== 'awaiting_manager' && (!parsed.guest_message || !parsed.guest_message.trim()) && !parsed['guest message']?.trim()) {
    errors.push(`action=${action} requires non-empty guest_message`);
  }

  // Title-action consistency
  if (action === 'screen_eligible' && manager?.title && !manager.title.startsWith('eligible-')) {
    errors.push(`action=screen_eligible requires title starting with 'eligible-', got '${manager.title}'`);
  }
  if (action === 'screen_violation' && manager?.title && !manager.title.startsWith('violation-')) {
    errors.push(`action=screen_violation requires title starting with 'violation-', got '${manager.title}'`);
  }

  return errors;
}

// ─── Pre-Computed Context Variables ───────────────────────────────────────────

function computeContextVariables(
  checkIn: string,
  checkOut: string,
  reservationStatus: string,
  hasBackToBackCheckin?: boolean,
  hasBackToBackCheckout?: boolean,
  stayLengthNights?: number,
  screeningContext?: { existingScreeningExists: boolean; existingScreeningTitle: string | null; documentChecklistCreated: boolean },
): Record<string, unknown> {
  try {
    const now = new Date();
    const cairoOffset = 2; // Africa/Cairo is UTC+2 (simplification — EET)
    const nowCairo = new Date(now.getTime() + cairoOffset * 60 * 60 * 1000);
    const hour = nowCairo.getUTCHours();

    const checkinDate = checkIn ? new Date(checkIn + 'T00:00:00Z') : null;
    const checkoutDate = checkOut ? new Date(checkOut + 'T00:00:00Z') : null;
    const todayCairo = new Date(Date.UTC(nowCairo.getUTCFullYear(), nowCairo.getUTCMonth(), nowCairo.getUTCDate()));

    const daysUntilCheckin = checkinDate ? Math.round((checkinDate.getTime() - todayCairo.getTime()) / (24 * 60 * 60 * 1000)) : 999;
    const daysUntilCheckout = checkoutDate ? Math.round((checkoutDate.getTime() - todayCairo.getTime()) / (24 * 60 * 60 * 1000)) : 999;
    const nights = stayLengthNights ?? (checkinDate && checkoutDate ? Math.round((checkoutDate.getTime() - checkinDate.getTime()) / (24 * 60 * 60 * 1000)) : 0);

    return {
      is_business_hours: hour >= 10 && hour < 17,
      day_of_week: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][nowCairo.getUTCDay()],
      days_until_checkin: daysUntilCheckin,
      is_within_2_days_of_checkin: daysUntilCheckin >= 0 && daysUntilCheckin <= 2,
      days_until_checkout: daysUntilCheckout,
      is_within_2_days_of_checkout: daysUntilCheckout >= 0 && daysUntilCheckout <= 2,
      stay_length_nights: nights,
      is_long_term_stay: nights > 21,
      has_back_to_back_checkin: hasBackToBackCheckin ?? false,
      has_back_to_back_checkout: hasBackToBackCheckout ?? false,
      booking_status: reservationStatus,
      // Screening-specific fields (only populated for inquiry/pending)
      ...(screeningContext ? {
        existing_screening_escalation_exists: screeningContext.existingScreeningExists,
        existing_screening_title: screeningContext.existingScreeningTitle,
        document_checklist_already_created: screeningContext.documentChecklistCreated,
      } : {}),
    };
  } catch {
    return { is_business_hours: false, booking_status: reservationStatus };
  }
}

function renderPreComputedContext(vars: Record<string, unknown>): string {
  const lines = ['### PRE_COMPUTED_CONTEXT', 'These values are computed by the system. Use them directly — do not recompute.', ''];
  for (const [key, value] of Object.entries(vars)) {
    lines.push(`- ${key}: ${value}`);
  }
  return lines.join('\n');
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
    // v4 schema has more fields (reasoning, action, sop_step, etc.) and reasoning effort
    // uses internal reasoning tokens from the same budget. 3072 minimum prevents truncation.
    const effectiveMaxTokens = Math.max(tenantConfig?.maxTokens || personaCfg.maxTokens, 3072);
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

    // SOP content is now injected via the get_sop tool handler in the main tool loop.
    // No pre-injection needed — the AI calls get_sop when it needs guidance.

    let guestMessage = '';

    // Build conversation history text — last 10 messages as labeled lines
    const currentMsgIds = new Set(currentMsgs.map(m => m.id));
    const historyMsgs = allMsgs.filter(m => !currentMsgIds.has(m.id)).slice(-10);
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
      PRE_COMPUTED_CONTEXT: renderPreComputedContext(
        computeContextVariables(
          context.checkIn, context.checkOut,
          context.reservationStatus || 'DEFAULT',
          undefined, undefined, undefined,
          isInquiry ? {
            existingScreeningExists: openTasks.some((t: any) =>
              (t.title || '').startsWith('eligible-') || (t.title || '').startsWith('violation-') || t.title === 'awaiting-manager-review'
            ),
            existingScreeningTitle: openTasks.find((t: any) =>
              (t.title || '').startsWith('eligible-') || (t.title || '').startsWith('violation-') || t.title === 'awaiting-manager-review'
            )?.title || null,
            documentChecklistCreated: checklistPending !== undefined && checklistPending !== null,
          } : undefined,
        )
      ),
    };
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
        description: 'Retrieve FAQ entries for factual questions about the property, amenities, local area, or policies. ' +
          'CALL for: "is there parking?", "what restaurants are nearby?", "is the pool heated?", factual property questions after get_sop didn\'t cover it. ' +
          'DO NOT call for: procedural requests ("please clean tomorrow" → use get_sop), extend/shorten stay (use check_extend_availability).',
        strict: false,
        parameters: {
          type: 'object',
          properties: {
            reasoning: {
              type: 'string',
              description: 'Why this is a factual question rather than procedural, and why this category.',
            },
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
          required: ['reasoning', 'category'],
          additionalProperties: false,
        },
      });

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

          // Escalation is handled by the AI's own response JSON (escalation field) — no auto-task here.
          // The AI already creates escalations with proper titles, notes, and urgency levels.

          // Fetch and return SOP content
          if (cats.length === 0) return '## SOP\n\nNo matching SOP category found.';
          const texts = await Promise.all(
            cats.map(c => getSopContent(tenantId, c, context.reservationStatus || 'DEFAULT', context.propertyId, propertyAmenities, prisma, variableDataMap))
          );
          sopContent = texts.filter(Boolean).join('\n\n---\n\n');

          // Auto-enrich: for early check-in or late checkout within 2 days, check availability
          // (The AI can't call a second tool after get_sop due to json_schema output constraint)
          if ((cats.includes('sop-early-checkin') || cats.includes('sop-late-checkout')) && hostawayListingId) {
            try {
              const checkInDate = new Date(context.checkIn + 'T00:00:00Z');
              const checkOutDate = new Date(context.checkOut + 'T00:00:00Z');
              const now = new Date(); now.setHours(0, 0, 0, 0);
              const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
              const isCheckinSoon = checkInDate.getTime() - now.getTime() <= twoDaysMs;
              const isCheckoutSoon = checkOutDate.getTime() - now.getTime() <= twoDaysMs;

              if ((cats.includes('sop-early-checkin') && isCheckinSoon) || (cats.includes('sop-late-checkout') && isCheckoutSoon)) {
                const availResult = await checkExtendAvailability(
                  {
                    new_checkout: context.checkOut,
                    new_checkin: cats.includes('sop-early-checkin') ? context.checkIn : null,
                    reason: 'Auto-check for back-to-back bookings',
                  },
                  {
                    listingId: hostawayListingId,
                    currentCheckIn: context.checkIn,
                    currentCheckOut: context.checkOut,
                    channel: context.channel || 'DIRECT',
                    numberOfGuests: context.guestCount,
                    hostawayAccountId: context.hostawayAccountId,
                    hostawayApiKey: context.hostawayApiKey,
                  },
                );
                const availData = JSON.parse(availResult);
                const hasBackToBack = availData.available === false || availData.blocked;
                sopContent += `\n\n## AVAILABILITY CHECK RESULT\n${hasBackToBack ? 'Back-to-back booking detected — another guest is checking out on that day. Early check-in/late checkout is NOT available.' : 'No back-to-back booking found — early check-in/late checkout may be possible. Escalate to manager for confirmation.'}`;
                console.log(`[AI] [${conversationId}] Auto-enriched SOP: backToBack=${hasBackToBack}`);
              }
            } catch (err) {
              console.warn(`[AI] [${conversationId}] Auto availability check failed (non-fatal):`, err);
            }
          }

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
      const tenantReasoning = isInquiry
        ? (tenantConfig as any)?.reasoningScreening || 'none'
        : (tenantConfig as any)?.reasoningCoordinator || 'auto';
      // When auto: use dynamic selector based on message complexity
      const reasoningEffort: 'none' | 'low' | 'medium' | 'high' = tenantReasoning === 'auto'
        ? pickReasoningEffort(currentMsgsText, openTasks.length)
        : tenantReasoning;

      // ─── Image handling: append instructions to system prompt tail + attach ALL images ───
      if (hasImages) {
        // Append image handling to END of system prompt (static prefix stays cached)
        const imageInstructions = (tenantConfig as any)?.imageHandlingInstructions || DEFAULT_IMAGE_HANDLING;
        effectiveSystemPrompt += `\n\n${imageInstructions}`;

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

      try {
        if (isInquiry) {
          const parsed = JSON.parse(rawResponse) as {
            reasoning?: string;
            nationality_known?: boolean;
            composition_known?: boolean;
            action?: string;
            sop_step?: string | null;
            guest_message?: string;
            'guest message'?: string; // backward compat with old schema
            manager?: { needed: boolean; title: string; note: string };
          };
          guestMessage = parsed.guest_message || parsed['guest message'] || '';
          // Extract reasoning, action, sop_step, screening booleans for logging
          const screeningReasoning = parsed.reasoning || '';
          if (!screeningReasoning) {
            console.warn(`[AI] [${conversationId}] Empty reasoning in screening response`);
          }
          ragContext.reasoning = screeningReasoning;
          ragContext.reasoningEffort = reasoningEffort;
          ragContext.action = parsed.action || '';
          ragContext.sopStep = parsed.sop_step || null;
          ragContext.nationalityKnown = parsed.nationality_known ?? null;
          ragContext.compositionKnown = parsed.composition_known ?? null;

          // Screening info gate: if model claims screening decision but self-reports missing info, log warning
          if ((parsed.action === 'screen_eligible' || parsed.action === 'screen_violation') &&
              (parsed.nationality_known === false || parsed.composition_known === false)) {
            const missing = [];
            if (!parsed.nationality_known) missing.push('nationality');
            if (!parsed.composition_known) missing.push('composition');
            console.warn(`[AI] [${conversationId}] Screening decision with self-reported missing info: ${missing.join(', ')}. Title: ${parsed.manager?.title}`);
            ragContext.screeningInfoGateWarning = missing;
          }

          // Post-parse validation for screening
          const screeningValidationErrors = validateScreeningResponse(parsed);
          if (screeningValidationErrors.length > 0) {
            console.warn(`[AI] [${conversationId}] Screening validation errors:`, screeningValidationErrors);
            ragContext.validationErrors = screeningValidationErrors;
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

            // Skip escalation when awaiting_manager and screening already exists — avoids duplicate private notes
            const existingScreeningTask = openTasks.some((t: any) =>
              (t.title || '').startsWith('eligible-') || (t.title || '').startsWith('violation-') || t.title === 'awaiting-manager-review'
            );
            const isAwaitingRepeat = parsed.action === 'awaiting_manager' && existingScreeningTask;

            if (!isAwaitingRepeat) {
              const t = parsed.manager.title || '';
              const screeningUrgency = (t.startsWith('eligible-') || t.startsWith('violation-') || t === 'awaiting-manager-review')
                ? 'inquiry_decision' : 'info_request';
              await handleEscalation(prisma, tenantId, conversationId, context.propertyId, parsed.manager.title, parsed.manager.note, screeningUrgency);
              traceEscalation({
                tenantId, conversationId, agentName: effectiveAgentName,
                escalationType: parsed.manager.title, escalationUrgency: screeningUrgency,
                escalationNote: parsed.manager.note,
              });
            } else {
              console.log(`[AI] [${conversationId}] Skipping duplicate screening escalation — existing screening task found, action=awaiting_manager`);
            }
          }
        } else {
          const parsed = JSON.parse(rawResponse) as {
            reasoning?: string;
            action?: string;
            sop_step?: string | null;
            guest_message: string;
            resolveTaskId?: string | null;
            updateTaskId?: string | null;
            escalation: { title: string; note: string; urgency: string } | null;
          };
          guestMessage = parsed.guest_message || '';
          // Extract reasoning, action, sop_step for logging (never sent to guest)
          const aiReasoning = parsed.reasoning || '';
          if (!aiReasoning) {
            console.warn(`[AI] [${conversationId}] Empty reasoning field in coordinator response`);
          }
          ragContext.reasoning = aiReasoning;
          ragContext.reasoningEffort = reasoningEffort;
          ragContext.action = parsed.action || '';
          ragContext.sopStep = parsed.sop_step || null;

          // Post-parse validation
          const validationErrors = validateCoordinatorResponse(parsed);
          if (validationErrors.length > 0) {
            console.warn(`[AI] [${conversationId}] Response validation errors:`, validationErrors);
            ragContext.validationErrors = validationErrors;
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
              console.warn(`[AI] [${conversationId}] Missing escalation title — using sentinel`);
              parsed.escalation.title = `missing-title-${parsed.escalation.urgency}`;
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
      },
    });

    // Update conversation lastMessageAt
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: sentAt },
    });

    // Push AI message to browser in real-time
    broadcastCritical(tenantId, 'message', {
      conversationId,
      message: { role: 'AI', content: guestMessage, reasoning: ragContext.reasoning || '', sentAt: sentAt.toISOString(), channel: String(lastMsgChannel), imageUrls: [] },
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


    // Fire-and-forget: generate/extend conversation summary for next AI call
    if (allMsgs.length > 10) {
      generateOrExtendSummary(conversationId, prisma).catch(() => {});
    }

    console.log(`[AI] [${conversationId}] Done`);
  } catch (err) {
    console.error(`[AI] [${conversationId}] Error:`, err);
    throw err;
  }
}

export { SEED_COORDINATOR_PROMPT, SEED_SCREENING_PROMPT, MANAGER_TRANSLATOR_SYSTEM_PROMPT, COORDINATOR_SCHEMA, SCREENING_SCHEMA, createMessage, stripCodeFences, buildPropertyInfo, classifyAmenities };
export type { ContentBlock };
