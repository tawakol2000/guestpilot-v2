/**
 * Feature 041 sprint 02 §3 — Single-call LLM diagnostic service.
 *
 * Flow per invocation:
 *   1. Assemble the evidence bundle (sprint 01).
 *   2. Persist the bundle to `EvidenceBundle` and capture the row id.
 *   3. Compute Myers diff + magnitude on original vs final text.
 *   4. Single OpenAI Responses-API call with structured JSON output enforced
 *      by a json_schema. Model: TUNING_DIAGNOSTIC_MODEL env (default the
 *      gpt-5.4 full flagship, fallback gpt-5.4-mini if the env-configured
 *      model is not resolvable at runtime). Reasoning effort: high.
 *   5. Return a typed DiagnosticResult the suggestion-writer consumes.
 *
 * This replaces the two-step analyzer (nano classifier + mini analyzer) the
 * sprint-01 teardown deleted. One LLM call is cheaper, faster, and uses the
 * richer evidence bundle rather than a handful of truncated snippets.
 *
 * Degrades silently when OPENAI_API_KEY is missing per CLAUDE.md critical
 * rule #2: returns null, caller must handle it. Tracing emits a nested span
 * under the active root trace when one exists (sprint 01's AsyncLocalStorage
 * scope), otherwise spans no-op.
 *
 * Sprint 05 §1: model upgrade lever. Set TUNING_DIAGNOSTIC_MODEL to roll back
 * to mini if quality regresses or cost spikes.
 */
import OpenAI from 'openai';
import { PrismaClient, TuningConversationTriggerType } from '@prisma/client';
import {
  assembleEvidenceBundle,
  type EvidenceBundle,
  type EvidenceTriggerEvent,
} from '../evidence-bundle.service';
import {
  classifyEditMagnitude,
  computeMyersDiff,
  semanticSimilarity,
  type EditMagnitude,
  type MyersDiffResult,
} from './diff.service';
import { startAiSpan } from '../observability.service';

// ─── Public types ────────────────────────────────────────────────────────────

export type DiagnosticCategory =
  | 'SOP_CONTENT'
  | 'SOP_ROUTING'
  | 'FAQ'
  | 'SYSTEM_PROMPT'
  | 'TOOL_CONFIG'
  | 'MISSING_CAPABILITY'
  | 'PROPERTY_OVERRIDE'
  | 'NO_FIX';

export type ArtifactTargetType = 'SOP' | 'FAQ' | 'SYSTEM_PROMPT' | 'TOOL' | 'PROPERTY_OVERRIDE' | 'NONE';

export interface DiagnosticResult {
  category: DiagnosticCategory;
  subLabel: string;
  confidence: number; // 0..1, model-verbalized
  rationale: string;
  proposedText: string | null;
  artifactTarget: { type: ArtifactTargetType; id: string | null };
  capabilityRequest: { title: string; description: string; rationale: string } | null;
  // Pass-through context so the suggestion writer can stamp linkage fields
  // without re-reading the DB.
  evidenceBundleId: string;
  triggerType: TuningConversationTriggerType;
  tenantId: string;
  sourceMessageId: string | null;
  diagMeta: {
    similarity: number;
    magnitude: EditMagnitude;
    originalText: string;
    finalText: string;
    diff: MyersDiffResult;
  };
}

export interface DiagnosticInput extends EvidenceTriggerEvent {
  // sprint 02 has nothing extra yet; kept as an alias so future sprints can
  // extend the input without breaking callers.
}

