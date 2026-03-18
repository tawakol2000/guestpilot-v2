/**
 * OPUS — Daily AI System Audit Service
 *
 * Collects all pipeline data from the past 24 hours, sends to Claude Opus
 * for a comprehensive system review, and stores the report.
 */

import Anthropic from '@anthropic-ai/sdk';
import { PrismaClient, MessageRole } from '@prisma/client';
import { SOP_CONTENT } from './classifier-data';
import { getClassifierStatus, getClassifierThresholds } from './classifier.service';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Data Collection ─────────────────────────────────────────────────────────

export async function collectDailyData(tenantId: string, prisma: PrismaClient) {
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [
    aiLogs,
    evaluations,
    newExamples,
    messages,
    pendingReplies,
    tasks,
    config,
  ] = await Promise.all([
    // AI API calls
    prisma.aiApiLog.findMany({
      where: { tenantId, createdAt: { gte: dayAgo } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, agentName: true, model: true, inputTokens: true, outputTokens: true,
        costUsd: true, durationMs: true, error: true, ragContext: true,
        conversationId: true, createdAt: true, responseText: true,
      },
    }),
    // Classifier evaluations
    prisma.classifierEvaluation.findMany({
      where: { tenantId, createdAt: { gte: dayAgo } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, guestMessage: true, classifierLabels: true, classifierMethod: true,
        classifierTopSim: true, judgeCorrectLabels: true, retrievalCorrect: true,
        judgeConfidence: true, judgeReasoning: true, autoFixed: true,
        judgeCost: true, createdAt: true,
      },
    }),
    // New training examples generated today
    prisma.classifierExample.findMany({
      where: { tenantId, createdAt: { gte: dayAgo } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, text: true, labels: true, source: true, active: true, createdAt: true },
    }),
    // Messages
    prisma.message.findMany({
      where: { tenantId, sentAt: { gte: dayAgo } },
      select: { role: true, channel: true, sentAt: true, conversationId: true },
    }),
    // Pending AI replies
    prisma.pendingAiReply.findMany({
      where: { tenantId, createdAt: { gte: dayAgo } },
      select: { id: true, fired: true, scheduledAt: true, createdAt: true },
    }),
    // Tasks created by AI
    prisma.task.findMany({
      where: { tenantId, createdAt: { gte: dayAgo } },
      select: { id: true, title: true, urgency: true, status: true, source: true, createdAt: true },
    }),
    // Current config
    prisma.tenantAiConfig.findUnique({
      where: { tenantId },
    }),
  ]);

  // Aggregate message stats
  const messageCounts = {
    total: messages.length,
    guest: messages.filter(m => m.role === MessageRole.GUEST).length,
    ai: messages.filter(m => m.role === MessageRole.AI).length,
    host: messages.filter(m => m.role === MessageRole.HOST).length,
    aiPrivate: messages.filter(m => m.role === 'AI_PRIVATE' as MessageRole).length,
    managerPrivate: messages.filter(m => m.role === 'MANAGER_PRIVATE' as MessageRole).length,
  };

  const channelCounts: Record<string, number> = {};
  for (const m of messages) {
    channelCounts[m.channel] = (channelCounts[m.channel] || 0) + 1;
  }

  // Aggregate AI log stats
  const aiLogStats = {
    totalCalls: aiLogs.length,
    totalCost: aiLogs.reduce((s, l) => s + l.costUsd, 0),
    totalInputTokens: aiLogs.reduce((s, l) => s + l.inputTokens, 0),
    totalOutputTokens: aiLogs.reduce((s, l) => s + l.outputTokens, 0),
    avgDurationMs: aiLogs.length > 0 ? Math.round(aiLogs.reduce((s, l) => s + l.durationMs, 0) / aiLogs.length) : 0,
    errorCount: aiLogs.filter(l => l.error).length,
    byAgent: {} as Record<string, { calls: number; cost: number; avgDuration: number }>,
  };
  for (const log of aiLogs) {
    const agent = log.agentName || 'unknown';
    if (!aiLogStats.byAgent[agent]) aiLogStats.byAgent[agent] = { calls: 0, cost: 0, avgDuration: 0 };
    aiLogStats.byAgent[agent].calls++;
    aiLogStats.byAgent[agent].cost += log.costUsd;
  }
  for (const [agent, stats] of Object.entries(aiLogStats.byAgent)) {
    const agentLogs = aiLogs.filter(l => (l.agentName || 'unknown') === agent);
    stats.avgDuration = Math.round(agentLogs.reduce((s, l) => s + l.durationMs, 0) / agentLogs.length);
  }

  // Evaluation stats
  const evalStats = {
    total: evaluations.length,
    correct: evaluations.filter(e => e.retrievalCorrect).length,
    incorrect: evaluations.filter(e => !e.retrievalCorrect).length,
    autoFixed: evaluations.filter(e => e.autoFixed).length,
    totalJudgeCost: evaluations.reduce((s, e) => s + e.judgeCost, 0),
  };

  // Pending reply stats
  const pendingStats = {
    total: pendingReplies.length,
    fired: pendingReplies.filter(p => p.fired).length,
    unfired: pendingReplies.filter(p => !p.fired).length,
  };

  // RAG chunk hit frequency from AI logs
  const chunkHits: Record<string, number> = {};
  for (const log of aiLogs) {
    const ctx = log.ragContext as any;
    if (ctx?.classifierResult?.labels) {
      for (const label of ctx.classifierResult.labels) {
        chunkHits[label] = (chunkHits[label] || 0) + 1;
      }
    }
  }

  const classifierStatus = getClassifierStatus();
  const classifierThresholds = getClassifierThresholds();

  return {
    period: { from: dayAgo.toISOString(), to: now.toISOString() },
    messageCounts,
    channelCounts,
    aiLogStats,
    evalStats,
    pendingStats,
    chunkHits,
    // Detailed records for Opus to review
    evaluations: evaluations.map(e => ({
      message: e.guestMessage.substring(0, 200),
      classifierLabels: e.classifierLabels,
      topSim: e.classifierTopSim,
      correct: e.retrievalCorrect,
      judgeLabels: e.judgeCorrectLabels,
      autoFixed: e.autoFixed,
      reasoning: e.judgeReasoning,
    })),
    newExamples: newExamples.map(e => ({
      text: e.text.substring(0, 200),
      labels: e.labels,
      source: e.source,
      active: e.active,
    })),
    tasks: tasks.map(t => ({
      title: t.title,
      urgency: t.urgency,
      source: t.source,
    })),
    aiErrors: aiLogs.filter(l => l.error).map(l => ({
      agent: l.agentName,
      error: l.error!.substring(0, 200),
      time: l.createdAt.toISOString(),
    })),
    settings: config ? {
      model: config.model,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      debounceDelayMs: config.debounceDelayMs,
      judgeThreshold: config.judgeThreshold,
      autoFixThreshold: config.autoFixThreshold,
      classifierVoteThreshold: config.classifierVoteThreshold,
      classifierContextualGate: config.classifierContextualGate,
      workingHoursEnabled: config.workingHoursEnabled,
      workingHoursStart: config.workingHoursStart,
      workingHoursEnd: config.workingHoursEnd,
      workingHoursTimezone: config.workingHoursTimezone,
      ragEnabled: config.ragEnabled,
      memorySummaryEnabled: config.memorySummaryEnabled,
    } : null,
    classifierStatus: {
      exampleCount: classifierStatus.exampleCount,
      sopChunkCount: classifierStatus.sopChunkCount,
      voteThreshold: classifierThresholds.voteThreshold,
      contextualGate: classifierThresholds.contextualGate,
    },
    activeSops: Object.keys(SOP_CONTENT),
  };
}

