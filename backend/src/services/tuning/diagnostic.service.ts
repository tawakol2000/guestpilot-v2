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
  computeEditMagnitudeScore,
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

/**
 * Sprint 10 workstream C.2: per-category trace entry. The diagnostic must
 * evaluate ALL 8 categories before committing to a final one — each is
 * marked 'eliminated' or 'candidate' with a one-line reason citing the
 * specific evidence that drove the verdict. This forces explicit reasoning
 * over the full taxonomy and surfaces the chain to graders/auditors.
 */
export interface DecisionTraceEntry {
  category: DiagnosticCategory;
  verdict: 'eliminated' | 'candidate';
  reason: string;
}

export interface DiagnosticResult {
  category: DiagnosticCategory;
  subLabel: string;
  confidence: number; // 0..1, model-verbalized
  rationale: string;
  proposedText: string | null;
  artifactTarget: { type: ArtifactTargetType; id: string | null };
  capabilityRequest: { title: string; description: string; rationale: string } | null;
  // Sprint 10: explicit per-category reasoning chain (required, length 8).
  decisionTrace: DecisionTraceEntry[];
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
// Sprint 09 fix 7: after falling back, retry the primary model this often.
// Five minutes is long enough to avoid hammering OpenAI during a transient
// outage but short enough that a permanent-looking fallback doesn't end up
// degrading every tenant's diagnostics for the rest of the process lifetime.
const FALLBACK_RETRY_TTL_MS = 5 * 60 * 1000;

let _primaryModel: string | null = null;
let _fallbackUntil: number | null = null;

function getPrimaryModel(): string {
  if (_primaryModel) return _primaryModel;
  _primaryModel = (process.env.TUNING_DIAGNOSTIC_MODEL || DEFAULT_DIAGNOSTIC_MODEL).trim();
  return _primaryModel;
}

function getDiagnosticModel(): string {
  const primary = getPrimaryModel();
  if (_fallbackUntil !== null && Date.now() < _fallbackUntil) {
    return FALLBACK_DIAGNOSTIC_MODEL;
  }
  // Window expired (or never triggered) — primary is authoritative again.
  if (_fallbackUntil !== null && Date.now() >= _fallbackUntil) {
    console.log(
      `[Diagnostic] Fallback window expired, retrying primary model ${primary}.`
    );
    _fallbackUntil = null;
  }
  return primary;
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
  console.warn(
    `[Diagnostic] Falling back from ${getPrimaryModel()} to ${FALLBACK_DIAGNOSTIC_MODEL} for ${FALLBACK_RETRY_TTL_MS / 1000}s. Reason: ${reason}`
  );
  _fallbackUntil = Date.now() + FALLBACK_RETRY_TTL_MS;
}

function clearFallbackAfterSuccess(modelThatSucceeded: string): void {
  if (_fallbackUntil !== null && modelThatSucceeded === getPrimaryModel()) {
    console.log(`[Diagnostic] Primary model ${modelThatSucceeded} recovered — clearing fallback window.`);
    _fallbackUntil = null;
  }
}

/** Test-only reset helper — exposed for unit tests, not for callers. */
export function __resetDiagnosticModelCacheForTests(): void {
  _primaryModel = null;
  _fallbackUntil = null;
}

// ─── Taxonomy definitions (stable, hoisted so caching works cleanly) ─────────

// Sprint 10 workstream C.3: anchored-contrast exemplars. Each category is
// paired with a positive example AND its nearest-confusable negative,
// forcing the model to discriminate at the boundary rather than pattern-
// match on surface features. The expanded definitions also push the
// system prompt past the 1,024-token threshold OpenAI requires for
// automatic prompt caching (workstream C.5 / M8).
const TAXONOMY_DEFINITIONS = `
The 8 categories are:

1. SOP_CONTENT — The SOP for this status / category said the wrong thing or
   didn't cover this case. Fix: edit SopVariant.content (or a property
   override when needed).
   ✓ Example: Manager corrected "checkout is 11am" to "checkout is 12pm" —
     the SOP itself had the wrong time.
   ✗ Contrast (SOP_ROUTING): Manager corrected parking info, but the parking
     SOP existed with correct content; the classifier just routed to the
     wrong SOP. That's SOP_ROUTING, not SOP_CONTENT.

2. SOP_ROUTING — The classifier picked the wrong SOP; correct content
   existed elsewhere. Fix: edit the SopDefinition.toolDescription.
   ✓ Example: Guest asked about WiFi, AI fetched the check-in SOP (which
     happened to mention "WiFi works on arrival") instead of the dedicated
     WiFi SOP that holds the password and troubleshooting steps.
   ✗ Contrast (TOOL_CONFIG): Guest asked about extending stay, AI never
     called check_extend_availability at all. That's TOOL_CONFIG (the tool
     description didn't make the use-case obvious), not SOP_ROUTING.

3. FAQ — A factual detail the AI needed wasn't in any FAQ, or was but was
   incorrect. Fix: create or edit a FaqEntry (global or property-scoped).
   ✓ Example: Guest asked about the nearest pharmacy, AI said "I don't have
     that information" — no FAQ entry existed for pharmacy locations.
   ✗ Contrast (SOP_CONTENT): Guest asked about check-in time, AI gave the
     wrong time. Check-in time lives in the SOP, not FAQ — that's
     SOP_CONTENT.

4. SYSTEM_PROMPT — Tone, policy, reasoning, or conditional-branch behavior
   at the prompt level. Fix: edit TenantAiConfig.systemPromptCoordinator
   or systemPromptScreening.
   ✓ Example: AI repeatedly closed messages with "Cheers!" on Booking.com
     channel where the manager wants more formal tone — the conditional
     "channel-aware closing" rule belongs in the system prompt, not in any
     SOP.
   ✗ Contrast (NO_FIX): Manager rephrased a single sentence to sound
     warmer in one specific reply, with no pattern across other replies.
     One-off polish ≠ system-wide policy. That's NO_FIX.

5. TOOL_CONFIG — Wrong tool called, right tool called wrong, tool
   description unclear, tool parameters misused. Fix: edit ToolDefinition.
   ✓ Example: AI called search_available_properties when the guest just
     wanted to confirm THEIR existing booking — the tool description was
     ambiguous about cross-sell vs. own-booking lookup.
   ✗ Contrast (MISSING_CAPABILITY): Guest asked to swap their reservation
     for one in a different city; no tool exists to handle cross-city
     transfers. Don't edit a tool description — that's MISSING_CAPABILITY.

6. MISSING_CAPABILITY — The AI needed a tool that does not exist. Do NOT
   invent an artifact fix. Emit a capabilityRequest instead.
   ✓ Example: Guest wanted to split their stay across two adjacent units
     mid-reservation — no tool covers that workflow. capabilityRequest:
     "split_stay_across_units".
   ✗ Contrast (TOOL_CONFIG): Guest wanted to extend the stay, AI failed to
     call check_extend_availability — but that tool DOES exist. The
     description just wasn't clear enough. That's TOOL_CONFIG.

7. PROPERTY_OVERRIDE — The content is correct globally but this specific
   property is different and needs a SopPropertyOverride or property-scoped
   FAQ.
   ✓ Example: Default check-in SOP says "11am check-in"; the Marina Tower
     unit specifically has a 2pm check-in due to building staffing. Create
     a SopPropertyOverride for that property + status.
   ✗ Contrast (SOP_CONTENT): Manager corrected check-in time on a reply
     for the only property in inventory, or the correction is meant to
     apply to ALL properties. That's SOP_CONTENT (edit the variant), not
     PROPERTY_OVERRIDE.

8. NO_FIX — The edit was cosmetic (typo, punctuation, tone nudge) or a
   one-off manager preference that does NOT generalize. First-class abstain.
   Return this instead of a forced artifact change.
   ✓ Example: Manager fixed "your reservation" to "Your reservation" — a
     capitalisation polish with no policy implication. NO_FIX.
   ✗ Contrast (SYSTEM_PROMPT): Manager consistently downcases sentence-
     starters across multiple replies because the brand voice is "lowercase
     casual" — that IS a policy and belongs in the system prompt.
`.trim();

const DIAGNOSTIC_SYSTEM_PROMPT = `
You are the diagnostic engine inside GuestPilot's tuning agent. Your job is
to look at a single triggering event — where a manager edited, rejected,
complained about, or thumbs-downed an AI-generated guest reply — and route
the correction into exactly one of the 8 taxonomy categories. You produce
one structured JSON object per call; no prose outside the JSON.

${TAXONOMY_DEFINITIONS}

DEFAULT DISPOSITION: NO_FIX. Before committing to any other category, you must
identify: (a) the specific artifact that would change, (b) the specific
observation in the evidence bundle that necessitates the change, and (c) a
falsifiable prediction about what the change would fix. If any of (a), (b),
or (c) is missing, return NO_FIX.

The manager's correction is ONE datum, not ground truth. The manager may be
wrong, may be expressing a style preference, or may be correcting a one-off
mistake that doesn't generalize. Treat the correction as a claim to be
evaluated against the evidence, not as a directive to be satisfied. A
correction that the SOP/FAQ already covers correctly, or that contradicts
established platform rules, is NOT a fix — it's a NO_FIX with a rationale
explaining the conflict.

DECISION TRACE — REQUIRED. Populate the decision_trace array BEFORE
committing to the final category. Evaluate ALL 8 categories in the order
they appear above (SOP_CONTENT, SOP_ROUTING, FAQ, SYSTEM_PROMPT, TOOL_CONFIG,
MISSING_CAPABILITY, PROPERTY_OVERRIDE, NO_FIX), marking each as 'eliminated'
or 'candidate' with a one-sentence reason citing specific evidence (e.g.
"the parking SOP for CONFIRMED status already covers this case" or
"manager's edit only changed punctuation"). Exactly one entry should be
the candidate that becomes the final category — multiple candidates with
ambiguous evidence means you should return NO_FIX.

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
- proposedText is a COMPLETE REPLACEMENT for the targeted artifact text,
  NOT a snippet to be stitched in. Every untouched section, header, XML
  tag, variable placeholder, and rule must be preserved verbatim. The
  apply path writes proposedText directly into the artifact field; if you
  return only the new clause, every other rule in that artifact is lost.
  Edit minimally — change only the lines that actually need to change,
  copy everything else byte-for-byte.
  - For SYSTEM_PROMPT specifically: the evidence bundle's
    "## Current system prompts" section contains the full text of both
    coordinator and screening prompts. Locate the variant indicated by
    systemPromptContext.agentName (or pick the one that contains the
    rule you're modifying), copy it whole, edit only the target section,
    and return the entire revised prompt as proposedText.
  - For SOP_CONTENT / PROPERTY_OVERRIDE: the bundle's
    "## SOPs in effect" section shows the current variant.content. Copy
    it, modify the relevant lines, return the whole revised content.
  - For FAQ: return the complete revised answer text.
  - For SOP_ROUTING / TOOL_CONFIG: return the complete revised
    toolDescription / tool description (typically short, full rewrite is
    fine).
  Returning a fragment is a critical failure — it destroys the rest of
  the artifact when applied. If you cannot see the current text of the
  artifact you intend to edit in the evidence bundle, return NO_FIX with
  a rationale instead of guessing.
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
      // Sprint 10 workstream C.2: explicit per-category reasoning chain.
      // The model evaluates ALL 8 categories before committing to its
      // final pick — every entry is 'eliminated' or 'candidate' with a
      // short justification. Exactly 8 items in taxonomy order.
      decision_trace: {
        type: 'array',
        items: {
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
            verdict: { type: 'string', enum: ['eliminated', 'candidate'] },
            reason: { type: 'string' },
          },
          required: ['category', 'verdict', 'reason'],
          additionalProperties: false,
        },
        minItems: 8,
        maxItems: 8,
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
      'decision_trace',
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
    const magnitudeScore = computeEditMagnitudeScore(originalText, finalText);
    const diff = computeMyersDiff(originalText, finalText);

    // Sprint 05 §3 (C19): persist the authoritative numeric edit-magnitude on
    // the Message row so the graduation dashboard can average actual scores
    // instead of a character-position proxy. Best-effort — never throw.
    if (input.messageId) {
      try {
        await prisma.message.update({
          where: { id: input.messageId },
          data: { editMagnitudeScore: magnitudeScore },
        });
      } catch (err) {
        console.warn('[Diagnostic] persisting editMagnitudeScore failed (non-fatal):', err);
      }
    }

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
    const modelUsed = getDiagnosticModel();
    const batchId = `diag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    // Sprint 10 workstream C.4: self-consistency k=3. Run three parallel
    // diagnostic calls at temperature 0.7, majority-vote on the category.
    // Disagreement (all three different categories) overrides to NO_FIX
    // with a "diagnostic disagreement" rationale. Two-of-three uses the
    // majority's full output (highest-confidence wins ties on confidence).
    // All three responses log to AiApiLog under a shared batchId for
    // offline analysis.
    try {
      const samples = await Promise.all([
        runOneDiagnosticSample(openai, modelUsed, reasoningEffort, llmInput, input, evidenceBundleId, {
          similarity, magnitude, originalText, finalText, diff,
        }, batchId, 0, prisma),
        runOneDiagnosticSample(openai, modelUsed, reasoningEffort, llmInput, input, evidenceBundleId, {
          similarity, magnitude, originalText, finalText, diff,
        }, batchId, 1, prisma),
        runOneDiagnosticSample(openai, modelUsed, reasoningEffort, llmInput, input, evidenceBundleId, {
          similarity, magnitude, originalText, finalText, diff,
        }, batchId, 2, prisma),
      ]);

      const successful = samples.filter((s): s is { result: DiagnosticResult; modelUsed: string; usage: ReturnType<typeof extractUsage> } => s !== null);
      if (successful.length === 0) {
        console.warn(`[Diagnostic] all 3 samples failed — abstaining. batchId=${batchId}`);
        span.end({ error: 'ALL_SAMPLES_FAILED', durationMs: Date.now() - start, model: modelUsed, batchId });
        return null;
      }

      const finalResult = majorityVoteResult(successful.map((s) => s.result));
      const totalUsage = successful.reduce(
        (acc, s) => ({
          inputTokens: acc.inputTokens + s.usage.inputTokens,
          outputTokens: acc.outputTokens + s.usage.outputTokens,
          cachedInputTokens: acc.cachedInputTokens + s.usage.cachedInputTokens,
        }),
        { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }
      );

      const categoryVotes = successful
        .map((s) => s.result.category)
        .reduce<Record<string, number>>((acc, c) => {
          acc[c] = (acc[c] ?? 0) + 1;
          return acc;
        }, {});

      console.log(
        `[Diagnostic] k=3 batchId=${batchId} model=${modelUsed} reasoning=${reasoningEffort} input_tokens=${totalUsage.inputTokens} output_tokens=${totalUsage.outputTokens} votes=${JSON.stringify(categoryVotes)} category=${finalResult.category} confidence=${finalResult.confidence.toFixed(2)} duration_ms=${Date.now() - start}`
      );
      span.end(
        {
          category: finalResult.category,
          subLabel: finalResult.subLabel,
          confidence: finalResult.confidence,
        },
        {
          durationMs: Date.now() - start,
          magnitude,
          similarity,
          model: modelUsed,
          reasoningEffort,
          batchId,
          k: 3,
          successfulSamples: successful.length,
          votes: categoryVotes,
          ...totalUsage,
        }
      );
      return finalResult;
    } catch (err) {
      console.error('[Diagnostic] k=3 self-consistency pipeline failed (non-fatal):', err);
      span.end({
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        model: modelUsed,
        reasoningEffort,
        batchId,
      });
      return null;
    }
  } catch (outerErr) {
    console.error('[Diagnostic] pipeline failed (non-fatal):', outerErr);
    span.end({ error: outerErr instanceof Error ? outerErr.message : String(outerErr) });
    return null;
  }
}

