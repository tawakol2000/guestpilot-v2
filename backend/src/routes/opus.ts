import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { generateOpusReport } from '../services/opus.service';

export function opusRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.use(authMiddleware as any);

  // POST /api/opus/generate — trigger report generation (async)
  router.post('/generate', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;

      // Check for in-progress report
      const inProgress = await prisma.opusReport.findFirst({
        where: { tenantId, status: { in: ['pending', 'generating'] } },
      });
      if (inProgress) {
        res.json({ id: inProgress.id, status: inProgress.status, message: 'Report already in progress' });
        return;
      }

      const report = await prisma.opusReport.create({
        data: { tenantId, reportDate: new Date(), status: 'pending' },
      });

      // Fire-and-forget
      generateOpusReport(tenantId, report.id, prisma).catch(err =>
        console.error('[OPUS] Background generation failed:', err)
      );

      res.json({ id: report.id, status: 'generating' });
    } catch (err) {
      console.error('[OPUS] Generate failed:', err);
      res.status(500).json({ error: 'Failed to start report generation' });
    }
  });

  // GET /api/opus/reports — list all reports
  router.get('/reports', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const reports = await prisma.opusReport.findMany({
        where: { tenantId },
        orderBy: { reportDate: 'desc' },
        take: 50,
        select: {
          id: true, reportDate: true, status: true,
          inputTokens: true, outputTokens: true, costUsd: true, durationMs: true,
          createdAt: true,
        },
      });
      res.json(reports);
    } catch (err) {
      console.error('[OPUS] List reports failed:', err);
      res.status(500).json({ error: 'Failed to list reports' });
    }
  });

  // GET /api/opus/reports/:id — get specific report
  router.get('/reports/:id', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const report = await prisma.opusReport.findFirst({
        where: { id: req.params.id, tenantId },
      });
      if (!report) { res.status(404).json({ error: 'Report not found' }); return; }
      res.json({
        id: report.id,
        reportDate: report.reportDate,
        status: report.status,
        reportMarkdown: report.reportMarkdown,
        inputTokens: report.inputTokens,
        outputTokens: report.outputTokens,
        costUsd: report.costUsd,
        durationMs: report.durationMs,
        createdAt: report.createdAt,
      });
    } catch (err) {
      console.error('[OPUS] Get report failed:', err);
      res.status(500).json({ error: 'Failed to get report' });
    }
  });

  // GET /api/opus/reports/:id/raw — download raw data as JSON
  router.get('/reports/:id/raw', async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const report = await prisma.opusReport.findFirst({
        where: { id: req.params.id, tenantId },
        select: { rawData: true, reportDate: true },
      });
      if (!report) { res.status(404).json({ error: 'Report not found' }); return; }
      const dateStr = report.reportDate.toISOString().split('T')[0];
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="opus-raw-${dateStr}.json"`);
      res.json(report.rawData);
    } catch (err) {
      console.error('[OPUS] Get raw data failed:', err);
      res.status(500).json({ error: 'Failed to get raw data' });
    }
  });

  return router;
}