// ─── OpenAI client (lazy, graceful) ──────────────────────────────────────────

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI | null {
  if (_openai) return _openai;
  if (!process.env.OPENAI_API_KEY) return null;
  _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

// ─── Model selection (sprint 05 §1) ──────────────────────────────────────────
//
// Default to the gpt-5.4 full flagship — the diagnostic is the highest-value
// LLM call in the tuning loop and we want maximum classification accuracy.
// Set TUNING_DIAGNOSTIC_MODEL to override (e.g. roll back to mini if quality
// regresses or cost spikes). Fallback path: if the configured model returns
// model_not_found at runtime, fall back to mini for the rest of this process
// and log once.

// `gpt-5.4` is the undated alias for the full 5.4 flagship. The dated
// identifier `gpt-5.4-2026-03-17` is referenced in tenant-config.service.ts's
// allowed-models list but returns model_not_found from OpenAI as of sprint
// 05 — the alias is the closest GA model. Override via TUNING_DIAGNOSTIC_MODEL
// once a dated GA snapshot ships.
const DEFAULT_DIAGNOSTIC_MODEL = 'gpt-5.4';
const FALLBACK_DIAGNOSTIC_MODEL = 'gpt-5.4-mini-2026-03-17';

let _resolvedModel: string | null = null;
let _fallbackLogged = false;

function getDiagnosticModel(): string {
  if (_resolvedModel) return _resolvedModel;
  _resolvedModel = (process.env.TUNING_DIAGNOSTIC_MODEL || DEFAULT_DIAGNOSTIC_MODEL).trim();
  return _resolvedModel;
}

function isModelNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: number; code?: string; message?: string };
  if (e.status === 404) return true;
  if (typeof e.code === 'string' && /model_not_found|invalid_model/i.test(e.code)) return true;
  if (typeof e.message === 'string' && /model.*(not.*found|does not exist|invalid)/i.test(e.message)) return true;
  return false;
}

function fallBackToMini(reason: string): void {
  if (!_fallbackLogged) {
    console.warn(
      `[Diagnostic] Falling back from ${_resolvedModel ?? DEFAULT_DIAGNOSTIC_MODEL} to ${FALLBACK_DIAGNOSTIC_MODEL} for the rest of this process. Reason: ${reason}`
    );
    _fallbackLogged = true;
  }
  _resolvedModel = FALLBACK_DIAGNOSTIC_MODEL;
}

/** Test-only reset helper — exposed for unit tests, not for callers. */
export function __resetDiagnosticModelCacheForTests(): void {
  _resolvedModel = null;
  _fallbackLogged = false;
}

// ─── Taxonomy definitions (stable, hoisted so caching works cleanly) ─────────

const TAXONOMY_DEFINITIONS = `
The 8 categories are:

1. SOP_CONTENT — The SOP for this status / category said the wrong thing or
   didn't cover this case. Fix: edit SopVariant.content (or a property
   override when needed).
2. SOP_ROUTING — The classifier picked the wrong SOP; correct content
   existed elsewhere. Fix: edit the SopDefinition.toolDescription.
3. FAQ — A factual detail the AI needed wasn't in any FAQ, or was but was
   incorrect. Fix: create or edit a FaqEntry (global or property-scoped).
4. SYSTEM_PROMPT — Tone, policy, reasoning, or conditional-branch behavior
   at the prompt level. Fix: edit TenantAiConfig.systemPromptCoordinator
   or systemPromptScreening.
5. TOOL_CONFIG — Wrong tool called, right tool called wrong, tool
   description unclear, tool parameters misused. Fix: edit ToolDefinition.
6. MISSING_CAPABILITY — The AI needed a tool that does not exist. Do NOT
   invent an artifact fix. Emit a capabilityRequest instead.
7. PROPERTY_OVERRIDE — The content is correct globally but this specific
   property is different and needs a SopPropertyOverride or property-scoped
   FAQ.
8. NO_FIX — The edit was cosmetic (typo, punctuation, tone nudge) or a
   one-off manager preference that does NOT generalize. First-class abstain.
   Return this instead of a forced artifact change.
`.trim();

