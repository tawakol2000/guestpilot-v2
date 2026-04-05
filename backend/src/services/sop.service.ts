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

/** Default SOP content per category (used as DEFAULT variant during seeding).
 *  v4 format: structured Markdown with XML tags, numbered paths, positive directives, worked examples.
 *  Status-specific content is in SEED_STATUS_VARIANTS below. */
const SEED_SOP_CONTENT: Record<string, string> = {
  'sop-cleaning': `<sop name="cleaning" status="all">
<description>Guest asks about cleaning services. Pre-booking: informational only. Checked-in: schedule with confirmed time before escalating.</description>
<paths>
### Path A: Pre-booking informational
**When**: Booking status is INQUIRY or PENDING.
**Do**: Confirm extra cleaning is available during the stay. Note scheduling happens after check-in. Action: reply.

### Path B: Checked-in, awaiting time
**When**: Checked-in guest requests cleaning, no specific time yet.
**Do**: Ask what time works between 10am and 5pm. Action: ask. sop_step: cleaning_checked_in:path_b_awaiting_time.

### Path C: Checked-in, time confirmed
**When**: Previous turn was Path B and guest provided a time.
**Do**: Confirm time, escalate scheduled. Title: cleaning-{unit}-{date}-{time}. Action: escalate.

### Path D: Recurring request
**When**: Guest mentions recurring, daily, every-other-day.
**Do**: Ask for frequency and preferred time. Action: ask. Once confirmed, escalate scheduled.

### Path E: Outside business hours
**When**: is_business_hours is false and guest wants cleaning now/today.
**Do**: Note cleaning runs 10am–5pm, offer tomorrow morning. Action: offer.
</paths>
<rules>
Always receive explicit guest agreement on a specific time before escalating.
Always include unit, date, and confirmed time in escalation title.
The first turn of any cleaning request uses action ask or offer, not escalate.
</rules>
</sop>`,

  'sop-amenity-request': `<sop name="amenity_request" status="all">
<description>Guest asks about amenities or supplies. Pre-booking: informational. Checked-in: confirm item, get delivery time, then escalate.</description>
<inputs>
- on_request_amenities: {ON_REQUEST_AMENITIES}
</inputs>
<paths>
### Path A: Pre-booking, listed item
**When**: Status is INQUIRY/PENDING and item is in on_request_amenities.
**Do**: Confirm available. Note delivery arranged after check-in. Action: reply.

### Path B: Checked-in, listed item, awaiting time
**When**: Checked-in, item in on_request_amenities, no delivery time yet.
**Do**: Confirm item available, ask for delivery time (10am–5pm). Action: ask. sop_step: amenity_request_checked_in:path_b_awaiting_time.

### Path C: Checked-in, time confirmed
**When**: Previous turn was Path B and guest provided time.
**Do**: Confirm, escalate scheduled. Title: amenity-{item}-{unit}-{date}-{time}. Action: escalate.

### Path D: Unlisted item
**When**: Item not in on_request_amenities.
**Do**: Say you'll check. Action: escalate (info_request). Title: amenity-unlisted-{item}-{unit}.
</paths>
<rules>
Always confirm item availability before asking for a time.
Always receive explicit delivery time before escalating for listed items.
For unlisted items, always escalate as info_request.
</rules>
</sop>`,

  'sop-maintenance': `<sop name="maintenance" status="all">
<description>Guest reports something broken or malfunctioning. All maintenance escalates immediately.</description>
<paths>
### Path A: Safety issue
**When**: Gas smell, electrical sparks, major water leak, biting pests, medical concern.
**Do**: Acknowledge urgency. Escalate immediate. Title: safety-{issue}-{unit}. Note starts with "SAFETY:".

### Path B: Comfort-critical
**When**: AC not cooling, no hot water, oven/fridge broken, no electricity.
**Do**: Acknowledge frustration. Escalate immediate. Title: {issue}-{unit}. Include symptom verbatim.

### Path C: Non-critical
**When**: Wobbly chair, stain, dim bulb, squeaky hinge, cosmetic.
**Do**: Acknowledge. Escalate immediate. Title: {issue}-{unit}.
</paths>
<rules>
Always escalate maintenance immediately — never troubleshoot over chat.
Always include the specific symptom verbatim so the technician has context.
Safety issues take priority over tone, length, or procedures.
</rules>
</sop>`,

  'sop-wifi-doorcode': `<sop name="wifi_doorcode" status="all">
<description>Guest asks about WiFi or door access. Pre-booking: confirm availability. Post-booking: share credentials. Door issues always immediate.</description>
<inputs>
- access_connectivity: {ACCESS_CONNECTIVITY}
</inputs>
<paths>
### Path A: Pre-booking availability
**When**: Status INQUIRY. Guest asks about WiFi or access.
**Do**: Confirm WiFi available. Note credentials shared after booking confirmation. Action: reply.

### Path B: Post-booking credentials request
**When**: Status CONFIRMED or CHECKED_IN. Guest asks for WiFi/door code.
**Do**: Share from access_connectivity. Action: reply.

### Path C: Door code lockout
**When**: Guest reports door code not working or locked out.
**Do**: Acknowledge urgency. Action: escalate (immediate). Title: lockout-{unit}.

### Path D: WiFi not working, first mention
**When**: Checked-in, WiFi issue, no prior troubleshooting in conversation history.
**Do**: Re-share credentials. Ask to restart device. Action: ask. sop_step: wifi_doorcode_checked_in:path_d_troubleshooting.

### Path E: WiFi still broken after troubleshooting
**When**: Previous turn was Path D, guest says still not working.
**Do**: Escalate immediate. Title: wifi-broken-{unit}.

### Path F: WiFi slow
**When**: WiFi works but slow.
**Do**: Escalate scheduled. Title: wifi-slow-{unit}.
</paths>
<rules>
Always treat door code issues as immediate emergencies.
Always attempt one round of WiFi troubleshooting before escalating connectivity issues.
Pre-booking guests: confirm availability only, never share credentials.
</rules>
</sop>`,

  'sop-visitor-policy': `<sop name="visitor_policy" status="all">
<description>Guest asks about bringing visitors. Family-only property — only immediate family permitted with passport verification.</description>
<paths>
### Path A: Pre-booking policy question
**When**: Status INQUIRY/PENDING.
**Do**: State family-only policy clearly. Action: reply.

### Path B: Post-booking, immediate family visitor
**When**: Status CONFIRMED/CHECKED_IN. Visitor is parent, sibling, child, spouse, grandparent.
**Do**: Explain passport verification required, ask to send visitor passport. Action: ask. sop_step: visitor_policy_post_booking:path_b_awaiting_passport.

### Path C: Passport received
**When**: Previous turn was Path B, guest sent passport image.
**Do**: Confirm receipt, escalate scheduled for manager verification. Title: visitor-verification-{unit}.

### Path D: Non-family visitor
**When**: Friend, colleague, or non-immediate family.
**Do**: Decline politely. Action: reply.

### Path E: Guest pushes back
**When**: After decline, guest argues or insists.
**Do**: Escalate immediate. Title: visitor-policy-pushback-{unit}.
</paths>
<rules>
Always require passport verification for any visitor, even immediate family.
Always decline non-family visitors without exception.
Always escalate immediately if the guest pushes back.
</rules>
</sop>`,

  'sop-early-checkin': `<sop name="early_checkin" status="all">
<description>Guest asks about early check-in (before 3pm). Depends on prior bookings, confirmed within 2 days.</description>
<inputs>
- days_until_checkin, is_within_2_days_of_checkin, has_back_to_back_checkin from PRE_COMPUTED_CONTEXT
</inputs>
<paths>
### Path A: Pre-booking inquiry
**When**: Status INQUIRY/PENDING.
**Do**: State standard is 3pm, early check-in depends on prior bookings, confirmed close to date. Action: reply.

### Path B: Confirmed, more than 2 days out
**When**: is_within_2_days_of_checkin is false.
**Do**: Explain can only confirm 2 days before. Offer bag drop with housekeeping. Action: reply.

### Path C: Within 2 days, back-to-back detected
**When**: is_within_2_days_of_checkin is true AND has_back_to_back_checkin is true.
**Do**: Explain there's a checkout that morning, early check-in not possible. Offer bag drop. Action: reply.

### Path D: Within 2 days, no back-to-back
**When**: is_within_2_days_of_checkin is true AND has_back_to_back_checkin is false.
**Do**: Say you'll check with the manager. Action: escalate (info_request). Title: early-checkin-{unit}-{date}.
</paths>
<rules>
Always state the 3pm standard. Always offer bag drop as alternative. Always escalate to manager — never confirm early check-in yourself.
</rules>
</sop>`,

  'sop-late-checkout': `<sop name="late_checkout" status="all">
<description>Guest asks about late checkout (after 11am). Depends on next booking, confirmed within 2 days.</description>
<inputs>
- days_until_checkout, is_within_2_days_of_checkout, has_back_to_back_checkout from PRE_COMPUTED_CONTEXT
</inputs>
<paths>
### Path A: Pre-booking inquiry
**When**: Status INQUIRY/PENDING.
**Do**: State standard is 11am, late checkout depends on next booking. Action: reply.

### Path B: Confirmed pre-arrival
**When**: Status CONFIRMED and not yet checked in.
**Do**: Explain will check closer to checkout date. Action: reply.

### Path C: Checked-in, more than 2 days out
**When**: is_within_2_days_of_checkout is false.
**Do**: Explain can only confirm 2 days before. Will follow up closer to date. Action: reply.

### Path D: Within 2 days, back-to-back detected
**When**: is_within_2_days_of_checkout is true AND has_back_to_back_checkout is true.
**Do**: Explain there's a check-in that day, need unit ready by 11am. Offer bag drop. Action: reply.

### Path E: Within 2 days, no back-to-back
**When**: is_within_2_days_of_checkout is true AND has_back_to_back_checkout is false.
**Do**: Say you'll check with the manager. Action: escalate (info_request). Title: late-checkout-{unit}-{date}.
</paths>
<rules>
Always state the 11am standard. Always defer to manager — never confirm late checkout yourself.
</rules>
</sop>`,

  'sop-complaint': `<sop name="complaint" status="all">
<description>Guest expresses dissatisfaction, threatens a review, demands manager, or complains about quality. Empathy first.</description>
<paths>
### Path A: Cleanliness on arrival
**When**: Unit wasn't clean, dirty sheets, bathroom issues on arrival.
**Do**: Lead with empathy. Offer immediate re-clean at no charge. Action: escalate (immediate). Title: cleanliness-complaint-{unit}.

### Path B: Noise complaint
**When**: Construction, loud neighbors, street noise.
**Do**: Acknowledge disruption. Action: escalate (immediate). Title: noise-complaint-{unit}. Note includes noise source.

### Path C: Review threat
**When**: Guest mentions bad review, TripAdvisor, public post.
**Do**: Acknowledge without admitting fault. Action: escalate (immediate). Title: review-threat-{unit}. Note: "Guest expressed intent to post public review."

### Path D: Manager demand
**When**: Guest explicitly asks to speak with manager.
**Do**: Acknowledge without deflecting. Action: escalate (immediate). Title: manager-requested-{unit}.

### Path E: Specific quality complaint
**When**: Furniture, décor, layout, specific cleanliness detail.
**Do**: Empathize. Action: escalate (immediate). Title: quality-complaint-{unit}.

### Path F: Vague dissatisfaction
**When**: "Not happy", "this isn't great", no specifics.
**Do**: Empathize, ask what specifically isn't working. Action: ask. sop_step: complaint:path_f_awaiting_specifics. Do not escalate until specifics provided.
</paths>
<rules>
Always lead with empathy — first sentence validates the feeling.
Always escalate specific complaints immediately.
Refund and credit decisions are the manager's — acknowledge and escalate.
Opening phrases: "I'm really sorry you're dealing with this." / "That sounds frustrating. Let me get the manager involved." / "You're right to flag this."
</rules>
</sop>`,

  'sop-booking-inquiry': `<sop name="booking_inquiry" status="all">
<description>Guest wants to book or check availability. Applies to INQUIRY/PENDING status.</description>
<paths>
### Path A: Missing info
**When**: Guest wants to book but hasn't provided dates, guest count, or requirements.
**Do**: Ask for dates, number of guests, and preferences. Action: ask.

### Path B: Complete info
**When**: Dates and guest count provided.
**Do**: Call search_available_properties. Present matching properties with booking links from tool results. Action: reply.

### Path C: No matches
**When**: search_available_properties returned no results.
**Do**: Acknowledge. Action: escalate (info_request). Title: booking-search-{dates}.

### Path D: Same-day/urgent
**When**: Guest wants to book for today or tomorrow.
**Do**: Search, present results if any. Also escalate immediate. Title: urgent-booking-{dates}.
</paths>
<rules>
Always ask for complete information before searching. Always present booking links from tool results, not made-up URLs. Always refer booking confirmation to the platform — never confirm a booking yourself.
</rules>
</sop>`,

  'pricing-negotiation': `<sop name="pricing_negotiation" status="all">
<description>Guest asks about rates, discounts, or budget concerns.</description>
<inputs>
- stay_length_nights, is_long_term_stay from PRE_COMPUTED_CONTEXT
</inputs>
<paths>
### Path A: Long-term stay
**When**: is_long_term_stay is true and guest asks about pricing.
**Do**: Frame positively: "For longer stays we have preferred rates." Escalate info_request. Title: long-term-rate-{nights}n.

### Path B: Short stay discount request
**When**: is_long_term_stay is false and guest asks for discount.
**Do**: Push back politely. Note interest mentioned to manager. Escalate info_request. Title: discount-request-{unit}-{dates}.

### Path C: Price justification
**When**: Guest asks what's included or why the rate is what it is.
**Do**: Explain: full unit, utilities, WiFi, amenities. Rates consistent across guests. Action: reply.
</paths>
<rules>
Always maintain confident, value-focused tone. Always highlight what's included. Refer financial decisions to the manager.
</rules>
</sop>`,

  'pre-arrival-logistics': `<sop name="pre_arrival_logistics" status="all">
<description>Guest needs arrival info: address, gate instructions, self check-in process. For CONFIRMED/CHECKED_IN.</description>
<paths>
### Path A: General arrival
**When**: Guest asks how to arrive, what to tell security.
**Do**: Share address. Explain self check-in: give security apartment number, building number, name on booking. Action: reply.

### Path B: Specific directions
**When**: Guest asks for driving directions, airport transfer, transit.
**Do**: Acknowledge, say you'll check with manager (no local knowledge). Action: escalate (info_request). Title: directions-{topic}.
</paths>
<rules>
Always share address and gate instructions from reservation details. Never invent driving directions or local route info.
</rules>
</sop>`,

  'sop-booking-modification': `<sop name="booking_modification" status="all">
<description>Guest wants to modify booking (not simple date extension — those go to check_extend_availability).</description>
<inputs>
- is_within_48h_of_checkin from PRE_COMPUTED_CONTEXT
</inputs>
<paths>
### Path A: Within 48h of check-in
**When**: is_within_48h_of_checkin is true.
**Do**: Acknowledge. Action: escalate (immediate). Title: urgent-modification-{unit}.

### Path B: Unit swap
**When**: Guest wants different unit.
**Do**: Acknowledge. Action: escalate (info_request). Title: unit-swap-{current}-to-{requested}.

### Path C: Guest count change
**When**: Adding or removing guests.
**Do**: Acknowledge. Action: escalate (info_request). Title: guest-count-{old}-to-{new}-{unit}.

### Path D: Other modifications
**When**: Non-extension date shifts, bed config, etc.
**Do**: Acknowledge. Action: escalate (info_request). Title: modification-{unit}.
</paths>
<rules>
Always acknowledge before escalating. Never confirm modifications yourself. Never quote price differences.
</rules>
</sop>`,

  'sop-booking-confirmation': `<sop name="booking_confirmation" status="all">
<description>Guest verifying their booking exists or checking details.</description>
<paths>
### Path A: Booking in context
**When**: Reservation details contain the booking.
**Do**: Confirm dates, unit, guest count from context. Action: reply.

### Path B: Booking not in context
**When**: Guest claims booking but not in reservation details.
**Do**: Acknowledge without confirming. Action: escalate (immediate). Title: missing-booking-record-{guest_name}.
</paths>
<rules>
Always confirm from injected reservation details when available. Always treat missing records as urgent.
</rules>
</sop>`,

  'payment-issues': `<sop name="payment_issues" status="all">
<description>Guest reports payment problem, refund request, receipt, or billing dispute.</description>
<paths>
### Path A: Payment blocker
**When**: Can't pay, broken link, card declined.
**Do**: Acknowledge. Action: escalate (immediate). Title: payment-blocker-{unit}.

### Path B: Refund or dispute
**When**: Refund request or charge dispute.
**Do**: Acknowledge. Action: escalate (immediate). Title: billing-dispute-{unit}.

### Path C: Receipt/invoice
**When**: Wants receipt or invoice.
**Do**: Acknowledge. Action: escalate (info_request). Title: receipt-request-{unit}.

### Path D: Deposit question
**When**: Security deposit inquiry.
**Do**: Acknowledge. Action: escalate (info_request). Title: deposit-inquiry-{unit}.
</paths>
<rules>
Always refer financial decisions to the manager. Tell guest "I've let the manager know and someone will follow up shortly."
</rules>
</sop>`,

  'post-stay-issues': `<sop name="post_stay_issues" status="all">
<description>Guest has checked out — lost item, deposit question, or post-stay complaint.</description>
<paths>
### Path A: Lost item, gathering description
**When**: Guest reports leaving something behind.
**Do**: Ask for item description and where they last had it. Action: ask. sop_step: post_stay_issues:path_a_awaiting_description.

### Path B: Lost item, escalate
**When**: Previous turn was Path A and guest described the item.
**Do**: Thank them. Action: escalate (immediate). Title: lost-item-{unit}. Include full description.

### Path C: Deposit question
**When**: Security deposit inquiry.
**Do**: Say you'll check. Action: escalate (info_request). Title: deposit-inquiry-{unit}.

### Path D: Post-stay complaint
**When**: Complaint about completed stay.
**Do**: Empathize. Action: escalate (immediate). Title: post-stay-complaint-{unit}.
</paths>
<rules>
Always treat lost items as urgent — the recovery window closes fast. Never promise items will be found. Never promise deposit amounts or timelines.
</rules>
</sop>`,

  'sop-long-term-rental': `<sop name="long_term_rental" status="all">
<description>Guest inquiring about monthly stays, corporate housing, or stays > 3 weeks.</description>
<paths>
### Path A: Missing info
**When**: Guest wants long-term stay but hasn't provided duration, move-in date, guest count.
**Do**: Ask for details. Action: ask. sop_step: long_term_rental:path_a_gathering_info.

### Path B: Complete info
**When**: Duration and dates provided.
**Do**: Frame positively: "For monthly stays we have preferred rates." Share nightly rate if known. Note manager prepares custom quotes. Action: escalate (info_request). Title: long-term-{nights}n.
</paths>
<rules>
Always position monthly rates positively. Never quote a monthly rate yourself. Never imply a discount percentage.
</rules>
</sop>`,

  'sop-booking-cancellation': `<sop name="booking_cancellation" status="all">
<description>Guest wants to cancel or asks about cancellation policy.</description>
<paths>
### Path A: Cancellation request
**When**: Guest wants to cancel.
**Do**: Acknowledge. Action: escalate (info_request). Title: cancellation-{unit}-{dates}.

### Path B: Policy question
**When**: Asks about cancellation terms.
**Do**: Explain policies depend on booking platform. Say you'll check. Action: escalate (info_request). Title: cancellation-policy-{channel}.

### Path C: Refund after cancellation
**When**: Asks about refund post-cancellation.
**Do**: Acknowledge. Action: escalate (immediate). Title: refund-after-cancellation-{unit}.
</paths>
<rules>
Always refer cancellations to the manager. Never cancel yourself. Never quote refund amounts.
</rules>
</sop>`,

  'sop-property-viewing': `<sop name="property_viewing" status="all">
<description>Guest wants to see the property — photos, video, or physical tour.</description>
<paths>
### Path A: Photos
**When**: Guest asks for photos.
**Do**: Direct to listing. Offer to highlight specific rooms. Action: reply.

### Path B: Video
**When**: Guest asks for video walkthrough.
**Do**: Say you'll check with manager. Action: escalate (info_request). Title: video-request-{unit}.

### Path C: Physical tour
**When**: Guest wants to visit the unit.
**Do**: Ask for preferred time. Action: ask. sop_step: property_viewing:path_c_awaiting_time. Once confirmed, escalate info_request. Title: tour-request-{unit}.
</paths>
<rules>
Always direct photo questions to the listing first. Never promise videos or tours without manager approval.
</rules>
</sop>`,

  'property-info': `<sop name="property_info" status="all">
<description>Guest asks factual question about the property — bedrooms, bathrooms, parking, pool, amenities, address, neighborhood.</description>
<inputs>
- property_description: {PROPERTY_DESCRIPTION}
- available_amenities: {AVAILABLE_AMENITIES}
</inputs>
<paths>
### Path A: Answer in context
**When**: Question answerable from property_description or available_amenities.
**Do**: Answer directly from context. Action: reply.

### Path B: Multiple requirements
**When**: Guest lists multiple requirements or asks what's available.
**Do**: Call search_available_properties. If this property is best match, pitch confidently. Only suggest alternatives if genuinely missing something. Action: reply.

### Path C: Not in context
**When**: Information not in property_description or available_amenities.
**Do**: Say you'll check. Action: escalate (info_request). Title: property-info-{topic}.
</paths>
<rules>
Always answer from injected context when available. Never guess features not in context.
</rules>
</sop>`,

  'local-recommendations': `<sop name="local_recommendations" status="all">
<description>Guest asks about anything outside the property — restaurants, pharmacies, ATMs, attractions, shopping.</description>
<paths>
### Path A: Defer to manager
**When**: Any local area question.
**Do**: Acknowledge warmly. Say the manager knows the area better. Action: escalate (info_request). Title: local-rec-{category}. Note: "Guest asked about: {specifics}."
</paths>
<rules>
Always defer local questions to the manager. Never suggest locations, distances, names, or prices. Never guess even when it seems obvious.
</rules>
</sop>`,

  'property-description': `<sop name="property_description" status="all">
<description>Guest asks about area vibe, neighborhood character, or general listing narrative.</description>
<inputs>
- property_description: {PROPERTY_DESCRIPTION}
</inputs>
<paths>
### Path A: Answer from description
**When**: Guest asks about vibe, neighborhood, area character.
**Do**: Answer from property_description. Action: reply.
</paths>
<rules>
Always use the property description. Never invent neighborhood details beyond what's provided.
</rules>
</sop>`,
};

