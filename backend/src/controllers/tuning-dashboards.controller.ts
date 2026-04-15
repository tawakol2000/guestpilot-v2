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

// Rough magnitude proxy: ratio of characters changed (Levenshtein via
// per-character-length diff). Sprint 02's classifyEditMagnitude is the
// authoritative implementation but its inputs aren't persisted; this proxy is
// deliberately cheap and documented in the report as an approximation.
function magnitudeProxy(a: string, b: string): number {
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

    async graduationMetrics(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const since = windowStart();

        const msgs = await prisma.message.findMany({
          where: { tenantId, role: MessageRole.AI, sentAt: { gte: since } },
          select: { editedByUserId: true, originalAiText: true, content: true },
        });
        const total = msgs.length;
        const edited = msgs.filter((m) => !!m.editedByUserId).length;
        const editRate = total === 0 ? 0 : edited / total;

        let magSum = 0;
        let magCount = 0;
        for (const m of msgs) {
          if (m.editedByUserId && m.originalAiText && m.content) {
            magSum += magnitudeProxy(m.originalAiText, m.content);
            magCount++;
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
