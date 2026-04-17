/**
 * Feature 041 sprint 03 — read-only dashboards for the /tuning right rail.
 *
 *   GET /api/tuning/coverage            — % of main-AI replies sent unedited
 *   GET /api/tuning/graduation-metrics  — 14d edit rate / magnitude / escalation / acceptance
 *
 * Both endpoints use only existing tables (`Message`, `Task`,
 * `TuningCategoryStats`). No schema change, no new writes.
 */
import { Response } from 'express';
import { PrismaClient, MessageRole, TuningDiagnosticCategory } from '@prisma/client';
import { AuthenticatedRequest } from '../types';

const WINDOW_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

// Sprint 08 §4 thresholds.
// - criticalFailure count in the last 30d must be 0 for graduation.
// - conversationCount30d must be >= 200 to have enough volume.
// - category gating kicks in at <30% acceptance over 30d.
const CRIT_FAIL_WINDOW_DAYS = 30;
const CONVERSATION_COUNT_WINDOW_DAYS = 30;
const CATEGORY_GATING_WINDOW_DAYS = 30;
export const GRADUATION_CRITICAL_FAILURE_TARGET = 0;
export const GRADUATION_CONVERSATION_COUNT_TARGET = 200;
export const CATEGORY_GATING_ACCEPTANCE_THRESHOLD = 0.3;

// Sprint 08 §5 — when a category is gated, require this confidence or higher
// to surface a new suggestion in that category. Exported so the diagnostic
// pipeline can import the same constant and the behavior stays in sync.
export const CATEGORY_GATING_CONFIDENCE_FLOOR = 0.75;

function windowStart(): Date {
  return new Date(Date.now() - WINDOW_DAYS * DAY_MS);
}

// Sprint 05 §3 (C19): magnitude is now sourced authoritatively from
// `Message.editMagnitudeScore`, populated at trigger time by the diagnostic
// pipeline. The character-position-equality proxy below is kept ONLY as a
// fallback for legacy edited messages that were sent before sprint 05 (where
// editMagnitudeScore is null). When no scored rows exist in the window, the
// fallback prevents the dashboard from collapsing to zero.
function legacyMagnitudeProxy(a: string, b: string): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return 1;
  const len = Math.max(a.length, b.length);
  let same = 0;
  const min = Math.min(a.length, b.length);
  for (let i = 0; i < min; i++) if (a[i] === b[i]) same++;
  return Math.max(0, Math.min(1, 1 - same / len));
}

