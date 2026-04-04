import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { PrismaClient } from '@prisma/client';
import { authRouter } from './routes/auth';
import { conversationsRouter } from './routes/conversations';
import { propertiesRouter } from './routes/properties';
import { importRouter } from './routes/import';
import { webhooksRouter } from './routes/webhooks';
import { aiConfigRouter } from './routes/ai-config';
import { tasksRouter } from './routes/tasks';
import { templatesRouter } from './routes/templates';
import { analyticsRouter } from './routes/analytics';
import { knowledgeRouter } from './routes/knowledge';
import { tenantConfigRouter } from './routes/tenant-config';
import { sandboxRouter } from './routes/sandbox';
import { documentChecklistRouter } from './routes/document-checklist';
import { toolDefinitionsRouter } from './routes/tool-definitions';
import { pushRouter } from './routes/push';
import { faqRouter } from './routes/faq';
import { webhookLogsRouter } from './routes/webhook-logs';
import { reservationsRouter } from './routes/reservations';
import { alterationsRouter } from './routes/alterations';
import { hostawayConnectRouter } from './routes/hostaway-connect';
import { makeKnowledgeController } from './controllers/knowledge.controller';
import { errorMiddleware } from './middleware/error';
import { getAiApiLog } from './services/ai.service';
import { authMiddleware } from './middleware/auth';
import { getMessageSyncStats } from './services/message-sync.service';

