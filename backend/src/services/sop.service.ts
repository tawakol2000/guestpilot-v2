/**
 * SOP (Standard Operating Procedure) — DB-backed content & tool schema.
 *
 * Exports:
 * - SOP_CATEGORIES          — 23-value constant array (seeding + validation)
 * - SopCategory             — type alias
 * - getSopContent()         — async, DB-backed SOP lookup with property overrides
 * - buildToolDefinition()   — async, dynamic tool schema from enabled SopDefinitions
 * - seedSopDefinitions()    — populate DB from hardcoded defaults
 * - invalidateSopCache()    — bust per-tenant caches
 */

import { PrismaClient } from '@prisma/client';

// ════════════════════════════════════════════════════════════════════════════
// §1  CATEGORIES CONSTANT
// ════════════════════════════════════════════════════════════════════════════

export const SOP_CATEGORIES = [
  'sop-cleaning',
  'sop-amenity-request',
  'sop-maintenance',
  'sop-wifi-doorcode',
  'sop-visitor-policy',
  'sop-early-checkin',
  'sop-late-checkout',
  'sop-complaint',
  'sop-booking-inquiry',
  'pricing-negotiation',
  'sop-booking-modification',
  'sop-booking-confirmation',
  'sop-booking-cancellation',
  'payment-issues',
  'sop-long-term-rental',
  'property-info',
  'pre-arrival-logistics',
  'sop-property-viewing',
  'post-stay-issues',
  'local-recommendations',
  'property-description',
  'none',
  'escalate',
] as const;

export type SopCategory = (typeof SOP_CATEGORIES)[number];

// ════════════════════════════════════════════════════════════════════════════
// §2  CACHE
// ════════════════════════════════════════════════════════════════════════════

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const _sopCache = new Map<string, CacheEntry<any>>();

function cacheGet<T>(key: string): T | undefined {
  const entry = _sopCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    _sopCache.delete(key);
    return undefined;
  }
  return entry.data as T;
}

