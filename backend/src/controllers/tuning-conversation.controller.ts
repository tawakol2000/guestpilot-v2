/**
 * Tuning conversation CRUD.
 *
 *   POST   /api/tuning/conversations        — create a TuningConversation.
 *                                             Body: { anchorMessageId?, triggerType?, initialMessage?, title? }
 *   GET    /api/tuning/conversations        — list for the tenant (pagination + q).
 *   GET    /api/tuning/conversations/:id    — fetch with messages.
 *   PATCH  /api/tuning/conversations/:id    — rename / archive.
 *
 * All tenant-scoped via authMiddleware.
 */
import { Response } from 'express';
import { PrismaClient, TuningConversationTriggerType } from '@prisma/client';
import { AuthenticatedRequest } from '../types';
import {
  coerceSnapshot,
  type InnerState,
  type OuterMode,
  type StateMachineSnapshot,
} from '../build-tune-agent/state-machine';
import { verifyTransitionNonce } from '../build-tune-agent/tools/lib/transition-nonce';

const VALID_TRIGGERS: readonly TuningConversationTriggerType[] = [
  'MANUAL',
  'EDIT_TRIGGERED',
  'REJECT_TRIGGERED',
  'COMPLAINT_TRIGGERED',
  'THUMBS_DOWN_TRIGGERED',
  'CLUSTER_TRIGGERED',
  'ESCALATION_TRIGGERED',
];

function deriveTitleFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;
  return trimmed.slice(0, 80);
}

