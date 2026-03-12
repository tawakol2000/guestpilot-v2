import { Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../types';
import { getAiConfig, updateAiConfig } from '../services/ai-config.service';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export function makeAiConfigController(prisma: PrismaClient) {
  return {
    async get(_req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        res.json(getAiConfig());
      } catch (err) {
        console.error('[AiConfig] get error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async update(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const updated = updateAiConfig(req.body);

        // Save a version snapshot
        try {
          const tenantId = req.tenantId;
          const lastVersion = await prisma.aiConfigVersion.findFirst({
            where: { tenantId },
            orderBy: { version: 'desc' },
          });
          const nextVersion = (lastVersion?.version ?? 0) + 1;
          await prisma.aiConfigVersion.create({
            data: {
              tenantId,
              version: nextVersion,
              config: updated as any,
              note: req.body._versionNote || null,
            },
          });
        } catch (vErr) {
          console.error('[AiConfig] version save error (non-fatal):', vErr);
        }

        res.json(updated);
      } catch (err) {
        console.error('[AiConfig] update error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async test(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { systemPrompt, userMessage, model, temperature, maxTokens } = req.body;
        if (!systemPrompt || !userMessage) {
          res.status(400).json({ error: 'systemPrompt and userMessage are required' });
          return;
        }
        const startMs = Date.now();
        const response = await anthropic.messages.create({
          model: model || 'claude-haiku-4-5-20251001',
          max_tokens: maxTokens || 2048,
          ...(temperature !== undefined ? { temperature } : {}),
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        });
        const textBlock = response.content.find(b => b.type === 'text');
        const responseText = textBlock && textBlock.type === 'text' ? textBlock.text : '';
        res.json({
          response: responseText,
          inputTokens: response.usage?.input_tokens ?? 0,
          outputTokens: response.usage?.output_tokens ?? 0,
          durationMs: Date.now() - startMs,
          model: model || 'claude-haiku-4-5-20251001',
        });
      } catch (err) {
        console.error('[AiConfig] test error:', err);
        res.status(500).json({ error: err instanceof Error ? err.message : 'Test failed' });
      }
    },

    async listVersions(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const tenantId = req.tenantId;
        const versions = await prisma.aiConfigVersion.findMany({
          where: { tenantId },
          orderBy: { version: 'desc' },
          take: 20,
        });
        res.json(versions.map(v => ({
          id: v.id,
          version: v.version,
          config: v.config,
          note: v.note,
          createdAt: v.createdAt.toISOString(),
        })));
      } catch (err) {
        console.error('[AiConfig] listVersions error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async revertVersion(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const tenantId = req.tenantId;
        const versionId = req.params.id;
        const version = await prisma.aiConfigVersion.findFirst({
          where: { id: versionId, tenantId },
        });
        if (!version) {
          res.status(404).json({ error: 'Version not found' });
          return;
        }
        const updated = updateAiConfig(version.config as any);

        // Save a new version noting the revert
        try {
          const lastVersion = await prisma.aiConfigVersion.findFirst({
            where: { tenantId },
            orderBy: { version: 'desc' },
          });
          const nextVersion = (lastVersion?.version ?? 0) + 1;
          await prisma.aiConfigVersion.create({
            data: {
              tenantId,
              version: nextVersion,
              config: updated as any,
              note: `Reverted to version ${version.version}`,
            },
          });
        } catch (vErr) {
          console.error('[AiConfig] revert version save error (non-fatal):', vErr);
        }

        res.json(updated);
      } catch (err) {
        console.error('[AiConfig] revertVersion error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  };
}
