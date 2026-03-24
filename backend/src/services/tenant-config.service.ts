/**
 * Per-tenant AI configuration service.
 * Each tenant gets their own agent name, model, temperature, debounce delay, etc.
 * Uses a 60-second in-memory cache to avoid repeated DB hits.
 * Creates default config on first access (upsert).
 */
import { PrismaClient, TenantAiConfig } from '@prisma/client';
import { SEED_COORDINATOR_PROMPT, SEED_SCREENING_PROMPT } from './ai.service';

interface CacheEntry {
  config: TenantAiConfig;
  cachedAt: number;
}

const _cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 1000; // 60 seconds — reduced for faster config propagation

const ALLOWED_MODELS = [
  'gpt-5.4-mini-2026-03-17',
  'gpt-5.4-nano-2026-03-17',
  'gpt-5.4-2026-03-17',
];

export async function getTenantAiConfig(
  tenantId: string,
  prisma: PrismaClient
): Promise<TenantAiConfig> {
  const cached = _cache.get(tenantId);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.config;
  }

  let config = await prisma.tenantAiConfig.upsert({
    where: { tenantId },
    update: {},
    create: { tenantId },
  });

  // Seed system prompts if not yet set (null = use seed default)
  if (config.systemPromptCoordinator === null || config.systemPromptScreening === null) {
    config = await prisma.tenantAiConfig.update({
      where: { tenantId },
      data: {
        ...(config.systemPromptCoordinator === null ? { systemPromptCoordinator: SEED_COORDINATOR_PROMPT } : {}),
        ...(config.systemPromptScreening === null ? { systemPromptScreening: SEED_SCREENING_PROMPT } : {}),
      },
    });
    console.log(`[TenantConfig] Seeded system prompts for tenant ${tenantId}`);
  }

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
  const VALID_REASONING = ['none', 'low', 'medium', 'high', 'auto'];
  for (const field of ['reasoningCoordinator', 'reasoningScreening'] as const) {
    if ((updates as any)[field] !== undefined && !VALID_REASONING.includes((updates as any)[field])) {
      const err = new Error(`${field} must be one of: ${VALID_REASONING.join(', ')}`) as any;
      err.field = field;
      throw err;
    }
  }
  const VALID_TIER_MODES = ['active', 'ghost', 'off'];
  for (const field of ['tier1Mode', 'tier2Mode', 'tier3Mode'] as const) {
    if ((updates as any)[field] !== undefined && !VALID_TIER_MODES.includes((updates as any)[field])) {
      const err = new Error(`${field} must be one of: ${VALID_TIER_MODES.join(', ')}`) as any;
      err.field = field;
      throw err;
    }
  }

  // Validate system prompts
  for (const field of ['systemPromptCoordinator', 'systemPromptScreening'] as const) {
    const val = (updates as any)[field];
    if (val !== undefined) {
      if (typeof val !== 'string' || val.length < 100) {
        const err = new Error(`${field} must be at least 100 characters`) as any;
        err.field = field; throw err;
      }
      if (val.length > 50000) {
        const err = new Error(`${field} max 50000 chars`) as any;
        err.field = field; throw err;
      }
    }
  }

  // Strip non-updatable system fields
  const { id: _id, tenantId: _tid, createdAt: _c, updatedAt: _u, systemPromptVersion: _spv, ...safeUpdates } = updates as any;

  // Auto-increment prompt version when prompts are edited
  const bumpPromptVersion = safeUpdates.systemPromptCoordinator !== undefined || safeUpdates.systemPromptScreening !== undefined;

  // Separate update and create data — increment only works in update, not create
  const updateData = { ...safeUpdates };
  if (bumpPromptVersion) {
    updateData.systemPromptVersion = { increment: 1 };
  }

  const config = await prisma.tenantAiConfig.upsert({
    where: { tenantId },
    update: updateData,
    create: { tenantId, ...safeUpdates },
  });

  invalidateTenantConfigCache(tenantId);
  return config;
}