const DIAGNOSTIC_SYSTEM_PROMPT = `
You are the diagnostic engine inside GuestPilot's tuning agent. Your job is
to look at a single triggering event — where a manager edited, rejected,
complained about, or thumbs-downed an AI-generated guest reply — and route
the correction into exactly one of the 8 taxonomy categories. You produce
one structured JSON object per call; no prose outside the JSON.

${TAXONOMY_DEFINITIONS}

Rules (non-negotiable):

- Anti-sycophancy: if no artifact change is warranted, return NO_FIX. Do
  not invent a fix to satisfy the request. Cosmetic typo fixes, one-off
  manager preferences, and polish that does not generalize are NO_FIX.
- Refuse directly without lecturing. If the manager's edit reflects a
  personal style tic that should not be trained into the system, return
  NO_FIX with a short rationale explaining why it does not generalize.
- Sub-labels are free-form strings, not drawn from a fixed list. Keep them
  short (1–4 words) and descriptive, e.g. "parking-info-missing",
  "checkin-time-tone", "extend-stay-tool-unclear".
- Confidence is your own 0..1 self-assessment — not an alternate way to
  hedge. Return 0.9+ only when you are sure; return 0.3–0.6 when you are
  uncertain and the reader should weigh it lightly.
- proposedText must be non-null ONLY for categories that edit text:
  SOP_CONTENT, SOP_ROUTING, FAQ, SYSTEM_PROMPT, TOOL_CONFIG,
  PROPERTY_OVERRIDE. For MISSING_CAPABILITY and NO_FIX, proposedText must
  be null.
- capabilityRequest must be non-null ONLY when category is
  MISSING_CAPABILITY. Otherwise it must be null.
- artifactTarget.type must be NONE when category is NO_FIX or
  MISSING_CAPABILITY. Otherwise, pick the target type that matches the
  category (SOP for SOP_CONTENT/SOP_ROUTING, FAQ for FAQ, etc.) and
  include the target id from the evidence bundle when one is obvious
  (e.g. the sopCategory + status that was classified). If no id is
  knowable from the evidence, return id = null.
- Prefer editing an existing artifact over creating a new one. If the
  evidence bundle already shows an SOP variant or FAQ entry on the same
  topic, propose editing it rather than creating a duplicate.
- Think about prior corrections. If the bundle shows a recent APPLIED
  correction on the same artifact, be skeptical — either the prior fix
  was incomplete (genuine new correction) or the manager is oscillating
  (return NO_FIX with a rationale noting the conflict).
`.trim();

// ─── Structured output schema (OpenAI strict json_schema) ───────────────────

const DIAGNOSTIC_SCHEMA = {
  type: 'json_schema' as const,
  name: 'tuning_diagnostic',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: [
          'SOP_CONTENT',
          'SOP_ROUTING',
          'FAQ',
          'SYSTEM_PROMPT',
          'TOOL_CONFIG',
          'MISSING_CAPABILITY',
          'PROPERTY_OVERRIDE',
          'NO_FIX',
        ],
      },
      subLabel: { type: 'string' },
      confidence: { type: 'number' },
      rationale: { type: 'string' },
      proposedText: { type: ['string', 'null'] as any },
      artifactTarget: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['SOP', 'FAQ', 'SYSTEM_PROMPT', 'TOOL', 'PROPERTY_OVERRIDE', 'NONE'],
          },
          id: { type: ['string', 'null'] as any },
        },
        required: ['type', 'id'],
        additionalProperties: false,
      },
      capabilityRequest: {
        type: ['object', 'null'] as any,
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          rationale: { type: 'string' },
        },
        required: ['title', 'description', 'rationale'],
        additionalProperties: false,
      },
    },
    required: [
      'category',
      'subLabel',
      'confidence',
      'rationale',
      'proposedText',
      'artifactTarget',
      'capabilityRequest',
    ],
    additionalProperties: false,
  },
};

// ─── Size caps for the evidence bundle in the prompt ─────────────────────────
// The whole bundle can get large (Langfuse trace + 20-message context). We
// trim the heaviest parts so the LLM input stays well under model limits.

const MAX_CTX_MESSAGE_CHARS = 600;
const MAX_SOP_CONTENT_CHARS = 2000;
const MAX_FAQ_ANSWER_CHARS = 800;
const MAX_TRACE_JSON_CHARS = 8000;

// ─── Public entrypoint ───────────────────────────────────────────────────────

/**
 * Run the diagnostic pipeline end-to-end. Returns null when the OpenAI API
 * key is missing or the call fails — never throws into the caller.
 */
