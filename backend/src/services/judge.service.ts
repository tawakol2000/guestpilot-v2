/**
 * LLM-as-Judge for classifier retrieval evaluation.
 * Runs after every guestCoordinator AI response (fire-and-forget).
 * When classifier confidence is low AND judge finds wrong retrieval,
 * automatically adds the guest message as a new training example.
 */

import Anthropic from '@anthropic-ai/sdk';
import { PrismaClient } from '@prisma/client';
import { addExample, getExampleByText } from './classifier-store.service';
import { reinitializeClassifier } from './classifier.service';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
  'sop-escalation-info',
  'property-info',
  'property-description',
  'property-amenities',
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
- sop-escalation-info: restaurant recommendations, local info, questions we can't answer
- property-info: address, floor, bedrooms, check-in/out times, door code, WiFi credentials
- property-description: building features, pool, gym, parking
- property-amenities: list of available items and appliances

New 11:
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
- non-actionable: greetings, test messages, wrong chat, system messages

Baked-in categories (handled by system prompt, never retrieved):
- sop-scheduling, sop-house-rules, sop-escalation-immediate, sop-escalation-scheduled

Messages that are just acknowledgments ("ok", "thanks", "sure", "got it", "👍") or contextual follow-ups ("5am", "tomorrow works", "friend", "Egyptian") should get NO documents at all — return empty correct_labels. These are handled by a topic cache, not the classifier.

Messages about house rules, smoking, parties, noise, scheduling/working hours, or emergencies (gas leak, safety threats, wanting to speak to manager) are handled by the system prompt and should also get NO documents — return empty correct_labels.

Return ONLY raw JSON, no markdown, no explanation outside the JSON:
{"retrieval_correct":true,"correct_labels":[],"confidence":"high","reasoning":"one sentence"}`;

export interface JudgeInput {
  tenantId: string;
  conversationId: string;
  guestMessage: string;
  classifierLabels: string[];
  classifierMethod: string;
  classifierTopSim: number;
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
    // Tier 3 re-injections should NOT become training examples.
    // "friend" with sop-visitor-policy is contextual — Tier 1 correctly returns [] for it.
    if (input.tier3Reinjected) {
      return;
    }

    // Load per-tenant thresholds (cached)
    const thresholds = await getThresholds(input.tenantId, prisma);

    // Skip if topSim is above the judge threshold — trusted result
    if (input.classifierTopSim >= thresholds.judgeThreshold) {
      return;
    }

    // Skip if all winning labels have majority support (≥2/3 neighbors agree) —
    // the classifier is consistent even at lower similarity, no judge needed
    if (hasMajorityNeighborSupport(input.classifierLabels, input.neighbors)) {
      return;
    }

    // ── Tier 2 feedback path ──────────────────────────────────────────────
    // Tier 2 already called Haiku WITH conversation context and got the right labels.
    // No need to call the judge (another Haiku call WITHOUT conversation context).
    // Use Tier 2's labels directly as the correction — more reliable and cheaper.
    if (input.tier2Labels && input.tier2Labels.length > 0) {
      const tier2Differs = !arraysEqual(input.classifierLabels, input.tier2Labels);
      if (tier2Differs && canAutoFix(input.tenantId)) {
        const validLabels = input.tier2Labels.filter(l => VALID_CHUNK_IDS.includes(l));
        if (validLabels.length > 0) {
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
              judgeReasoning: `Tier 2 resolved: [${validLabels.join(', ')}]`,
              judgeInputTokens: 0,
              judgeOutputTokens: 0,
              judgeCost: 0,
              autoFixed: true,
            },
          }).catch(err => console.warn('[Judge] Failed to save Tier 2 feedback evaluation:', err));

          await reinitializeClassifier(input.tenantId, prisma);
          console.log(`[Judge] Tier 2 feedback: "${input.guestMessage.substring(0, 50)}" → [${validLabels.join(', ')}] (skipped judge call)`);
        }
      }
      return; // Tier 2 handled it — don't also run the judge
    }

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
      input.classifierTopSim < thresholds.autoFixThreshold &&
      canAutoFix(input.tenantId)
    ) {
      // Verify the labels are valid
      const validLabels = judgeResult.correctLabels.filter(l => VALID_CHUNK_IDS.includes(l));

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
    } else if (!judgeResult.retrievalCorrect && input.classifierTopSim >= 0.7) {
      console.log(`[Judge] High-confidence misclassification (sim=${input.classifierTopSim.toFixed(2)}), flagged for review: "${input.guestMessage.substring(0, 50)}"`);
    }

    // Step 4: Low-confidence reinforcement — judge says correct but Tier 1 barely recognized it.
    // Add as training example so Tier 1 handles it confidently next time (no Tier 2 needed).
    const LOW_SIM_REINFORCE_THRESHOLD = 0.40;
    if (
      judgeResult.retrievalCorrect &&
      input.classifierTopSim < LOW_SIM_REINFORCE_THRESHOLD &&
      canAutoFix(input.tenantId)
    ) {
      const existing = await getExampleByText(input.tenantId, input.guestMessage, prisma);
      if (!existing) {
        const reinforceLabels = judgeResult.correctLabels.filter(l => VALID_CHUNK_IDS.includes(l));
        await addExample(input.tenantId, input.guestMessage, reinforceLabels, 'low-sim-reinforce', prisma);
        recordAutoFix(input.tenantId);
        await reinitializeClassifier(input.tenantId, prisma);
        console.log(`[Judge] Low-sim reinforcement (sim=${input.classifierTopSim.toFixed(2)}): "${input.guestMessage.substring(0, 50)}" → [${reinforceLabels.join(', ') || '(contextual)'}]`);
      }
    }
  } catch (err) {
    console.warn('[Judge] evaluateAndImprove failed (non-fatal):', err);
  }
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sorted1 = [...a].sort();
  const sorted2 = [...b].sort();
  return sorted1.every((v, i) => v === sorted2[i]);
}

async function callJudge(input: JudgeInput): Promise<JudgeResult | null> {
  try {
    const userMessage = `GUEST MESSAGE: "${input.guestMessage}"
CLASSIFIER RETRIEVED: [${input.classifierLabels.join(', ') || 'nothing'}]
CLASSIFIER CONFIDENCE: ${input.classifierTopSim.toFixed(3)} (nearest neighbor similarity)
CLASSIFIER METHOD: ${input.classifierMethod}
AI RESPONSE: "${input.aiResponse.substring(0, 500)}"

Was the retrieval correct? If not, what should have been retrieved?`;

    const response = await anthropic.messages.create({
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
