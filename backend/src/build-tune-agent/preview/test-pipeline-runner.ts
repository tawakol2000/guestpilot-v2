/**
 * Sprint 045 Gate 3 — dry pipeline runner for the `test_pipeline` tool.
 *
 * Runs a simplified, side-effect-free version of the guest-reply
 * pipeline against ONE test message. The goal is to let a BUILD-mode
 * manager verify that a freshly-written SOP / FAQ / system prompt
 * produces a sensible reply before exposing the change to real guests.
 *
 * Simplifications vs `generateAndSendAiReply`:
 *   - No Hostaway pre-sync, no reservation-status resync.
 *   - No message-history DB writes, no SSE broadcasts.
 *   - No shadow-preview / copilot branching, no Hostaway send.
 *   - No task-manager escalation dedup.
 *   - No tool loop — instead, ALL enabled SOP contents + ALL active
 *     FAQ entries are pre-injected into the system prompt so the model
 *     can reason over them directly. This gives the reply access to
 *     everything a full tool loop would eventually surface, without
 *     the latency and log noise of a real loop.
 *
 * The production hot path (`ai.service.ts#generateAndSendAiReply`) is
 * untouched. This runner is a separate code path used only by the
 * BUILD `test_pipeline` tool and its unit tests.
 *
 * Cache bypass: the runner threads `{ bypassCache: true }` through
 * every cached config read so a freshly-written artifact is visible
 * immediately:
 *   - getTenantAiConfig — tenant-config + system prompt (60s TTL)
 *   - getSopContent     — per-category SOP content (5-min TTL)
 * These are the two caches in the dry-run path. The FAQ lookup is a
 * direct Prisma query with no caching layer. Production (`ai.service`)
 * does NOT use this flag and stays on the normal TTLs.
 */
import type { PrismaClient } from '@prisma/client';
import OpenAI from 'openai';
import {
  getTenantAiConfig,
  type GetTenantAiConfigOptions,
} from '../../services/tenant-config.service';
import { SOP_CATEGORIES, getSopContent } from '../../services/sop.service';

export interface TestPipelineContext {
  reservationStatus?:
    | 'INQUIRY'
    | 'PENDING'
    | 'CONFIRMED'
    | 'CHECKED_IN'
    | 'CHECKED_OUT'
    | 'CANCELLED';
  channel?: 'AIRBNB' | 'BOOKING' | 'DIRECT' | 'WHATSAPP' | 'OTHER';
}

export interface RunPipelineDryInput {
  tenantId: string;
  testMessage: string;
  context?: TestPipelineContext;
  prisma: PrismaClient;
  /** Injected OpenAI client for tests. Falls back to a default instance. */
  openai?: Pick<OpenAI, 'responses'>;
}

/**
 * 2026-04-24: surfaces the structured pipeline output (escalation,
 * scheduledTime, resolve/update task ids) so downstream consumers —
 * the judge in particular — can credit a short-ack + background
 * escalation as meeting the SOP. Before this, only the prose reply was
 * visible to the judge, producing false-negative 'missing-sop-reference'
 * verdicts on passport-submission tests that DID escalate correctly.
 */
export interface PipelineStructuredAction {
  escalation: {
    title: string;
    note: string;
    urgency: 'immediate' | 'scheduled' | 'info_request';
  } | null;
  scheduledTime: { kind: 'check_in' | 'check_out'; time: string } | null;
  resolveTaskId: string | null;
  updateTaskId: string | null;
  confidence: number;
}

export interface RunPipelineDryResult {
  reply: string;
  replyModel: string;
  /** Compact tenant-context summary used for the judge grader. */
  tenantContextSummary: string;
  latencyMs: number;
  /**
   * Structured action the pipeline planned alongside the reply. Null
   * when the model returned plain prose (e.g. when a future variant
   * of the runner can't enforce a schema); non-null on the standard
   * path.
   */
  action: PipelineStructuredAction | null;
}

const DEFAULT_STATUS: NonNullable<TestPipelineContext['reservationStatus']> =
  'CONFIRMED';
const DEFAULT_CHANNEL: NonNullable<TestPipelineContext['channel']> = 'DIRECT';

