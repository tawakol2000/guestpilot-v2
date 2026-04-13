import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import * as taskService from '../services/task.service';
import { broadcastToTenant } from '../services/socket.service';
import { AuthenticatedRequest } from '../types';

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
          orderBy: [{ status: 'asc' }, { urgency: 'asc' }, { createdAt: 'desc' }],
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
        const { status, dueDate, assignee } = req.body;
        const data: Record<string, unknown> = {};
        if (status !== undefined) {
          data.status = status;
          if (status === 'completed') data.completedAt = new Date();
        }
        if (dueDate !== undefined) data.dueDate = dueDate ? new Date(dueDate) : null;
        if (assignee !== undefined) data.assignee = assignee || null;
        const existing = await prisma.task.findFirst({ where: { id, tenantId } });
        if (!existing) { res.status(404).json({ error: 'Task not found' }); return; }
        const task = await prisma.task.update({ where: { id }, data });
        broadcastToTenant(tenantId, 'task_updated', { conversationId: task.conversationId, task });
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