// ─── Opus Report Generation ──────────────────────────────────────────────────

const OPUS_SYSTEM_PROMPT = `You are the Chief AI Systems Auditor for GuestPilot, an AI-powered guest communication platform for short-term rental properties.

## Architecture Overview

GuestPilot uses a multi-tier classification and response pipeline:

### Message Flow
1. Guest sends message via Airbnb/Booking.com/WhatsApp → Hostaway webhook → GuestPilot backend
2. Message saved to DB → debounce timer started (waits for more messages)
3. After debounce: Tier 1-3 classification → RAG retrieval → AI response generation → send via Hostaway API

### Tier 1 — KNN Embedding Classifier
- 300+ training examples, each labeled with SOP categories
- Embeds the guest message, finds K=3 nearest neighbors by cosine similarity
- Weighted voting: label needs >voteThreshold (default 0.30) of weighted vote AND ≥2/3 neighbor agreement
- Contextual gate: if best match is "contextual" above contextualGate (default 0.85), skip SOP retrieval and re-inject last topic (Tier 3)
- Returns: labels[], topSimilarity, method

### Tier 2 — Intent Extractor (Claude Haiku)
- Fires when Tier 1 topSimilarity < 0.75 (judgeThreshold) AND Tier 3 doesn't re-inject
- Reads last 3 guest + 2 host messages for context
- Returns: TOPIC, STATUS, URGENCY, SOPS[]

### Tier 3 — Topic State Cache
- Tracks the last SOP topic per conversation
- If Tier 1 returns "contextual" (short follow-up like "yes", "ok"), re-injects the previous topic's SOPs
- Prevents topic loss during multi-turn conversations

### Self-Improvement Judge
- Runs after each AI response (fire-and-forget)
- Skipped if Tier 1 topSimilarity ≥ judgeThreshold (0.75) or majority neighbor support
- If Tier 2 fired: validates Tier 2's labels have ≥0.35 similarity to existing examples before auto-fixing
- Otherwise: calls Claude Haiku to judge if classification was correct
- If incorrect AND topSim < autoFixThreshold (0.70): auto-adds the message as a new training example
- Rate limited to 10 auto-fixes per hour

### SOP System
- Each classified label maps to an SOP (Standard Operating Procedure) text
- SOPs contain instructions for the AI on how to handle specific scenarios
- 4 SOPs are "baked in" (always in system prompt): scheduling, house rules, escalation-immediate, escalation-scheduled
- Remaining SOPs retrieved dynamically based on classification

### AI Response
- Claude Haiku generates the response with: system prompt + SOP context + property info + conversation history
- Returns JSON: {"guest_message": "...", "escalation": {...} | null}

## Your Task

Analyze the past 24 hours of system data and produce a comprehensive audit report. Be specific — cite actual numbers, flag specific messages, and make actionable recommendations. Do not be generic.

## Report Structure (use markdown headers)

# Daily AI System Audit Report

## 1. Executive Summary
3-4 sentences: overall system health, key metrics, any critical issues.

## 2. Message Volume & Response Rate
Guest/AI/host message counts, AI response rate (AI messages / guest messages), channel breakdown.

## 3. Classification Accuracy
Tier 1 accuracy rate, average similarity scores, Tier 2 fire rate, judge intervention rate. Flag any patterns in misclassifications.

## 4. Auto-Fix Review
Review EACH auto-fixed example individually. For each: was the correction correct? Is the text-to-label mapping sensible? Flag any that should be deactivated.

## 5. Cost Analysis
Total API costs, cost per guest message, breakdown by agent (Omar, Judge, IntentExtractor). Trends or anomalies.

## 6. SOP Coverage
Which SOPs fired most? Any SOPs that never fired? Any messages that fell through without a good SOP match?

## 7. Threshold Recommendations
Based on the data: should judgeThreshold, autoFixThreshold, voteThreshold, or contextualGate be adjusted? Explain why with data.

## 8. System Health Score
Rate 1-10 with justification. Consider: accuracy, cost efficiency, response coverage, error rate, self-improvement quality.

## 9. Action Items
Prioritized list of specific, actionable recommendations. Include: training examples to add, settings to change, SOPs to update, examples to deactivate.`;

