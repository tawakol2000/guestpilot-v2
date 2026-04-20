/**
 * SOP Update Script — v5 → v6 (tight SOPs from guestpilot-tight.md)
 *
 * Updates ALL existing SOP definitions, variants, and tool descriptions.
 * Creates 5 new SOP categories: sop-repeat-guest, sop-arrival-eta,
 * sop-delivery-address, sop-vendor-pitch, sop-minimum-stay.
 *
 * Usage: cd backend && railway run npx ts-node scripts/update-sops-v6.ts
 *   Or locally: cd backend && npx ts-node scripts/update-sops-v6.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ═══════════════════════════════════════════════════════════════════
// Tool descriptions (classifier one-liners)
// ═══════════════════════════════════════════════════════════════════

const TOOL_DESCRIPTIONS: Record<string, string> = {
  'sop-cleaning': 'Mid-stay cleaning or housekeeping requests. NOT for cleanliness complaints on arrival (use sop-complaint).',
  'sop-amenity-request': 'Towels, pillows, hangers, hair dryer, baby crib, extra bed, blender, kettle, supplies, on-request items.',
  'sop-maintenance': 'Broken items, AC, plumbing, water, electricity, leaks, appliances, pests, mold, smell, structural noise. Not WiFi (use sop-wifi-doorcode).',
  'sop-wifi-doorcode': 'WiFi password, internet issues, door codes, building codes, lockout, building access.',
  'sop-visitor-policy': "Visitor requests, \"can my friend come over,\" guest count verification, visitor passport. Not guest's own booking documents.",
  'sop-early-checkin': 'Arriving before 3pm, early access, bag drop.',
  'sop-late-checkout': 'Staying past 11am on checkout day. Not extending stay by days (use sop-booking-modification).',
  'sop-complaint': 'Guest dissatisfaction, review threats, quality complaints, "not as advertised," cleanliness on arrival, noise, smell. Not specific broken items (use sop-maintenance).',
  'sop-booking-inquiry': 'New booking, availability, "is this available," property search.',
  'pricing-negotiation': 'Discounts, rates, "can you do better," budget, special pricing.',
  'sop-booking-modification': 'Extending stay, changing dates, adding nights, changing guest count, unit swaps.',
  'sop-booking-confirmation': 'Verifying reservation, checking dates/status, "did my booking go through."',
  'sop-booking-cancellation': 'Cancel requests, cancellation policy, refund-after-cancel.',
  'payment-issues': 'Payment failures, refunds, receipts, billing disputes, "Airbnb charged me wrong."',
  'sop-long-term-rental': 'Monthly stays, corporate housing, 3+ weeks.',
  'property-info': 'Bedrooms, bathrooms, floor, parking, pool, gym, security, neighborhood, standard amenities. Any property feature question.',
  'pre-arrival-logistics': "Arrival coordination, ETA, directions, gate entry, \"I'm at the gate,\" self check-in.",
  'sop-property-viewing': 'In-person tour before booking, photo/video requests, filming permission.',
  'post-stay-issues': 'Lost items, post-stay complaints, deposit questions, post-checkout feedback.',
  'local-recommendations': 'Nearby restaurants, malls, pharmacies, ATMs, hospitals, mosques, "where is the nearest X."',
  'property-description': 'Listing narrative, neighborhood vibe, area description, compound overview. Not specific features (use property-info).',
  'sop-repeat-guest': 'Returning guest, mentions previous stays, flagged repeat in context.',
  'sop-arrival-eta': 'ETA sharing, "what time will you arrive," arrival time coordination.',
  'sop-delivery-address': 'Talabat, Glovo, Uber Eats, delivery driver address questions.',
  'sop-vendor-pitch': 'Unsolicited service pitch (photographer, marketer, supplier), not a guest booking.',
  'sop-minimum-stay': 'Booking inquiry below 2-night minimum.',
  'none': 'Simple greeting, thank you, acknowledgment, or message fully answered by system knowledge.',
  'escalate': 'Safety, fire, gas, flood, medical, break-in, or anything needing immediate human action.',
};

// ═══════════════════════════════════════════════════════════════════
// DEFAULT variant content
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_CONTENT: Record<string, string> = {
  'escalate': `Acknowledge with empathy, do not advise beyond safety basics. Escalate immediate.
Fire/gas: leave apartment, call 122. Medical: call 123. Break-in: call 122.`,

  'none': '',

  'local-recommendations': `No local knowledge. Don't guess. Acknowledge → escalate info_request with the specific request.
O1 Mall is 1-min walk (only safe local fact).
Energy lockdown affects commercial buildings only (~9pm weekdays / 10pm weekends), not residential.`,

  'payment-issues': `Airbnb/Booking.com bookings → payment handled by platform, not us. Direct guest to platform support, escalate info_request.
Direct bookings (boutiqueresidence.holidayfuture.com) → escalate immediate-payment-issue.
Receipts/invoices → escalate info_request.
Never process payments, confirm receipt, or authorize refunds.`,

  'post-stay-issues': `Lost items: ask description (item, location) → escalate immediate "post-stay-lost-item."
Deposit questions → escalate info_request, don't promise amounts/timing.
Complaints → empathy, escalate immediate with details.
Feedback → thank, escalate info_request.
Never promise items found or deposits returned.`,

  'pre-arrival-logistics': `Standard info (always safe): Silver Palm, behind O1 Mall, New Cairo. Maps: https://maps.app.goo.gl/5fouptzcvA9svfa7A. Self check-in. At gate share apartment number, building number, booking names with security.
No ETA on file → ask. Has ETA → confirm self check-in, share standard info if needed.
Before 3pm → use sop-early-checkin. Guest at gate held by security → escalate immediate "guest-at-gate."
Building/floor/apt/codes/network/staff names must come from context. Not in context → escalate.`,

  'pricing-negotiation': `14+ nights → escalate info_request "discount-eligible."
21+ nights → also tag sop-long-term-rental.
Repeat guest → escalate flagged "repeat-guest-discount."
<14 nights → decline: "Unfortunately we only offer discounts for stays longer than 2 weeks."
Pushback → "This is one of our best units and I can't discount it further. We have other options at different price points if you'd like." Then call search_available_properties if interested.
Never quote a discount yourself. Be firm, don't apologize for the rate.`,

  'property-description': `Answer from {PROPERTY_DESCRIPTION}, 2-3 sentences max. Don't invent features.
Area: Silver Palm gated compound, New Cairo, behind O1 Mall. Cafés, shops, malls within walking distance. Tagamo3 / 5th Settlement area, near Garden 8 and Waterway.

{PROPERTY_DESCRIPTION}`,

  'property-info': `Check {PROPERTY_DESCRIPTION} and {AVAILABLE_AMENITIES}. Answer if in context.
Multiple requirements or "what's available" → call search_available_properties.
Feature not in context → "Let me check on that" → escalate info_request. Don't guess.
Pool varies by unit: pool-front = direct access, others = via backyard exception, shared, not heated, ~120cm. Check amenities first.
Never invent building/floor/apartment number.

{PROPERTY_DESCRIPTION}
{AVAILABLE_AMENITIES}`,

  'sop-amenity-request': `Many items already in unit — check before promising delivery. Detergent: under kitchen sink. Iron/ironing board: closet. Drying rack: bathroom (pull-out). Extra TP: under sink. Hair dryer: bathroom or bedroom drawer.
Item on {ON_REQUEST_AMENITIES} → confirm → ask preferred time 10am–5pm → wait for time → escalate "scheduled."
Item not listed → "Let me check on that" → escalate info_request.
After 5pm → arrange for tomorrow's window.

{ON_REQUEST_AMENITIES}`,

  'sop-booking-cancellation': `"Please submit a cancellation request through Airbnb / Booking.com."
Acknowledge reason without judgment. Escalate "booking-cancellation."
Policy questions → don't quote terms, direct to platform, escalate info_request.
Refund-after-cancel → tag payment-issues.
Never cancel or confirm cancellation yourself.`,

  'sop-booking-confirmation': `Confirm what's in reservation context (dates, unit, guest count).
Not in context → "Let me check with the team" → escalate info_request.
Guest claims booking but no record → escalate immediate.
Repeat guest mention ("stayed before") → "Great to have you back!", skip basic intro, still verify nationality + composition.`,

  'sop-booking-inquiry': `Gather: dates, guest count, preferences. Multiple requirements / open to options → call search_available_properties.
Search returned booking links → include verbatim. No links → list properties by name, escalate for manager. Never promise links you don't have.
Same-day → escalate immediate. Future → escalate info_request.
Minimum 2 nights. Below minimum → decline, offer 2-night alternative.
Never confirm a booking yourself.`,

  'sop-booking-modification': `"Please submit an alteration request through Airbnb / Booking.com — once you do, I'll review it."
Escalate info_request with current booking + requested change.
Within 48h of check-in → escalate immediate.
Guest count change → flag "requires re-screening of new person" if nationality unknown.
Never confirm modifications yourself.`,

  'sop-cleaning': `Cleaning: $20/session, $30 with linens, 10am–5pm. Recurring OK.
Flow: confirm price → ask time within window → wait for time → escalate "scheduled" with time, price, linens flag.
After 5pm → arrange for tomorrow's window.
"Unit wasn't cleaned" / dirty on arrival = complaint, not cleaning. Waive $20, escalate immediate via sop-complaint.`,

  'sop-complaint': `Acknowledge once with empathy, never cheerfully, never defensive. Escalate immediate.
Cleanliness on arrival → offer immediate cleaning, waive $20, escalate immediate.
Noise → escalate immediate (usually external — mall/compound construction — not neighbors).
Review threats / "speak to manager" → escalate immediate.
Quality / not-as-advertised → escalate immediate with details.
Vague dissatisfaction → ask for specifics → escalate immediate.
Never offer refunds, discounts, or compensation.
Phrase: "I'm sorry to hear that — I'm flagging this with the manager right away and someone will be in touch shortly."`,

  'sop-early-checkin': `Standard 3pm. Back-to-back = early check-in confirmed only 2 days before.
>2 days out: "We can only confirm early check-in 2 days before your date. O1 Mall is 1 min walk if you arrive early — we'll let you know as soon as the apartment is ready." Don't escalate.
≤2 days out: check {AVAILABILITY_CHECK_RESULT}. Back-to-back detected → tell guest not available, suggest O1 cafés. No back-to-back → "Let me check with the manager" → escalate info_request.
Never confirm yourself.`,

  'sop-late-checkout': `Standard 11am. Free 12pm extension usually OK as goodwill.
Tiers: 11–1pm $25, 1–6pm $65, after 6pm $120.
Back-to-back = late checkout confirmed only 2 days before.
>2 days out: quote tiers + 2-day rule, don't escalate.
≤2 days out: quote tiers, ask preferred time, wait → escalate info_request with time + fee.
Free 12pm ask → still escalate, flag "free 12pm extension."
Never confirm yourself.`,

  'sop-long-term-rental': `Gather: duration, move-in date, guest count, preferences.
"Monthly rates differ from nightly and need manager approval. I'll let the manager know — he handles long-term pricing."
Escalate "long-term-rental" with details. Never quote monthly rates.
Manager often steers to direct booking site for better rates — don't share URL, flag "direct-booking-referral-recommended."
Corporate stays may need employer letter / multiple passports — don't collect, escalate.`,

  'sop-maintenance': `Acknowledge once, escalate immediate.
Livability (AC, water, hot water, electricity, leaks, pests) → immediate.
Cosmetic (scratches, marks) → scheduled.
Power outages = recurring local issue in this compound, not unit fault. "Sorry about that — there can be local power issues in the area. I'm checking with the manager now." Escalate immediate, don't panic.
Noise = usually external (mall, compound construction, downstairs reno). Don't assume neighbors. Escalate immediate, don't promise night-time fixes.
Appliance failure (Nespresso, kettle, blender, hair dryer) → manager often swaps from warehouse. "I'll check with the manager about a replacement."
Never promise repair times, never offer compensation, never apologize twice.`,

  'sop-property-viewing': `Viewings usually possible if unit is empty and guest is in/near Cairo.
Ask: "Where are you currently? When would you like to come?"
Guest at/near compound (≤30 min) → escalate immediate "viewing-request-now" with location/ETA.
Guest far / future day → escalate "viewing-request-scheduled" with proposed time.
Mention escorted viewing, identify at gate.
Video requests → escalate info_request.
Filming/photoshoot → escalate info_request, needs approval.
Never name specific staff, never promise specific times yourself, never push photos online if guest wants in-person.`,

  'sop-visitor-policy': `Family-only. Only immediate family (parent, sibling, spouse on booking, child, grandparent, grandchild) allowed as visitors. Last names must match.
Family visitor request → confirm relationship + matching last names → ask for visitor passport via chat → received → escalate immediate with image.
Non-family request → decline, cite house rules. Don't say "let me check" — firm rule. Phrase: "Only immediate family members are allowed as visitors at this property."
Pushback → escalate immediate, don't argue.
If guest is asking about their OWN booking docs (not a visitor) → escalate info_request, this SOP doesn't apply.`,

  'sop-wifi-doorcode': '',

  'sop-repeat-guest': `"Great to have you back!" Skip basic property intro. Still verify nationality + composition.
Discount eligible even on stays <14 nights → escalate info_request "repeat-guest-discount."
Direct booking referral often offered — don't share URL, flag "direct-booking-referral."`,

  'sop-arrival-eta': `No ETA on file → ask: "What time are you expecting to arrive?"
Has ETA: confirm self check-in (works 24/7 once codes shared). At gate share apt number, building, booking names with security.
Before 3pm → use sop-early-checkin.
Don't escalate routine ETAs. Don't promise staff at arrival.`,

  'sop-delivery-address': `Format: "Silver Palm Compound, Building <X>, Apartment <Y>, New Cairo." Substitute from context.
"The driver will call you when they're at the gate, security will direct them."
No building/apt in context → escalate.
Never share door code with drivers, never promise staff collect deliveries.`,

  'sop-vendor-pitch': `"Thank you, we don't need this at the moment." Don't escalate. Set escalation null.`,

  'sop-minimum-stay': `"Our minimum stay is 2 nights. If you can extend, I'd be happy to check availability."
Don't escalate unless guest asks for exception → then info_request.`,
};

// ═══════════════════════════════════════════════════════════════════
// Status-specific variants (only where content differs from DEFAULT)
// ═══════════════════════════════════════════════════════════════════

interface VariantUpdate {
  status: string;
  content: string;
}

const STATUS_VARIANTS: Record<string, VariantUpdate[]> = {
  'sop-amenity-request': [
    { status: 'INQUIRY', content: `Confirm what's in {ON_REQUEST_AMENITIES} and {AVAILABLE_AMENITIES}. Reassure ready for arrival. Don't schedule.\n\n{ON_REQUEST_AMENITIES}` },
    { status: 'CONFIRMED', content: `Confirm what's in {ON_REQUEST_AMENITIES} and {AVAILABLE_AMENITIES}. Reassure ready for arrival. Don't schedule.\n\n{ON_REQUEST_AMENITIES}` },
    { status: 'CHECKED_IN', content: DEFAULT_CONTENT['sop-amenity-request'] },
  ],
  'sop-early-checkin': [
    { status: 'INQUIRY', content: `Standard 3pm. Early check-in depends on prior bookings, confirmed 2 days before.` },
    { status: 'CONFIRMED', content: `Standard 3pm. Back-to-back = early check-in confirmed only 2 days before.\n>2 days out: "We can only confirm early check-in 2 days before your date. O1 Mall is 1 min walk if you arrive early — we'll let you know as soon as the apartment is ready." Don't escalate.\n≤2 days out: check {AVAILABILITY_CHECK_RESULT}. Back-to-back detected → tell guest not available, suggest O1 cafés. No back-to-back → "Let me check with the manager" → escalate info_request.\nNever confirm yourself.` },
    { status: 'CHECKED_IN', content: '' },
  ],
  'sop-late-checkout': [
    { status: 'INQUIRY', content: `Standard 11am. Quote tiers ($25 / $65 / $120) + 2-day rule.` },
    { status: 'CONFIRMED', content: `Standard 11am. Quote tiers ($25 / $65 / $120) + 2-day rule.` },
    { status: 'CHECKED_IN', content: DEFAULT_CONTENT['sop-late-checkout'] },
  ],
  'sop-cleaning': [
    { status: 'INQUIRY', content: `Confirm prices ($20 / $30, 10am–5pm) and availability. Don't schedule — not checked in yet.` },
    { status: 'CONFIRMED', content: `Confirm prices ($20 / $30, 10am–5pm) and availability. Don't schedule — not checked in yet.` },
    { status: 'CHECKED_IN', content: DEFAULT_CONTENT['sop-cleaning'] },
  ],
  'sop-wifi-doorcode': [
    { status: 'INQUIRY', content: `WiFi available. Access details provided after check-in is arranged. Don't share codes.` },
    { status: 'CONFIRMED', content: `{ACCESS_CONNECTIVITY}\nConfirm WiFi available, self check-in. Codes/network/password sent in pre-arrival message before check-in day.\nNeed codes urgently and pre-arrival not yet sent → escalate info_request.\nDoor code issue → escalate immediate.` },
    { status: 'CHECKED_IN', content: `{ACCESS_CONNECTIVITY}\nWiFi not working → re-share creds from context → still failing → escalate immediate.\nDoor code issue / lockout → apologize, escalate immediate.\nStandard: WiFi password BR@12345678 (most units), network usually "BR <unit number>" (some non-BR like "ARAY Maison"). Door codes 7-digit + #. Building codes 4-digit + #.\nNever guess or partially reconstruct codes — not in context = escalate.` },
  ],
  'sop-visitor-policy': [
    { status: 'INQUIRY', content: `Family-only. Only immediate family allowed as visitors. Non-family not permitted at any time.` },
    { status: 'CONFIRMED', content: DEFAULT_CONTENT['sop-visitor-policy'] },
    { status: 'CHECKED_IN', content: DEFAULT_CONTENT['sop-visitor-policy'] },
  ],
  'sop-booking-modification': [
    { status: 'INQUIRY', content: `"Please submit an alteration request" → escalate to manager with new details.` },
    { status: 'CONFIRMED', content: DEFAULT_CONTENT['sop-booking-modification'] },
    { status: 'CHECKED_IN', content: `Call check_extend_availability for new checkout date.\nAvailable → "The property is free for those dates. Please submit an alteration request and I'll get it confirmed." Escalate.\nExtension + discount ask + 14+ total nights → tag pricing-negotiation, flag "discount-with-extension."` },
  ],
  'pre-arrival-logistics': [
    { status: 'INQUIRY', content: '' },
    { status: 'CONFIRMED', content: DEFAULT_CONTENT['pre-arrival-logistics'] },
    { status: 'CHECKED_IN', content: DEFAULT_CONTENT['pre-arrival-logistics'] },
  ],
  'sop-arrival-eta': [
    { status: 'CONFIRMED', content: DEFAULT_CONTENT['sop-arrival-eta'] },
    { status: 'CHECKED_IN', content: DEFAULT_CONTENT['sop-arrival-eta'] },
  ],
};

// ═══════════════════════════════════════════════════════════════════
// Main migration
// ═══════════════════════════════════════════════════════════════════

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log(' SOP Update: v5 → v6 (tight SOPs)');
  console.log('═══════════════════════════════════════════════════\n');

  const tenants = await prisma.tenant.findMany({ select: { id: true, email: true } });
  console.log(`Found ${tenants.length} tenant(s)\n`);

  for (const tenant of tenants) {
    console.log(`\n── Tenant: ${tenant.email} (${tenant.id}) ──\n`);

    let created = 0;
    let updated = 0;

    const allCategories = Object.keys(TOOL_DESCRIPTIONS);

    for (const category of allCategories) {
      const toolDescription = TOOL_DESCRIPTIONS[category] || '';
      const defaultContent = DEFAULT_CONTENT[category] ?? '';

      // Upsert SopDefinition (create if new, update toolDescription)
      const sopDef = await prisma.sopDefinition.upsert({
        where: { tenantId_category: { tenantId: tenant.id, category } },
        create: {
          tenantId: tenant.id,
          category,
          toolDescription,
          enabled: true,
        },
        update: {
          toolDescription,
        },
      });

      // Check if this is a newly created definition
      const isNew = !await prisma.sopVariant.findUnique({
        where: { sopDefinitionId_status: { sopDefinitionId: sopDef.id, status: 'DEFAULT' } },
      });

      // Upsert DEFAULT variant
      await prisma.sopVariant.upsert({
        where: { sopDefinitionId_status: { sopDefinitionId: sopDef.id, status: 'DEFAULT' } },
        create: {
          sopDefinitionId: sopDef.id,
          status: 'DEFAULT',
          content: defaultContent,
          enabled: true,
        },
        update: {
          content: defaultContent,
        },
      });

      // Upsert status-specific variants
      const variants = STATUS_VARIANTS[category];
      if (variants) {
        for (const v of variants) {
          await prisma.sopVariant.upsert({
            where: { sopDefinitionId_status: { sopDefinitionId: sopDef.id, status: v.status } },
            create: {
              sopDefinitionId: sopDef.id,
              status: v.status,
              content: v.content,
              enabled: true,
            },
            update: {
              content: v.content,
            },
          });
        }
      }

      if (isNew) {
        console.log(`  ✚ CREATED: ${category}`);
        created++;
      } else {
        console.log(`  ✔ UPDATED: ${category}`);
        updated++;
      }
    }

    console.log(`\n  Summary: ${created} created, ${updated} updated, ${allCategories.length} total`);
  }

  console.log('\n═══════════════════════════════════════════════════');
  console.log(' Done!');
  console.log('═══════════════════════════════════════════════════');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
