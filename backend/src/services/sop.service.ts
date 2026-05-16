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

/**
 * Bugfix (2026-04-23): the `prisma ?? new PrismaClient()` fallback in
 * getSopContent used to construct a brand-new PrismaClient on every
 * call where the caller forgot to pass one — each new client opens its
 * own connection pool (default ~10 connections), and the per-call
 * `$disconnect()` in the finally block is async + slow. On hot paths
 * this could exhaust Postgres max_connections under load.
 *
 * Today every production caller threads its own prisma (verified:
 * test-pipeline-runner, knowledge route, sandbox route, ai.service.ts).
 * The `?? new PrismaClient()` was effectively dead code — but a footgun
 * for any future caller that forgets to pass one. Replace with a
 * module-scope lazily-created singleton so the worst case is one
 * extra pool for the entire process lifetime, not one per call.
 *
 * This fallback is still NOT the recommended path: the function should
 * always be called with the caller's prisma so transactions and
 * lifecycle stay in the caller's hands.
 */
let _fallbackPrisma: PrismaClient | null = null;
function getFallbackPrisma(): PrismaClient {
  if (!_fallbackPrisma) {
    console.warn(
      '[sop.service] FALLBACK PrismaClient created — caller forgot to pass prisma. ' +
      'Pass the request-scoped prisma to getSopContent() for proper lifecycle management.',
    );
    _fallbackPrisma = new PrismaClient();
  }
  return _fallbackPrisma;
}

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
 * Resolve SOP content from DB.
 *
 * 2026-05-16: SOPs are now single-body — one DEFAULT variant per category
 * containing inline `### When booking is X` subsections. Per-status
 * variants (INQUIRY/CONFIRMED/CHECKED_IN) are no longer seeded; legacy
 * rows from older tenants are ignored (migration script merges them).
 *
 * Resolution cascade:
 *   1. SopPropertyOverride (sopDefId, propertyId, DEFAULT) → if enabled
 *   2. SopVariant          (sopDefId, DEFAULT)             → if enabled
 *   3. '' (empty)
 *
 * The `reservationStatus` argument is still required because it's threaded
 * through `applyTemplates` (e.g. ACCESS_CONNECTIVITY is empty for INQUIRY)
 * and embedded in the cache key, but it no longer steers which variant
 * row we pick.
 *
 * Auto-seeds the tenant on first call if no SopDefinitions exist.
 * Caches resolved content per (tenant, category, status, propertyId) for 5 min.
 *
 * Pass `{ bypassCache: true }` to force a DB hit even if a cached entry
 * exists. This is the BUILD-mode test_pipeline's R4 mitigation — a new
 * SOP written via create_sop must be visible to the very next
 * test_pipeline call, and the 5-min cache would otherwise hide it.
 */
export interface GetSopContentOptions {
  bypassCache?: boolean;
}

