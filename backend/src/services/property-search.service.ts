/**
 * Property Search Service
 * Handles the `search_available_properties` tool for cross-selling.
 * Uses gpt-5-nano to semantically score candidate properties against
 * guest requirements. Includes the current property in results (flagged).
 *
 * SECURITY: Never exposes access codes (doorCode, wifiPassword, wifiName).
 */

import { PrismaClient } from '@prisma/client';
import OpenAI from 'openai';
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

// ─── Constants ──────────────────────────────────────────────────────────────

const SCORING_MODEL = 'gpt-5-nano';
const SCORE_THRESHOLD = 5;
const MAX_RESULTS = 3;
const DESCRIPTION_MAX_CHARS = 500;
const SCORING_TIMEOUT_MS = 15000;

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

interface PropertyProfile {
  index: number;
  propertyId: string;
  name: string;
  bedrooms: number;
  capacity: number;
  address: string;
  description: string;
  amenities: string;
}

interface ScoringResultItem {
  index: number;
  score: number;
  met: string[];
  unmet: string[];
  note: string;
}

interface PropertyResult {
  name: string;
  capacity: number;
  bedrooms: number;
  score: number;
  is_current_property: boolean;
  label: string | null;
  met: string[];
  unmet: string[];
  note: string;
  booking_link: string | null;
}

interface SearchResult {
  found: boolean;
  count: number;
  properties: PropertyResult[];
  dates_checked: string;
  city: string;
  current_property_matched: boolean;
  error?: string;
  should_escalate?: boolean;
}

// ─── Nano scoring prompt ────────────────────────────────────────────────────

function buildScoringPrompt(requirements: string, profiles: PropertyProfile[]): string {
  const propertyBlocks = profiles.map(p =>
    `[${p.index}] "${p.name}"\nBedrooms: ${p.bedrooms} | Capacity: ${p.capacity} | Address: ${p.address}\nDescription: ${p.description}\nAmenities: ${p.amenities}`
  ).join('\n\n');

  return `You are scoring rental properties against a guest's requirements.

Guest requirements:
${requirements}

Properties to score:

${propertyBlocks}

Score each property 0-10 based on how well it matches ALL the guest's requirements.
Consider the property description, amenities, location, bedrooms, and capacity.
Understand synonyms and context: "play area" = "playgrounds", "near malls" = "near O1 Mall", "outdoor space" = "garden or backyard", "fast internet" = "Internet, Wireless".
For each property, list which requirements are MET and which are UNMET.
Provide a short note (1 sentence) explaining the score.`;
}

const SCORING_SCHEMA = {
  name: 'property_scores',
  strict: true,
  schema: {
    type: 'object' as const,
    properties: {
      scores: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            index: { type: 'integer' as const },
            score: { type: 'integer' as const },
            met: { type: 'array' as const, items: { type: 'string' as const } },
            unmet: { type: 'array' as const, items: { type: 'string' as const } },
            note: { type: 'string' as const },
          },
          required: ['index', 'score', 'met', 'unmet', 'note'],
          additionalProperties: false,
        },
      },
    },
    required: ['scores'],
    additionalProperties: false,
  },
};

// ─── Scoring function ───────────────────────────────────────────────────────

async function scorePropertiesWithNano(
  requirements: string,
  profiles: PropertyProfile[],
): Promise<ScoringResultItem[]> {
  if (!process.env.OPENAI_API_KEY || profiles.length === 0) return [];

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const prompt = buildScoringPrompt(requirements, profiles);

  const response = await openai.responses.create({
    model: SCORING_MODEL,
    input: [{ role: 'user', content: prompt }],
    text: {
      format: {
        type: 'json_schema',
        ...SCORING_SCHEMA,
      },
    },
    max_output_tokens: 4000,
  });

  const text = (response as any).output_text || '';
  const parsed = JSON.parse(text);
  return parsed.scores || [];
}

// ─── Property profile builder ───────────────────────────────────────────────

function buildPropertyProfile(
  property: any,
  index: number,
): PropertyProfile {
  const kb = (property.customKnowledgeBase as Record<string, unknown>) || {};
  const description = (property.listingDescription || '') as string;

  return {
    index,
    propertyId: property.id,
    name: property.name || 'Unnamed Property',
    bedrooms: Number(kb.bedroomsNumber) || 0,
    capacity: Number(kb.personCapacity) || 0,
    address: property.address || '',
    description: description.substring(0, DESCRIPTION_MAX_CHARS),
    amenities: (kb.amenities as string) || '',
  };
}

// ─── Channel booking link resolver ──────────────────────────────────────────

