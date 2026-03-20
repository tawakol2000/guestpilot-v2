/**
 * LLM-as-Judge for classifier retrieval evaluation.
 * Runs after every guestCoordinator AI response (fire-and-forget).
 * When classifier confidence is low AND judge finds wrong retrieval,
 * automatically adds the guest message as a new training example.
 */

import Anthropic from '@anthropic-ai/sdk';
import { PrismaClient } from '@prisma/client';
import { addExample, getExampleByText } from './classifier-store.service';
import { reinitializeClassifier, getMaxSimilarityForLabels } from './classifier.service';
import { getTenantAiConfig } from './tenant-config.service';

let _anthropic: Anthropic | null = null;
function getJudgeClient(): Anthropic | null {
  if (!_anthropic) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) { console.warn('[Judge] No ANTHROPIC_API_KEY — judge disabled'); return null; }
    _anthropic = new Anthropic({ apiKey: key });
  }
  return _anthropic;
}

// Per-tenant threshold cache (5-min TTL) — avoids a DB hit on every message
const _thresholdCache = new Map<string, { judgeThreshold: number; autoFixThreshold: number; expiresAt: number }>();

async function getThresholds(tenantId: string, prisma: PrismaClient): Promise<{ judgeThreshold: number; autoFixThreshold: number }> {
  const cached = _thresholdCache.get(tenantId);
  if (cached && Date.now() < cached.expiresAt) {
    return { judgeThreshold: cached.judgeThreshold, autoFixThreshold: cached.autoFixThreshold };
  }
  const cfg = await prisma.tenantAiConfig.findUnique({
    where: { tenantId },
    select: { judgeThreshold: true, autoFixThreshold: true },
  });
  const result = {
    judgeThreshold:  cfg?.judgeThreshold  ?? 0.75,
    autoFixThreshold: cfg?.autoFixThreshold ?? 0.70,
  };
  _thresholdCache.set(tenantId, { ...result, expiresAt: Date.now() + 5 * 60 * 1000 });
  return result;
}

/** Call after saving new thresholds so the next message picks them up immediately. */
export function invalidateThresholdCache(tenantId: string): void {
  _thresholdCache.delete(tenantId);
}

// Rate limit: max auto-fixes per hour per tenant
const _fixCounts = new Map<string, { count: number; resetAt: number }>();
const MAX_FIXES_PER_HOUR = 10;

function canAutoFix(tenantId: string): boolean {
  const now = Date.now();
  const entry = _fixCounts.get(tenantId);
  if (!entry || now > entry.resetAt) {
    _fixCounts.set(tenantId, { count: 0, resetAt: now + 3600000 });
    return true;
  }
  return entry.count < MAX_FIXES_PER_HOUR;
}

function recordAutoFix(tenantId: string): void {
  const entry = _fixCounts.get(tenantId);
  if (entry) entry.count++;
}

// Periodic cleanup of expired cache entries (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _thresholdCache.entries()) {
    if (now > entry.expiresAt) _thresholdCache.delete(key);
  }
  for (const [key, entry] of _fixCounts.entries()) {
    if (now > entry.resetAt) _fixCounts.delete(key);
  }
}, 5 * 60 * 1000);

// All valid SOP chunk IDs the judge can recommend (22 RAG categories)
const VALID_CHUNK_IDS = [
  // Original 11
  'sop-cleaning',
  'sop-amenity-request',
  'sop-maintenance',
  'sop-wifi-doorcode',
  'sop-visitor-policy',
  'sop-early-checkin',
  'sop-late-checkout',
  'sop-complaint',
  'property-info',
  'property-description',
  // New 11
  'sop-booking-inquiry',
  'pricing-negotiation',
  'pre-arrival-logistics',
  'sop-booking-modification',
  'sop-booking-confirmation',
  'payment-issues',
  'post-stay-issues',
  'sop-long-term-rental',
  'sop-booking-cancellation',
  'sop-property-viewing',
  'non-actionable',
  'contextual',
];

