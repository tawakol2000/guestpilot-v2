/**
 * Tuning Edit Queue (2026-05-17).
 *
 * Single owner of the post-edit pipeline. Replaces the inline diagnostic-fire
 * blocks that used to live in shadow-preview / conversations / messages
 * controllers. Routes every qualifying edit through one of two modes selected
 * by `TenantAiConfig.tuningAutoAnalyze`:
 *
 *   - auto (default): record → pre-classify → diagnostic (with cooldown
 *     short-circuits) → write suggestion → mark queue row ANALYZED. UI shows
 *     it under "Analyzed".
 *
 *   - manual: record → pre-classify → STOP (status=PENDING). Manager clicks
 *     "Run analysis" from the Studio right column, which calls
 *     analyzeQueueItem() and finishes the run.
 *
 * Idempotent on sourceMessageId (db @unique). A second call for the same
 * message id is a no-op upsert.
 *
 * All errors are swallowed in fire-and-forget paths per CLAUDE.md critical
 * rule #2 (never crash the main guest-messaging flow).
 */
import {
  PrismaClient,
  TuningEditQueueStatus,
  TuningConversationTriggerType,
} from '@prisma/client';
import { runDiagnostic } from './diagnostic.service';
import { writeSuggestionFromDiagnostic } from './suggestion-writer.service';
import {
  classifyEditCategory,
  type PreClassifierResult,
} from './category-pre-classifier.service';
import { logTuningDiagnosticFailure } from './diagnostic-failure-log';

export type CallerPath = 'shadow-preview' | 'conversations' | 'messages';

export interface EnqueueEditInput {
  tenantId: string;
  sourceMessageId: string;
  originalText: string;
  editedText: string;
  similarity: number;
  triggerType: TuningConversationTriggerType;
  reservationStatus?: string | null;
  channel?: string | null;
  note: string; // human-readable note passed to runDiagnostic
  callerPath: CallerPath;
}

/**
 * Public entry point. Called by the 3 controllers right after the manager's
 * edit lands. Performs the upsert + classifier and, if auto mode is on,
 * kicks off the full diagnostic fire-and-forget.
 */
export async function enqueueEditForAnalysis(
  input: EnqueueEditInput,
  prisma: PrismaClient,
): Promise<void> {
  try {
    // Resolve auto-analyze mode for this tenant. Default true (matches the
    // existing behavior before this feature). Missing config row is treated
    // as auto on.
    const cfg = await prisma.tenantAiConfig.findUnique({
      where: { tenantId: input.tenantId },
      select: { tuningAutoAnalyze: true },
    });
    const autoAnalyze = cfg?.tuningAutoAnalyze ?? true;

    // Run the cheap pre-classifier first so the row carries its verdict even
    // when manual mode delays the full diagnostic. ~$0.01 / ~1.5s.
    const preClass = await classifyEditCategory({
      originalText: input.originalText,
      editedText: input.editedText,
      similarity: input.similarity,
      reservationStatus: input.reservationStatus ?? null,
      channel: input.channel ?? null,
    });

    // Upsert the queue row. Idempotent on sourceMessageId. If a row already
    // exists (re-fire), we leave the status alone — a previously-analyzed
    // row stays ANALYZED; a previously-pending row keeps its PENDING.
    const created = await prisma.tuningEditQueue
      .upsert({
        where: { sourceMessageId: input.sourceMessageId },
        create: {
          tenantId: input.tenantId,
          sourceMessageId: input.sourceMessageId,
          originalText: input.originalText,
          editedText: input.editedText,
          similarity: input.similarity,
          triggerType: input.triggerType,
          reservationStatus: input.reservationStatus ?? null,
          channel: input.channel ?? null,
          preClassifierCategory: preClass?.category ?? null,
          preClassifierConfidence: preClass?.confidence ?? null,
          preClassifierRationale: preClass?.rationale ?? null,
          preClassifierModel: preClass?.modelUsed ?? null,
          status: autoAnalyze ? 'ANALYZING' : 'PENDING',
        },
        update: {}, // no-op on conflict
      })
      .catch((err) => {
        console.warn(
          `[EditQueue] [${input.sourceMessageId}] upsert failed:`,
          err,
        );
        return null;
      });

    if (!created) return;

    // Manual mode: stop here. The right-column "Run analysis" button calls
    // analyzeQueueItem() to finish the run.
    if (!autoAnalyze) {
      console.log(
        `[EditQueue] [${input.sourceMessageId}] queued (manual mode) — ` +
          `preClassifier=${preClass?.category ?? 'null'} ` +
          `conf=${preClass?.confidence?.toFixed(2) ?? 'n/a'}.`,
      );
      return;
    }

    // Auto mode: kick the diagnostic fire-and-forget. Errors swallowed.
    void runAnalysisForQueueItem(
      created.id,
      input,
      preClass,
      prisma,
    ).catch((err) => {
      console.warn(
        `[EditQueue] [${created.id}] auto-analysis crashed (swallowed):`,
        err,
      );
    });
  } catch (outer) {
    console.warn(
      `[EditQueue] [${input.sourceMessageId}] enqueue crashed (swallowed):`,
      outer,
    );
  }
}