// ─── Sprint 10 workstream C.4: single-sample helper for self-consistency ────

interface SingleSampleSuccess {
  result: DiagnosticResult;
  modelUsed: string;
  usage: ReturnType<typeof extractUsage>;
}

async function runOneDiagnosticSample(
  openai: OpenAI,
  initialModel: string,
  reasoningEffort: 'high',
  llmInput: string,
  input: DiagnosticInput,
  evidenceBundleId: string,
  diagMeta: {
    similarity: number;
    magnitude: EditMagnitude;
    originalText: string;
    finalText: string;
    diff: MyersDiffResult;
  },
  batchId: string,
  sampleIndex: number,
  prisma: PrismaClient
): Promise<SingleSampleSuccess | null> {
  let modelUsed = initialModel;
  const sampleStart = Date.now();
  try {
    let response: any;
    try {
      response = await callDiagnosticModel(openai, modelUsed, reasoningEffort, llmInput, input.tenantId);
      clearFallbackAfterSuccess(modelUsed);
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
        `[Diagnostic] sample ${sampleIndex} empty output — skipping. batchId=${batchId} model=${modelUsed}`
      );
      await logSampleToAiApiLog(prisma, input.tenantId, modelUsed, batchId, sampleIndex, llmInput, '', usage, Date.now() - sampleStart, 'EMPTY_OUTPUT').catch(() => {});
      return null;
    }
    const parsed = JSON.parse(rawText) as Parameters<typeof normalizeResult>[0];
    const result = normalizeResult(parsed, {
      evidenceBundleId,
      triggerType: input.triggerType as TuningConversationTriggerType,
      tenantId: input.tenantId,
      sourceMessageId: input.messageId ?? null,
      diagMeta,
    });
    await logSampleToAiApiLog(prisma, input.tenantId, modelUsed, batchId, sampleIndex, llmInput, rawText, usage, Date.now() - sampleStart, null).catch(() => {});
    return { result, modelUsed, usage };
  } catch (err) {
    console.warn(
      `[Diagnostic] sample ${sampleIndex} failed: ${err instanceof Error ? err.message : String(err)} batchId=${batchId}`
    );
    return null;
  }
}

