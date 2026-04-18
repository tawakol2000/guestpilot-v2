// Feature 043 — AutomatedReplyTemplate CRUD for the Settings UI.
//
// Contract: specs/043-checkin-checkout-actions/contracts/reply-templates-api.md
import { Response } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../types';
import {
  SUPPORTED_ESCALATION_TYPES,
  SUPPORTED_DECISIONS,
  getDefaultReplyTemplate,
  isSupportedEscalationType,
  isSupportedDecision,
} from '../config/reply-template-defaults';

const upsertBodySchema = z.object({
  body: z.string().min(1).max(4000),
});

export function makeReplyTemplatesController(prisma: PrismaClient) {
  return {
    async list(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;

        const existing = await prisma.automatedReplyTemplate.findMany({
          where: { tenantId },
        });

        const byKey = new Map<string, { body: string; updatedAt: Date }>();
        for (const row of existing) {
          byKey.set(`${row.escalationType}::${row.decision}`, {
            body: row.body,
            updatedAt: row.updatedAt,
          });
        }

        const templates: Array<{
          escalationType: string;
          decision: 'approve' | 'reject';
          body: string;
          isDefault: boolean;
          updatedAt: string | null;
        }> = [];

        for (const type of SUPPORTED_ESCALATION_TYPES) {
          for (const decision of SUPPORTED_DECISIONS) {
            const key = `${type}::${decision}`;
            const override = byKey.get(key);
            if (override) {
              templates.push({
                escalationType: type,
                decision,
                body: override.body,
                isDefault: false,
                updatedAt: override.updatedAt.toISOString(),
              });
            } else {
              templates.push({
                escalationType: type,
                decision,
                body: getDefaultReplyTemplate(type, decision) ?? '',
                isDefault: true,
                updatedAt: null,
              });
            }
          }
        }

        res.json({ templates });
      } catch (err) {
        console.error('[ReplyTemplates] list error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async upsert(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { escalationType, decision } = req.params;

        if (!isSupportedEscalationType(escalationType)) {
          res.status(400).json({ error: 'Unsupported escalation type' });
          return;
        }
        if (!isSupportedDecision(decision)) {
          res.status(400).json({ error: "decision must be 'approve' or 'reject'" });
          return;
        }

        const parsed = upsertBodySchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.flatten() });
          return;
        }

        const saved = await prisma.automatedReplyTemplate.upsert({
          where: {
            tenantId_escalationType_decision: { tenantId, escalationType, decision },
          },
          update: { body: parsed.data.body },
          create: { tenantId, escalationType, decision, body: parsed.data.body },
        });

        res.json({
          escalationType: saved.escalationType,
          decision: saved.decision,
          body: saved.body,
          isDefault: false,
          updatedAt: saved.updatedAt.toISOString(),
        });
      } catch (err) {
        console.error('[ReplyTemplates] upsert error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async remove(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { escalationType, decision } = req.params;

        if (!isSupportedEscalationType(escalationType) || !isSupportedDecision(decision)) {
          // Still 204 — delete is idempotent even if the args are nonsense.
          res.status(204).end();
          return;
        }

        await prisma.automatedReplyTemplate
          .delete({
            where: {
              tenantId_escalationType_decision: { tenantId, escalationType, decision },
            },
          })
          .catch(() => {
            // Row didn't exist — 204 anyway.
          });

        res.status(204).end();
      } catch (err) {
        console.error('[ReplyTemplates] remove error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  };
}