export async function runDiagnostic(
  input: DiagnosticInput,
  prisma: PrismaClient
): Promise<DiagnosticResult | null> {
  const span = startAiSpan('tuning:diagnostic', { triggerType: input.triggerType, messageId: input.messageId ?? null });
  try {
    const bundle = await assembleEvidenceBundle(input, prisma);

    // Persist the bundle so the sprint-04 tuning agent has post-hoc access
    // and so the suggestion row can link back via evidenceBundleId.
    const persisted = await prisma.evidenceBundle.create({
      data: {
        tenantId: input.tenantId,
        messageId: input.messageId ?? null,
        triggerType: input.triggerType as TuningConversationTriggerType,
        payload: bundle as any,
      },
      select: { id: true },
    });
    const evidenceBundleId = persisted.id;

    const originalText = bundle.disputedMessage?.originalAiText ?? '';
    const finalText = bundle.disputedMessage?.content ?? '';
    const similarity = semanticSimilarity(originalText, finalText);
    const magnitude = classifyEditMagnitude(originalText, finalText);
    const diff = computeMyersDiff(originalText, finalText);

    const openai = getOpenAI();
    if (!openai) {
      console.warn('[Diagnostic] OPENAI_API_KEY missing — returning null; caller should skip suggestion write.');
      span.end({ error: 'OPENAI_KEY_MISSING' });
      return null;
    }

    const llmInput = buildLlmInput(bundle, input, {
      originalText,
      finalText,
      similarity,
      magnitude,
      diff,
    });

    const start = Date.now();
    const reasoningEffort: 'high' = 'high';
    let result: DiagnosticResult | null = null;
    let modelUsed = getDiagnosticModel();
    try {
      let response: any;
      try {
        response = await callDiagnosticModel(openai, modelUsed, reasoningEffort, llmInput, input.tenantId);
      } catch (err) {
        if (isModelNotFoundError(err) && modelUsed !== FALLBACK_DIAGNOSTIC_MODEL) {
          fallBackToMini(`model_not_found for ${modelUsed}`);
          modelUsed = FALLBACK_DIAGNOSTIC_MODEL;
          response = await callDiagnosticModel(openai, modelUsed, reasoningEffort, llmInput, input.tenantId);
        } else {
          throw err;
        }
      }

      const rawText = extractOutputText(response);
      const usage = extractUsage(response);
      if (!rawText) {
        console.warn(
          `[Diagnostic] Empty model output — abstaining. model=${modelUsed} reasoning=${reasoningEffort} input_tokens=${usage.inputTokens} output_tokens=${usage.outputTokens}`
        );
        span.end({ error: 'EMPTY_OUTPUT', durationMs: Date.now() - start, model: modelUsed, ...usage });
        return null;
      }

      const parsed = JSON.parse(rawText) as Omit<DiagnosticResult, 'evidenceBundleId' | 'triggerType' | 'tenantId' | 'sourceMessageId' | 'diagMeta'>;
      result = normalizeResult(parsed, {
        evidenceBundleId,
        triggerType: input.triggerType as TuningConversationTriggerType,
        tenantId: input.tenantId,
        sourceMessageId: input.messageId ?? null,
        diagMeta: { similarity, magnitude, originalText, finalText, diff },
      });
      // Sprint 05 §1: one-line per-call log so cost + model + reasoning effort
      // are visible in stdout/Railway logs without hunting through Langfuse.
      console.log(
        `[Diagnostic] model=${modelUsed} reasoning=${reasoningEffort} input_tokens=${usage.inputTokens} output_tokens=${usage.outputTokens} category=${result.category} confidence=${result.confidence.toFixed(2)} duration_ms=${Date.now() - start}`
      );
      span.end(
        {
          category: result.category,
          subLabel: result.subLabel,
          confidence: result.confidence,
        },
        {
          durationMs: Date.now() - start,
          magnitude,
          similarity,
          model: modelUsed,
          reasoningEffort,
          ...usage,
        }
      );
      return result;
    } catch (err) {
      console.error('[Diagnostic] OpenAI call failed (non-fatal):', err);
      span.end({
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        model: modelUsed,
        reasoningEffort,
      });
      return null;
    }
  } catch (outerErr) {
    console.error('[Diagnostic] pipeline failed (non-fatal):', outerErr);
    span.end({ error: outerErr instanceof Error ? outerErr.message : String(outerErr) });
    return null;
  }
}

// ─── Prompt assembly ─────────────────────────────────────────────────────────