// ── Status-variant overrides for SOPs whose response differs by reservation status ──

interface StatusVariant {
  status: string;
  content: string;
}

// v4: SOPs handle status branching internally via path triggers.
// Status variants point to the same content — the SOP's paths check booking_status from PRE_COMPUTED_CONTEXT.
// Only override when a status needs truly different content (e.g., empty for inapplicable statuses).
const SEED_STATUS_VARIANTS: Record<string, StatusVariant[]> = {
  'sop-amenity-request': [
    { status: 'INQUIRY', content: SEED_SOP_CONTENT['sop-amenity-request'] },
    { status: 'CONFIRMED', content: SEED_SOP_CONTENT['sop-amenity-request'] },
    { status: 'CHECKED_IN', content: SEED_SOP_CONTENT['sop-amenity-request'] },
  ],
  'sop-early-checkin': [
    { status: 'INQUIRY', content: SEED_SOP_CONTENT['sop-early-checkin'] },
    { status: 'CONFIRMED', content: SEED_SOP_CONTENT['sop-early-checkin'] },
    { status: 'CHECKED_IN', content: '' },
  ],
  'sop-late-checkout': [
    { status: 'INQUIRY', content: SEED_SOP_CONTENT['sop-late-checkout'] },
    { status: 'CONFIRMED', content: SEED_SOP_CONTENT['sop-late-checkout'] },
    { status: 'CHECKED_IN', content: SEED_SOP_CONTENT['sop-late-checkout'] },
  ],
  'sop-cleaning': [
    { status: 'INQUIRY', content: SEED_SOP_CONTENT['sop-cleaning'] },
    { status: 'CONFIRMED', content: SEED_SOP_CONTENT['sop-cleaning'] },
    { status: 'CHECKED_IN', content: SEED_SOP_CONTENT['sop-cleaning'] },
  ],
  'sop-wifi-doorcode': [
    { status: 'INQUIRY', content: SEED_SOP_CONTENT['sop-wifi-doorcode'] },
    { status: 'CONFIRMED', content: SEED_SOP_CONTENT['sop-wifi-doorcode'] },
    { status: 'CHECKED_IN', content: SEED_SOP_CONTENT['sop-wifi-doorcode'] },
  ],
  'sop-visitor-policy': [
    { status: 'INQUIRY', content: SEED_SOP_CONTENT['sop-visitor-policy'] },
    { status: 'CONFIRMED', content: SEED_SOP_CONTENT['sop-visitor-policy'] },
    { status: 'CHECKED_IN', content: SEED_SOP_CONTENT['sop-visitor-policy'] },
  ],
  'sop-booking-modification': [
    { status: 'INQUIRY', content: SEED_SOP_CONTENT['sop-booking-modification'] },
    { status: 'CONFIRMED', content: SEED_SOP_CONTENT['sop-booking-modification'] },
    { status: 'CHECKED_IN', content: SEED_SOP_CONTENT['sop-booking-modification'] },
  ],
  'pre-arrival-logistics': [
    { status: 'INQUIRY', content: '' },
    { status: 'CONFIRMED', content: SEED_SOP_CONTENT['pre-arrival-logistics'] },
    { status: 'CHECKED_IN', content: SEED_SOP_CONTENT['pre-arrival-logistics'] },
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
