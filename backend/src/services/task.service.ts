import { PrismaClient } from '@prisma/client';

export interface CreateTaskInput {
  tenantId: string;
  conversationId: string;
  propertyId?: string;
  title: string;
  note?: string;
  urgency: string;
  type?: string;
  source?: string;
}

export async function createTask(prisma: PrismaClient, input: CreateTaskInput) {
  return prisma.task.create({
    data: {
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      propertyId: input.propertyId,
      title: input.title,
      note: input.note,
      urgency: input.urgency,
      type: input.type || 'other',
      source: input.source || 'ai',
    },
  });
}

export async function listTasksByConversation(prisma: PrismaClient, conversationId: string, tenantId: string) {
  return prisma.task.findMany({
    where: { conversationId, tenantId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function updateTask(prisma: PrismaClient, id: string, tenantId: string, data: { status?: string }) {
  return prisma.task.update({
    where: { id },
    data: {
      ...data,
      ...(data.status === 'completed' ? { completedAt: new Date() } : {}),
    },
  });
}

export async function deleteTask(prisma: PrismaClient, id: string, tenantId: string) {
  // Verify ownership
  const task = await prisma.task.findFirst({ where: { id, tenantId } });
  if (!task) {
    const err: any = new Error('Task not found');
    err.status = 404;
    throw err;
  }
  await prisma.task.delete({ where: { id } });
  return task; // Return the deleted task for broadcast payload
}