export function makeTuningConversationController(prisma: PrismaClient) {
  return {
    async create(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const userId = (req as any).userId ?? null;
        const body = (req.body ?? {}) as {
          anchorMessageId?: string | null;
          triggerType?: string;
          initialMessage?: string;
          title?: string;
        };

        const trig = body.triggerType && VALID_TRIGGERS.includes(body.triggerType as TuningConversationTriggerType)
          ? (body.triggerType as TuningConversationTriggerType)
          : 'MANUAL';

        // Validate anchor message belongs to tenant, if provided.
        let anchorMessageId: string | null = null;
        if (body.anchorMessageId) {
          const msg = await prisma.message.findFirst({
            where: { id: body.anchorMessageId, tenantId },
            select: { id: true },
          });
          if (!msg) {
            res.status(404).json({ error: 'ANCHOR_MESSAGE_NOT_FOUND' });
            return;
          }
          anchorMessageId = msg.id;
        }

        const title = body.title ?? deriveTitleFromText(body.initialMessage) ?? null;

        // Bugfix (2026-04-23): was returning only 5 fields, but the
        // frontend's TuningConversationSummary type (used by the
        // Studio left-rail + startNew flow) also reads `status`,
        // `updatedAt`, and `messageCount`. Callers were falling back
        // to hardcoded defaults ('OPEN', null, 0). Return the full
        // summary shape so there's no drift between POST / GET / list.
        const conv = await prisma.tuningConversation.create({
          data: {
            tenantId,
            userId,
            triggerType: trig,
            anchorMessageId,
            title,
            status: 'OPEN',
          },
          select: {
            id: true,
            title: true,
            anchorMessageId: true,
            triggerType: true,
            status: true,
            createdAt: true,
            updatedAt: true,
            _count: { select: { messages: true } },
          },
        });

        res.status(201).json({
          conversation: {
            id: conv.id,
            title: conv.title,
            anchorMessageId: conv.anchorMessageId,
            triggerType: conv.triggerType,
            status: conv.status,
            messageCount: conv._count.messages,
            createdAt: conv.createdAt,
            updatedAt: conv.updatedAt,
          },
        });
      } catch (err) {
        console.error('[tuning-conversation] create failed:', err);
        res.status(500).json({ error: 'INTERNAL_ERROR' });
      }
    },

    async list(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const limit = Math.max(1, Math.min(100, parseInt(String(req.query.limit || '30'), 10) || 30));
        const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
        const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

        const where: any = { tenantId };

        // Substring search over TuningMessage.parts content. Keep it simple
        // via raw query to avoid Json path-quirks on older Postgres.
        //
        // Sprint 09 follow-up: join to TuningConversation and filter by
        // tenantId so the scan doesn't iterate every TuningMessage in the
        // database. The outer `where.id = { in: ids }` already narrows the
        // result to tenant-scoped conversations, but the raw query itself
        // should not cross tenants.
        if (q) {
          // Escape ILIKE wildcards in the user-supplied query string. Without
          // this, a search for "100%" becomes "%100%%" and matches far more
          // rows than intended; `_` similarly matches any single char. Not
          // an SQLi vector (parameterised), but a user-visible correctness
          // bug — `%`, `_`, and `\` all need escaping.
          const escaped = q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
          const ids = await prisma.$queryRawUnsafe<{ conversationId: string }[]>(
            `SELECT DISTINCT m."conversationId"
             FROM "TuningMessage" m
             INNER JOIN "TuningConversation" c ON c.id = m."conversationId"
             WHERE c."tenantId" = $2 AND m."parts"::text ILIKE $1 ESCAPE '\\'
             LIMIT 500`,
            `%${escaped}%`,
            tenantId
          );
          where.id = { in: ids.map((r) => r.conversationId) };
        }

        const rows = await prisma.tuningConversation.findMany({
          where,
          orderBy: { updatedAt: 'desc' },
          take: limit + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: {
            id: true,
            title: true,
            anchorMessageId: true,
            triggerType: true,
            status: true,
            createdAt: true,
            updatedAt: true,
            _count: { select: { messages: true } },
          },
        });

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;

        res.json({
          conversations: page.map((c) => ({
            id: c.id,
            title: c.title,
            anchorMessageId: c.anchorMessageId,
            triggerType: c.triggerType,
            status: c.status,
            messageCount: c._count.messages,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
          })),
          nextCursor: hasMore ? page[page.length - 1].id : null,
        });
      } catch (err) {
        console.error('[tuning-conversation] list failed:', err);
        res.status(500).json({ error: 'INTERNAL_ERROR' });
      }
    },

    async get(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { id } = req.params;

        // Bugfix (2026-04-23): the include previously fetched the
        // anchorMessage with no tenant filter. If data corruption or a
        // historic race ever landed a TuningConversation pointing at
        // another tenant's Message, this GET would leak that message
        // body cross-tenant. Filter the relation explicitly — Prisma
        // returns null when the join doesn't match the filter, which
        // the response mapper below already treats as "no anchor."
        const conv = await prisma.tuningConversation.findFirst({
          where: { id, tenantId },
          include: {
            messages: { orderBy: { createdAt: 'asc' } },
            anchorMessage: {
              where: { tenantId },
              select: {
                id: true,
                content: true,
                role: true,
                sentAt: true,
                conversationId: true,
              },
            },
          },
        });

        if (!conv) {
          res.status(404).json({ error: 'CONVERSATION_NOT_FOUND' });
          return;
        }

        // Sprint 060-C — return the current state-machine snapshot so the
        // frontend can paint the state chip + reclassify control on
        // initial load without waiting for the next turn's SSE event.
        const stateMachineSnapshot = coerceSnapshot((conv as any).stateMachineSnapshot);
        res.json({
          conversation: {
            id: conv.id,
            title: conv.title,
            anchorMessageId: conv.anchorMessageId,
            anchorMessage: conv.anchorMessage,
            triggerType: conv.triggerType,
            status: conv.status,
            sdkSessionId: conv.sdkSessionId,
            createdAt: conv.createdAt,
            updatedAt: conv.updatedAt,
            stateMachineSnapshot,
            messages: conv.messages.map((m) => ({
              id: m.id,
              role: m.role,
              parts: m.parts,
              createdAt: m.createdAt,
            })),
          },
        });
      } catch (err) {
        console.error('[tuning-conversation] get failed:', err);
        res.status(500).json({ error: 'INTERNAL_ERROR' });
      }
    },

    async patch(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { id } = req.params;
        const body = (req.body ?? {}) as { title?: string | null; status?: string };

        const conv = await prisma.tuningConversation.findFirst({
          where: { id, tenantId },
          select: { id: true },
        });
        if (!conv) {
          res.status(404).json({ error: 'CONVERSATION_NOT_FOUND' });
          return;
        }

        const data: any = {};
        if (typeof body.title === 'string' || body.title === null) data.title = body.title;
        if (typeof body.status === 'string') data.status = body.status;
        if (Object.keys(data).length === 0) {
          res.status(400).json({ error: 'NO_UPDATES' });
          return;
        }

        // Bugfix (2026-04-23): align PATCH response shape with
        // list/GET/create so the frontend gets a complete
        // TuningConversationSummary and doesn't have to merge with
        // hardcoded fallbacks. Also adds tenantId to the update's
        // where clause as defence-in-depth (findFirst above already
        // validated tenant scope).
        const updated = await prisma.tuningConversation.update({
          where: { id, tenantId },
          data,
          select: {
            id: true,
            title: true,
            anchorMessageId: true,
            triggerType: true,
            status: true,
            createdAt: true,
            updatedAt: true,
            _count: { select: { messages: true } },
          },
        });
        res.json({
          conversation: {
            id: updated.id,
            title: updated.title,
            anchorMessageId: updated.anchorMessageId,
            triggerType: updated.triggerType,
            status: updated.status,
            messageCount: updated._count.messages,
            createdAt: updated.createdAt,
            updatedAt: updated.updatedAt,
          },
        });
      } catch (err) {
        console.error('[tuning-conversation] patch failed:', err);
        res.status(500).json({ error: 'INTERNAL_ERROR' });
      }
    },

    // ─── Sprint 060-C — state machine endpoints ─────────────────────────
    //
    // Three endpoints handle the agent-proposed / host-confirmed transition
    // protocol. The DB is the only source of truth for inner_state /
    // outer_mode; these endpoints are the only path that mutates them.

    async confirmTransition(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { id, nonce } = req.params;
        if (!nonce) {
          res.status(400).json({ error: 'NONCE_REQUIRED' });
          return;
        }
        const verified = verifyTransitionNonce(nonce);
        if (!verified.ok) {
          res.status(400).json({ error: 'INVALID_NONCE', reason: verified.reason });
          return;
        }
        const conv = await prisma.tuningConversation.findFirst({
          where: { id, tenantId },
          select: { id: true, stateMachineSnapshot: true },
        });
        if (!conv) {
          res.status(404).json({ error: 'CONVERSATION_NOT_FOUND' });
          return;
        }
        const snapshot = coerceSnapshot(conv.stateMachineSnapshot);
        const pending = snapshot.pending_transition;
        if (!pending) {
          res.status(409).json({ error: 'NO_PENDING_TRANSITION' });
          return;
        }
        if (pending.token !== nonce) {
          res.status(409).json({ error: 'NONCE_MISMATCH' });
          return;
        }
        const expiresAt = new Date(pending.expires_at).getTime();
        if (Number.isFinite(expiresAt) && Date.now() > expiresAt) {
          res.status(410).json({ error: 'NONCE_EXPIRED' });
          return;
        }
        const now = new Date();
        const next: StateMachineSnapshot = {
          ...snapshot,
          inner_state: pending.to,
          last_transition_at: now.toISOString(),
          last_transition_reason: pending.because,
          transition_ack_pending: true,
          pending_transition: null,
        };
        await prisma.tuningConversation.update({
          where: { id, tenantId },
          data: { stateMachineSnapshot: next as unknown as object },
        });
        res.json({ ok: true, stateMachineSnapshot: next });
      } catch (err) {
        console.error('[tuning-conversation] confirmTransition failed:', err);
        res.status(500).json({ error: 'INTERNAL_ERROR' });
      }
    },

    async rejectTransition(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { id, nonce } = req.params;
        if (!nonce) {
          res.status(400).json({ error: 'NONCE_REQUIRED' });
          return;
        }
        const verified = verifyTransitionNonce(nonce);
        if (!verified.ok) {
          res.status(400).json({ error: 'INVALID_NONCE', reason: verified.reason });
          return;
        }
        const conv = await prisma.tuningConversation.findFirst({
          where: { id, tenantId },
          select: { id: true, stateMachineSnapshot: true },
        });
        if (!conv) {
          res.status(404).json({ error: 'CONVERSATION_NOT_FOUND' });
          return;
        }
        const snapshot = coerceSnapshot(conv.stateMachineSnapshot);
        const pending = snapshot.pending_transition;
        // Idempotent: if pending is gone or doesn't match the nonce,
        // there's nothing to reject. Don't 409 — the client may have
        // double-clicked or the proposal already expired. Just return ok.
        if (!pending || pending.token !== nonce) {
          res.json({ ok: true, stateMachineSnapshot: snapshot, alreadyCleared: true });
          return;
        }
        const next: StateMachineSnapshot = {
          ...snapshot,
          pending_transition: null,
        };
        await prisma.tuningConversation.update({
          where: { id, tenantId },
          data: { stateMachineSnapshot: next as unknown as object },
        });
        res.json({ ok: true, stateMachineSnapshot: next });
      } catch (err) {
        console.error('[tuning-conversation] rejectTransition failed:', err);
        res.status(500).json({ error: 'INTERNAL_ERROR' });
      }
    },

    async reclassify(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { id } = req.params;
        const body = (req.body ?? {}) as { outer_mode?: string };
        const requested = body.outer_mode;
        if (requested !== 'BUILD' && requested !== 'TUNE') {
          res.status(400).json({ error: 'INVALID_OUTER_MODE' });
          return;
        }
        const target: OuterMode = requested;
        const conv = await prisma.tuningConversation.findFirst({
          where: { id, tenantId },
          select: { id: true, stateMachineSnapshot: true },
        });
        if (!conv) {
          res.status(404).json({ error: 'CONVERSATION_NOT_FOUND' });
          return;
        }
        const snapshot = coerceSnapshot(conv.stateMachineSnapshot);
        if (snapshot.outer_mode === target && !snapshot.pending_transition) {
          // No-op — return current snapshot, idempotent.
          res.json({ ok: true, stateMachineSnapshot: snapshot, noop: true });
          return;
        }
        const cancelledPending = !!snapshot.pending_transition;
        const now = new Date();
        const next: StateMachineSnapshot = {
          ...snapshot,
          outer_mode: target,
          // Preserve inner_state — cognitive posture is mode-agnostic.
          inner_state: snapshot.inner_state as InnerState,
          pending_transition: null,
          // Only emit a one-turn ack block if we cancelled an in-flight
          // proposal (the agent needs to know that). Plain mode flips
          // don't need an ack block — the next turn's tenant_state
          // already conveys the new outer mode.
          transition_ack_pending: cancelledPending ? true : snapshot.transition_ack_pending,
          last_transition_at: cancelledPending ? now.toISOString() : snapshot.last_transition_at,
          last_transition_reason: cancelledPending
            ? `Reclassified to ${target}; in-flight inner transition cancelled.`
            : snapshot.last_transition_reason,
        };
        await prisma.tuningConversation.update({
          where: { id, tenantId },
          data: { stateMachineSnapshot: next as unknown as object },
        });
        res.json({ ok: true, stateMachineSnapshot: next, cancelledPending });
      } catch (err) {
        console.error('[tuning-conversation] reclassify failed:', err);
        res.status(500).json({ error: 'INTERNAL_ERROR' });
      }
    },
  };
}