export function createApp(prisma: PrismaClient) {
  const app = express();

  // Trust first proxy hop (Railway reverse proxy)
  app.set('trust proxy', 1);

  // ── Security headers (FR-015) ───────────────────────────────────────────
  app.use(helmet({
    contentSecurityPolicy: false,       // API-only, no HTML served
    crossOriginEmbedderPolicy: false,   // Not needed for API
  }));

  // ── Middleware ────────────────────────────────────────────────────────────
  const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',')
    : ['http://localhost:3000'];
  if (process.env.NODE_ENV === 'production' && !process.env.CORS_ORIGINS) {
    console.warn('[CORS] WARNING: CORS_ORIGINS not set in production — falling back to localhost. This is unsafe for production.');
  }
  app.use(cors({ origin: allowedOrigins, credentials: true }));
  app.use(express.json({
    limit: '10mb',
    verify: (req: any, _res, buf) => { req.rawBody = buf; },
  }));
  app.use(express.urlencoded({ extended: true }));

  // ── Health check ──────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), messageSync: getMessageSyncStats() });
  });

  // ── Routes ────────────────────────────────────────────────────────────────
  app.use('/auth', authRouter(prisma));
  app.use('/api/conversations', conversationsRouter(prisma));
  app.use('/api/properties', propertiesRouter(prisma));
  app.use('/api/import', importRouter(prisma));
  app.use('/webhooks', webhooksRouter(prisma));
  app.use('/api/ai-config', aiConfigRouter(prisma));
  app.use('/api', tasksRouter(prisma));
  app.use('/api/templates', templatesRouter(prisma));
  app.use('/api/analytics', analyticsRouter(prisma));
  app.use('/api/knowledge', knowledgeRouter(prisma));
  app.use('/api/tenant-config', tenantConfigRouter(prisma));
  app.use('/api/sandbox', sandboxRouter(prisma));
  app.use('/api/conversations', documentChecklistRouter(prisma));
  app.use('/api/tools', toolDefinitionsRouter(prisma));
  app.use('/api/push', pushRouter(prisma));
  app.use('/api/faq', faqRouter(prisma));
  app.use('/api/webhook-logs', webhookLogsRouter(prisma));
  app.use('/api/reservations', reservationsRouter(prisma));
  app.use('/api/reservations', alterationsRouter(prisma));
  app.use('/api/hostaway-connect', hostawayConnectRouter(prisma));

  // Message rating endpoint
  const knowledgeCtrl = makeKnowledgeController(prisma);
  app.post('/api/messages/:id/rate', authMiddleware as any, (req: any, res: any) => {
    knowledgeCtrl.rateMessage(req, res);
  });

  // ── AI logs helper ────────────────────────────────────────────────────────
  const normaliseBlocks = (raw: unknown): { type: string; textPreview?: string; textLength?: number }[] => {
    if (!Array.isArray(raw)) return [];
    return raw.map((b: any) => {
      const text: string | undefined = typeof b.text === 'string' ? b.text : undefined;
      return {
        type: b.type || 'text',
        textPreview: text ? text.substring(0, 500) : b.textPreview,
        textLength: text !== undefined ? text.length : b.textLength,
      };
    });
  };

  // ── AI API Logs — persistent DB + in-memory fallback ─────────────────────
  app.get('/api/ai-logs', authMiddleware as any, async (req: any, res) => {
    try {
      const tenantId = req.tenantId;
      const { agent, model, search, limit: limitStr, offset: offsetStr } = req.query as Record<string, string | undefined>;
      const limit = Math.min(parseInt(limitStr || '50', 10), 200);
      const offset = parseInt(offsetStr || '0', 10);

      const where: Record<string, unknown> = { tenantId };
      if (agent) where.agentName = agent;
      if (model) where.model = { contains: model };
      if (search) {
        where.OR = [
          { agentName: { contains: search, mode: 'insensitive' } },
          { responseText: { contains: search, mode: 'insensitive' } },
          { systemPrompt: { contains: search, mode: 'insensitive' } },
        ];
      }

      const [logs, total] = await Promise.all([
        prisma.aiApiLog.findMany({
          where: where as any,
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
        }),
        prisma.aiApiLog.count({ where: where as any }),
      ]);

      const formatted = logs.map(l => ({
        id: l.id,
        timestamp: l.createdAt.toISOString(),
        agentName: l.agentName,
        model: l.model,
        temperature: l.temperature,
        maxTokens: l.maxTokens,
        systemPromptPreview: l.systemPrompt.substring(0, 1000),
        systemPromptLength: l.systemPrompt.length,
        contentBlocks: (() => { try { return normaliseBlocks(JSON.parse(l.userContent)); } catch { return []; } })(),
        responseText: l.responseText,
        responseLength: l.responseText.length,
        inputTokens: l.inputTokens,
        outputTokens: l.outputTokens,
        costUsd: l.costUsd,
        durationMs: l.durationMs,
        conversationId: l.conversationId,
        error: l.error,
        ragContext: l.ragContext ?? null,
      }));

      res.json({ logs: formatted, total, limit, offset });
    } catch (err) {
      // Fallback to in-memory
      console.error('[AI-Logs] DB query failed, falling back to in-memory:', err);
      res.json({ logs: getAiApiLog(), total: getAiApiLog().length, limit: 50, offset: 0 });
    }
  });

  app.get('/api/ai-logs/:id', authMiddleware as any, async (req: any, res) => {
    try {
      const tenantId = req.tenantId;
      const log = await prisma.aiApiLog.findFirst({ where: { id: req.params.id, tenantId } });
      if (!log) {
        // Fallback to in-memory
        const entry = getAiApiLog().find(e => e.id === req.params.id);
        if (!entry) { res.status(404).json({ error: 'Log entry not found' }); return; }
        res.json(entry);
        return;
      }
      res.json({
        id: log.id,
        timestamp: log.createdAt.toISOString(),
        agentName: log.agentName,
        model: log.model,
        temperature: log.temperature,
        maxTokens: log.maxTokens,
        systemPromptPreview: log.systemPrompt.substring(0, 1000),
        systemPromptFull: log.systemPrompt,
        systemPromptLength: log.systemPrompt.length,
        contentBlocks: (() => { try { return normaliseBlocks(JSON.parse(log.userContent)); } catch { return []; } })(),
        responseText: log.responseText,
        responseLength: log.responseText.length,
        inputTokens: log.inputTokens,
        outputTokens: log.outputTokens,
        costUsd: log.costUsd,
        durationMs: log.durationMs,
        conversationId: log.conversationId,
        error: log.error,
        ragContext: log.ragContext ?? null,
      });
    } catch (err) {
      console.error('[AI-Logs] DB query failed:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── 404 catch-all (log unknown routes to help debug webhook config) ──────
  app.use((req, res) => {
    console.warn(`[404] ${req.method} ${req.path} — no route matched`);
    res.status(404).json({ error: `No route: ${req.method} ${req.path}` });
  });

  // ── Error handler ─────────────────────────────────────────────────────────
  app.use(errorMiddleware);

  return app;
}
