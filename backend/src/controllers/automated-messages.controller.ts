import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../types';

export function makeAutomatedMessagesController(prisma: PrismaClient) {
  return {
    async list(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const messages = await prisma.automatedMessage.findMany({
          where: { tenantId: req.tenantId },
          orderBy: { createdAt: 'desc' },
        });
        res.json(messages);
      } catch (err) {
        console.error('[AutomatedMessages] list error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async create(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { name, trigger, content, timing, channel, enabled } = req.body;
        const msg = await prisma.automatedMessage.create({
          data: {
            tenantId: req.tenantId,
            name: name || 'Untitled',
            trigger: trigger || 'manual',
            content: content || '',
            timing: timing || null,
            channel: channel || null,
            enabled: enabled !== false,
          },
        });
        res.json(msg);
      } catch (err) {
        console.error('[AutomatedMessages] create error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async update(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { id } = req.params;
        const existing = await prisma.automatedMessage.findFirst({ where: { id, tenantId: req.tenantId } });
        if (!existing) { res.status(404).json({ error: 'Not found' }); return; }
        const { name, trigger, content, timing, channel, enabled } = req.body;
        const updated = await prisma.automatedMessage.update({
          where: { id },
          data: {
            ...(name !== undefined ? { name } : {}),
            ...(trigger !== undefined ? { trigger } : {}),
            ...(content !== undefined ? { content } : {}),
            ...(timing !== undefined ? { timing } : {}),
            ...(channel !== undefined ? { channel } : {}),
            ...(enabled !== undefined ? { enabled } : {}),
            lastEditedAt: new Date(),
          },
        });
        res.json(updated);
      } catch (err) {
        console.error('[AutomatedMessages] update error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async toggle(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { id } = req.params;
        const existing = await prisma.automatedMessage.findFirst({ where: { id, tenantId: req.tenantId } });
        if (!existing) { res.status(404).json({ error: 'Not found' }); return; }
        const updated = await prisma.automatedMessage.update({
          where: { id },
          data: { enabled: !existing.enabled },
        });
        res.json(updated);
      } catch (err) {
        console.error('[AutomatedMessages] toggle error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async remove(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { id } = req.params;
        const existing = await prisma.automatedMessage.findFirst({ where: { id, tenantId: req.tenantId } });
        if (!existing) { res.status(404).json({ error: 'Not found' }); return; }
        await prisma.automatedMessage.delete({ where: { id } });
        res.json({ ok: true });
      } catch (err) {
        console.error('[AutomatedMessages] remove error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async sync(req: AuthenticatedRequest, res: Response): Promise<void> {
      // Placeholder — would call Hostaway API to fetch automated messages
      // For now just return current list
      try {
        const messages = await prisma.automatedMessage.findMany({
          where: { tenantId: req.tenantId },
          orderBy: { createdAt: 'desc' },
        });
        res.json({ synced: 0, messages });
      } catch (err) {
        console.error('[AutomatedMessages] sync error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  };
}
