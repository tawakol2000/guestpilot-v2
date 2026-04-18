// Feature 043 — Task Actions controller.
//
// Implements the manager's Accept / Reject / Preview flow for action-card
// escalations (currently late_checkout_request + early_checkin_request).
// Send delivers a message via Hostaway, writes the Reservation scheduled-time
// override (accept only), resolves the Task, and appends a TaskActionLog.
//
// Contract: specs/043-checkin-checkout-actions/contracts/task-actions-api.md
import { Response } from 'express';
import { PrismaClient, MessageRole } from '@prisma/client';
import { AuthenticatedRequest } from '../types';
import * as hostawayService from '../services/hostaway.service';
import { renderReplyTemplate } from '../services/reply-template.service';
import {
  isSupportedEscalationType,
  isSupportedDecision,
} from '../config/reply-template-defaults';
import { broadcastToTenant } from '../services/socket.service';

type TimeRequestMetadata = {
  kind?: 'check_in' | 'check_out';
  requestedTime?: string;
};

function readMetadata(task: { metadata: unknown }): TimeRequestMetadata {
  const md = task.metadata;
  if (md && typeof md === 'object') return md as TimeRequestMetadata;
  return {};
}

export function makeTaskActionsController(prisma: PrismaClient) {
  return {
    async preview(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { taskId } = req.params;
        const decision = String(req.query.decision || '');

        if (!isSupportedDecision(decision)) {
          res.status(400).json({ error: "decision must be 'approve' or 'reject'" });
          return;
        }

        const task = await prisma.task.findFirst({
          where: { id: taskId, tenantId },
          select: { id: true, type: true, status: true, conversationId: true, metadata: true },
        });
        if (!task) {
          res.status(404).json({ error: 'Task not found' });
          return;
        }
        if (!isSupportedEscalationType(task.type)) {
          res.status(400).json({ error: 'Unsupported task type for this endpoint' });
          return;
        }
        if (task.status === 'resolved') {
          res.status(409).json({ error: 'Task is already resolved' });
          return;
        }
        if (!task.conversationId) {
          res.status(400).json({ error: 'Task has no associated conversation' });
          return;
        }

        const md = readMetadata(task);
        const body = await renderReplyTemplate(
          tenantId,
          task.type,
          decision,
          { conversationId: task.conversationId, requestedTime: md.requestedTime ?? null },
          prisma
        );

        res.json({ body });
      } catch (err) {
        console.error('[TaskActions] preview error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    accept(req: AuthenticatedRequest, res: Response) {
      return resolveTask(prisma, req, res, 'approve');
    },

    reject(req: AuthenticatedRequest, res: Response) {
      return resolveTask(prisma, req, res, 'reject');
    },
  };
}

async function resolveTask(
  prisma: PrismaClient,
  req: AuthenticatedRequest,
  res: Response,
  decision: 'approve' | 'reject'
): Promise<void> {
  const t0 = Date.now();
  const { tenantId } = req;
  const { taskId } = req.params;
  let ok = false;

  try {
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!body) {
      res.status(400).json({ error: 'body required' });
      return;
    }
    if (body.length > 4000) {
      res.status(400).json({ error: 'body exceeds 4000 chars' });
      return;
    }

    const task = await prisma.task.findFirst({
      where: { id: taskId, tenantId },
      select: { id: true, type: true, status: true, conversationId: true, metadata: true },
    });
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    if (!isSupportedEscalationType(task.type)) {
      res.status(400).json({ error: 'Unsupported task type for this endpoint' });
      return;
    }
    if (task.status === 'resolved') {
      res.status(409).json({ error: 'Task is already resolved' });
      return;
    }
    if (!task.conversationId) {
      res.status(400).json({ error: 'Task has no associated conversation' });
      return;
    }

    const conversation = await prisma.conversation.findFirst({
      where: { id: task.conversationId, tenantId },
      include: { tenant: true, reservation: true },
    });
    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    // Send to guest via Hostaway BEFORE any DB writes. If this fails → 502 and
    // the task/reservation stay untouched.
    let hostawayMsgId = '';
    if (conversation.hostawayConversationId) {
      try {
        const hwResult = await hostawayService.sendMessageToConversation(
          conversation.tenant.hostawayAccountId,
          conversation.tenant.hostawayApiKey,
          conversation.hostawayConversationId,
          body,
          'channel'
        );
        hostawayMsgId = String((hwResult as any)?.result?.id || '');
      } catch (err: any) {
        console.warn(`[TaskActions] Hostaway send failed for ${taskId}: ${err?.message}`);
        res.status(502).json({ error: 'Failed to deliver message to guest' });
        return;
      }
    }

    const md = readMetadata(task);
    const rawSource = req.headers['x-client-source'] as string | undefined;
    const clientSource = rawSource && ['web', 'ios'].includes(rawSource) ? rawSource : 'web';

    const result = await prisma.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          conversationId: conversation.id,
          tenantId,
          role: MessageRole.HOST,
          content: body,
          channel: conversation.channel,
          communicationType: 'channel',
          sentAt: new Date(),
          hostawayMessageId: hostawayMsgId,
          deliveryStatus: conversation.hostawayConversationId ? 'sent' : 'pending',
          deliveredAt: conversation.hostawayConversationId ? new Date() : null,
          source: clientSource,
        },
      });

      await tx.conversation.updateMany({
        where: { id: conversation.id, tenantId },
        data: { lastMessageAt: new Date() },
      });

      let updatedReservation: { id: string; scheduledCheckInAt: string | null; scheduledCheckOutAt: string | null } | null = null;
      if (decision === 'approve' && md.kind && md.requestedTime && conversation.reservationId) {
        updatedReservation = await tx.reservation.update({
          where: { id: conversation.reservationId },
          data:
            md.kind === 'check_in'
              ? { scheduledCheckInAt: md.requestedTime }
              : { scheduledCheckOutAt: md.requestedTime },
          select: { id: true, scheduledCheckInAt: true, scheduledCheckOutAt: true },
        });
      } else if (conversation.reservationId) {
        updatedReservation = await tx.reservation.findUnique({
          where: { id: conversation.reservationId },
          select: { id: true, scheduledCheckInAt: true, scheduledCheckOutAt: true },
        });
      }

      await tx.task.update({
        where: { id: task.id },
        data: { status: 'resolved', completedAt: new Date() },
      });

      await tx.taskActionLog.create({
        data: {
          tenantId,
          taskId: task.id,
          action: decision === 'approve' ? 'accepted' : 'rejected',
          actorKind: 'manager',
          actorUserId: (req as any).userId ?? null,
          deliveredBody: body,
          requestedTime: md.requestedTime ?? null,
          appliedTime: decision === 'approve' ? md.requestedTime ?? null : null,
        },
      });

      return { message, reservation: updatedReservation };
    });

    broadcastToTenant(tenantId, 'task_resolved', {
      taskId: task.id,
      conversationId: conversation.id,
      action: decision === 'approve' ? 'accepted' : 'rejected',
    });
    if (decision === 'approve' && result.reservation) {
      broadcastToTenant(tenantId, 'reservation_scheduled_updated', {
        reservationId: result.reservation.id,
        conversationId: conversation.id,
        scheduledCheckInAt: result.reservation.scheduledCheckInAt,
        scheduledCheckOutAt: result.reservation.scheduledCheckOutAt,
      });
    }

    ok = true;
    res.json({
      message: {
        id: result.message.id,
        role: result.message.role,
        content: result.message.content,
        sentAt: result.message.sentAt,
        deliveryStatus: result.message.deliveryStatus,
      },
      reservation: result.reservation,
    });
  } catch (err) {
    console.error(`[TaskActions] ${decision} error:`, err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    console.log(`[TaskActions] ${decision} taskId=${taskId} tenantId=${tenantId} ms=${Date.now() - t0} ok=${ok}`);
  }
}