function buildLlmInput(
  bundle: EvidenceBundle,
  trigger: DiagnosticInput,
  diag: {
    originalText: string;
    finalText: string;
    similarity: number;
    magnitude: EditMagnitude;
    diff: MyersDiffResult;
  }
): string {
  const trimmedBundle = trimBundleForPrompt(bundle);
  const priorSummary = summarizePriorSuggestions(bundle);

  const sections: string[] = [
    `## Trigger`,
    `- type: ${trigger.triggerType}`,
    `- tenantId: ${trigger.tenantId}`,
    `- messageId: ${trigger.messageId ?? 'null'}`,
    `- note: ${trigger.note ? JSON.stringify(trigger.note) : 'null'}`,
    ``,
    `## Disputed reply`,
    `### Original AI text (what the AI produced)`,
    '```',
    diag.originalText || '(empty)',
    '```',
    ``,
    `### Final text (what was sent / what the manager said was right)`,
    '```',
    diag.finalText || '(empty)',
    '```',
    ``,
    `### Diff summary`,
    `- similarity: ${diag.similarity.toFixed(3)}`,
    `- magnitude: ${diag.magnitude}`,
    `- insertions (${diag.diff.insertions.length}): ${safeTruncateList(diag.diff.insertions, 400)}`,
    `- deletions (${diag.diff.deletions.length}): ${safeTruncateList(diag.diff.deletions, 400)}`,
    ``,
    '```diff',
    safeTruncate(diag.diff.unified, 2000),
    '```',
    ``,
    `## Conversation context (most recent ${bundle.conversationContext?.messages.length ?? 0} messages)`,
    renderContextMessages(trimmedBundle),
    ``,
    `## Hostaway entities`,
    '```json',
    JSON.stringify(trimmedBundle.entities, null, 2),
    '```',
    ``,
    `## Main AI trace (AiApiLog.ragContext and totals)`,
    '```json',
    safeTruncate(JSON.stringify(trimmedBundle.mainAiTrace ?? null, null, 2), MAX_TRACE_JSON_CHARS),
    '```',
    ``,
    `## SOPs in effect at the time of the disputed reply`,
    '```json',
    safeTruncate(JSON.stringify(trimmedBundle.sopsInEffect, null, 2), MAX_TRACE_JSON_CHARS),
    '```',
    ``,
    `## FAQ hits`,
    '```json',
    safeTruncate(JSON.stringify(trimmedBundle.faqHits, null, 2), MAX_TRACE_JSON_CHARS),
    '```',
    ``,
    `## Prior corrections for this property/category (last 90 days)`,
    priorSummary,
    ``,
    `## System prompt context`,
    '```json',
    JSON.stringify(bundle.systemPromptContext, null, 2),
    '```',
    ``,
    `## Your task`,
    `Produce the structured JSON per the schema. Remember:`,
    `- NO_FIX if the edit is cosmetic or a one-off preference. Do not invent a fix.`,
    `- MISSING_CAPABILITY only if the AI needed a tool that does not exist.`,
    `- artifactTarget.id should be the SOP category / FAQ id / tool name / prompt variant when knowable from the evidence above; otherwise null.`,
  ];
  return sections.join('\n');
}

function trimBundleForPrompt(bundle: EvidenceBundle): EvidenceBundle {
  return {
    ...bundle,
    conversationContext: bundle.conversationContext
      ? {
          ...bundle.conversationContext,
          messages: bundle.conversationContext.messages.map((m) => ({
            ...m,
            content: safeTruncate(m.content, MAX_CTX_MESSAGE_CHARS),
          })),
        }
      : null,
    sopsInEffect: bundle.sopsInEffect.map((s) => ({
      ...s,
      variants: s.variants.map((v) => ({ ...v, content: safeTruncate(v.content, MAX_SOP_CONTENT_CHARS) })),
      propertyOverrides: s.propertyOverrides.map((o) => ({ ...o, content: safeTruncate(o.content, MAX_SOP_CONTENT_CHARS) })),
    })),
    faqHits: bundle.faqHits.map((f) => ({
      ...f,
      answer: safeTruncate(f.answer, MAX_FAQ_ANSWER_CHARS),
    })),
  };
}

function renderContextMessages(bundle: EvidenceBundle): string {
  const msgs = bundle.conversationContext?.messages ?? [];
  if (msgs.length === 0) return '(none)';
  return msgs
    .map((m) => `- [${m.sentAt}] ${m.role}: ${m.content}`)
    .join('\n');
}

