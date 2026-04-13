import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { getAiApiLog } from '../services/ai.service';

// Helper: normalise content blocks for list view
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

export function aiLogsRouter(prisma: PrismaClient): Router {
  const router = Router();
  const auth = authMiddleware as unknown as RequestHandler;

  // GET /api/ai-logs — list AI API logs (was inlined in app.ts)
  router.get('/', auth, async (req: any, res) => {
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

  // GET /api/ai-logs/:id — single AI API log detail (was inlined in app.ts)
  router.get('/:id', auth, async (req: any, res) => {
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

  return router;
}