export async function runPipelineDry(
  input: RunPipelineDryInput
): Promise<RunPipelineDryResult> {
  const started = Date.now();
  const status = input.context?.reservationStatus ?? DEFAULT_STATUS;
  const channel = input.context?.channel ?? DEFAULT_CHANNEL;

  // Cache bypass ensures a just-written system prompt is visible.
  const cacheOpts: GetTenantAiConfigOptions = { bypassCache: true };
  const tenantConfig = await getTenantAiConfig(
    input.tenantId,
    input.prisma,
    cacheOpts
  );

  const isInquiry = status === 'INQUIRY' || status === 'PENDING';
  const basePrompt = isInquiry
    ? tenantConfig.systemPromptScreening
    : tenantConfig.systemPromptCoordinator;
  if (!basePrompt) {
    throw new Error(
      `Tenant ${input.tenantId} has no ${
        isInquiry ? 'screening' : 'coordinator'
      } system prompt configured.`
    );
  }

  const [sopContext, faqContext] = await Promise.all([
    collectSopContext(input.tenantId, status, input.prisma, true),
    collectFaqContext(input.tenantId, input.prisma),
  ]);

  const tenantContextSummary = buildTenantContextSummary({
    systemPromptExcerpt: truncate(basePrompt, 1200),
    sopContext,
    faqContext,
  });

  const systemPrompt = [
    basePrompt,
    '',
    '---',
    '<test_pipeline_context>',
    'You are running inside a BUILD-mode test harness. Generate ONE direct',
    'reply to the guest message below. Keep it concise, natural, and',
    'grounded in the tenant knowledge shown. Do not reference the test',
    'harness or this instruction block.',
    `Reservation status: ${status}. Channel: ${channel}.`,
    '</test_pipeline_context>',
    '',
    sopContext ? '<tenant_sops>\n' + sopContext + '\n</tenant_sops>' : '',
    faqContext ? '<tenant_faqs>\n' + faqContext + '\n</tenant_faqs>' : '',
  ]
    .filter((s) => s.length > 0)
    .join('\n');

  const model = tenantConfig.model || 'gpt-5.4-mini-2026-03-17';
  const normalisedModel = model.startsWith('claude-')
    ? 'gpt-5.4-mini-2026-03-17'
    : model;

  const client: Pick<OpenAI, 'responses'> =
    input.openai ?? new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // 2026-04-24: match production's structured-output shape so the
  // judge sees the SAME (reply, escalation) pair real guests trigger.
  // Uses the same schema path as ai.service#COORDINATOR_SCHEMA /
  // SCREENING_SCHEMA — duplicated here (not imported) to keep the dry
  // runner a standalone module with no circular pull from the main
  // pipeline. Drift risk: if ai.service ever changes the canonical
  // schema field names, update both sides (see also direct production
  // call site). The schema below omits fields the runner doesn't need
  // (resolveTaskId, updateTaskId stay for fidelity) and is still
  // strict-mode-compliant.
  const schema = isInquiry ? DRY_SCREENING_SCHEMA : DRY_COORDINATOR_SCHEMA;
  const response = await (client.responses as any).create({
    model: normalisedModel,
    instructions: systemPrompt,
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text: input.testMessage }],
      },
    ],
    max_output_tokens: 600,
    text: { format: schema },
  });

  const parsed = extractStructuredResponse(response, isInquiry);
  if (!parsed.reply) {
    throw new Error(
      'test_pipeline: OpenAI returned an empty reply. Check the tenant system prompt + SOPs.'
    );
  }

  return {
    reply: parsed.reply,
    replyModel: normalisedModel,
    tenantContextSummary,
    latencyMs: Date.now() - started,
    action: parsed.action,
  };
}

// ─── Structured output schemas — kept in sync with ai.service. ───
// Strict mode requires every property to be in `required`; nullable
// values use type: ['object', 'null'].

const DRY_COORDINATOR_SCHEMA = {
  type: 'json_schema' as const,
  name: 'coordinator_response',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      guest_message: { type: 'string' },
      escalation: {
        type: ['object', 'null'] as any,
        properties: {
          title: { type: 'string' },
          note: { type: 'string' },
          urgency: { type: 'string', enum: ['immediate', 'scheduled', 'info_request'] },
        },
        required: ['title', 'note', 'urgency'],
        additionalProperties: false,
      },
      resolveTaskId: { type: ['string', 'null'] as any },
      updateTaskId: { type: ['string', 'null'] as any },
      confidence: { type: 'number' },
      scheduledTime: {
        type: ['object', 'null'] as any,
        properties: {
          kind: { type: 'string', enum: ['check_in', 'check_out'] },
          time: { type: 'string', pattern: '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' },
        },
        required: ['kind', 'time'],
        additionalProperties: false,
      },
    },
    required: [
      'guest_message',
      'escalation',
      'resolveTaskId',
      'updateTaskId',
      'confidence',
      'scheduledTime',
    ],
    additionalProperties: false,
  },
};

const DRY_SCREENING_SCHEMA = {
  type: 'json_schema' as const,
  name: 'screening_response',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      'guest message': { type: 'string' },
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
      confidence: { type: 'number' },
    },
    required: ['guest message', 'manager', 'confidence'],
    additionalProperties: false,
  },
};

