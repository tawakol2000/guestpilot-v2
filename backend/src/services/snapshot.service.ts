/**
 * Pipeline Health Snapshot Service
 *
 * Generates a comprehensive health snapshot of the classifier + judge pipeline,
 * including accuracy metrics, training stats, threshold settings, top misclassifications,
 * and an AI-generated health summary. Writes the report to .specify/memory/.
 */

import OpenAI from 'openai';
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

export async function generatePipelineSnapshot(tenantId: string, prisma: PrismaClient): Promise<string> {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // ── 1. Accuracy Metrics (last 30 days) ──────────────────────────────────────

  let overallCorrect = 0;
  let overallTotal = 0;
  let emptyLabelCount = 0;
  let perCategory: Record<string, { correct: number; total: number }> = {};

  try {
    // Evaluations where skipReason IS NULL (actually evaluated)
    const evaluations = await prisma.classifierEvaluation.findMany({
      where: {
        tenantId,
        createdAt: { gte: thirtyDaysAgo },
        skipReason: null,
      },
      select: {
        classifierLabels: true,
        judgeCorrectLabels: true,
        retrievalCorrect: true,
      },
    });

    overallTotal = evaluations.length;
    overallCorrect = evaluations.filter(e => e.retrievalCorrect).length;
    emptyLabelCount = evaluations.filter(e => e.classifierLabels.length === 0).length;

    // Per-category breakdown by judgeCorrectLabels
    for (const ev of evaluations) {
      for (const label of ev.judgeCorrectLabels) {
        if (!perCategory[label]) perCategory[label] = { correct: 0, total: 0 };
        perCategory[label].total++;
        if (ev.retrievalCorrect) {
          perCategory[label].correct++;
        }
      }
    }
  } catch (err) {
    console.warn('[Snapshot] Failed to query accuracy metrics:', err);
  }

  // ── 2. Training Stats ───────────────────────────────────────────────────────

  let totalActive = 0;
  let bySource: Record<string, number> = {};
  let addedThisPeriod = 0;

  try {
    const examples = await prisma.classifierExample.findMany({
      where: { tenantId, active: true },
      select: { source: true, createdAt: true },
    });

    totalActive = examples.length;

    for (const ex of examples) {
      bySource[ex.source] = (bySource[ex.source] || 0) + 1;
    }

    addedThisPeriod = examples.filter(e => e.createdAt >= thirtyDaysAgo).length;
  } catch (err) {
    console.warn('[Snapshot] Failed to query training stats:', err);
  }

  // ── 3. Threshold Settings ───────────────────────────────────────────────────

  let thresholds: {
    classifierVoteThreshold: number;
    classifierContextualGate: number;
    judgeThreshold: number;
    autoFixThreshold: number;
    judgeMode: string;
  } = {
    classifierVoteThreshold: 0.30,
    classifierContextualGate: 0.85,
    judgeThreshold: 0.75,
    autoFixThreshold: 0.70,
    judgeMode: 'evaluate_all',
  };

  try {
    const config = await prisma.tenantAiConfig.findUnique({
      where: { tenantId },
      select: {
        classifierVoteThreshold: true,
        classifierContextualGate: true,
        judgeThreshold: true,
        autoFixThreshold: true,
        judgeMode: true,
      },
    });

    if (config) {
      thresholds = {
        classifierVoteThreshold: config.classifierVoteThreshold,
        classifierContextualGate: config.classifierContextualGate,
        judgeThreshold: config.judgeThreshold,
        autoFixThreshold: config.autoFixThreshold,
        judgeMode: config.judgeMode,
      };
    }
  } catch (err) {
    console.warn('[Snapshot] Failed to query threshold settings:', err);
  }

  // ── 4. Top 10 Misclassifications ───────────────────────────────────────────

  let misclassifications: Array<{
    guestMessage: string;
    classifierLabels: string[];
    judgeCorrectLabels: string[];
  }> = [];

  try {
    const misses = await prisma.classifierEvaluation.findMany({
      where: {
        tenantId,
        retrievalCorrect: false,
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        guestMessage: true,
        classifierLabels: true,
        judgeCorrectLabels: true,
      },
    });

    misclassifications = misses;
  } catch (err) {
    console.warn('[Snapshot] Failed to query misclassifications:', err);
  }

  // ── Build Metrics Markdown ──────────────────────────────────────────────────

  const overallAccuracy = overallTotal > 0
    ? ((overallCorrect / overallTotal) * 100).toFixed(1)
    : 'N/A';

  const emptyLabelRate = overallTotal > 0
    ? ((emptyLabelCount / overallTotal) * 100).toFixed(1)
    : 'N/A';

  // Per-category table rows
  const categoryRows = Object.entries(perCategory)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([cat, stats]) => {
      const acc = stats.total > 0
        ? ((stats.correct / stats.total) * 100).toFixed(1)
        : 'N/A';
      return `| ${cat} | ${stats.correct} | ${stats.total} | ${acc}% |`;
    })
    .join('\n');

  // By-source breakdown
  const sourceEntries = ['manual', 'llm-judge', 'tier2-feedback', 'gap-analysis']
    .map(s => `${s}: ${bySource[s] || 0}`)
    .join(', ');

  // Misclassification list
  const misclassificationLines = misclassifications.length > 0
    ? misclassifications.map((m, i) => {
        const msg = m.guestMessage.length > 80
          ? m.guestMessage.substring(0, 80) + '...'
          : m.guestMessage;
        return `${i + 1}. "${msg}" — Classifier: [${m.classifierLabels.join(', ')}] → Judge: [${m.judgeCorrectLabels.join(', ')}]`;
      }).join('\n')
    : 'No misclassifications found.';

  // ── 5. AI Health Summary ───────────────────────────────────────────────────

  let healthSummary = '[Health summary generation failed]';

  const metricsForSummary = JSON.stringify({
    accuracy: {
      overall: `${overallAccuracy}% (${overallCorrect}/${overallTotal})`,
      emptyLabelRate: `${emptyLabelRate}%`,
      perCategory,
    },
    training: {
      totalActive,
      bySource,
      addedThisPeriod,
    },
    thresholds,
    recentMisclassifications: misclassifications.map(m => ({
      message: m.guestMessage.substring(0, 100),
      classifierLabels: m.classifierLabels,
      judgeCorrectLabels: m.judgeCorrectLabels,
    })),
  }, null, 2);

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const response = await (openai.responses as any).create({
      model: 'gpt-5.4-mini-2026-03-17',
      max_output_tokens: 500,
      instructions: 'You are a pipeline health analyst. Given these metrics, write a concise health assessment: overall status, worst-performing categories, self-improvement velocity, and top 3 recommended actions.',
      input: metricsForSummary,
      reasoning: { effort: 'none' },
      store: true,
    });

    if (response.output_text) {
      healthSummary = response.output_text;
    }
  } catch (err) {
    console.warn('[Snapshot] AI health summary generation failed:', err);
  }

  // ── 6. Assemble Markdown ───────────────────────────────────────────────────

  const markdown = `# Pipeline Health Snapshot

**Generated**: ${now.toISOString()}
**Tenant**: ${tenantId}
**Period**: Last 30 days

## Accuracy
- Overall: ${overallAccuracy}% (${overallCorrect}/${overallTotal} correct)
- Empty-label rate: ${emptyLabelRate}%

## Per-Category Accuracy
| Category | Correct | Total | Accuracy |
|----------|---------|-------|----------|
${categoryRows || '| (no data) | — | — | — |'}

## Training Set
- Total active: ${totalActive}
- By source: ${sourceEntries}
- Added this period: ${addedThisPeriod}

## Thresholds
- Vote: ${thresholds.classifierVoteThreshold}, Contextual gate: ${thresholds.classifierContextualGate}, Judge: ${thresholds.judgeThreshold}, Auto-fix: ${thresholds.autoFixThreshold}
- Judge mode: ${thresholds.judgeMode}

## Top Misclassifications
${misclassificationLines}

## Health Summary
${healthSummary}
`;

  // ── 7. Write to disk ───────────────────────────────────────────────────────

  try {
    const outputPath = path.resolve(__dirname, '../../../../.specify/memory/pipeline-snapshot.md');
    fs.writeFileSync(outputPath, markdown, 'utf-8');
    console.log(`[Snapshot] Written to ${outputPath}`);
  } catch (err) {
    console.warn('[Snapshot] Failed to write snapshot file:', err);
  }

  // ── 8. Return ──────────────────────────────────────────────────────────────

  return markdown;
}
