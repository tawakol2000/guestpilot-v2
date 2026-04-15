/**
 * Feature 041 sprint 03 — CapabilityRequest backlog CRUD.
 *
 *   GET   /api/capability-requests
 *   PATCH /api/capability-requests/:id   { status }
 *
 * Additive; the table is written by sprint-02's diagnostic suggestion writer
 * when the model outputs MISSING_CAPABILITY. V1 has no create-from-UI path.
 */
import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../types';

const VALID_STATUSES = new Set(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'WONT_FIX']);

export function makeCapabilityRequestController(prisma: PrismaClient) {
  return {
    async list(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const rows = await prisma.capabilityRequest.findMany({
          where: { tenantId },
          orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
          take: 200,
        });
        res.json({
          requests: rows.map((r) => ({
            id: r.id,
            title: r.title,
            description: r.description,
            rationale: r.rationale,
            sourceConversationId: r.sourceConversationId,
            status: r.status,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
          })),
        });
      } catch (err) {
        console.error('[capability-request] list failed:', err);
        res.status(500).json({ error: 'INTERNAL_ERROR' });
      }
    },

    async update(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { id } = req.params;
        const body = req.body || {};
        const status = typeof body.status === 'string' ? body.status : null;
        if (!status || !VALID_STATUSES.has(status)) {
          res.status(400).json({ error: 'INVALID_STATUS' });
          return;
        }
        const row = await prisma.capabilityRequest.findFirst({
          where: { id, tenantId },
        });
        if (!row) {
          res.status(404).json({ error: 'CAPABILITY_REQUEST_NOT_FOUND' });
          return;
        }
        const updated = await prisma.capabilityRequest.update({
          where: { id: row.id },
          data: { status },
        });
        res.json({ ok: true, request: updated });
      } catch (err) {
        console.error('[capability-request] update failed:', err);
        res.status(500).json({ error: 'INTERNAL_ERROR' });
      }
    },
  };
}
