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
import { PrismaClient, MessageRole } from '@prisma/client';
import { AuthenticatedRequest } from '../types';

const WINDOW_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

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

        const currentRows = await prisma.message.findMany({
          where: { tenantId, role: MessageRole.AI, sentAt: { gte: since } },
          select: { editedByUserId: true, originalAiText: true, content: true },
        });
        const prevRows = await prisma.message.findMany({
          where: {
            tenantId,
            role: MessageRole.AI,
            sentAt: { gte: prevStart, lt: since },
          },
          select: { editedByUserId: true, originalAiText: true, content: true },
        });

        const uneditedOf = (rows: Array<{ editedByUserId: string | null; originalAiText: string | null; content: string }>) =>
          rows.filter((m) => !m.editedByUserId && (!m.originalAiText || m.originalAiText === m.content)).length;

        const totalSent = currentRows.length;
        const unedited = uneditedOf(currentRows);
        const coverage = totalSent === 0 ? 0 : unedited / totalSent;

        const prevTotal = prevRows.length;
        const prevUnedited = uneditedOf(prevRows);
        const previousCoverage = prevTotal === 0 ? null : prevUnedited / prevTotal;

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

        // Accepts in the 14d window, split by "settled" (≥7d old) vs "pending".
        const accepts = await prisma.tuningSuggestion.findMany({
          where: {
            tenantId,
            status: 'ACCEPTED',
            appliedAt: { gte: windowStart14d },
          },
          select: { appliedAndRetained7d: true, appliedAt: true },
        });

        let retained = 0;
        let reverted = 0;
        let pending = 0;
        for (const a of accepts) {
          if (!a.appliedAt) continue;
          if (a.appliedAt > sevenDaysAgo) {
            // <7d old — flag hasn't had a chance to be set by the retention job yet.
            pending++;
            continue;
          }
          if (a.appliedAndRetained7d === true) retained++;
          else if (a.appliedAndRetained7d === false) reverted++;
          else pending++; // null — job hasn't run on it yet despite being eligible
        }

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

        const msgs = await prisma.message.findMany({
          where: { tenantId, role: MessageRole.AI, sentAt: { gte: since } },
          select: {
            editedByUserId: true,
            originalAiText: true,
            content: true,
            editMagnitudeScore: true,
          },
        });
        const total = msgs.length;
        const edited = msgs.filter((m) => !!m.editedByUserId).length;
        const editRate = total === 0 ? 0 : edited / total;

        // Sprint 05 §3 (C19): prefer the persisted authoritative score from
        // sprint 02's classifyEditMagnitude pipeline. Old rows (pre sprint-05)
        // have null editMagnitudeScore and fall back to the proxy so the
        // dashboard stays meaningful on the first 14 days post-deploy.
        let magSum = 0;
        let magCount = 0;
        let scoredCount = 0;
        let proxyCount = 0;
        for (const m of msgs) {
          if (!m.editedByUserId) continue;
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

        const escalations = await prisma.task.count({
          where: { tenantId, type: 'ESCALATION', createdAt: { gte: since } },
        });
        // Denominator: distinct conversations that saw an AI reply in the window.
        const conversationsWithAi = await prisma.message.findMany({
          where: { tenantId, role: MessageRole.AI, sentAt: { gte: since } },
          select: { conversationId: true },
          distinct: ['conversationId'],
        });
        const convCount = conversationsWithAi.length;
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
        });
      } catch (err) {
        console.error('[tuning-dashboards] graduation-metrics failed:', err);
        res.status(500).json({ error: 'INTERNAL_ERROR' });
      }
    },
  };
}