function cacheSet<T>(key: string, data: T): void {
  _sopCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Clear both content and tool-schema caches for a tenant.
 */
export function invalidateSopCache(tenantId: string): void {
  for (const key of _sopCache.keys()) {
    if (key.startsWith(`sop:${tenantId}:`)) {
      _sopCache.delete(key);
    }
  }
  console.log(`[SOP] Cache invalidated for tenant=${tenantId}`);
}

// ════════════════════════════════════════════════════════════════════════════
// §3  getSopContent()
// ════════════════════════════════════════════════════════════════════════════

/**
 * Resolve SOP content from DB with cascading fallback:
 *   1. SopPropertyOverride (sopDefId, propertyId, status)  → if enabled
 *   2. SopPropertyOverride (sopDefId, propertyId, DEFAULT) → if enabled
 *   3. SopVariant          (sopDefId, status)              → if enabled
 *   4. SopVariant          (sopDefId, DEFAULT)             → if enabled
 *   5. '' (empty)
 *
 * Auto-seeds the tenant on first call if no SopDefinitions exist.
 * Caches resolved content per (tenant, category, status, propertyId) for 5 min.
 */
export async function getSopContent(
  tenantId: string,
  category: string,
  reservationStatus: string,
  propertyId?: string,
  propertyAmenities?: string,
  prisma?: PrismaClient,
  variableDataMap?: Record<string, string>,
): Promise<string> {
  // Normalise status to match DB values
  const status = normaliseStatus(reservationStatus);

  // Cache key includes all resolution dimensions
  const cacheKey = `sop:${tenantId}:content:${category}:${status}:${propertyId || '_'}`;
  const cached = cacheGet<string>(cacheKey);
  if (cached !== undefined) {
    return applyTemplates(cached, category, propertyAmenities, variableDataMap);
  }

  // We need Prisma for DB lookups
  const db = prisma ?? new PrismaClient();
  try {
    // Auto-seed if no definitions exist for this tenant
    const defCount = await db.sopDefinition.count({ where: { tenantId } });
    if (defCount === 0) {
      await seedSopDefinitions(tenantId, db);
    }

    // Find the SopDefinition for this category + tenant
    const sopDef = await db.sopDefinition.findUnique({
      where: { tenantId_category: { tenantId, category } },
    });
    if (!sopDef || !sopDef.enabled) {
      cacheSet(cacheKey, '');
      return '';
    }

    let content = '';

    // 1. Property override — exact status
    if (propertyId) {
      const override = await db.sopPropertyOverride.findUnique({
        where: {
          sopDefinitionId_propertyId_status: {
            sopDefinitionId: sopDef.id,
            propertyId,
            status,
          },
        },
      });
      if (override?.enabled) {
        content = override.content;
      }
    }

    // 2. Property override — DEFAULT status
    if (!content && propertyId) {
      const overrideDef = await db.sopPropertyOverride.findUnique({
        where: {
          sopDefinitionId_propertyId_status: {
            sopDefinitionId: sopDef.id,
            propertyId,
            status: 'DEFAULT',
          },
        },
      });
      if (overrideDef?.enabled) {
        content = overrideDef.content;
      }
    }

    // 3. Variant — exact status
    if (!content) {
      const variant = await db.sopVariant.findUnique({
        where: {
          sopDefinitionId_status: {
            sopDefinitionId: sopDef.id,
            status,
          },
        },
      });
      if (variant?.enabled) {
        content = variant.content;
      }
    }

    // 4. Variant — DEFAULT
    if (!content) {
      const variantDef = await db.sopVariant.findUnique({
        where: {
          sopDefinitionId_status: {
            sopDefinitionId: sopDef.id,
            status: 'DEFAULT',
          },
        },
      });
      if (variantDef?.enabled) {
        content = variantDef.content;
      }
    }

    cacheSet(cacheKey, content);
    return applyTemplates(content, category, propertyAmenities, variableDataMap);
  } finally {
    // Only disconnect if we created the client
    if (!prisma) await db.$disconnect();
  }
}

function normaliseStatus(raw: string): string {
  const upper = (raw || 'DEFAULT').toUpperCase().replace(/-/g, '_');
  // PENDING uses INQUIRY SOPs (same screening flow)
  if (upper === 'PENDING') return 'INQUIRY';
  if (['INQUIRY', 'CONFIRMED', 'CHECKED_IN'].includes(upper)) return upper;
  return 'DEFAULT';
}

/**
 * Replace template variables in SOP content.
 * For sop-amenity-request: {ON_REQUEST_AMENITIES} (or legacy alias {PROPERTY_AMENITIES})
 * is replaced with the on-request amenities list.
 * When amenity classifications exist, the caller passes only "on_request" items.
 * When no classifications exist, the full amenities string is passed for backward compatibility.
 */
function applyTemplates(content: string, category: string, propertyAmenities?: string, variableDataMap?: Record<string, string>): string {
  let result = content;

  // Resolve ALL {VARIABLE} placeholders from the data map
  if (variableDataMap) {
    result = result.replace(/\{([A-Z_]+)\}/g, (match, varName) => {
      if (varName in variableDataMap) {
        return variableDataMap[varName] || '';
      }
      return match; // Leave unresolved if not in map
    });
  }

  // Legacy: resolve {ON_REQUEST_AMENITIES} and {PROPERTY_AMENITIES} from propertyAmenities string
  if (propertyAmenities) {
    if (result.includes('{ON_REQUEST_AMENITIES}') || result.includes('{PROPERTY_AMENITIES}')) {
      const list = propertyAmenities.split(',').map(a => `• ${a.trim()}`).filter(Boolean).join('\n');
      result = result.replace('{ON_REQUEST_AMENITIES}', list);
      result = result.replace('{PROPERTY_AMENITIES}', list);
    }
  } else {
    const fallback = 'No amenities data available for this property.';
    result = result.replace('{ON_REQUEST_AMENITIES}', fallback);
    result = result.replace('{PROPERTY_AMENITIES}', fallback);
  }

  return result;
}

// ════════════════════════════════════════════════════════════════════════════
// §4  buildToolDefinition()
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build the get_sop tool schema dynamically from enabled SopDefinitions.
 * `none` and `escalate` are always included even if no DB record exists.
 * Cached per tenant for 5 minutes.
 */
export async function buildToolDefinition(
  tenantId: string,
  prisma: PrismaClient,
): Promise<any> {
  const cacheKey = `sop:${tenantId}:toolDef`;
  const cached = cacheGet<any>(cacheKey);
  if (cached) return cached;

  // Auto-seed if empty
  const defCount = await prisma.sopDefinition.count({ where: { tenantId } });
  if (defCount === 0) {
    await seedSopDefinitions(tenantId, prisma);
  }

  const defs = await prisma.sopDefinition.findMany({
    where: { tenantId, enabled: true },
    orderBy: { category: 'asc' },
  });

  // Collect enabled category names
  const enabledCategories: string[] = defs.map(d => d.category);

  // Ensure `none` and `escalate` are always present
  if (!enabledCategories.includes('none')) enabledCategories.push('none');
  if (!enabledCategories.includes('escalate')) enabledCategories.push('escalate');

  // Build per-category description lines
  const descLines: string[] = [];
  for (const d of defs) {
    if (d.toolDescription) {
      descLines.push(`- '${d.category}': ${d.toolDescription}`);
    }
  }
  // Ensure none/escalate always have descriptions even without DB records
  if (!defs.find(d => d.category === 'none')) {
    descLines.push(`- 'none': Simple greeting, thank you, acknowledgment, or message fully answered by system knowledge.`);
  }
  if (!defs.find(d => d.category === 'escalate')) {
    descLines.push(`- 'escalate': Safety concern, legal issue, billing dispute requiring human, or anything needing immediate manager attention.`);
  }

  const categoriesDescription =
    `SOP categories matching the guest's intent(s), ordered by priority. Most messages have exactly one intent.\n\n` +
    descLines.join('\n');

  const toolDef: any = {
    type: 'function',
    name: 'get_sop',
    description:
      'Classifies a guest message and retrieves the Standard Operating Procedure that should guide your response. ' +
      'You MUST call this for any guest request involving: cleaning, amenities, maintenance, complaints, check-in/out, booking changes, ' +
      'early check-in, late checkout, WiFi issues, noise, visitors, extend stay, pricing, refunds, or any question needing action. ' +
      'ONLY skip this for pure greetings ("hi", "hey"), simple acknowledgments ("ok", "thanks"), and conversation-ending messages. ' +
      'When in doubt, call it — the SOP content guides your response quality. ' +
      'For messages requiring human intervention, classify as "escalate".',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        reasoning: {
          type: 'string',
          description: 'Brief reasoning for classification (1 sentence)',
        },
        categories: {
          type: 'array',
          items: {
            type: 'string',
            enum: enabledCategories,
          },
          minItems: 1,
          maxItems: 3,
          description: categoriesDescription,
        },
        confidence: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description: "Classification confidence. Use 'low' when ambiguous between multiple SOPs or unclear intent.",
        },
      },
      required: ['reasoning', 'categories', 'confidence'],
      additionalProperties: false,
    },
  };

  cacheSet(cacheKey, toolDef);
  return toolDef;
}