function summarizePriorSuggestions(bundle: EvidenceBundle): string {
  if (bundle.priorSuggestions.length === 0) return '(no prior suggestions for this property/category in the last 90 days)';
  return bundle.priorSuggestions
    .slice(0, 20)
    .map((p) => {
      const when = p.createdAt instanceof Date ? p.createdAt.toISOString() : String(p.createdAt);
      return `- ${when} ${p.status} ${p.actionType} sop=${p.sopCategory ?? '-'} faq=${p.faqEntryId ?? '-'} :: ${safeTruncate(p.rationale ?? '', 160)}`;
    })
    .join('\n');
}

function safeTruncate(s: string, max: number): string {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max) + `… [+${s.length - max} chars trimmed]`;
}

function safeTruncateList(items: string[], max: number): string {
  const joined = items.map((x) => JSON.stringify(x)).join(', ');
  return safeTruncate(joined, max);
}

// ─── OpenAI call (extracted so we can retry with a fallback model) ───────────

async function callDiagnosticModel(
  openai: OpenAI,
  model: string,
  reasoningEffort: 'high',
  llmInput: string,
  tenantId: string
): Promise<any> {
  return await (openai as any).responses.create({
    model,
    instructions: DIAGNOSTIC_SYSTEM_PROMPT,
    input: [{ role: 'user', content: llmInput }],
    reasoning: { effort: reasoningEffort },
    // Sprint 05 §1: bumped from 1500 to 4000. The full gpt-5.4 with
    // reasoning effort high spends a meaningful chunk of output tokens on
    // hidden reasoning before producing the structured JSON. 1500 starves
    // the model and produces empty output on real (non-NO_FIX) edits.
    max_output_tokens: 4000,
    text: { format: DIAGNOSTIC_SCHEMA },
    store: true,
    prompt_cache_key: `tuning-diagnostic-${tenantId}`,
    prompt_cache_retention: '24h',
  });
}

function extractUsage(response: any): { inputTokens: number; outputTokens: number; cachedInputTokens: number } {
  const u = response?.usage ?? {};
  return {
    inputTokens: typeof u.input_tokens === 'number' ? u.input_tokens : 0,
    outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : 0,
    cachedInputTokens:
      typeof u.input_tokens_details?.cached_tokens === 'number'
        ? u.input_tokens_details.cached_tokens
        : 0,
  };
}

// ─── Response parsing ────────────────────────────────────────────────────────

function extractOutputText(response: any): string | null {
  // Responses API: easiest path is response.output_text (string). If not
  // present, dig into the first output item's text content.
  if (typeof response?.output_text === 'string' && response.output_text.length > 0) {
    return response.output_text;
  }
  const output = response?.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (item?.type === 'message' && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (typeof c?.text === 'string' && c.text.length > 0) return c.text;
        }
      }
    }
  }
  return null;
}

function normalizeResult(
  parsed: Omit<DiagnosticResult, 'evidenceBundleId' | 'triggerType' | 'tenantId' | 'sourceMessageId' | 'diagMeta'>,
  extra: Pick<DiagnosticResult, 'evidenceBundleId' | 'triggerType' | 'tenantId' | 'sourceMessageId' | 'diagMeta'>
): DiagnosticResult {
  // Clamp confidence defensively.
  const clampedConfidence =
    Number.isFinite(parsed.confidence) ? Math.max(0, Math.min(1, Number(parsed.confidence))) : 0;

  // Honor category-specific invariants even if the model drifted:
  let proposedText = parsed.proposedText ?? null;
  let capabilityRequest = parsed.capabilityRequest ?? null;
  let artifactTarget = parsed.artifactTarget ?? { type: 'NONE' as const, id: null };

  if (parsed.category === 'NO_FIX' || parsed.category === 'MISSING_CAPABILITY') {
    proposedText = null;
    artifactTarget = { type: 'NONE', id: null };
  }
  if (parsed.category !== 'MISSING_CAPABILITY') {
    capabilityRequest = null;
  }

  return {
    category: parsed.category,
    subLabel: (parsed.subLabel ?? '').trim() || 'unlabeled',
    confidence: clampedConfidence,
    rationale: parsed.rationale ?? '',
    proposedText,
    artifactTarget,
    capabilityRequest,
    ...extra,
  };
}