export async function getSopContent(
  tenantId: string,
  category: string,
  reservationStatus: string,
  propertyId?: string,
  propertyAmenities?: string,
  prisma?: PrismaClient,
  variableDataMap?: Record<string, string>,
  options?: GetSopContentOptions,
): Promise<string> {
  // Normalise status to match DB values
  const status = normaliseStatus(reservationStatus);

  // Cache key includes all resolution dimensions
  const cacheKey = `sop:${tenantId}:content:${category}:${status}:${propertyId || '_'}`;
  if (!options?.bypassCache) {
    const cached = cacheGet<string>(cacheKey);
    if (cached !== undefined) {
      return applyTemplates(cached, category, propertyAmenities, variableDataMap);
    }
  }

  // We need Prisma for DB lookups. Use the caller's prisma when
  // present; else borrow the module-scope fallback singleton (see
  // getFallbackPrisma above for rationale).
  const db = prisma ?? getFallbackPrisma();
  try {
    // Auto-seed if no definitions exist for this tenant
    const defCount = await db.sopDefinition.count({ where: { tenantId } });
    if (defCount === 0) {
      await seedSopDefinitions(tenantId, db);
    }

    // 2026-05-16: single-body SOPs — fetch only the DEFAULT variant +
    // DEFAULT property override (if any). Legacy per-status rows are
    // ignored; the migration script collapses them into DEFAULT.
    const sopDef = await db.sopDefinition.findUnique({
      where: { tenantId_category: { tenantId, category } },
      include: {
        variants: {
          where: { status: 'DEFAULT', enabled: true },
        },
        propertyOverrides: propertyId
          ? {
              where: { propertyId, status: 'DEFAULT', enabled: true },
            }
          : { where: { id: '__never__' } },
      },
    });
    if (!sopDef || !sopDef.enabled) {
      cacheSet(cacheKey, '');
      return '';
    }

    let content = '';

    // Property override beats global variant when present.
    if (propertyId) {
      const override = sopDef.propertyOverrides[0];
      if (override) content = override.content;
    }
    if (!content) {
      const defaultVariant = sopDef.variants[0];
      if (defaultVariant) content = defaultVariant.content;
    }

    cacheSet(cacheKey, content);
    return applyTemplates(content, category, propertyAmenities, variableDataMap);
  } finally {
    // Bugfix (2026-04-23): NEVER disconnect — the fallback is a
    // module-scope singleton; disconnecting it would tear down the
    // pool that subsequent fallback calls reuse. The caller-supplied
    // prisma is owned by the caller's process (server.ts main()) and
    // must not be touched here.
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

  // 2026-05-15 M3: any remaining `{TOKEN}` placeholders must NOT leak to the
  // guest. They reach here when a caller forgets to pass variableDataMap
  // (BUILD test_pipeline before sprint 045 occasionally did this) or when
  // a new SOP placeholder is added in content before the AI pipeline
  // populates it. Strip them rather than ship raw template tokens to a
  // guest's WhatsApp / Airbnb thread.
  const leftover = result.match(/\{[A-Z_]+\}/g);
  if (leftover && leftover.length > 0) {
    console.warn(
      `[SOP] applyTemplates left ${leftover.length} unresolved placeholders for category=${category}: ${leftover.slice(0, 6).join(', ')} — stripping before return.`,
    );
    result = result.replace(/\{[A-Z_]+\}/g, '');
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

/**
 * Default SOP content per category — the SINGLE canonical body the AI receives.
 *
 * 2026-05-16: SOP architecture was simplified from per-status variants
 * (DEFAULT/INQUIRY/CONFIRMED/CHECKED_IN, each with its own body) into a
 * single merged body per category. Where guidance differs by booking
 * status, the body now uses explicit Markdown subsections:
 *
 *     ### When booking is INQUIRY
 *     ... do this for inquiries ...
 *
 *     ### When booking is CONFIRMED or CHECKED_IN
 *     ... do this for active reservations ...
 *
 * The AI receives the FULL merged body PLUS a one-line preamble naming
 * the current booking status (`## SOP: <cat>  ·  current booking status:
 * <STATUS>`), and selects the matching subsection. Content not wrapped
 * in a "When booking is X" subsection applies to all statuses.
 *
 * This costs ~50 tokens per multi-status SOP for the heading scaffold
 * but reads more clearly than 3 separate near-duplicate variants, and
 * lets the AI answer cross-status questions ("what about when I check
 * in?") without re-classifying.
 */
export const SEED_SOP_CONTENT: Record<string, string> = {
  'sop-cleaning': `Guest asks for cleaning, housekeeping, maid service, tidying up, or mopping.

### When booking is INQUIRY or CONFIRMED (not yet checked in)
Reassure that extra cleaning is available during the stay. Do NOT schedule — the guest hasn't checked in yet.

### When booking is CHECKED_IN (guest is currently staying)
Extra cleaning is available during working hours only (10am–5pm). Recurring cleaning is OK. Ask for the guest's preferred time, then escalate as "scheduled" once they confirm.
If the guest reports the unit was not cleaned on arrival, apologise and escalate as "immediate".`,

  'sop-amenity-request': `Guest requests towels, extra towels, pillows, blankets, baby crib, extra bed, hair dryer, blender, kids dinnerware, espresso machine, hangers, or any item/amenity.

## AVAILABLE PROPERTY AMENITIES

{PROPERTY_AMENITIES}

Only confirm items explicitly listed above. Items not listed → say "Let me check on that" → escalate as "info_request".

### When booking is INQUIRY (guest is browsing, not yet booked)
Confirm what's available based on the amenities list. Don't discuss delivery or scheduling — the guest is still deciding whether to book.

### When booking is CONFIRMED (booked, not yet arrived)
Confirm availability and assure the amenity will be ready for arrival. Don't schedule delivery — they haven't checked in yet.

### When booking is CHECKED_IN (guest is currently staying)
- Item on the amenities list → confirm availability and ask for preferred delivery time during working hours (10am–5pm). Do NOT escalate yet — wait for the guest to confirm a specific time in their next message, THEN escalate as "scheduled".`,

  'sop-maintenance': `Guest reports something broken, not working, or needing repair — AC not cooling, no hot water, plumbing, leak, water damage, appliance broken, electricity issue, insects, bugs, pests, cockroach, mold, smell, noise from neighbors.
Broken or malfunctioning items: Acknowledge the problem, assure the guest someone will look into it and that you informed the manager, and escalate immediately.
**All maintenance/technical issues → urgency: "immediate"**`,

  'sop-wifi-doorcode': `Guest asks about WiFi, internet, the door code, the smart lock, building access, or self check-in.

### When booking is INQUIRY (guest is browsing, not yet booked)
Confirm that WiFi and self check-in are available at the property. Do NOT share the WiFi password or door code — access details are only released once the booking is confirmed. Reassure that the full access details will be sent ahead of arrival.

### When booking is CONFIRMED or CHECKED_IN (booked or currently staying)
Share these access details verbatim:

{ACCESS_CONNECTIVITY}

This is a self check-in property — the door code above is what the guest uses to enter.

### Escalation rules (all statuses)
- WiFi not working → apologise and escalate as "immediate".
- Door code not working / guest locked out → apologise and escalate as **"immediate"** — high priority, the guest may be stuck outside.
- Any building or compound access issue → escalate as "immediate".`,

  'sop-visitor-policy': `Guest wants to invite someone ELSE over — a friend, family member, or visitor to the apartment. NOTE: This SOP is for VISITOR requests only. If the guest is asking about their OWN booking documents (passport, marriage cert, ID), this does not apply — escalate as info_request instead.

## VISITOR POLICY (all statuses)
- ONLY immediate family members allowed as visitors.
- Family names must match the guest's family name.
- Non-family visitors (friends, colleagues, etc.) = NOT allowed.
- Any pushback on this rule → escalate as "immediate".

### When booking is INQUIRY (guest is browsing, not yet booked)
Share the family-only policy upfront so the guest can decide whether to book. Don't request a passport image yet — they aren't booked.

### When booking is CONFIRMED or CHECKED_IN (booked or currently staying)
Ask the guest to send the visitor's passport image through the chat. Once received, escalate as "immediate" for manager verification.`,

  'sop-early-checkin': `Guest asks for early check-in, arriving early, wants to check in before 3pm, or asks if they can come earlier.

Standard check-in: 3:00 PM. **Never confirm early check-in yourself.**

### When booking is INQUIRY (guest is browsing, not yet booked)
Mention the 3:00 PM standard check-in and note that early check-in availability depends on the prior booking. Don't promise a time.

### When booking is CONFIRMED (booked, not yet arrived)
{CHECKIN_SITUATION}

### When booking is CHECKED_IN (guest is currently staying)
The guest has already checked in — early check-in is no longer relevant. If they're asking about a different upcoming stay, ask which booking they mean.`,

  'sop-late-checkout': `Guest asks for late checkout — wants to leave later on their checkout day, check out after 11am, or stay past checkout time on their last day.

Standard check-out: 11:00 AM. **Never confirm late checkout yourself.** Tiers: 11am-1pm $25, 1-6pm $65, after 6pm $120.

### When booking is INQUIRY (guest is browsing, not yet booked)
Mention the 11:00 AM standard checkout and note that late checkout may be possible depending on the next booking. Don't promise a time.

### When booking is CONFIRMED or CHECKED_IN (booked or currently staying)
{CHECKOUT_SITUATION}`,

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

  'pre-arrival-logistics': `Guest is coordinating arrival — sharing ETA, asking for directions, or requesting the property location.

### When booking is INQUIRY (guest is browsing, not yet booked)
Share general area / neighbourhood info if asked, but do NOT share the exact street address or compound entry instructions until the booking is confirmed.

### When booking is CONFIRMED or CHECKED_IN (booked or currently staying)
Share the property address and location from your knowledge. For compound entry, tell the guest to share the apartment number, building number, and their names with gate security. The property is self check-in. If the guest asks for directions from a specific location, share what you know or escalate as "info_request".`,

  'sop-booking-modification': `BOOKING MODIFICATION: Guest wants to change dates, add/remove nights, change unit, or update guest count. Acknowledge the request. NEVER confirm modifications yourself.

### When booking is INQUIRY (guest is still browsing, no confirmed booking)
The guest wants to adjust their inquiry — changes to requested dates, guest count, or unit preference. Acknowledge and escalate to the manager with the new details. Don't reference "your existing booking" — they don't have one yet.

### When booking is CONFIRMED (booked, not yet arrived)
Escalate as info_request with: current booking details, requested changes, and reason if provided. For date changes within 48 hours of check-in, escalate as "immediate". For guest count changes that might affect unit assignment, note the new count clearly.

### When booking is CHECKED_IN (guest is currently staying)
Guest is asking to extend or change dates mid-stay. If extending, use check_extend_availability first to confirm the unit is free. Escalate to the manager with details — never confirm modifications yourself.`,

  'sop-booking-confirmation': `BOOKING CONFIRMATION: Guest is verifying their reservation exists, checking dates/details, or asking about booking status. Check reservation details in your knowledge and confirm what you can see — dates, unit, guest count. If the booking isn't in your system, let them know you'll check with the team. For guests claiming they booked but no record found or there is a problem, escalate as immediate.`,

  'payment-issues': `PAYMENT ISSUES: Guest has questions about payment methods, failed transactions, receipts, billing disputes, or refund status. NEVER process payments, confirm receipt of payment, or authorize refunds yourself. For payment link issues, escalate as immediate-payment-issue. For receipt requests or invoice, escalate as info_request. For billing disputes or refund requests, acknowledge and escalate as immediate with full details. For deposit return questions, escalate as info_request. And inform the guest that you have notified the manager.`,

  'post-stay-issues': `POST-STAY ISSUES: Guest has checked out and contacts about lost items, post-stay complaints, damage deposit questions, or feedback. For lost items: ask for description. Escalate as immediate as post-stay-issue so staff can check. For damage deposit questions, escalate as info_request. For post-stay complaints, acknowledge with empathy and escalate as immediate. Never promise items will be found or deposits returned.`,

  'sop-long-term-rental': `LONG-TERM RENTAL: Guest is inquiring about monthly stays, corporate housing, or stays longer than 3 weeks. Ask: duration needed, move-in date, number of guests, any preferences. Share standard nightly rate if known, but note that monthly rates are different and need manager approval. Escalate as long-term-rental with all details. Tell the guest I will inform the manager for additional discount if there are any. Never quote monthly rates yourself.`,

  'sop-booking-cancellation': `BOOKING CANCELLATION: Guest wants to cancel their reservation or is asking about cancellation policy. Acknowledge the request. NEVER cancel bookings or confirm cancellation yourself. Escalate as booking-cancellation with booking details. For cancellation policy questions, escalate as info_request — policies vary by platform (Airbnb, Booking.com, direct). For refund-after-cancellation questions, also tag with payment-issues.`,

  'sop-property-viewing': `PROPERTY VIEWING: Guest wants to see the apartment before booking, requests photos/video, or asks about filming/photoshoot permission. First recommend that the photos are available online and comprehensive of the property. If wants videos, escalate to manager, and tell the guest I'll ask the manager if there are videos to provide.`,

  'property-info': `PROPERTY INFO: Guest is asking about the property — bedrooms, bathrooms, floor level, parking, pool, security, neighborhood, compound, area description, or general property details. Answer from the property description and amenities below.

First check if this property matches the guest's requirements using the description and amenities below. When a guest lists multiple requirements or asks what's available, also call search_available_properties — it scores this property and alternatives together. If this property is the best match, pitch it confidently. Only suggest alternatives if they genuinely offer something this property lacks.

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

// 2026-05-16: per-status SOP variants were removed in favour of a single
// merged DEFAULT body per category with inline `### When booking is X`
// subsections (see SEED_SOP_CONTENT above). New tenants only get a DEFAULT
// variant; existing tenants are migrated by `backend/scripts/merge-sop-variants.ts`.
// `getSopContent` now always resolves to the DEFAULT body and the AI
// receives the current booking status in the get_sop tool result preamble
// so it can pick the matching subsection.

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

  }

  console.log(`[SOP] Seeded ${SOP_CATEGORIES.length} SOP definitions for tenant ${tenantId}`);
}