// ════════════════════════════════════════════════════════════════════════════
// §5  SEED DATA (hardcoded defaults — used ONLY by seedSopDefinitions)
// ════════════════════════════════════════════════════════════════════════════

/** Tool description per category (one-line, for AI classification). */
const SEED_TOOL_DESCRIPTIONS: Record<string, string> = {
  'sop-cleaning': 'Mid-stay cleaning or housekeeping requests. NOT for cleanliness complaints on arrival (use sop-complaint).',
  'sop-amenity-request': 'Requesting supplies (towels, pillows, hangers) or asking for on request amenities. NOT for general property description (use property-description). NOT for standard available amenities (use property-info)',
  'sop-maintenance': 'Broken items, plumbing, HVAC, electrical, pests, mold, smell. NOT for WiFi issues (use sop-wifi-doorcode).',
  'sop-wifi-doorcode': 'WiFi password, internet issues, door codes, locked out, building access.',
  'sop-visitor-policy': 'Visitor requests, guest count verification, passport submission for visitors. NOT for guest\'s own documents.',
  'sop-early-checkin': 'Arriving before 3PM, early access, bag drop-off.',
  'sop-late-checkout': 'Staying past 11AM on checkout day only. NOT for extending stay by days (use sop-booking-modification).',
  'sop-complaint': 'Guest dissatisfaction, review threats, quality complaints. NOT for specific broken items (use sop-maintenance).',
  'sop-booking-inquiry': 'New booking requests, availability checks, property search.',
  'pricing-negotiation': 'Discount requests, rate questions, budget concerns.',
  'sop-booking-modification': 'Extending stay, changing dates, adding nights, changing guest count, unit swaps.',
  'sop-booking-confirmation': 'Verifying reservation exists, checking booking status/details.',
  'sop-booking-cancellation': 'Cancel requests, cancellation policy questions.',
  'payment-issues': 'Payment failures, refund requests, receipts, billing disputes or an invoice.',
  'sop-long-term-rental': 'Monthly rental inquiries, corporate stays, stays over 3 weeks.',
  'property-info': 'Property details: bedrooms, bathrooms, floor, parking, pool, gym, address, neighborhood, compound description, area vibe, security, and all standard amenities/features. Use for ANY property question — what the place looks like, what it has, where it is. NOT for on-request items like towels/pillows (use sop-amenity-request).',
  'pre-arrival-logistics': 'Arrival coordination, compound instructions or  directions.',
  'sop-property-viewing': 'Property tours, photo/video requests, filming permission.',
  'post-stay-issues': 'Lost items after checkout, post-stay complaints, damage deposit.',
  'property-description': 'Listing narrative only — neighborhood description, area vibe, compound overview. NOT for specific features like pool/gym/parking (use property-info).',
  'none': 'Simple greeting, thank you, acknowledgment, or message fully answered by system knowledge.',
  'escalate': 'Safety concern, legal issue, billing dispute requiring human, or anything needing immediate manager attention.',
};

