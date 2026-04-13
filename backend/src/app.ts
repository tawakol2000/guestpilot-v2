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
import { shadowPreviewRouter } from './routes/shadow-preview';
import { tuningSuggestionRouter } from './routes/tuning-suggestion';
import { messagesRouter } from './routes/messages';
import { aiLogsRouter } from './routes/ai-logs';
import { meRouter } from './routes/me';
import { errorMiddleware } from './middleware/error';
import { getMessageSyncStats } from './services/message-sync.service';
import { setTuningAnalyzerPrisma } from './services/tuning-analyzer.service';

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
  // Feature 040: Copilot Shadow Mode routes
  app.use('/api/shadow-previews', shadowPreviewRouter(prisma));
  app.use('/api/tuning-suggestions', tuningSuggestionRouter(prisma));
  setTuningAnalyzerPrisma(prisma);

  // Route files for previously-inlined endpoints
  app.use('/api/messages', messagesRouter(prisma));
  app.use('/api/ai-logs', aiLogsRouter(prisma));
  app.use('/api/me', meRouter(prisma));

  // ── 404 catch-all (log unknown routes to help debug webhook config) ──────
  app.use((req, res) => {
    console.warn(`[404] ${req.method} ${req.path} — no route matched`);
    res.status(404).json({ error: `No route: ${req.method} ${req.path}` });
  });

  // ── Error handler ─────────────────────────────────────────────────────────
  app.use(errorMiddleware);

  return app;
}
