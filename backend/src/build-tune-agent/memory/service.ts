/**
 * Tenant-scoped memory CRUD against the `AgentMemory` Prisma table. Called by
 * the `memory` MCP tool and by the runtime's PreCompact / session-start
 * preference injection.
 *
 * See ./README.md for the key-namespacing convention.
 */
import { PrismaClient, Prisma } from '@prisma/client';

export interface MemoryRecord {
  key: string;
  value: unknown;
  source: string | null;
  updatedAt: string;
}

export async function viewMemory(
  prisma: PrismaClient,
  tenantId: string,
  key: string
): Promise<MemoryRecord | null> {
  const row = await prisma.agentMemory.findUnique({
    where: { tenantId_key: { tenantId, key } },
  });
  if (!row) return null;
  return {
    key: row.key,
    value: row.value,
    source: row.source,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function createMemory(
  prisma: PrismaClient,
  tenantId: string,
  key: string,
  value: unknown,
  source?: string
): Promise<{ ok: true } | { ok: false; error: 'ALREADY_EXISTS' }> {
  try {
    await prisma.agentMemory.create({
      data: {
        tenantId,
        key,
        value: value as Prisma.InputJsonValue,
        source: source ?? null,
      },
    });
    return { ok: true };
  } catch (err: any) {
    if (err?.code === 'P2002') return { ok: false, error: 'ALREADY_EXISTS' };
    throw err;
  }
}

export async function updateMemory(
  prisma: PrismaClient,
  tenantId: string,
  key: string,
  value: unknown,
  source?: string
): Promise<MemoryRecord> {
  const row = await prisma.agentMemory.upsert({
    where: { tenantId_key: { tenantId, key } },
    update: {
      value: value as Prisma.InputJsonValue,
      ...(source ? { source } : {}),
    },
    create: {
      tenantId,
      key,
      value: value as Prisma.InputJsonValue,
      source: source ?? null,
    },
  });
  return {
    key: row.key,
    value: row.value,
    source: row.source,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function deleteMemory(
  prisma: PrismaClient,
  tenantId: string,
  key: string
): Promise<{ ok: true; deleted: boolean }> {
  try {
    await prisma.agentMemory.delete({
      where: { tenantId_key: { tenantId, key } },
    });
    return { ok: true, deleted: true };
  } catch (err: any) {
    if (err?.code === 'P2025') return { ok: true, deleted: false };
    throw err;
  }
}

/**
 * Used by the runtime's session-start preference injection and by the
 * PreCompact hook. Returns rows whose key starts with `prefix` (typically
 * `"preferences/"`). Capped at `limit` entries by most-recent update.
 */
export async function listMemoryByPrefix(
  prisma: PrismaClient,
  tenantId: string,
  prefix: string,
  limit = 50
): Promise<MemoryRecord[]> {
  const rows = await prisma.agentMemory.findMany({
    where: { tenantId, key: { startsWith: prefix } },
    orderBy: { updatedAt: 'desc' },
    take: limit,
  });
  return rows.map((row) => ({
    key: row.key,
    value: row.value,
    source: row.source,
    updatedAt: row.updatedAt.toISOString(),
  }));
}