export async function generateOpusReport(tenantId: string, reportId: string, prisma: PrismaClient): Promise<void> {
  const start = Date.now();

  try {
    await prisma.opusReport.update({
      where: { id: reportId },
      data: { status: 'generating' },
    });

    const rawData = await collectDailyData(tenantId, prisma);

    const userContent = `Here is the complete pipeline data for the past 24 hours (${rawData.period.from} to ${rawData.period.to}):

## Message Volume
${JSON.stringify(rawData.messageCounts, null, 2)}

## Channel Distribution
${JSON.stringify(rawData.channelCounts, null, 2)}

## AI API Call Statistics
${JSON.stringify(rawData.aiLogStats, null, 2)}

## Classifier Evaluation Statistics
${JSON.stringify(rawData.evalStats, null, 2)}

## SOP Hit Frequency
${JSON.stringify(rawData.chunkHits, null, 2)}

## Pending AI Replies
${JSON.stringify(rawData.pendingStats, null, 2)}

## All Classifier Evaluations (${rawData.evaluations.length} total)
${JSON.stringify(rawData.evaluations, null, 2)}

## New Training Examples Generated Today (${rawData.newExamples.length} total)
${JSON.stringify(rawData.newExamples, null, 2)}

## Tasks/Escalations Created (${rawData.tasks.length} total)
${JSON.stringify(rawData.tasks, null, 2)}

## AI Errors (${rawData.aiErrors.length} total)
${JSON.stringify(rawData.aiErrors, null, 2)}

## Current Settings
${JSON.stringify(rawData.settings, null, 2)}

## Classifier Status
${JSON.stringify(rawData.classifierStatus, null, 2)}

## Active SOPs (${rawData.activeSops.length})
${rawData.activeSops.join(', ')}`;

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 4096,
      system: OPUS_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    });

    const reportText = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const durationMs = Date.now() - start;
    const costUsd = (response.usage.input_tokens / 1_000_000) * 15 + (response.usage.output_tokens / 1_000_000) * 75;

    await prisma.opusReport.update({
      where: { id: reportId },
      data: {
        status: 'complete',
        rawData: rawData as any,
        reportMarkdown: reportText,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        costUsd,
        durationMs,
      },
    });

    console.log(`[OPUS] Report ${reportId} complete: ${response.usage.input_tokens}in/${response.usage.output_tokens}out, $${costUsd.toFixed(4)}, ${durationMs}ms`);
  } catch (err: any) {
    console.error(`[OPUS] Report ${reportId} failed:`, err.message);
    await prisma.opusReport.update({
      where: { id: reportId },
      data: { status: 'failed', reportMarkdown: `Error: ${err.message}`, durationMs: Date.now() - start },
    }).catch(() => {});
  }
}