export function makeTuningDashboardsController(prisma: PrismaClient) {
  return {
    async coverage(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const since = windowStart();
        const prevStart = new Date(since.getTime() - WINDOW_DAYS * DAY_MS);

        // Sprint 09 fix 18: aggregate via count() instead of loading the
        // entire Message table into memory. "Unedited" == editedByUserId
        // is null AND (originalAiText is null OR originalAiText equals
        // content). The last clause isn't directly expressible in a
        // Prisma count(), but it's only non-null when a preview was
        // edited — in practice the two conditions converge. For strict
        // parity with the old filter we approximate: treat "edited"
        // as editedByUserId != null. The rare case of originalAiText
        // diverging without an editedByUserId set was a historical
        // Shadow-Mode bug that's been fixed; the EMA will catch any
        // regression.
        const [totalSent, edited, prevTotal, prevEdited] = await Promise.all([
          prisma.message.count({
            where: { tenantId, role: MessageRole.AI, sentAt: { gte: since } },
          }),
          prisma.message.count({
            where: {
              tenantId,
              role: MessageRole.AI,
              sentAt: { gte: since },
              editedByUserId: { not: null },
            },
          }),
          prisma.message.count({
            where: { tenantId, role: MessageRole.AI, sentAt: { gte: prevStart, lt: since } },
          }),
          prisma.message.count({
            where: {
              tenantId,
              role: MessageRole.AI,
              sentAt: { gte: prevStart, lt: since },
              editedByUserId: { not: null },
            },
          }),
        ]);
        const unedited = totalSent - edited;
        const coverage = totalSent === 0 ? 0 : unedited / totalSent;
        const previousCoverage = prevTotal === 0 ? null : (prevTotal - prevEdited) / prevTotal;

        res.json({
          windowDays: WINDOW_DAYS,
          totalSent,
          unedited,
          coverage,
          previousCoverage,
        });
      } catch (err) {
        console.error('[tuning-dashboards] coverage failed:', err);
        res.status(500).json({ error: 'INTERNAL_ERROR' });
      }
    },

    /**
     * Sprint 05 §4 / sprint 08 §1: retention surface for accepted tuning
     * suggestions. Reads `appliedAndRetained7d` populated daily by
     * `tuningRetention.job.ts`.
     *
     * Shape (sprint 08):
     *   retained      — accepted ≥7d ago AND retention flag === true
     *   reverted      — accepted ≥7d ago AND retention flag === false
     *   pending       — accepted <7d ago (flag not yet set)
     *   retentionRate — retained / (retained + reverted), null when denom=0
     *   windowDays    — 14 (kept for wire compat)
     *
     * Legacy-shape fields (eligibleAccepts, evaluatedAccepts, retainedAccepts,
     * retentionWindow) are kept for any in-flight callers. They can be dropped
     * once the sprint 03 dashboard reads the new names.
     */
    async retentionSummary(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const now = Date.now();
        const windowStart14d = new Date(now - 14 * DAY_MS);
        const sevenDaysAgo = new Date(now - 7 * DAY_MS);

        // Sprint 09 follow-up: aggregate via count() instead of findMany.
        // Previously this loaded every accepted row in the 14d window into
        // memory just to tally three buckets.
        const [pendingYoung, retainedOld, revertedOld, pendingOldNullFlag] = await Promise.all([
          // <7d old — the retention job hasn't had a chance to run on these.
          prisma.tuningSuggestion.count({
            where: {
              tenantId,
              status: 'ACCEPTED',
              appliedAt: { gte: sevenDaysAgo },
            },
          }),
          prisma.tuningSuggestion.count({
            where: {
              tenantId,
              status: 'ACCEPTED',
              appliedAt: { gte: windowStart14d, lt: sevenDaysAgo },
              appliedAndRetained7d: true,
            },
          }),
          prisma.tuningSuggestion.count({
            where: {
              tenantId,
              status: 'ACCEPTED',
              appliedAt: { gte: windowStart14d, lt: sevenDaysAgo },
              appliedAndRetained7d: false,
            },
          }),
          prisma.tuningSuggestion.count({
            where: {
              tenantId,
              status: 'ACCEPTED',
              appliedAt: { gte: windowStart14d, lt: sevenDaysAgo },
              appliedAndRetained7d: null,
            },
          }),
        ]);
        const retained = retainedOld;
        const reverted = revertedOld;
        const pending = pendingYoung + pendingOldNullFlag;

        const settled = retained + reverted;
        const retentionRate = settled === 0 ? null : retained / settled;

        res.json({
          windowDays: 14,
          // Sprint 08 canonical shape.
          retained,
          reverted,
          pending,
          retentionRate,
          // Legacy shape (kept additive — sprint 05 dashboards-era callers).
          retentionWindow: '7d',
          eligibleAccepts: retained + reverted + pending,
          evaluatedAccepts: settled,
          retainedAccepts: retained,
        });
      } catch (err) {
        console.error('[tuning-dashboards] retention-summary failed:', err);
        res.status(500).json({ error: 'INTERNAL_ERROR' });
      }
    },

    async graduationMetrics(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const since = windowStart();

        // Sprint 09 fix 18: totals via count() instead of loading the whole
        // AI message table. The edited-message detail load is narrowed to
        // ONLY edited rows (editedByUserId != null), and only the two
        // columns needed for magnitude averaging.
        const [total, edited, editedMsgs] = await Promise.all([
          prisma.message.count({
            where: { tenantId, role: MessageRole.AI, sentAt: { gte: since } },
          }),
          prisma.message.count({
            where: {
              tenantId,
              role: MessageRole.AI,
              sentAt: { gte: since },
              editedByUserId: { not: null },
            },
          }),
          prisma.message.findMany({
            where: {
              tenantId,
              role: MessageRole.AI,
              sentAt: { gte: since },
              editedByUserId: { not: null },
            },
            select: {
              originalAiText: true,
              content: true,
              editMagnitudeScore: true,
            },
          }),
        ]);
        const editRate = total === 0 ? 0 : edited / total;

        // Sprint 05 §3 (C19): prefer the persisted authoritative score from
        // sprint 02's classifyEditMagnitude pipeline. Old rows (pre sprint-05)
        // have null editMagnitudeScore and fall back to the proxy so the
        // dashboard stays meaningful on the first 14 days post-deploy.
        let magSum = 0;
        let magCount = 0;
        let scoredCount = 0;
        let proxyCount = 0;
        for (const m of editedMsgs) {
          if (typeof m.editMagnitudeScore === 'number') {
            magSum += m.editMagnitudeScore;
            magCount++;
            scoredCount++;
          } else if (m.originalAiText && m.content) {
            magSum += legacyMagnitudeProxy(m.originalAiText, m.content);
            magCount++;
            proxyCount++;
          }
        }
        const editMagnitude = magCount === 0 ? 0 : magSum / magCount;

        // Sprint 09 follow-up: match the escalation numerator to the
        // conversation-with-AI denominator. The old code counted ALL
        // tenant-scoped escalations (including ones with no AI
        // conversationId), then divided by conversations-with-AI — which
        // inflated the rate above 1 for tenants running manual ops, then
        // clamped with Math.min. Narrow the numerator to escalations tied
        // to a conversation that also saw an AI reply in the window.
        const convsWithAi = await prisma.conversation.findMany({
          where: {
            tenantId,
            messages: {
              some: { role: MessageRole.AI, sentAt: { gte: since } },
            },
          },
          select: { id: true },
        });
        const convCount = convsWithAi.length;
        const convIds = convsWithAi.map((c) => c.id);
        const escalations =
          convIds.length === 0
            ? 0
            : await prisma.task.count({
                where: {
                  tenantId,
                  type: 'ESCALATION',
                  createdAt: { gte: since },
                  conversationId: { in: convIds },
                },
              });
        const escalationRate = convCount === 0 ? 0 : Math.min(1, escalations / convCount);

        // Composite acceptance rate across TuningCategoryStats. Volume-weighted.
        const stats = await prisma.tuningCategoryStats.findMany({ where: { tenantId } });
        let weighted = 0;
        let weightTotal = 0;
        for (const s of stats) {
          const w = s.acceptCount + s.rejectCount;
          weighted += s.acceptRateEma * w;
          weightTotal += w;
        }
        const acceptanceRate = weightTotal === 0 ? 0 : weighted / weightTotal;

        // ─── Sprint 08 §4 hardening (30-day windows) ───────────────────────
        const critSince = new Date(Date.now() - CRIT_FAIL_WINDOW_DAYS * DAY_MS);
        const convSince = new Date(Date.now() - CONVERSATION_COUNT_WINDOW_DAYS * DAY_MS);
        const catGatingSince = new Date(Date.now() - CATEGORY_GATING_WINDOW_DAYS * DAY_MS);

        const criticalFailures30d = await prisma.tuningSuggestion.count({
          where: {
            tenantId,
            criticalFailure: true,
            createdAt: { gte: critSince },
          },
        });

        // Sprint 09 fix 18: same conversation-count pattern as above.
        const conversationCount30d = await prisma.conversation.count({
          where: {
            tenantId,
            messages: {
              some: { role: MessageRole.AI, sentAt: { gte: convSince } },
            },
          },
        });

        // Per-category 30d acceptance rate. We compute this directly from
        // TuningSuggestion rows (not TuningCategoryStats) so the "30 day
        // window" matches the graduation criterion regardless of how long
        // the EMA has been accumulating.
        const catGroups = await prisma.tuningSuggestion.groupBy({
          where: {
            tenantId,
            createdAt: { gte: catGatingSince },
            diagnosticCategory: { not: null },
            status: { in: ['ACCEPTED', 'REJECTED'] },
          },
          by: ['diagnosticCategory', 'status'],
          _count: { _all: true },
        });
        const perCat: Record<string, { accepted: number; rejected: number }> = {};
        for (const row of catGroups) {
          const cat = row.diagnosticCategory ?? 'NO_FIX';
          if (!perCat[cat]) perCat[cat] = { accepted: 0, rejected: 0 };
          if (row.status === 'ACCEPTED') perCat[cat].accepted += row._count._all;
          else if (row.status === 'REJECTED') perCat[cat].rejected += row._count._all;
        }
        const allCats: TuningDiagnosticCategory[] = [
          'SOP_CONTENT',
          'SOP_ROUTING',
          'FAQ',
          'SYSTEM_PROMPT',
          'TOOL_CONFIG',
          'MISSING_CAPABILITY',
          'PROPERTY_OVERRIDE',
          'NO_FIX',
        ];
        const categoryConfidenceGating: Record<
          string,
          { acceptanceRate: number | null; sampleSize: number; gated: boolean }
        > = {};
        for (const cat of allCats) {
          const row = perCat[cat] ?? { accepted: 0, rejected: 0 };
          const n = row.accepted + row.rejected;
          const rate = n === 0 ? null : row.accepted / n;
          // Gate only when we have enough signal to gate on. <30% over <5
          // samples is just noise; require 5+ settled decisions in the window.
          // Below that, emit the row with gated=false so the UI can show the
          // category cleanly.
          const gated = rate !== null && n >= 5 && rate < CATEGORY_GATING_ACCEPTANCE_THRESHOLD;
          categoryConfidenceGating[cat] = { acceptanceRate: rate, sampleSize: n, gated };
        }

        res.json({
          windowDays: WINDOW_DAYS,
          editRate,
          editMagnitude,
          editMagnitudeSource: {
            scoredCount, // edited messages with editMagnitudeScore set
            proxyCount, // edited messages still on the legacy proxy
          },
          escalationRate,
          acceptanceRate,
          sampleSize: total,
          // Sprint 08 §4 additions
          criticalFailures30d,
          criticalFailuresTarget: GRADUATION_CRITICAL_FAILURE_TARGET,
          conversationCount30d,
          conversationCountTarget: GRADUATION_CONVERSATION_COUNT_TARGET,
          categoryConfidenceGating,
          categoryGatingThreshold: CATEGORY_GATING_ACCEPTANCE_THRESHOLD,
        });
      } catch (err) {
        console.error('[tuning-dashboards] graduation-metrics failed:', err);
        res.status(500).json({ error: 'INTERNAL_ERROR' });
      }
    },
  };
}