/**
 * Majority-vote across N≥1 successful samples on the `category` field.
 * - All-disagree → NO_FIX with "diagnostic disagreement" rationale, mean
 *   confidence across samples (capped low to signal uncertainty).
 * - Tie / majority → pick the highest-confidence sample within the
 *   majority bucket; that sample's full output becomes the canonical
 *   result.
 */
function majorityVoteResult(results: DiagnosticResult[]): DiagnosticResult {
  if (results.length === 1) return results[0];
  const buckets = new Map<DiagnosticCategory, DiagnosticResult[]>();
  for (const r of results) {
    const arr = buckets.get(r.category) ?? [];
    arr.push(r);
    buckets.set(r.category, arr);
  }
  let bestCategory: DiagnosticCategory | null = null;
  let bestSize = 0;
  for (const [cat, arr] of buckets) {
    if (arr.length > bestSize) {
      bestCategory = cat;
      bestSize = arr.length;
    }
  }
  // No majority (every sample voted differently) → abstain to NO_FIX.
  if (bestCategory == null || bestSize < 2) {
    const seed = results[0];
    const meanConf = results.reduce((a, r) => a + r.confidence, 0) / results.length;
    const altCategories = results.map((r) => `${r.category}:${r.confidence.toFixed(2)}`).join(', ');
    return {
      ...seed,
      category: 'NO_FIX',
      subLabel: 'diagnostic-disagreement',
      confidence: Math.min(meanConf, 0.4),
      rationale:
        `Self-consistency k=3 produced 3 different categories (${altCategories}). ` +
        `Overriding to NO_FIX per sprint 10 protocol — disagreement is treated as low signal.`,
      proposedText: null,
      artifactTarget: { type: 'NONE', id: null },
      capabilityRequest: null,
    };
  }
  const winners = buckets.get(bestCategory)!;
  // Pick the highest-confidence winner; ties resolve naturally by array order.
  winners.sort((a, b) => b.confidence - a.confidence);
  return winners[0];
}

