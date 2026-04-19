/**
 * Feature 044: Doc-handoff settings controller.
 * Contract: specs/044-doc-handoff-whatsapp/contracts/settings-api.md
 */
import { PrismaClient } from '@prisma/client';
import { Response } from 'express';
import { AuthenticatedRequest } from '../types';
import { isValidRecipient, isValidTime } from '../config/doc-handoff-defaults';

export function makeDocHandoffController(prisma: PrismaClient) {
  return {
    async getSettings(req: AuthenticatedRequest, res: Response) {
      try {
        const tenantId = req.tenantId!;
        const tenant = await prisma.tenant.findUnique({
          where: { id: tenantId },
          select: {
            docHandoffManagerRecipient: true,
            docHandoffSecurityRecipient: true,
            docHandoffReminderTime: true,
            docHandoffTime: true,
            docHandoffEnabled: true,
          },
        });
        if (!tenant) {
          res.status(404).json({ error: 'Tenant not found' });
          return;
        }
        res.json({
          enabled: tenant.docHandoffEnabled,
          managerRecipient: tenant.docHandoffManagerRecipient,
          securityRecipient: tenant.docHandoffSecurityRecipient,
          reminderTime: tenant.docHandoffReminderTime,
          handoffTime: tenant.docHandoffTime,
        });
      } catch (err: any) {
        console.error('[DocHandoff] getSettings failed:', err);
        res.status(500).json({ error: 'Failed to load doc-handoff settings' });
      }
    },

    async putSettings(req: AuthenticatedRequest, res: Response) {
      try {
        const tenantId = req.tenantId!;
        const body = req.body as {
          enabled?: boolean;
          managerRecipient?: string | null;
          securityRecipient?: string | null;
          reminderTime?: string;
          handoffTime?: string;
        };

        const data: Record<string, unknown> = {};

        if (body.enabled !== undefined) {
          if (typeof body.enabled !== 'boolean') {
            return sendValidation(res, 'enabled', 'Must be a boolean');
          }
          data.docHandoffEnabled = body.enabled;
        }
        if (body.managerRecipient !== undefined) {
          if (body.managerRecipient !== null && body.managerRecipient !== '' && !isValidRecipient(body.managerRecipient)) {
            return sendValidation(res, 'managerRecipient', 'Invalid manager recipient');
          }
          data.docHandoffManagerRecipient = body.managerRecipient || null;
        }
        if (body.securityRecipient !== undefined) {
          if (body.securityRecipient !== null && body.securityRecipient !== '' && !isValidRecipient(body.securityRecipient)) {
            return sendValidation(res, 'securityRecipient', 'Invalid security recipient');
          }
          data.docHandoffSecurityRecipient = body.securityRecipient || null;
        }
        if (body.reminderTime !== undefined) {
          if (!isValidTime(body.reminderTime)) {
            return sendValidation(res, 'reminderTime', 'Invalid reminder time (HH:MM)');
          }
          data.docHandoffReminderTime = body.reminderTime;
        }
        if (body.handoffTime !== undefined) {
          if (!isValidTime(body.handoffTime)) {
            return sendValidation(res, 'handoffTime', 'Invalid handoff time (HH:MM)');
          }
          data.docHandoffTime = body.handoffTime;
        }

        const tenant = await prisma.tenant.update({
          where: { id: tenantId },
          data,
          select: {
            docHandoffManagerRecipient: true,
            docHandoffSecurityRecipient: true,
            docHandoffReminderTime: true,
            docHandoffTime: true,
            docHandoffEnabled: true,
          },
        });

        res.json({
          enabled: tenant.docHandoffEnabled,
          managerRecipient: tenant.docHandoffManagerRecipient,
          securityRecipient: tenant.docHandoffSecurityRecipient,
          reminderTime: tenant.docHandoffReminderTime,
          handoffTime: tenant.docHandoffTime,
        });
      } catch (err: any) {
        console.error('[DocHandoff] putSettings failed:', err);
        res.status(500).json({ error: 'Failed to update doc-handoff settings' });
      }
    },

    async listRecentSends(req: AuthenticatedRequest, res: Response) {
      try {
        const tenantId = req.tenantId!;
        const rawLimit = Number(req.query.limit);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
        const rows = await prisma.documentHandoffState.findMany({
          where: { tenantId },
          orderBy: { updatedAt: 'desc' },
          take: limit,
          select: {
            id: true,
            reservationId: true,
            messageType: true,
            status: true,
            scheduledFireAt: true,
            sentAt: true,
            recipientUsed: true,
            messageBodyUsed: true,
            imageUrlsUsed: true,
            lastError: true,
            providerMessageId: true,
          },
        });
        res.json({
          items: rows.map(r => ({
            id: r.id,
            reservationId: r.reservationId,
            messageType: r.messageType,
            status: r.status,
            scheduledFireAt: r.scheduledFireAt.toISOString(),
            sentAt: r.sentAt?.toISOString() ?? null,
            recipientUsed: r.recipientUsed,
            messageBodyUsed: r.messageBodyUsed,
            imageUrlCount: r.imageUrlsUsed.length,
            lastError: r.lastError,
            providerMessageId: r.providerMessageId,
          })),
        });
      } catch (err: any) {
        console.error('[DocHandoff] listRecentSends failed:', err);
        res.status(500).json({ error: 'Failed to list recent sends' });
      }
    },
  };
}

function sendValidation(res: Response, field: string, message: string) {
  res.status(400).json({ error: message, field, message });
}