/** Default SOP content per category (used as DEFAULT variant during seeding). */
const SEED_SOP_CONTENT: Record<string, string> = {
  'sop-cleaning': `Guest asks for cleaning, housekeeping, maid service, tidying up, or mopping.
Extra Cleaning is available during working hours only (10am–5pm). Recurring cleaning is OK. If the guest mentions anything that the unit was not cleaned, apologies and escalate to manager.`,

  'sop-amenity-request': `Guest requests towels, extra towels, pillows, blankets, baby crib, extra bed, hair dryer, blender, kids dinnerware, espresso machine, hangers, or any item/amenity.

## AVAILABLE PROPERTY AMENITIES

{PROPERTY_AMENITIES}

Check the property amenities list for available items. Only confirm items explicitly listed there.
- Item on the amenities list → confirm availability and ask for preferred delivery time during working hours (10am–5pm). Do NOT escalate yet — wait for the guest to confirm a specific time in their next message, THEN escalate as "scheduled"
- Item NOT on the list → say "Let me check on that" → escalate as "info_request"`,

  'sop-maintenance': `Guest reports something broken, not working, or needing repair — AC not cooling, no hot water, plumbing, leak, water damage, appliance broken, electricity issue, insects, bugs, pests, cockroach, mold, smell, noise from neighbors.
Broken or malfunctioning items: Acknowledge the problem, assure guest someone will look into it and that you informed the manager, and escalate immediately.
**All maintenance/technical issues → urgency: "immediate"**`,

  'sop-wifi-doorcode': ``,

  'sop-visitor-policy': `Guest wants to invite someone ELSE over — a friend, family member, or visitor to the apartment. NOTE: This SOP is for VISITOR requests only. If the guest is asking about their OWN booking documents (passport, marriage cert, ID), this does not apply — escalate as info_request instead.

## VISITOR POLICY
- ONLY immediate family members allowed as visitors
- Guest must send visitor's passport through the chat
- Family names must match guest's family name
Collect passport image → escalate for manager verification
Non-family visitors (friends, colleagues, etc.) = NOT allowed
Any pushback on this rule → escalate as immediate`,

  'sop-early-checkin': `Guest asks for early check-in, arriving early, wants to check in before 3pm, or asks if they can come earlier.

## EARLY CHECK-IN
Standard check-in: 3:00 PM. Back-to-back bookings mean early check-in can only be confirmed 2 days before.
**More than 2 days before check-in:** Do NOT escalate. Tell guest: "We can only confirm early check-in 2 days before your date since there may be guests checking out. You're welcome to leave your bags with housekeeping and grab coffee at O1 Mall — it's a 1-minute walk."
**Within 2 days of check-in:** Tell guest you'll check → escalate as "info_request"
**Never confirm early check-in yourself.**`,

  'sop-late-checkout': `Guest asks for late checkout — wants to leave later on their checkout day, check out after 11am, or stay past checkout time on their last day.
Standard check-out: 11:00 AM. Back-to-back bookings mean late checkout can only be confirmed 2 days before.
**More than 2 days before checkout:** Do NOT escalate. Tell guest: "We can only confirm late checkout 2 days before your date since there may be guests checking in. We'll let you know closer to the date."
**Within 2 days of checkout:** Tell guest you'll check → escalate as "info_request"
**Never confirm late checkout yourself.**`,

  'sop-complaint': `COMPLAINT: Guest is unhappy, dissatisfied, or complaining about their experience — property quality, cleanliness on arrival, misleading photos/listing, noise from neighbors, uncomfortable beds, bad smell, or general dissatisfaction.
Acknowledge the complaint with genuine empathy. Do NOT be defensive or dismissive. Ask what specifically is wrong if not clear.
- Cleanliness complaints → offer immediate cleaning (waive $20 fee) and escalate as immediate
- Noise complaints → acknowledge and escalate as immediate
- Review threats or requests to speak to manager → acknowledge their frustration, escalate as immediate
- Property-quality complaints (misleading listing, broken promises, not as advertised) → escalate as immediate with full details
- General dissatisfaction → empathize, ask for specifics, escalate as immediate
Never offer refunds, discounts, or compensation yourself. Inform the guest you have notified the manager.`,

  'sop-booking-inquiry': `BOOKING INQUIRY: Guest is asking about availability, unit options, or making a new reservation. Ask: dates, number of guests, any preferences (bedrooms, floor, view). Check if property/dates are available in your knowledge. If the search tool found matching properties, present them with booking links from the tool results. If no booking links are available, list properties by name and escalate to manager to send links — never promise to send links you don't have. If not available or unsure, escalate as info_request with guest requirements. Never confirm a booking yourself — escalate with all details for manager to finalize. For urgent same-day requests, escalate as immediate.`,

  'pricing-negotiation': `PRICING/NEGOTIATION: Guest is asking about rates, requesting discounts, or expressing budget concerns. NEVER offer discounts, special rates, or price matches yourself. If guest asks for better price, weekly/monthly rate, or says it's too expensive, acknowledge and push back. If the guest has booked more than 3 weeks, escalate as info_request with the guest's budget/request details. Don't apologize for pricing — present it neutrally. For long-term stay pricing, also tag with sop-long-term-rental. If you escalate, tell the guest I requested an additional discount from the manager.`,

  'pre-arrival-logistics': `PRE-ARRIVAL LOGISTICS: Guest is coordinating arrival — sharing ETA, asking for directions, requesting location. Share property address and location from your knowledge. If guest asks for directions from a specific location, share what you know or escalate. If the guest asks for instructions for arriving at the compound, tell them to share the apartment number, building number, and their names with the gate security. The property is self check in. `,

  'sop-booking-modification': `BOOKING MODIFICATION: Guest wants to change dates, add/remove nights, change unit, or update guest count. Acknowledge the request. NEVER confirm modifications yourself. Escalate as info_request with: current booking details, requested changes, and reason if provided. For date changes within 48 hours of check-in, escalate as immediate. For guest count changes that might affect unit assignment, note the new count clearly.`,

  'sop-booking-confirmation': `BOOKING CONFIRMATION: Guest is verifying their reservation exists, checking dates/details, or asking about booking status. Check reservation details in your knowledge and confirm what you can see — dates, unit, guest count. If the booking isn't in your system, let them know you'll check with the team. For guests claiming they booked but no record found or there is a problem, escalate as immediate.`,

  'payment-issues': `PAYMENT ISSUES: Guest has questions about payment methods, failed transactions, receipts, billing disputes, or refund status. NEVER process payments, confirm receipt of payment, or authorize refunds yourself. For payment link issues, escalate as immediate-payment-issue. For receipt requests or invoice, escalate as info_request. For billing disputes or refund requests, acknowledge and escalate as immediate with full details. For deposit return questions, escalate as info_request. And inform the guest that you have notified the manager.`,

  'post-stay-issues': `POST-STAY ISSUES: Guest has checked out and contacts about lost items, post-stay complaints, damage deposit questions, or feedback. For lost items: ask for description. Escalate as immediate as post-stay-issue so staff can check. For damage deposit questions, escalate as info_request. For post-stay complaints, acknowledge with empathy and escalate as immediate. Never promise items will be found or deposits returned.`,

  'sop-long-term-rental': `LONG-TERM RENTAL: Guest is inquiring about monthly stays, corporate housing, or stays longer than 3 weeks. Ask: duration needed, move-in date, number of guests, any preferences. Share standard nightly rate if known, but note that monthly rates are different and need manager approval. Escalate as long-term-rental with all details. Tell the guest I will inform the manager for additional discount if there are any. Never quote monthly rates yourself.`,

  'sop-booking-cancellation': `BOOKING CANCELLATION: Guest wants to cancel their reservation or is asking about cancellation policy. Acknowledge the request. NEVER cancel bookings or confirm cancellation yourself. Escalate as booking-cancellation with booking details. For cancellation policy questions, escalate as info_request — policies vary by platform (Airbnb, Booking.com, direct). For refund-after-cancellation questions, also tag with payment-issues.`,

  'sop-property-viewing': `PROPERTY VIEWING: Guest wants to see the apartment before booking, requests photos/video, or asks about filming/photoshoot permission. First recommend that the photos are available online and comprehensive of the property. If wants videos, escalate to manager, and tell the guest I'll ask the manager if there are videos to provide.`,

  'property-info': `PROPERTY INFO: Guest is asking about the property — bedrooms, bathrooms, floor level, parking, pool, security, neighborhood, compound, area description, or general property details. Answer from the property description and amenities below.

If the guest asks for an amenity or feature this property does NOT have (e.g. sea view, jacuzzi, sauna), call search_available_properties to check if another property matches. Present results as alternatives.

If the information is not in your knowledge, say you'll check and escalate as info_request.

## PROPERTY DESCRIPTION
{PROPERTY_DESCRIPTION}

## AVAILABLE AMENITIES
{AVAILABLE_AMENITIES}`,

  'local-recommendations': `Guest asks about nearby places, local recommendations, or "where is the nearest X?"
You do NOT have local area knowledge. Do NOT guess locations, distances, or directions.
Acknowledge the question naturally, then escalate as info_request with what the guest is looking for.
Common requests: pharmacy (صيدلية), mall (مول), supermarket, restaurant, hospital, ATM, mosque (مسجد).`,

  'property-description': `## PROPERTY DESCRIPTION
{PROPERTY_DESCRIPTION} `,
};