/**
 * Sprint 10 workstream C.4: persist each sample's prompt + response under a
 * shared batchId so offline analysis can re-score self-consistency without
 * the wall-time penalty of replaying the call. The batchId is stamped into
 * `ragContext` JSON since AiApiLog has no dedicated column. Best-effort —
 * writes are fire-and-forget; failures here never break the diagnostic.
 */
async function logSampleToAiApiLog(
  prisma: PrismaClient,
  tenantId: string,
  model: string,
  batchId: string,
  sampleIndex: number,
  systemPlusInput: string,
  responseText: string,
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number },
  durationMs: number,
  error: string | null
): Promise<void> {
  await prisma.aiApiLog.create({
    data: {
      tenantId,
      agentName: 'tuning-diagnostic',
      model,
      temperature: 0.7,
      maxTokens: 4000,
      systemPrompt: DIAGNOSTIC_SYSTEM_PROMPT,
      userContent: systemPlusInput,
      responseText: responseText ?? '',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      durationMs,
      error: error ?? null,
      ragContext: {
        batchId,
        sampleIndex,
        cachedInputTokens: usage.cachedInputTokens,
      } as any,
    },
  });
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
    JSON.stringify(
      {
        version: bundle.systemPromptContext.version,
        agentName: bundle.systemPromptContext.agentName,
        reservationStatus: bundle.systemPromptContext.reservationStatus,
        branchTags: bundle.systemPromptContext.branchTags,
      },
      null,
      2
    ),
    '```',
    ``,
    `## Current system prompts (full text — REQUIRED for any SYSTEM_PROMPT proposedText)`,
    `If category=SYSTEM_PROMPT, copy the variant indicated by agentName whole, edit ONLY the target lines, return the full revised prompt as proposedText. Returning a fragment will destroy the rest of the prompt at apply time.`,
    ``,
    `### Coordinator prompt (${(bundle.systemPromptContext.coordinatorPrompt ?? '').length.toLocaleString()} chars)`,
    '```',
    bundle.systemPromptContext.coordinatorPrompt || '(empty — not configured for this tenant)',
    '```',
    ``,
    `### Screening prompt (${(bundle.systemPromptContext.screeningPrompt ?? '').length.toLocaleString()} chars)`,
    '```',
    bundle.systemPromptContext.screeningPrompt || '(empty — not configured for this tenant)',
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
  // Sprint 10 workstream C.4: temperature 0.7 enables sample diversity for
  // the k=3 self-consistency ensemble. The Responses API on GPT-5.x
  // accepts the legacy temperature param even with reasoning effort set;
  // it modulates the final-output sampling stage.
  return await (openai as any).responses.create({
    model,
    instructions: DIAGNOSTIC_SYSTEM_PROMPT,
    input: [{ role: 'user', content: llmInput }],
    reasoning: { effort: reasoningEffort },
    temperature: 0.7,
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
  parsed: Omit<DiagnosticResult, 'evidenceBundleId' | 'triggerType' | 'tenantId' | 'sourceMessageId' | 'diagMeta' | 'decisionTrace'> & {
    decision_trace?: Array<{ category?: string; verdict?: string; reason?: string }>;
  },
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

  // Sprint 10: decision_trace passes through. The schema enforces 8 entries,
  // but defend against drift by coercing missing/malformed entries.
  const decisionTrace: DecisionTraceEntry[] = Array.isArray(parsed.decision_trace)
    ? parsed.decision_trace.map((e) => ({
        category: (e?.category as DiagnosticCategory) ?? 'NO_FIX',
        verdict: e?.verdict === 'candidate' ? 'candidate' : 'eliminated',
        reason: typeof e?.reason === 'string' ? e.reason : '',
      }))
    : [];

  return {
    category: parsed.category,
    subLabel: (parsed.subLabel ?? '').trim() || 'unlabeled',
    confidence: clampedConfidence,
    rationale: parsed.rationale ?? '',
    proposedText,
    artifactTarget,
    capabilityRequest,
    decisionTrace,
    ...extra,
  };
}