function extractStructuredResponse(
  response: any,
  isInquiry: boolean
): { reply: string; action: PipelineStructuredAction | null } {
  // Responses API surfaces the strict-schema JSON via the first
  // output item's text blocks (or `output_text`). Fall back to the
  // legacy text extractor if the model returned plain prose (e.g. a
  // rare path where the schema couldn't be honoured).
  const rawText = extractResponseText(response);
  if (!rawText) return { reply: '', action: null };
  let obj: any;
  try {
    obj = JSON.parse(rawText);
  } catch {
    return { reply: rawText, action: null };
  }
  if (isInquiry) {
    const reply = typeof obj?.['guest message'] === 'string' ? obj['guest message'] : '';
    const mgr = obj?.manager;
    const needed = mgr && typeof mgr === 'object' && mgr.needed === true;
    const action: PipelineStructuredAction = {
      escalation: needed
        ? {
            title: String(mgr.title ?? ''),
            note: String(mgr.note ?? ''),
            urgency: 'info_request',
          }
        : null,
      scheduledTime: null,
      resolveTaskId: null,
      updateTaskId: null,
      confidence: typeof obj?.confidence === 'number' ? obj.confidence : 0,
    };
    return { reply, action };
  }
  const reply = typeof obj?.guest_message === 'string' ? obj.guest_message : '';
  const esc = obj?.escalation;
  const escOk =
    esc &&
    typeof esc === 'object' &&
    typeof esc.title === 'string' &&
    typeof esc.note === 'string' &&
    (esc.urgency === 'immediate' || esc.urgency === 'scheduled' || esc.urgency === 'info_request');
  const scheduled = obj?.scheduledTime;
  const scheduledOk =
    scheduled &&
    typeof scheduled === 'object' &&
    (scheduled.kind === 'check_in' || scheduled.kind === 'check_out') &&
    typeof scheduled.time === 'string';
  const action: PipelineStructuredAction = {
    escalation: escOk ? { title: esc.title, note: esc.note, urgency: esc.urgency } : null,
    scheduledTime: scheduledOk ? { kind: scheduled.kind, time: scheduled.time } : null,
    resolveTaskId: typeof obj?.resolveTaskId === 'string' ? obj.resolveTaskId : null,
    updateTaskId: typeof obj?.updateTaskId === 'string' ? obj.updateTaskId : null,
    confidence: typeof obj?.confidence === 'number' ? obj.confidence : 0,
  };
  return { reply, action };
}

async function collectSopContext(
  tenantId: string,
  status: string,
  prisma: PrismaClient,
  bypassCache: boolean
): Promise<string> {
  const sections: string[] = [];
  for (const category of SOP_CATEGORIES) {
    if (category === 'none' || category === 'escalate') continue;
    const content = await getSopContent(
      tenantId,
      category,
      status,
      undefined,
      undefined,
      prisma,
      undefined,
      { bypassCache }
    ).catch(() => '');
    if (content && content.trim().length > 0) {
      sections.push(`## ${category}\n${content.trim()}`);
    }
  }
  return sections.join('\n\n');
}

export async function collectFaqContext(
  tenantId: string,
  prisma: PrismaClient
): Promise<string> {
  // Bugfix (2026-04-22): previously `scope: 'GLOBAL'` was hard-filtered,
  // so PROPERTY-scoped FAQs were invisible to the dry pipeline. That
  // contradicted this module's own header doc ("ALL active FAQ entries
  // are pre-injected") and produced a false-negative from the Sonnet
  // judge whenever the change under test was a per-property FAQ —
  // managers saw test_pipeline fail even though the FAQ was correct,
  // because the runner wasn't loading it. test_pipeline has no
  // propertyId parameter, so we include both scopes and annotate each
  // entry so the judge can reason about applicability. GLOBAL entries
  // come first in sort order so if the 2,000-char truncate downstream
  // clips tail, the fleet-wide FAQs survive preferentially.
  const entries = await prisma.faqEntry.findMany({
    where: { tenantId, status: 'ACTIVE' },
    select: {
      category: true,
      question: true,
      answer: true,
      scope: true,
      propertyId: true,
    },
    orderBy: [{ scope: 'asc' }, { createdAt: 'asc' }],
    take: 100,
  });
  if (entries.length === 0) return '';
  return entries
    .map((e) => {
      const scopeTag =
        e.scope === 'GLOBAL'
          ? 'GLOBAL'
          : `PROPERTY:${e.propertyId ?? 'unknown'}`;
      return `[${scopeTag} ${e.category}] Q: ${e.question}\nA: ${e.answer}`;
    })
    .join('\n\n');
}

export function buildTenantContextSummary(input: {
  systemPromptExcerpt: string;
  sopContext: string;
  faqContext: string;
}): string {
  const parts: string[] = [];
  parts.push('## System prompt (excerpt)');
  parts.push(input.systemPromptExcerpt);
  if (input.sopContext) {
    parts.push('');
    parts.push('## Active SOPs');
    parts.push(truncate(input.sopContext, 4000));
  }
  if (input.faqContext) {
    parts.push('');
    parts.push('## Active FAQs');
    parts.push(truncate(input.faqContext, 2000));
  }
  return parts.join('\n');
}

function truncate(s: string, limit: number): string {
  if (s.length <= limit) return s;
  return s.slice(0, limit) + '\n… [truncated]';
}

function extractResponseText(response: any): string {
  if (!response) return '';
  if (typeof response.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }
  const out = response.output;
  if (Array.isArray(out)) {
    const chunks: string[] = [];
    for (const item of out) {
      if (!item) continue;
      const content = item.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c?.type === 'output_text' && typeof c.text === 'string') {
            chunks.push(c.text);
          }
        }
      } else if (typeof item.text === 'string') {
        chunks.push(item.text);
      }
    }
    return chunks.join('').trim();
  }
  if (typeof response.text === 'string') return response.text.trim();
  return '';
}