// ── Status-variant overrides for SOPs whose response differs by reservation status ──

interface StatusVariant {
  status: string;
  content: string;
}

const SEED_STATUS_VARIANTS: Record<string, StatusVariant[]> = {
  'sop-amenity-request': [
    {
      status: 'INQUIRY',
      content: `Guest asks about available amenities or features. Check the amenities listed in your context (AVAILABLE AMENITIES and ON REQUEST AMENITIES blocks). Confirm what is available. Don't discuss delivery or scheduling — the guest is deciding whether to book.\n\n## ON REQUEST AMENITIES\nOnly confirm items explicitly listed there.\n\n{ON_REQUEST_AMENITIES}`,
    },
    {
      status: 'CONFIRMED',
      content: `Guest asks about amenities for their upcoming stay. Confirm availability and assure the amenity will be ready for their arrival. Don't schedule delivery — they haven't checked in yet.\n\n## ON REQUEST AMENITIES\nOnly confirm items explicitly listed there.\n\n{ON_REQUEST_AMENITIES}`,
    },
    {
      status: 'CHECKED_IN',
      content: `Guest requests an amenity to be delivered. Check the ON REQUEST AMENITIES in your context.\n\n## ON REQUEST AMENITIES\nOnly confirm items explicitly listed there.\n{ON_REQUEST_AMENITIES}\n\n- Item listed → confirm availability and ask for preferred delivery time during working hours (10am–5pm). Do NOT escalate yet — wait for guest to confirm time, THEN escalate as "scheduled"\n- Item NOT listed → say "Let me check on that" → escalate as "info_request"`,
    },
  ],

  'sop-early-checkin': [
    {
      status: 'INQUIRY',
      content: `Guest asking about early check-in as part of their booking inquiry. Standard check-in is 3:00 PM. Mention this and note that early check-in availability depends on prior bookings.`,
    },
    {
      status: 'CONFIRMED',
      content: `## EARLY CHECK-IN                                                                     \n  Standard check-in: 3:00 PM. Back-to-back bookings mean early check-in can only be confirmed 2 days before. \n**More than 2 days before check-in:** Do NOT escalate. Tell guest: "We can only confirm early check-in 2 days before your date since there may be guests checking out. You're welcome to leave your bags with housekeeping and grab coffee at O1 Mall — it's a 1-minute walk."                                                                         \n  **Within 2 days of check-in:** Check the AVAILABILITY CHECK RESULT section below. If it says back-to-back booking detected, tell the guest early check-in is not available because another guest is checking out the same day. If no back-to-back, tell the guest you'll check with the manager → escalate as "info_request" \n  **Never confirm early check-in yourself.**`,
    },
    {
      status: 'CHECKED_IN',
      content: '',
    },
  ],

  'sop-late-checkout': [
    {
      status: 'INQUIRY',
      content: `Guest asking about late checkout as part of their booking inquiry. Standard checkout is 11:00 AM. Mention this and note that late checkout may be possible depending on next booking.`,
    },
    {
      status: 'CONFIRMED',
      content: `Guest asking about late checkout for their upcoming stay. Standard checkout is 11:00 AM. Can only confirm 2 days before checkout date.`,
    },
    {
      status: 'CHECKED_IN',
      content: SEED_SOP_CONTENT['sop-late-checkout'],
    },
  ],

  'sop-cleaning': [
    {
      status: 'INQUIRY',
      content: `Guest asks for cleaning, housekeeping, maid service, tidying up, or mopping.\nExtra cleaning is available during their stay. Don't schedule, their booking has not been accepted yet. Reassure cleaning services are available on request.`,
    },
    {
      status: 'CONFIRMED',
      content: `Guest asks for cleaning, housekeeping, maid service, tidying up, or mopping.\nExtra cleaning is available during their stay. Don't schedule, guest has not checked in yet. Reassure cleaning services are available on request. `,
    },
    {
      status: 'CHECKED_IN',
      content: `Guest asks for cleaning, housekeeping, maid service, tidying up, or mopping.\nExtra Cleaning is available during working hours only (10am–5pm). Recurring cleaning is OK. If the guest mentions anything that the unit was not cleaned, apologies and escalate and schedule booking during working hours. `,
    },
  ],

  'sop-wifi-doorcode': [
    {
      status: 'INQUIRY',
      content: `Guest asks about WiFi or access. Confirm WiFi is available at the property. Reassure that access details will be provided after check-in — the guest is not yet booked.`,
    },
    {
      status: 'CONFIRMED',
      content: `{ACCESS_CONNECTIVITY}\nConfirm WiFi is available at the property, and its self check-in.\nIf there is an issue with the door code apologies and escalate immediately, this is a big issue and needs sorting right away. `,
    },
    {
      status: 'CHECKED_IN',
      content: `{ACCESS_CONNECTIVITY}\nIf there is an issue with the Wifi apologies and escalate.\nIf there is an issue with the door code apologies and escalate immediately, this is a big issue and needs sorting right away. `,
    },
  ],

  'sop-visitor-policy': [
    {
      status: 'INQUIRY',
      content: `Guest asks about visitor policy. Family-only property — only immediate family members allowed as visitors. Non-family visitors are not allowed. Share the policy upfront.`,
    },
    {
      status: 'CONFIRMED',
      content: SEED_SOP_CONTENT['sop-visitor-policy'],
    },
    {
      status: 'CHECKED_IN',
      content: SEED_SOP_CONTENT['sop-visitor-policy'],
    },
  ],

  'sop-booking-modification': [
    {
      status: 'INQUIRY',
      content: `Guest wants to modify their inquiry — change dates, guest count, or unit preference. Acknowledge the change request and escalate to manager with the new details. Never confirm changes yourself.`,
    },
    {
      status: 'CONFIRMED',
      content: SEED_SOP_CONTENT['sop-booking-modification'],
    },
    {
      status: 'CHECKED_IN',
      content: `Guest wants to extend their current stay or change dates. Acknowledge the request. Check if the extend-stay tool is available to check availability and pricing. Escalate to manager with details. Never confirm modifications yourself.`,
    },
  ],

  'pre-arrival-logistics': [
    {
      status: 'INQUIRY',
      content: '',
    },
    {
      status: 'CONFIRMED',
      content: SEED_SOP_CONTENT['pre-arrival-logistics'],
    },
    {
      status: 'CHECKED_IN',
      content: SEED_SOP_CONTENT['pre-arrival-logistics'],
    },
  ],

};