const JUDGE_SYSTEM_PROMPT = `You are a retrieval quality evaluator for a hospitality AI system.

The system works like this:
- A guest sends a message
- A classifier selects which SOP (Standard Operating Procedure) documents to include in the AI's context
- The AI then responds using those documents

Your job: evaluate whether the classifier selected the RIGHT documents.

Available SOP document IDs (22 total) and what they cover:

Original 11:
- sop-cleaning: cleaning requests, housekeeping, mopping, $20 fee
- sop-amenity-request: item requests (towels, pillows, crib, blender, etc.)
- sop-maintenance: broken items, leaks, AC, electrical, plumbing, pests, mold
- sop-wifi-doorcode: WiFi password, WiFi name, door code, internet connection issues
- sop-visitor-policy: visitors, friends coming over, family visits, passport verification
- sop-early-checkin: early check-in, arriving before 3pm, bag drop
- sop-late-checkout: late checkout, leaving after 11am, extending stay
- sop-complaint: guest dissatisfaction, review threats, property quality complaints
- property-info: address, floor, bedrooms, check-in/out times, door code, WiFi credentials
- property-description: building features, pool, gym, parking

Other categories:
- sop-booking-inquiry: availability checks, new booking requests, unit options
- pricing-negotiation: discounts, rates, budget concerns, price negotiations
- pre-arrival-logistics: directions, arrival coordination, location sharing, airport transfer
- sop-booking-modification: date changes, guest count changes, unit swaps, adding/removing nights
- sop-booking-confirmation: verifying reservation exists, confirming booking details/status
- payment-issues: payment failures, receipts, billing disputes, refunds, overcharges
- post-stay-issues: lost items after checkout, post-stay complaints, damage deposit questions
- sop-long-term-rental: monthly rental inquiries, long-term contracts, corporate stays
- sop-booking-cancellation: cancellation requests, cancellation policy questions
- sop-property-viewing: property tours, photo/video requests, filming inquiries
- non-actionable: greetings ("hi", "hello", "مرحبا"), test messages, wrong chat, house rules questions, scheduling questions, working hours, emergencies (gas, safety), noise complaints — topics already handled by the baked-in system prompt
- contextual: ONLY short follow-ups to an ongoing conversation ("ok", "yes", "sure", "5am", "tomorrow works", "got it", "👍") — triggers re-injection of the previous topic's SOP

Baked-in categories (handled by system prompt, never retrieved):
- sop-scheduling, sop-house-rules, sop-escalation-immediate, sop-escalation-scheduled

IMPORTANT distinction between contextual and non-actionable:
- "contextual" = the message is a FOLLOW-UP to a previous topic (e.g., guest said "ok" after being told about cleaning). The system re-injects the last SOP.
- "non-actionable" = the message has NO ongoing topic context (greetings, test messages, house rules questions, scheduling questions, emergencies). The system prompt handles it directly.

Examples:
- "Hi" → non-actionable (greeting, no previous topic)
- "Hello Omar" → non-actionable (greeting)
- "Ok thanks" → contextual (follow-up acknowledgment)
- "Can I smoke?" → non-actionable (house rules, baked in)
- "Sure" → contextual (follow-up)

Return ONLY raw JSON, no markdown, no explanation outside the JSON:
{"retrieval_correct":true,"correct_labels":[],"confidence":"high","reasoning":"one sentence"}`;

export interface JudgeInput {
  tenantId: string;
  conversationId: string;
  guestMessage: string;
  classifierLabels: string[];
  classifierMethod: string;
  classifierTopSim: number;
  /** LR sigmoid confidence (primary confidence metric). Falls back to classifierTopSim if absent. */
  confidence?: number;
  neighbors: Array<{ labels: string[]; similarity: number }>;
  aiResponse: string;
  /** When Tier 2 resolved, pass its labels here to skip the judge call */
  tier2Labels?: string[];
  /** Whether Tier 3 re-injected cached labels (don't learn from these) */
  tier3Reinjected?: boolean;
}

/**
 * Returns true if every winning label appears in at least 2 of the 3 nearest
 * neighbors. When this is true, the classifier voted with majority agreement
 * and the judge is not needed even at low similarity.
 * Empty labels → false (uncertain, run judge).
 * No neighbors → false (no data, run judge).
 */
function hasMajorityNeighborSupport(
  labels: string[],
  neighbors: Array<{ labels: string[]; similarity: number }>,
): boolean {
  if (labels.length === 0) return false;
  if (neighbors.length === 0) return false;
  for (const label of labels) {
    const supportCount = neighbors.filter(n => n.labels.includes(label)).length;
    if (supportCount < 2) return false;
  }
  return true;
}