/**
 * Manual entry point — called by `POST /api/tuning/queue/:id/analyze` to
 * finish a PENDING row. Returns the updated row (or null on miss).
 */
export async function analyzeQueueItem(
  queueItemId: string,
  tenantId: string,
  prisma: PrismaClient,
): Promise<{ ok: boolean; status: TuningEditQueueStatus; suggestionId: string | null } | null> {
  const item = await prisma.tuningEditQueue.findFirst({
    where: { id: queueItemId, tenantId },
  });
  if (!item) return null;

  // Manual trigger only runs PENDING rows. The skipped (NO_FIX) and
  // terminal (ANALYZED / FAILED / DISMISSED) states return the current
  // state untouched. NO_FIX rows are intentionally not re-runnable — the
  // pre-classifier already decided this edit isn't a real fix.
  if (item.status !== 'PENDING') {
    return { ok: false, status: item.status, suggestionId: item.suggestionId };
  }

  // Re-derive the pre-classifier result from persisted fields so we can
  // pass it to the analysis runner.
  const preClass: PreClassifierResult | null = item.preClassifierCategory
    ? {
        category: item.preClassifierCategory as PreClassifierResult['category'],
        confidence: item.preClassifierConfidence ?? 0,
        rationale: item.preClassifierRationale ?? '',
        modelUsed: item.preClassifierModel ?? 'unknown',
        latencyMs: 0,
      }
    : null;

  // Move → ANALYZING and run the diagnostic synchronously so the HTTP
  // caller gets the outcome in the same response.
  await prisma.tuningEditQueue.update({
    where: { id: queueItemId },
    data: { status: 'ANALYZING', skipReason: null, errorMessage: null },
  });

  await runAnalysisForQueueItem(
    queueItemId,
    {
      tenantId,
      sourceMessageId: item.sourceMessageId,
      originalText: item.originalText,
      editedText: item.editedText,
      similarity: item.similarity,
      triggerType: item.triggerType,
      reservationStatus: item.reservationStatus,
      channel: item.channel,
      note:
        item.triggerType === 'REJECT_TRIGGERED'
          ? 'Manager replaced the AI draft wholesale (similarity < 0.3).'
          : 'Manager edited the AI draft before sending.',
      callerPath: 'shadow-preview', // Used only for failure-log tagging; "manual" would also be valid.
    },
    preClass,
    prisma,
  );

  const updated = await prisma.tuningEditQueue.findUnique({
    where: { id: queueItemId },
    select: { status: true, suggestionId: true },
  });
  return updated
    ? { ok: true, status: updated.status, suggestionId: updated.suggestionId }
    : null;
}

/**
 * Dismiss — sets status=DISMISSED on a row. Used when the manager wants the
 * row out of the pending list without running analysis (or after seeing the
 * pre-classifier verdict).
 */
export async function dismissQueueItem(
  queueItemId: string,
  tenantId: string,
  prisma: PrismaClient,
): Promise<boolean> {
  const res = await prisma.tuningEditQueue.updateMany({
    where: { id: queueItemId, tenantId, status: 'PENDING' },
    data: { status: 'DISMISSED' },
  });
  return res.count > 0;
}

// ─── Internal: shared analysis runner ───────────────────────────────────────

