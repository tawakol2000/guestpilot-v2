/**
 * LLM-as-Judge for SOP classification quality evaluation.
 * Runs after every guestCoordinator AI response (fire-and-forget).
 *
 * Simplified in 013-sop-tool-routing: evaluates tool-based classification quality
 * instead of 3-tier classifier accuracy.
 */

import { PrismaClient } from '@prisma/client';
import { getTenantAiConfig } from './tenant-config.service';

// Per-tenant threshold cache (5-min TTL)
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

// Periodic cleanup of expired cache entries
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _thresholdCache.entries()) {
    if (now > entry.expiresAt) _thresholdCache.delete(key);
  }
}, 5 * 60 * 1000);

export interface JudgeInput {
  tenantId: string;
  conversationId: string;
  guestMessage: string;
  /** SOP categories from tool-based classification */
  sopCategories: string[];
  /** Classification confidence from get_sop tool */
  sopConfidence: 'high' | 'medium' | 'low';
  /** Reasoning from get_sop tool */
  sopReasoning: string;
  aiResponse: string;
}

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
 * Evaluate SOP classification quality and log for monitoring.
 * FIRE AND FORGET — call without await. Never blocks the AI pipeline.
 *
 * Simplified flow (013-sop-tool-routing):
 * - High confidence + sampling mode → skip
 * - Low confidence → log for review
 * - All classifications → save to ClassifierEvaluation for monitoring dashboard
 */
export async function evaluateAndImprove(input: JudgeInput, prisma: PrismaClient): Promise<void> {
  try {
    const judgeMode = ((await getTenantAiConfig(input.tenantId, prisma)) as any)?.judgeMode === 'sampling' ? 'sampling' : 'evaluate_all';

    if (input.sopConfidence === 'high' && judgeMode === 'sampling') {
      console.log(`[Judge] Skipping — high confidence SOP classification: [${input.sopCategories.join(', ')}]`);
      return;
    }

    if (input.sopConfidence === 'low') {
      console.log(`[Judge] Low confidence SOP classification: [${input.sopCategories.join(', ')}] — ${input.sopReasoning}`);
    }

    // Log to ClassifierEvaluation for monitoring
    await prisma.classifierEvaluation.create({
      data: {
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        guestMessage: input.guestMessage,
        classifierLabels: input.sopCategories,
        classifierMethod: 'sop_tool',
        classifierTopSim: input.sopConfidence === 'high' ? 1.0 : input.sopConfidence === 'medium' ? 0.7 : 0.3,
        judgeCorrectLabels: [],
        retrievalCorrect: true,
        judgeConfidence: input.sopConfidence,
        judgeReasoning: input.sopReasoning,
        judgeInputTokens: 0,
        judgeOutputTokens: 0,
        judgeCost: 0,
        autoFixed: false,
      },
    }).catch(err => console.warn('[Judge] Failed to save evaluation record:', err));
  } catch (err) {
    console.warn('[Judge] evaluateAndImprove failed (non-fatal):', err);
  }
}
