/**
 * Per-tenant AI configuration service.
 * Each tenant gets their own agent name, model, temperature, debounce delay, etc.
 * Uses a 60-second in-memory cache to avoid repeated DB hits.
 * Creates default config on first access (upsert).
 */
import { PrismaClient, TenantAiConfig } from '@prisma/client';

interface CacheEntry {
  config: TenantAiConfig;
  cachedAt: number;
}

const _cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 1000; // 60 seconds — reduced for faster config propagation

const ALLOWED_MODELS = [
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-5',
  'claude-opus-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
];

export async function getTenantAiConfig(
  tenantId: string,
  prisma: PrismaClient
): Promise<TenantAiConfig> {
  const cached = _cache.get(tenantId);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.config;
  }

  const config = await prisma.tenantAiConfig.upsert({
    where: { tenantId },
    update: {},
    create: { tenantId },
  });

  _cache.set(tenantId, { config, cachedAt: Date.now() });
  return config;
}

export function invalidateTenantConfigCache(tenantId: string): void {
  _cache.delete(tenantId);
}

export async function updateTenantAiConfig(
  tenantId: string,
  updates: Partial<TenantAiConfig>,
  prisma: PrismaClient
): Promise<TenantAiConfig> {
  // Validation
  if (updates.agentName !== undefined) {
    if (!updates.agentName || updates.agentName.length > 50 || /<[^>]+>/.test(updates.agentName)) {
      const err = new Error('agentName must be 1-50 chars with no HTML') as any;
      err.field = 'agentName';
      throw err;
    }
  }
  if (updates.customInstructions !== undefined && updates.customInstructions.length > 2000) {
    const err = new Error('customInstructions max 2000 chars') as any;
    err.field = 'customInstructions';
    throw err;
  }
  if (
    updates.temperature !== undefined &&
    (updates.temperature < 0 || updates.temperature > 1)
  ) {
    const err = new Error('temperature must be 0.0–1.0') as any;
    err.field = 'temperature';
    throw err;
  }
  if (updates.model !== undefined && !ALLOWED_MODELS.includes(updates.model)) {
    const err = new Error(`model must be one of: ${ALLOWED_MODELS.join(', ')}`) as any;
    err.field = 'model';
    throw err;
  }
  if (updates.workingHoursStart !== undefined && !/^\d{2}:\d{2}$/.test(updates.workingHoursStart)) {
    const err = new Error('workingHoursStart must be HH:mm') as any;
    err.field = 'workingHoursStart';
    throw err;
  }
  if (updates.workingHoursEnd !== undefined && !/^\d{2}:\d{2}$/.test(updates.workingHoursEnd)) {
    const err = new Error('workingHoursEnd must be HH:mm') as any;
    err.field = 'workingHoursEnd';
    throw err;
  }
  if (updates.workingHoursTimezone !== undefined) {
    try { new Intl.DateTimeFormat(undefined, { timeZone: updates.workingHoursTimezone }); } catch {
      const err = new Error('Invalid timezone') as any;
      err.field = 'workingHoursTimezone';
      throw err;
    }
  }
  if (
    updates.judgeMode !== undefined &&
    !['evaluate_all', 'sampling'].includes(updates.judgeMode)
  ) {
    const err = new Error('judgeMode must be "evaluate_all" or "sampling"') as any;
    err.field = 'judgeMode';
    throw err;
  }
  if (updates.sopOverrides !== undefined) {
    if (
      typeof updates.sopOverrides !== 'object' ||
      updates.sopOverrides === null ||
      Array.isArray(updates.sopOverrides)
    ) {
      const err = new Error('sopOverrides must be a JSON object') as any;
      err.field = 'sopOverrides';
      throw err;
    }
  }

  // Strip non-updatable system fields
  const { id: _id, tenantId: _tid, createdAt: _c, updatedAt: _u, ...safeUpdates } = updates as any;

  const config = await prisma.tenantAiConfig.upsert({
    where: { tenantId },
    update: safeUpdates,
    create: { tenantId, ...safeUpdates },
  });

  invalidateTenantConfigCache(tenantId);
  return config;
}
