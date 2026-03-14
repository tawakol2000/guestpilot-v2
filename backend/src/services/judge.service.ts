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
  aiResponse: string;
}

export interface JudgeResult {
  retrievalCorrect: boolean;
  correctLabels: string[];
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

/**
 * Run LLM-as-judge evaluation and handle self-improvement.
 * FIRE AND FORGET — call without await. Never blocks the AI pipeline.
 */
export async function evaluateAndImprove(input: JudgeInput, prisma: PrismaClient): Promise<void> {
  try {
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
        autoFixed: false,
      },
    }).catch(err => console.warn('[Judge] Failed to save evaluation:', err));

    // Step 3: Decide whether to auto-fix
    if (
      !judgeResult.retrievalCorrect &&
      input.classifierTopSim < 0.7 &&
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

    const result: JudgeResult = {
      retrievalCorrect: parsed.retrieval_correct === true,
      correctLabels: Array.isArray(parsed.correct_labels)
        ? parsed.correct_labels.filter((l: unknown) => typeof l === 'string')
        : [],
      confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium',
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    };

    return result;
  } catch (err) {
    console.warn('[Judge] callJudge failed:', err);
    return null;
  }
}
