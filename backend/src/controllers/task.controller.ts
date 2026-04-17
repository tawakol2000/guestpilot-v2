import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import * as taskService from '../services/task.service';
import { broadcastToTenant } from '../services/socket.service';
import { AuthenticatedRequest } from '../types';
import { maybeFireEscalationTrigger } from '../services/tuning/escalation-trigger.service';

export function taskController(prisma: PrismaClient) {
  return {
    async listAll(req: Request, res: Response, next: NextFunction): Promise<void> {
      try {
        const { tenantId } = req as unknown as AuthenticatedRequest;
        const { status, urgency, propertyId } = req.query as Record<string, string | undefined>;
        const where: Record<string, unknown> = { tenantId };
        if (status) where.status = status;
        if (urgency) where.urgency = urgency;
        if (propertyId) where.propertyId = propertyId;
        const tasks = await prisma.task.findMany({
          where,
          orderBy: [{ status: 'desc' }, { urgency: 'asc' }, { createdAt: 'desc' }],
          include: {
            conversation: { include: { guest: true, property: true } },
            property: true,
          },
        });
        res.json(tasks.map(t => ({
          id: t.id,
          title: t.title,
          note: t.note,
          urgency: t.urgency,
          type: t.type,
          status: t.status,
          source: t.source,
          dueDate: t.dueDate,
          assignee: t.assignee,
          completedAt: t.completedAt,
          createdAt: t.createdAt,
          conversationId: t.conversationId,
          propertyId: t.propertyId,
          guestName: t.conversation?.guest?.name || null,
          propertyName: t.conversation?.property?.name || t.property?.name || null,
        })));
      } catch (err) { next(err); }
    },

    async listByConversation(req: Request, res: Response, next: NextFunction) {
      try {
        const tenantId = (req as any).tenantId;
        const { conversationId } = req.params;
        const tasks = await taskService.listTasksByConversation(prisma, conversationId, tenantId);
        res.json(tasks);
      } catch (err) { next(err); }
    },

    async create(req: Request, res: Response, next: NextFunction) {
      try {
        const tenantId = (req as any).tenantId;
        const { conversationId } = req.params;
        const { title, note, urgency, type } = req.body;
        const task = await taskService.createTask(prisma, {
          tenantId, conversationId, title, note, urgency: urgency || 'info_request', type, source: 'manual',
        });
        broadcastToTenant(tenantId, 'new_task', { conversationId, task });
        res.status(201).json(task);
      } catch (err) { next(err); }
    },

    async createGlobal(req: Request, res: Response, next: NextFunction) {
      try {
        const tenantId = (req as any).tenantId;
        const { title, note, urgency, type, propertyId, dueDate, assignee } = req.body;
        if (!title) { res.status(400).json({ error: 'title is required' }); return; }
        const task = await prisma.task.create({
          data: {
            tenantId,
            title,
            note: note || null,
            urgency: urgency || 'info_request',
            type: type || 'other',
            source: 'manual',
            propertyId: propertyId || null,
            dueDate: dueDate ? new Date(dueDate) : null,
            assignee: assignee || null,
          },
          include: { property: true },
        });
        const mapped = {
          id: task.id,
          title: task.title,
          note: task.note,
          urgency: task.urgency,
          type: task.type,
          status: task.status,
          source: task.source,
          dueDate: task.dueDate,
          assignee: task.assignee,
          completedAt: task.completedAt,
          createdAt: task.createdAt,
          propertyId: task.propertyId,
          propertyName: task.property?.name || null,
          guestName: null,
        };
        broadcastToTenant(tenantId, 'new_task', { conversationId: null, task: mapped });
        res.status(201).json(mapped);
      } catch (err) { next(err); }
    },

    async update(req: Request, res: Response, next: NextFunction) {
      try {
        const tenantId = (req as any).tenantId;
        const { id } = req.params;
        const { status, dueDate, assignee, title, note, urgency } = req.body;
        const data: Record<string, unknown> = {};
        if (status !== undefined) {
          data.status = status;
          if (status === 'completed') data.completedAt = new Date();
          if (status === 'open') data.completedAt = null;
        }
        if (dueDate !== undefined) data.dueDate = dueDate ? new Date(dueDate) : null;
        if (assignee !== undefined) data.assignee = assignee || null;
        if (title !== undefined) {
          if (typeof title !== 'string' || title.length < 1 || title.length > 200) {
            res.status(400).json({ error: 'title must be 1-200 characters' }); return;
          }
          data.title = title;
        }
        if (note !== undefined) {
          if (note !== null && typeof note === 'string' && note.length > 2000) {
            res.status(400).json({ error: 'note must be at most 2000 characters' }); return;
          }
          data.note = note || null;
        }
        if (urgency !== undefined) {
          const validUrgencies = ['info_request', 'scheduled', 'urgent', 'modification_request', 'complaint'];
          if (!validUrgencies.includes(urgency)) {
            res.status(400).json({ error: `urgency must be one of: ${validUrgencies.join(', ')}` }); return;
          }
          data.urgency = urgency;
        }
        const existing = await prisma.task.findFirst({ where: { id, tenantId } });
        if (!existing) { res.status(404).json({ error: 'Task not found' }); return; }
        // Sprint-10 follow-up: atomic transition guard. Two concurrent
        // PATCHes flipping an open escalation to completed used to both
        // pass the non-atomic read+update, call maybeFireEscalationTrigger
        // twice with previous.status='open', and (when the retries cross
        // the in-process 60s dedup window) produce duplicate diagnostic
        // runs for the same resolution. When the caller is flipping status
        // we use updateMany with a precondition on the previous value so
        // only one caller wins.
        let task;
        let fireEscalationTrigger = false;
        if (status !== undefined && String(status) !== existing.status) {
          const claim = await prisma.task.updateMany({
            where: { id, tenantId, status: existing.status },
            data,
          });
          if (claim.count === 0) {
            // Lost the race — some other caller already transitioned the
            // task. Fetch the winning state and return it without firing
            // another diagnostic.
            const current = await prisma.task.findFirst({ where: { id, tenantId } });
            if (!current) { res.status(404).json({ error: 'Task not found' }); return; }
            res.json(current);
            return;
          }
          task = await prisma.task.findFirst({ where: { id, tenantId } });
          fireEscalationTrigger = true;
        } else {
          task = await prisma.task.update({ where: { id }, data });
        }
        if (!task) { res.status(404).json({ error: 'Task not found' }); return; }
        broadcastToTenant(tenantId, 'task_updated', { conversationId: task.conversationId, task });
        // Feature 041 sprint 08 §2 — escalation-resolution → ESCALATION_TRIGGERED.
        // Fire-and-forget; must never block or fail the HTTP response.
        if (fireEscalationTrigger) {
          maybeFireEscalationTrigger(prisma, {
            tenantId,
            newStatus: String(status),
            previous: {
              id: existing.id,
              type: existing.type,
              status: existing.status,
              conversationId: existing.conversationId,
              createdAt: existing.createdAt,
              title: existing.title,
            },
          });
        }
        res.json(task);
      } catch (err) { next(err); }
    },

    async remove(req: Request, res: Response, next: NextFunction) {
      try {
        const tenantId = (req as any).tenantId;
        const { id } = req.params;
        const deleted = await taskService.deleteTask(prisma, id, tenantId);
        broadcastToTenant(tenantId, 'task_deleted', { taskId: id, conversationId: deleted.conversationId });
        res.json({ ok: true });
      } catch (err) { next(err); }
    },
  };
}