async function runAnalysisForQueueItem(
  queueItemId: string,
  input: EnqueueEditInput,
  preClass: PreClassifierResult | null,
  prisma: PrismaClient,
): Promise<void> {
  const stamp = `[EditQueue] [${queueItemId}/${input.sourceMessageId}]`;

  try {
    // Skip path 1: pre-classifier says NO_FIX with high confidence.
    if (preClass && preClass.category === 'NO_FIX' && preClass.confidence >= 0.7) {
      console.log(
        `${stamp} pre-classifier: NO_FIX (conf=${preClass.confidence.toFixed(2)}) — skipping diagnostic. ` +
          `Saved ~$0.21 + ~120s. Rationale: ${preClass.rationale}`,
      );
      await prisma.tuningEditQueue
        .update({
          where: { id: queueItemId },
          data: {
            status: 'SKIPPED_NO_FIX',
            skipReason: `NO_FIX (conf=${preClass.confidence.toFixed(2)}): ${preClass.rationale}`,
            analyzedAt: new Date(),
          },
        })
        .catch(() => {});
      return;
    }

    // 2026-05-17: cooldown removed per operator request. Previously a 48h
    // probe short-circuited when the predicted category had a recent
    // ACCEPTED suggestion. Operator wanted every real edit analyzed.
    // Only NO_FIX (skip path 1 above) still gates the diagnostic spend.

    // Full diagnostic run.
    const result = await runDiagnostic(
      {
        triggerType: input.triggerType,
        tenantId: input.tenantId,
        messageId: input.sourceMessageId,
        note: input.note,
      },
      prisma,
    );

    if (!result) {
      // runDiagnostic returns null when OPENAI_API_KEY is missing or the
      // primary+fallback models both errored. Treat as ANALYZED-with-no-fix.
      await prisma.tuningEditQueue
        .update({
          where: { id: queueItemId },
          data: {
            status: 'ANALYZED',
            skipReason: 'Diagnostic returned null (no api key or transient error).',
            analyzedAt: new Date(),
          },
        })
        .catch(() => {});
      return;
    }

    const outcome = await writeSuggestionFromDiagnostic(result, {}, prisma);

    await prisma.tuningEditQueue
      .update({
        where: { id: queueItemId },
        data: {
          status: 'ANALYZED',
          suggestionId: outcome.suggestion?.id ?? null,
          skipReason: !outcome.suggestion
            ? `Diagnostic ${result.category} — ${outcome.note ?? 'no suggestion written'}.`
            : null,
          analyzedAt: new Date(),
        },
      })
      .catch(() => {});
  } catch (err) {
    logTuningDiagnosticFailure({
      phase: 'diagnostic',
      path: input.callerPath,
      tenantId: input.tenantId,
      messageId: input.sourceMessageId,
      triggerType:
        input.triggerType === 'EDIT_TRIGGERED' || input.triggerType === 'REJECT_TRIGGERED'
          ? input.triggerType
          : null,
      error: err,
    });
    await prisma.tuningEditQueue
      .update({
        where: { id: queueItemId },
        data: {
          status: 'FAILED',
          errorMessage: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
          analyzedAt: new Date(),
        },
      })
      .catch(() => {});
  }
}

// ─── Listing / reading helpers (used by the controller) ─────────────────────

export type QueueBucket = 'pending' | 'analyzed' | 'all';

export async function listQueueItems(
  tenantId: string,
  bucket: QueueBucket,
  limit: number,
  prisma: PrismaClient,
) {
  const statusFilter: TuningEditQueueStatus[] | undefined =
    bucket === 'pending'
      ? ['PENDING']
      : bucket === 'analyzed'
        ? ['ANALYZED', 'SKIPPED_NO_FIX', 'SKIPPED_COOLDOWN', 'FAILED', 'DISMISSED']
        : undefined;

  return prisma.tuningEditQueue.findMany({
    where: {
      tenantId,
      ...(statusFilter ? { status: { in: statusFilter } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      suggestion: {
        select: {
          id: true,
          status: true,
          diagnosticCategory: true,
          diagnosticSubLabel: true,
          rationale: true,
          confidence: true,
        },
      },
    },
  });
}
