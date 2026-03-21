/**
 * Property Search Service
 * Handles the `search_available_properties` tool for cross-selling.
 * Finds available properties matching amenity/capacity requirements,
 * checks Hostaway availability, and returns channel-appropriate booking links.
 *
 * SECURITY: Never exposes access codes (doorCode, wifiPassword, wifiName).
 */

import { PrismaClient } from '@prisma/client';
import * as path from 'path';
import * as fs from 'fs';
import { listAvailableListings } from './hostaway.service';

// ─── Module-level singletons ────────────────────────────────────────────────

let prisma: PrismaClient | null = null;
function getPrisma(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient();
  }
  return prisma;
}

/** Allow the caller (e.g. server.ts) to inject a shared PrismaClient. */
export function setPropertySearchPrisma(p: PrismaClient): void {
  prisma = p;
}

// Load amenity synonym map once at module init
type SynonymMap = Record<string, string[]>;
let amenitySynonyms: SynonymMap = {};
try {
  const synonymPath = path.join(__dirname, '..', 'config', 'amenity-synonyms.json');
  amenitySynonyms = JSON.parse(fs.readFileSync(synonymPath, 'utf-8'));
} catch (err) {
  console.warn('[PropertySearch] Failed to load amenity-synonyms.json, amenity matching disabled:', err);
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface SearchInput {
  amenities: string[];
  min_capacity?: number;
  reason?: string;
}

interface SearchContext {
  tenantId: string;
  currentPropertyId: string;
  checkIn: string;    // YYYY-MM-DD
  checkOut: string;   // YYYY-MM-DD
  channel: string;    // AIRBNB | BOOKING | DIRECT | OTHER | WHATSAPP
  hostawayAccountId: string;
  hostawayApiKey: string;
  currentCity: string;
}

interface PropertyResult {
  name: string;
  highlights: string;
  booking_link: string | null;
  capacity: number;
  amenities_matched: string[];
}

interface SearchResult {
  found: boolean;
  count: number;
  properties: PropertyResult[];
  dates_checked: string;
  city: string;
  error?: string;
  should_escalate?: boolean;
}

// ─── Amenity matching helpers ───────────────────────────────────────────────

/**
 * Given a requested amenity (e.g. "pool"), find the synonym group key
 * and all its synonyms. Falls back to using the raw amenity as a single-item list.
 */
function getSynonymsForAmenity(requested: string): { key: string; synonyms: string[] } {
  const lower = requested.toLowerCase().trim();

  // Direct key match
  if (amenitySynonyms[lower]) {
    return { key: lower, synonyms: amenitySynonyms[lower] };
  }

  // Check if the requested term appears inside any synonym group
  for (const [key, synonyms] of Object.entries(amenitySynonyms)) {
    if (synonyms.some(s => s.toLowerCase() === lower)) {
      return { key, synonyms };
    }
  }

  // No match in synonym map — use the raw term
  return { key: lower, synonyms: [lower] };
}

/**
 * Check if a property's amenities CSV contains any synonym for a requested amenity.
 */
function propertyHasAmenity(amenitiesCsv: string, synonyms: string[]): boolean {
  const lower = amenitiesCsv.toLowerCase();
  return synonyms.some(syn => lower.includes(syn.toLowerCase()));
}

// ─── Channel booking link resolver ──────────────────────────────────────────

function getBookingLink(kb: Record<string, unknown>, channel: string): string | null {
  let link: string | null = null;

  switch (channel.toUpperCase()) {
    case 'AIRBNB':
      link = (kb.airbnbListingUrl as string) || null;
      break;
    case 'BOOKING':
      link = (kb.vrboListingUrl as string) || null;
      break;
    case 'DIRECT':
    case 'WHATSAPP':
    case 'OTHER':
      link = (kb.bookingEngineUrl as string) || null;
      break;
  }

  // Fallback: if channel-specific URL missing, try bookingEngineUrl
  if (!link) {
    link = (kb.bookingEngineUrl as string) || null;
  }

  return link;
}

// ─── Main search function ───────────────────────────────────────────────────

export async function searchAvailableProperties(
  input: SearchInput,
  context: SearchContext
): Promise<string> {
  const db = getPrisma();
  const { tenantId, currentPropertyId, checkIn, checkOut, channel, currentCity } = context;

  // 1. Query all properties for this tenant
  const allProperties = await db.property.findMany({
    where: { tenantId },
  });

  // 2. Filter to same city (case-insensitive) and exclude current property
  const cityLower = (currentCity || '').toLowerCase();
  const candidates = allProperties.filter(p => {
    if (p.id === currentPropertyId) return false;
    if (!cityLower) return true; // If no city context, include all
    return (p.address || '').toLowerCase().includes(cityLower);
  });

  // 3. Match amenities and score each candidate
  const requestedAmenities = (input.amenities || []).map(a => ({
    original: a,
    ...getSynonymsForAmenity(a),
  }));

  const scored = candidates.map(property => {
    const kb = (property.customKnowledgeBase as Record<string, unknown>) || {};
    const amenitiesCsv = (kb.amenities as string) || '';
    const capacity = Number(kb.personCapacity) || 0;

    // Check capacity filter
    if (input.min_capacity && capacity < input.min_capacity) {
      return null;
    }

    // Match amenities
    const matchedAmenities: string[] = [];
    for (const req of requestedAmenities) {
      if (propertyHasAmenity(amenitiesCsv, req.synonyms)) {
        matchedAmenities.push(req.key);
      }
    }

    return {
      property,
      kb,
      amenitiesCsv,
      capacity,
      matchedAmenities,
      matchCount: matchedAmenities.length,
    };
  }).filter((x): x is NonNullable<typeof x> => x !== null);

  // 4. Call Hostaway to check availability
  let availableListingIds: Set<string>;
  try {
    const availableRes = await listAvailableListings(
      context.hostawayAccountId,
      context.hostawayApiKey,
      checkIn,
      checkOut
    );
    const listings = availableRes.result || [];
    availableListingIds = new Set(listings.map(l => String(l.id)));
  } catch (err) {
    console.error('[PropertySearch] Hostaway availability check failed:', err);
    const errorResult: SearchResult = {
      found: false,
      count: 0,
      properties: [],
      dates_checked: `${checkIn} to ${checkOut}`,
      city: currentCity || 'unknown',
      error: 'Could not check availability',
      should_escalate: true,
    };
    return JSON.stringify(errorResult);
  }

  // 5. Intersect: only keep properties available on Hostaway
  const available = scored.filter(s =>
    availableListingIds.has(s.property.hostawayListingId)
  );

  // 6. Sort by amenity match count (descending), take top 3
  available.sort((a, b) => b.matchCount - a.matchCount);
  const top = available.slice(0, 3);

  // 7. Build results — NEVER include access codes
  const properties: PropertyResult[] = top.map(item => {
    const { property, kb, amenitiesCsv, capacity, matchedAmenities } = item;

    // Build highlights from first 3-4 amenities + capacity
    const amenityItems = amenitiesCsv
      .split(',')
      .map(a => a.trim())
      .filter(Boolean)
      .slice(0, 4);
    if (capacity > 0) {
      amenityItems.push(`Sleeps ${capacity}`);
    }
    const highlights = amenityItems.join(', ');

    const bookingLink = getBookingLink(kb, channel);

    return {
      name: property.name,
      highlights,
      booking_link: bookingLink,
      capacity,
      amenities_matched: matchedAmenities,
    };
  });

  const result: SearchResult = {
    found: properties.length > 0,
    count: properties.length,
    properties,
    dates_checked: `${checkIn} to ${checkOut}`,
    city: currentCity || 'unknown',
  };

  return JSON.stringify(result);
}