function getBookingLink(kb: Record<string, unknown>, channel: string): string | null {
  let link: string | null = null;

  const airbnb = (kb.airbnbListingUrl as string) || null;
  const vrbo = (kb.vrboListingUrl as string) || null;
  const engine = (kb.bookingEngineUrl as string) || null;
  // Bugfix (2026-04-23): also pick up an explicit Booking.com listing
  // URL if the operator has stored one. The previous BOOKING branch
  // handed out a VRBO link, which is off-channel for Booking.com guests
  // and at minimum looks confusing — at worst Booking.com's
  // content-scanner rejects messages containing competitor URLs.
  const bookingDotCom = (kb.bookingListingUrl as string) || null;

  switch (channel.toUpperCase()) {
    case 'AIRBNB':
      link = airbnb;
      break;
    case 'BOOKING':
      // Prefer an explicit Booking.com URL if present; otherwise fall
      // through to the direct booking engine (channel-safe). Do NOT
      // fall through to VRBO inline — the cross-channel mismatch was
      // the original bug.
      link = bookingDotCom ?? engine;
      break;
    case 'DIRECT':
    case 'WHATSAPP':
    case 'OTHER':
      link = engine;
      break;
  }

  // Fallback chain: bookingEngineUrl → airbnbListingUrl → vrboListingUrl.
  // (For BOOKING this is reached only when both booking-engine and
  // booking-com URLs are missing — at that point any URL beats nothing,
  // and the original platform's terms-of-service review surfaces it.)
  if (!link) link = engine;
  if (!link) link = airbnb;
  if (!link) link = vrbo;

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

  // 2. Filter to same city (case-insensitive) — INCLUDE current property
  const cityLower = (currentCity || '').toLowerCase();
  const candidates = allProperties.filter(p => {
    if (!cityLower) return true;
    return (p.address || '').toLowerCase().includes(cityLower);
  });

  // 3. Call Hostaway to check availability
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
      current_property_matched: false,
      error: 'Could not check availability',
      should_escalate: true,
    };
    return JSON.stringify(errorResult);
  }

  // 4. Intersect: only keep available properties (current property included if available)
  const available = candidates.filter(p =>
    availableListingIds.has(p.hostawayListingId)
  );

  if (available.length === 0) {
    const emptyResult: SearchResult = {
      found: false,
      count: 0,
      properties: [],
      dates_checked: `${checkIn} to ${checkOut}`,
      city: currentCity || 'unknown',
      current_property_matched: false,
    };
    return JSON.stringify(emptyResult);
  }

  // 5. Build rich profiles for scoring
  const profiles = available.map((p, i) => buildPropertyProfile(p, i + 1));

  // 6. Build requirements string from AI input
  const requirementsText = input.amenities.join(', ')
    + (input.min_capacity ? ` | Minimum capacity: ${input.min_capacity} guests` : '')
    + (input.reason ? ` | Context: ${input.reason}` : '');

  // 7. Score with nano
  let scores: ScoringResultItem[];
  try {
    scores = await scorePropertiesWithNano(requirementsText, profiles);
  } catch (err) {
    console.error('[PropertySearch] Nano scoring failed:', err);
    const errorResult: SearchResult = {
      found: false,
      count: 0,
      properties: [],
      dates_checked: `${checkIn} to ${checkOut}`,
      city: currentCity || 'unknown',
      current_property_matched: false,
      error: 'Property scoring temporarily unavailable. Please answer from the property information above.',
      should_escalate: false,
    };
    return JSON.stringify(errorResult);
  }

  // 8. Map scores back to properties, filter threshold, sort, take top 3
  const scoredProperties = scores
    .filter(s => s.score >= SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS)
    .map(s => {
      const profile = profiles.find(p => p.index === s.index);
      if (!profile) return null;

      const property = available.find(p => p.id === profile.propertyId);
      if (!property) return null;

      const kb = (property.customKnowledgeBase as Record<string, unknown>) || {};
      const isCurrent = property.id === currentPropertyId;

      const result: PropertyResult = {
        name: profile.name,
        capacity: profile.capacity,
        bedrooms: profile.bedrooms,
        score: s.score,
        is_current_property: isCurrent,
        label: isCurrent ? 'This is the property the guest is viewing' : null,
        met: s.met,
        unmet: s.unmet,
        note: s.note,
        booking_link: isCurrent ? null : getBookingLink(kb, channel),
      };

      return result;
    })
    .filter((r): r is PropertyResult => r !== null);

  const currentPropertyMatched = scoredProperties.some(p => p.is_current_property);

  const result: SearchResult = {
    found: scoredProperties.length > 0,
    count: scoredProperties.length,
    properties: scoredProperties,
    dates_checked: `${checkIn} to ${checkOut}`,
    city: currentCity || 'unknown',
    current_property_matched: currentPropertyMatched,
  };

  console.log(`[PropertySearch] Scored ${profiles.length} properties, ${scoredProperties.length} above threshold. Current property matched: ${currentPropertyMatched}`);

  return JSON.stringify(result);
}
