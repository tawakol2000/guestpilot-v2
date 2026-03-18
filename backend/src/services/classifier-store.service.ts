/**
 * DB-backed classifier example store.
 * Manages the growing set of training examples produced by the LLM judge.
 * The hardcoded TRAINING_EXAMPLES in classifier-data.ts are the base seed;
 * these DB records extend that set at runtime.
 */

import { PrismaClient } from '@prisma/client';

export async function addExample(
  tenantId: string,
  text: string,
  labels: string[],
  source: string,
  prisma: PrismaClient
): Promise<{ id: string }> {
  return prisma.classifierExample.upsert({
    where: { tenantId_text: { tenantId, text } },
    create: { tenantId, text, labels, source },
    update: { labels, source, active: true },
    select: { id: true },
  });
}

export async function getActiveExamples(
  tenantId: string,
  prisma: PrismaClient
): Promise<Array<{ id: string; text: string; labels: string[] }>> {
  return prisma.classifierExample.findMany({
    where: { tenantId, active: true },
    select: { id: true, text: true, labels: true },
    orderBy: { createdAt: 'asc' },
  });
}

export async function getExampleByText(
  tenantId: string,
  text: string,
  prisma: PrismaClient
): Promise<{ id: string; text: string; labels: string[] } | null> {
  return prisma.classifierExample.findFirst({
    where: { tenantId, text, active: true },
    select: { id: true, text: true, labels: true },
  });
}
