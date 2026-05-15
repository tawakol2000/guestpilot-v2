/**
 * Feature 044: Doc-handoff settings controller.
 * Contract: specs/044-doc-handoff-whatsapp/contracts/settings-api.md
 */
import { PrismaClient } from '@prisma/client';
import { Response } from 'express';
import { AuthenticatedRequest } from '../types';
import { isValidRecipient, isValidTime } from '../config/doc-handoff-defaults';
import {
  isWasenderEnabled,
  sendText,
  WasenderDisabledError,
  WasenderRequestError,
  WasenderServerError,
  WasenderTimeoutError,
} from '../services/wasender.service';
import {
  forceFireDocHandoff,
  listTodayCheckIns,
} from '../services/doc-handoff.service';

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

    async testSend(req: AuthenticatedRequest, res: Response) {
      const tenantId = req.tenantId!;
      const body = (req.body || {}) as {
        to?: string;
        recipient?: 'manager' | 'security' | 'custom';
        text?: string;
      };

      const diagnostics: {
        envEnabled: boolean;
        baseUrl: string;
        timeoutMs: number;
        recipientResolved: string | null;
        recipientSource: 'manager' | 'security' | 'custom' | null;
        recipientValid: boolean;
        attempted: boolean;
        ok: boolean;
        providerMessageId: string | null;
        errorKind: string | null;
        errorStatus: number | null;
        errorMessage: string | null;
        responseBody: unknown;
        durationMs: number;
      } = {
        envEnabled: isWasenderEnabled(),
        baseUrl: process.env.WASENDER_BASE_URL || 'https://wasenderapi.com',
        timeoutMs: Number(process.env.WASENDER_TIMEOUT_MS) || 15_000,
        recipientResolved: null,
        recipientSource: null,
        recipientValid: false,
        attempted: false,
        ok: false,
        providerMessageId: null,
        errorKind: null,
        errorStatus: null,
        errorMessage: null,
        responseBody: null,
        durationMs: 0,
      };

      try {
        // Resolve recipient: explicit `to` wins; else load from tenant config.
        let recipient: string | null = null;
        let source: 'manager' | 'security' | 'custom' | null = null;
        if (body.to && typeof body.to === 'string') {
          recipient = body.to.trim();
          source = 'custom';
        } else if (body.recipient === 'manager' || body.recipient === 'security') {
          const tenant = await prisma.tenant.findUnique({
            where: { id: tenantId },
            select: {
              docHandoffManagerRecipient: true,
              docHandoffSecurityRecipient: true,
            },
          });
          recipient =
            body.recipient === 'manager'
              ? tenant?.docHandoffManagerRecipient ?? null
              : tenant?.docHandoffSecurityRecipient ?? null;
          source = body.recipient;
        }

        diagnostics.recipientResolved = recipient;
        diagnostics.recipientSource = source;
        diagnostics.recipientValid = isValidRecipient(recipient);

        if (!recipient) {
          res.status(400).json({
            ok: false,
            error: source
              ? `No ${source} recipient configured on this tenant`
              : 'Missing `to` or `recipient` field',
            diagnostics,
          });
          return;
        }
        if (!diagnostics.recipientValid) {
          res.status(400).json({
            ok: false,
            error: 'Recipient is not a valid E.164 phone (+...) or WhatsApp group JID (...@g.us)',
            diagnostics,
          });
          return;
        }
        if (!diagnostics.envEnabled) {
          res.status(400).json({
            ok: false,
            error: 'WAsender disabled — WASENDER_API_KEY env var is not set on the backend',
            diagnostics,
          });
          return;
        }

        const text =
          (typeof body.text === 'string' && body.text.trim()) ||
          `GuestPilot test message — ${new Date().toISOString()}`;

        diagnostics.attempted = true;
        const t0 = Date.now();
        try {
          const result = await sendText({ to: recipient, text });
          diagnostics.durationMs = Date.now() - t0;
          diagnostics.ok = true;
          diagnostics.providerMessageId = result.providerMessageId;
          diagnostics.responseBody = result.raw;
          res.json({ ok: true, diagnostics });
          return;
        } catch (err: any) {
          diagnostics.durationMs = Date.now() - t0;
          if (err instanceof WasenderDisabledError) {
            diagnostics.errorKind = 'disabled';
            diagnostics.errorMessage = err.message;
          } else if (err instanceof WasenderTimeoutError) {
            diagnostics.errorKind = 'timeout';
            diagnostics.errorMessage = err.message;
          } else if (err instanceof WasenderServerError) {
            diagnostics.errorKind = 'server_error';
            diagnostics.errorStatus = err.status;
            diagnostics.errorMessage = err.message;
          } else if (err instanceof WasenderRequestError) {
            diagnostics.errorKind = 'request_error';
            diagnostics.errorStatus = err.status;
            diagnostics.errorMessage = err.message;
            diagnostics.responseBody = err.responseBody;
          } else {
            diagnostics.errorKind = 'unknown';
            diagnostics.errorMessage = err?.message || String(err);
          }
          res.status(200).json({ ok: false, error: diagnostics.errorMessage, diagnostics });
          return;
        }
      } catch (err: any) {
        console.error('[DocHandoff] testSend failed:', err);
        res.status(500).json({
          ok: false,
          error: 'Test send crashed',
          diagnostics: { ...diagnostics, errorKind: 'crash', errorMessage: err?.message || String(err) },
        });
      }
    },

    async listToday(req: AuthenticatedRequest, res: Response) {
      try {
        const tenantId = req.tenantId!;
        const items = await listTodayCheckIns(tenantId, prisma);
        res.json({ items });
      } catch (err: any) {
        console.error('[DocHandoff] listToday failed:', err);
        res.status(500).json({ error: 'Failed to list today reservations' });
      }
    },

    async forceFire(req: AuthenticatedRequest, res: Response) {
      try {
        const tenantId = req.tenantId!;
        const body = (req.body || {}) as {
          reservationId?: string;
          messageType?: 'REMINDER' | 'HANDOFF';
        };
        if (!body.reservationId || typeof body.reservationId !== 'string') {
          return sendValidation(res, 'reservationId', 'Missing reservationId');
        }
        if (body.messageType !== 'REMINDER' && body.messageType !== 'HANDOFF') {
          return sendValidation(res, 'messageType', 'messageType must be REMINDER or HANDOFF');
        }
        // Tenant scope guard — never let one tenant fire another's handoff.
        const reservation = await prisma.reservation.findFirst({
          where: { id: body.reservationId, tenantId },
          select: { id: true },
        });
        if (!reservation) {
          res.status(404).json({ error: 'Reservation not found for this tenant' });
          return;
        }

        const t0 = Date.now();
        const { rowId, result, row } = await forceFireDocHandoff(
          body.reservationId,
          body.messageType,
          prisma,
        );
        res.json({
          ok: result === 'sent',
          result,
          rowId,
          durationMs: Date.now() - t0,
          row: row
            ? {
                status: row.status,
                sentAt: row.sentAt?.toISOString() ?? null,
                recipientUsed: row.recipientUsed,
                messageBodyUsed: row.messageBodyUsed,
                imageUrlCount: row.imageUrlsUsed.length,
                imageUrlsUsed: row.imageUrlsUsed,
                providerMessageId: row.providerMessageId,
                lastError: row.lastError,
                attemptCount: row.attemptCount,
              }
            : null,
        });
      } catch (err: any) {
        console.error('[DocHandoff] forceFire failed:', err);
        res.status(500).json({ error: err?.message || 'Force-fire failed' });
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
