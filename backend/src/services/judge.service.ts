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

// All valid SOP chunk IDs the judge can recommend
const VALID_CHUNK_IDS = [
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
];

const JUDGE_SYSTEM_PROMPT = `You are a retrieval quality evaluator for a hospitality AI system.

The system works like this:
- A guest sends a message
- A classifier selects which SOP (Standard Operating Procedure) documents to include in the AI's context
- The AI then responds using those documents

Your job: evaluate whether the classifier selected the RIGHT documents.

Available SOP document IDs and what they cover:
- sop-cleaning: cleaning requests, housekeeping, mopping, $20 fee
- sop-amenity-request: item requests (towels, pillows, crib, blender, etc.)
- sop-maintenance: broken items, leaks, AC, electrical, plumbing, pests, mold
- sop-wifi-doorcode: WiFi password, WiFi name, door code, internet connection issues
- sop-visitor-policy: visitors, friends coming over, family visits, passport verification
- sop-early-checkin: early check-in, arriving before 3pm, bag drop
- sop-late-checkout: late checkout, leaving after 11am, extending stay
- sop-escalation-info: restaurant recommendations, local info, refunds, discounts, reservation changes
- property-info: address, floor, bedrooms, check-in/out times, door code, WiFi credentials
- property-description: building features, pool, gym, parking
- property-amenities: list of available items and appliances

Messages that are just acknowledgments ("ok", "thanks", "sure", "got it", "👍") or contextual follow-ups ("5am", "tomorrow works") should get NO documents at all — return empty correct_labels.

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
 */
export async function evaluateAndImprove(input: JudgeInput, prisma: PrismaClient): Promise<void> {
  try {
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
  } catch (err) {
    console.warn('[Judge] evaluateAndImprove failed (non-fatal):', err);
  }
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