// ════════════════════════════════════════════════════════════════════════════
// §6  seedSopDefinitions()
// ════════════════════════════════════════════════════════════════════════════

/**
 * Populate SopDefinition + SopVariant rows for a tenant from hardcoded defaults.
 * Safe to call multiple times — uses upsert to avoid duplicates.
 */
export async function seedSopDefinitions(
  tenantId: string,
  prisma: PrismaClient,
): Promise<void> {
  console.log(`[SOP] Seeding SOP definitions for tenant ${tenantId}`);

  for (const category of SOP_CATEGORIES) {
    const toolDescription = SEED_TOOL_DESCRIPTIONS[category] || '';
    const defaultContent = SEED_SOP_CONTENT[category] || '';

    // Upsert the SopDefinition
    const sopDef = await prisma.sopDefinition.upsert({
      where: { tenantId_category: { tenantId, category } },
      create: {
        tenantId,
        category,
        toolDescription,
        enabled: true,
      },
      update: {}, // don't overwrite if already exists
    });

    // Upsert the DEFAULT variant
    await prisma.sopVariant.upsert({
      where: {
        sopDefinitionId_status: {
          sopDefinitionId: sopDef.id,
          status: 'DEFAULT',
        },
      },
      create: {
        sopDefinitionId: sopDef.id,
        status: 'DEFAULT',
        content: defaultContent,
        enabled: true,
      },
      update: {},
    });

    // Upsert status-specific variants if this SOP needs them
    const statusVariants = SEED_STATUS_VARIANTS[category];
    if (statusVariants) {
      for (const sv of statusVariants) {
        await prisma.sopVariant.upsert({
          where: {
            sopDefinitionId_status: {
              sopDefinitionId: sopDef.id,
              status: sv.status,
            },
          },
          create: {
            sopDefinitionId: sopDef.id,
            status: sv.status,
            content: sv.content,
            enabled: true,
          },
          update: {},
        });
      }
    }
  }

  console.log(`[SOP] Seeded ${SOP_CATEGORIES.length} SOP definitions for tenant ${tenantId}`);
}
