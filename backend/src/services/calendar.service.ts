/**
 * Calendar Pricing Service
 *
 * Fetches and caches per-night pricing from Hostaway Calendar API.
 * In-memory cache with 15-minute TTL (same pattern as tenant-config.service.ts).
 * Supports bulk fetch for all tenant properties with concurrency limit.
 */
import { PrismaClient } from '@prisma/client';
import * as hostawayService from './hostaway.service';

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

export interface CalendarDay {
  date: string;
  price: number | null;
  available: boolean;
  minimumStay: number | null;
}

export interface PropertyCalendar {
  propertyId: string;
  currency: string;
  days: CalendarDay[];
}

interface CacheEntry {
  data: PropertyCalendar;
  cachedAt: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Cache
// ════════════════════════════════════════════════════════════════════════════

const _cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_CONCURRENCY = 5;

function cacheKey(tenantId: string, propertyId: string, startDate: string, endDate: string): string {
  return `${tenantId}:${propertyId}:${startDate}:${endDate}`;
}

// ════════════════════════════════════════════════════════════════════════════
// Single property calendar
// ════════════════════════════════════════════════════════════════════════════

export async function getCalendarPricing(
  tenantId: string,
  propertyId: string,
  startDate: string,
  endDate: string,
  prisma: PrismaClient,
): Promise<PropertyCalendar & { cached: boolean; cachedAt: string | null }> {
  const key = cacheKey(tenantId, propertyId, startDate, endDate);
  const cached = _cache.get(key);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return { ...cached.data, cached: true, cachedAt: new Date(cached.cachedAt).toISOString() };
  }

  const property = await prisma.property.findFirst({
    where: { id: propertyId, tenantId },
    select: { hostawayListingId: true },
  });
  if (!property) {
    throw Object.assign(new Error('Property not found'), { status: 404 });
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { hostawayAccountId: true, hostawayApiKey: true },
  });
  if (!tenant?.hostawayAccountId || !tenant?.hostawayApiKey) {
    throw Object.assign(new Error('Hostaway not configured'), { status: 502 });
  }

  const { result } = await hostawayService.getListingCalendar(
    tenant.hostawayAccountId, tenant.hostawayApiKey,
    property.hostawayListingId, startDate, endDate,
  );

  const days: CalendarDay[] = (result || []).map((day: any) => ({
    date: day.date,
    price: day.price != null ? Number(day.price) : null,
    available: day.isAvailable === 1 || day.isAvailable === true || day.status === 'available',
    minimumStay: day.minimumStay != null ? Number(day.minimumStay) : null,
  }));

  const data: PropertyCalendar = {
    propertyId,
    currency: (result?.[0]?.currencyCode || result?.[0]?.currency || 'USD'),
    days,
  };

  _cache.set(key, { data, cachedAt: Date.now() });
  return { ...data, cached: false, cachedAt: null };
}

// ════════════════════════════════════════════════════════════════════════════
// Bulk fetch — all tenant properties
// ════════════════════════════════════════════════════════════════════════════

export async function getCalendarPricingBulk(
  tenantId: string,
  startDate: string,
  endDate: string,
  prisma: PrismaClient,
): Promise<{ properties: PropertyCalendar[]; errors: Array<{ propertyId: string; error: string }> }> {
  const allProperties = await prisma.property.findMany({
    where: { tenantId },
    select: { id: true, hostawayListingId: true },
    orderBy: { name: 'asc' },
  });

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { hostawayAccountId: true, hostawayApiKey: true },
  });

  if (!tenant?.hostawayAccountId || !tenant?.hostawayApiKey) {
    return {
      properties: [],
      errors: allProperties.map(p => ({ propertyId: p.id, error: 'Hostaway not configured' })),
    };
  }

  const results: PropertyCalendar[] = [];
  const errors: Array<{ propertyId: string; error: string }> = [];

  // Process in batches of MAX_CONCURRENCY
  for (let i = 0; i < allProperties.length; i += MAX_CONCURRENCY) {
    const batch = allProperties.slice(i, i + MAX_CONCURRENCY);
    const promises = batch.map(async (prop) => {
      const key = cacheKey(tenantId, prop.id, startDate, endDate);
      const cached = _cache.get(key);
      if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
        return { success: true as const, data: cached.data };
      }

      try {
        const { result } = await hostawayService.getListingCalendar(
          tenant.hostawayAccountId, tenant.hostawayApiKey,
          prop.hostawayListingId, startDate, endDate,
        );

        const days: CalendarDay[] = (result || []).map((day: any) => ({
          date: day.date,
          price: day.price != null ? Number(day.price) : null,
          available: day.isAvailable === 1 || day.isAvailable === true || day.status === 'available',
          minimumStay: day.minimumStay != null ? Number(day.minimumStay) : null,
        }));

        const data: PropertyCalendar = {
          propertyId: prop.id,
          currency: (result?.[0]?.currencyCode || result?.[0]?.currency || 'USD'),
          days,
        };

        _cache.set(key, { data, cachedAt: Date.now() });
        return { success: true as const, data };
      } catch (err: any) {
        return { success: false as const, propertyId: prop.id, error: err.message || 'Unknown error' };
      }
    });

    const batchResults = await Promise.all(promises);
    for (const r of batchResults) {
      if (r.success) {
        results.push(r.data);
      } else {
        errors.push({ propertyId: r.propertyId, error: r.error });
      }
    }
  }

  return { properties: results, errors };
}