// Claude Haiku 4.5 pricing (per token)
const HAIKU_INPUT_COST  = 0.80  / 1_000_000; // $0.80 per million
const HAIKU_OUTPUT_COST = 4.00  / 1_000_000; // $4.00 per million

export interface JudgeResult {
  retrievalCorrect: boolean;
  correctLabels: string[];
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

/**
 * Run LLM-as-judge evaluation and handle self-improvement.
 * FIRE AND FORGET — call without await. Never blocks the AI pipeline.
 *
 * Three paths:
 * 1. Tier 2 already resolved → use Tier 2's labels as correction (skip judge call, save ~$0.0001)
 * 2. Tier 3 re-injected → skip entirely (contextual messages shouldn't become Tier 1 training data)
 * 3. Neither → run the judge (existing flow)
 */
export async function evaluateAndImprove(input: JudgeInput, prisma: PrismaClient): Promise<void> {
  try {
    // ── Resolve confidence: prefer LR sigmoid, fall back to KNN topSimilarity ──
    const effectiveConfidence = input.confidence ?? input.classifierTopSim;

    // ── Fetch tenant config for judgeMode ──────────────────────────────
    const tenantConfig = await getTenantAiConfig(input.tenantId, prisma);
    const judgeMode: 'evaluate_all' | 'sampling' =
      (tenantConfig as any).judgeMode === 'sampling' ? 'sampling' : 'evaluate_all';

    // ── Tier 3 re-injected — skip in ALL modes ─────────────────────────
    // Contextual messages shouldn't become Tier 1 training data.
    if (input.tier3Reinjected) {
      console.log(`[Judge] Mode: ${judgeMode} — skipping (tier3 re-injected)`);
      await saveSkipRecord(input, 'tier3_contextual', prisma);
      return;
    }

    if (judgeMode === 'evaluate_all') {
      console.log(`[Judge] Mode: evaluate_all — evaluating (tier3=${!!input.tier3Reinjected})`);
    }

    // ── Tier 2 feedback path (FREE — no judge call) ─────────────────────
    // Runs BEFORE majority-support / threshold checks so corrections are
    // always stored even when neighbors happen to agree with Tier 1.
    // Tier 2 already called Haiku WITH conversation context and got the right labels.
    // Use Tier 2's labels directly as the correction — more reliable and cheaper.
    if (input.tier2Labels && input.tier2Labels.length > 0) {
      const tier2Differs = !arraysEqual(input.classifierLabels, input.tier2Labels);
      if (tier2Differs && canAutoFix(input.tenantId)) {
        const validLabels = input.tier2Labels.filter(l => VALID_CHUNK_IDS.includes(l));
        if (validLabels.length > 0) {
          // Validate Tier 2 labels have reasonable semantic similarity to existing training examples.
          // Prevents auto-fixing with confident-but-wrong labels (e.g., "extend stay" → sop-late-checkout
          // when the correct label is sop-booking-modification).
          const tier2SimCheck = await getMaxSimilarityForLabels(input.guestMessage, validLabels);
          if (tier2SimCheck < 0.35) {
            console.log(`[Judge] Tier 2 labels [${validLabels.join(', ')}] have low similarity (${tier2SimCheck.toFixed(3)}) to existing examples — skipping auto-fix, falling through to judge`);
            // Don't return — fall through to the standard judge path below
          } else {
            const existing = await getExampleByText(input.tenantId, input.guestMessage, prisma);
            if (existing) {
              console.log(`[Judge] Tier 2 feedback — example already exists: "${input.guestMessage.substring(0, 50)}"`);
              return;
            }
            await addExample(input.tenantId, input.guestMessage, validLabels, 'tier2-feedback', prisma);
            recordAutoFix(input.tenantId);

            // Save evaluation record for observability
            await prisma.classifierEvaluation.create({
              data: {
                tenantId: input.tenantId,
                conversationId: input.conversationId,
                guestMessage: input.guestMessage,
                classifierLabels: input.classifierLabels,
                classifierMethod: input.classifierMethod,
                classifierTopSim: input.classifierTopSim,
                judgeCorrectLabels: validLabels,
                retrievalCorrect: false,
                judgeConfidence: 'high',
                judgeReasoning: `Tier 2 resolved: [${validLabels.join(', ')}] (lrConf=${(input.confidence ?? input.classifierTopSim).toFixed(3)})`,
                judgeInputTokens: 0,
                judgeOutputTokens: 0,
                judgeCost: 0,
                autoFixed: true,
              },
            }).catch(err => console.warn('[Judge] Failed to save Tier 2 feedback evaluation:', err));

            await reinitializeClassifier(input.tenantId, prisma);
            console.log(`[Judge] Tier 2 feedback: "${input.guestMessage.substring(0, 50)}" → [${validLabels.join(', ')}] (skipped judge call)`);
            return; // Tier 2 auto-fix succeeded — don't also run the judge
          }
        }
      } else if (!tier2Differs) {
        return; // Tier 2 agrees with Tier 1 — no correction needed
      }
    }

    // Load per-tenant thresholds (cached)
    const thresholds = await getThresholds(input.tenantId, prisma);

    // ── Mode-dependent skip logic ─────────────────────────────────────
    if (judgeMode === 'sampling') {
      // In sampling mode: keep existing skip conditions, but 30% random sample of skips
      let skipReason: string | null = null;

      if (effectiveConfidence >= thresholds.judgeThreshold) {
        skipReason = 'confident_skip';
      } else if (hasMajorityNeighborSupport(input.classifierLabels, input.neighbors)) {
        skipReason = 'neighbor_agreement_skip';
      }

      if (skipReason) {
        // 30% random sampling: evaluate anyway for quality monitoring
        if (Math.random() < 0.30) {
          console.log(`[Judge] Mode: sampling — random sample triggered (would have skipped: ${skipReason})`);
          // Fall through to standard judge path
        } else {
          console.log(`[Judge] Mode: sampling — skipping (${skipReason}, lrConf=${effectiveConfidence.toFixed(3)}, knnSim=${input.classifierTopSim.toFixed(3)})`);
          await saveSkipRecord(input, skipReason as any, prisma);
          return;
        }
      }
    }
    // In evaluate_all mode: skip conditions are removed — always evaluate

    // ── Standard judge path ───────────────────────────────────────────────
    // Step 1: Call the judge
    const judgeResult = await callJudge(input);
    if (!judgeResult) return; // Judge failed, silently bail

    // Step 2: Save evaluation to DB
    await prisma.classifierEvaluation.create({
      data: {
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        guestMessage: input.guestMessage,
        classifierLabels: input.classifierLabels,
        classifierMethod: input.classifierMethod,
        classifierTopSim: input.classifierTopSim,
        judgeCorrectLabels: judgeResult.correctLabels,
        retrievalCorrect: judgeResult.retrievalCorrect,
        judgeConfidence: judgeResult.confidence,
        judgeReasoning: judgeResult.reasoning,
        judgeInputTokens: judgeResult.inputTokens,
        judgeOutputTokens: judgeResult.outputTokens,
        judgeCost: judgeResult.cost,
        autoFixed: false,
      },
    }).catch(err => console.warn('[Judge] Failed to save evaluation:', err));

    // Step 3: Decide whether to auto-fix
    if (
      !judgeResult.retrievalCorrect &&
      effectiveConfidence < thresholds.autoFixThreshold &&
      canAutoFix(input.tenantId)
    ) {
      // Verify the labels are valid
      const validLabels = judgeResult.correctLabels.filter(l => VALID_CHUNK_IDS.includes(l));

      // T028: Guard — don't add example with empty labels
      if (validLabels.length > 0) {
        // Check for duplicate
        const existing = await getExampleByText(input.tenantId, input.guestMessage, prisma);
        if (existing) {
          console.log(`[Judge] Example already exists for: "${input.guestMessage.substring(0, 50)}"`);
          return;
        }

        // Add the actual guest message as a new training example
        await addExample(input.tenantId, input.guestMessage, validLabels, 'llm-judge', prisma);
        recordAutoFix(input.tenantId);

        // Mark evaluation as auto-fixed
        await prisma.classifierEvaluation.updateMany({
          where: {
            tenantId: input.tenantId,
            guestMessage: input.guestMessage,
            autoFixed: false,
          },
          data: { autoFixed: true },
        }).catch(() => {});

        // Re-initialize the classifier with the new example
        await reinitializeClassifier(input.tenantId, prisma);

        console.log(`[Judge] Self-improvement: added "${input.guestMessage.substring(0, 50)}" → [${validLabels.join(', ')}]`);
      }
    } else if (!judgeResult.retrievalCorrect && effectiveConfidence >= 0.7) {
      console.log(`[Judge] High-confidence misclassification (lrConf=${effectiveConfidence.toFixed(2)}, knnSim=${input.classifierTopSim.toFixed(2)}), flagged for review: "${input.guestMessage.substring(0, 50)}"`);
    }

    // Step 4: Low-confidence reinforcement — judge says correct but Tier 1 barely recognized it.
    // Add as training example so Tier 1 handles it confidently next time (no Tier 2 needed).
    const LOW_SIM_REINFORCE_THRESHOLD = 0.40;
    if (
      judgeResult.retrievalCorrect &&
      effectiveConfidence < LOW_SIM_REINFORCE_THRESHOLD &&
      canAutoFix(input.tenantId)
    ) {
      const existing = await getExampleByText(input.tenantId, input.guestMessage, prisma);
      if (!existing) {
        const reinforceLabels = judgeResult.correctLabels.filter(l => VALID_CHUNK_IDS.includes(l));
        // T028: Guard — don't add example with empty labels
        if (reinforceLabels.length > 0) {
          await addExample(input.tenantId, input.guestMessage, reinforceLabels, 'low-sim-reinforce', prisma);
          recordAutoFix(input.tenantId);
          await reinitializeClassifier(input.tenantId, prisma);
          console.log(`[Judge] Low-conf reinforcement (lrConf=${effectiveConfidence.toFixed(2)}, knnSim=${input.classifierTopSim.toFixed(2)}): "${input.guestMessage.substring(0, 50)}" → [${reinforceLabels.join(', ') || '(contextual)'}]`);
        }
      }
    }
  } catch (err) {
    console.warn('[Judge] evaluateAndImprove failed (non-fatal):', err);
  }
}

/**
 * T019 — Save a ClassifierEvaluation record when the judge skips evaluation,
 * recording the skip reason for observability.
 */
async function saveSkipRecord(
  input: JudgeInput,
  skipReason: 'tier3_contextual' | 'confident_skip' | 'neighbor_agreement_skip' | 'sampling_skip',
  prisma: PrismaClient,
): Promise<void> {
  await prisma.classifierEvaluation.create({
    data: {
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      guestMessage: input.guestMessage,
      classifierLabels: input.classifierLabels,
      classifierMethod: input.classifierMethod,
      classifierTopSim: input.classifierTopSim,
      skipReason,
      retrievalCorrect: true, // default — we don't know since we skipped
    },
  }).catch(err => console.warn(`[Judge] Failed to save skip record (${skipReason}):`, err));
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sorted1 = [...a].sort();
  const sorted2 = [...b].sort();
  return sorted1.every((v, i) => v === sorted2[i]);
}

async function callJudge(input: JudgeInput): Promise<JudgeResult | null> {
  try {
    const client = getJudgeClient();
    if (!client) return null;

    const lrConf = input.confidence ?? input.classifierTopSim;
    const userMessage = `GUEST MESSAGE: "${input.guestMessage}"
CLASSIFIER RETRIEVED: [${input.classifierLabels.join(', ') || 'nothing'}]
CLASSIFIER CONFIDENCE: ${lrConf.toFixed(3)} (LR sigmoid)
CLASSIFIER DIAGNOSTIC (KNN): ${input.classifierTopSim.toFixed(3)} (nearest neighbor)
CLASSIFIER METHOD: ${input.classifierMethod}
AI RESPONSE: "${input.aiResponse.substring(0, 500)}"

Was the retrieval correct? If not, what should have been retrieved?`;

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      temperature: 0,
      system: JUDGE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const textBlock = response.content.find(b => b.type === 'text');
    const raw = textBlock && textBlock.type === 'text' ? textBlock.text : '';

    // Parse JSON — strip markdown fences if present
    const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned);

    const inputTokens  = response.usage?.input_tokens  ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    const cost = inputTokens * HAIKU_INPUT_COST + outputTokens * HAIKU_OUTPUT_COST;

    const result: JudgeResult = {
      retrievalCorrect: parsed.retrieval_correct === true,
      correctLabels: Array.isArray(parsed.correct_labels)
        ? parsed.correct_labels.filter((l: unknown) => typeof l === 'string')
        : [],
      confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium',
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
      inputTokens,
      outputTokens,
      cost,
    };

    return result;
  } catch (err) {
    console.warn('[Judge] callJudge failed:', err);
    return null;
  }
}
