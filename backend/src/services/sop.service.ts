/**
 * SOP (Standard Operating Procedure) content store and tool schema definitions.
 * Moved from classifier-data.ts as part of 013-sop-tool-routing.
 *
 * Exports:
 * - getSopContent(category, propertyAmenities?) — retrieve SOP text for a category
 * - SOP_CATEGORIES — the 22-value enum array
 * - SOP_TOOL_DEFINITION — OpenAI function-format tool schema for get_sop
 */

// ── SOP Categories (22 total: 20 operational + none + escalate) ──

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
  'property-description',
  'pre-arrival-logistics',
  'sop-property-viewing',
  'post-stay-issues',
  'none',
  'escalate',
] as const;

export type SopCategory = (typeof SOP_CATEGORIES)[number];

// ── SOP Content Map ──

const SOP_CONTENT: Record<string, string> = {
  'sop-cleaning': `Guest asks for cleaning, housekeeping, maid service, tidying up, or mopping.
Cleaning costs $20 per session. Available during working hours only (10am–5pm). Recurring cleaning is OK ($20 each session). If the guest mentions anything that the unit was not cleaned, waive and don't mention the $20 fee.`,

  'sop-amenity-request': `Guest requests towels, extra towels, pillows, blankets, baby crib, extra bed, hair dryer, blender, kids dinnerware, espresso machine, hangers, or any item/amenity.

## AVAILABLE PROPERTY AMENITIES

{PROPERTY_AMENITIES}

Check the property amenities list for available items. Only confirm items explicitly listed there.
- Item on the amenities list → confirm availability and ask for preferred delivery time during working hours (10am–5pm). Do NOT escalate yet — wait for the guest to confirm a specific time in their next message, THEN escalate as "scheduled"
- Item NOT on the list → say "Let me check on that" → escalate as "info_request"`,

  'sop-maintenance': `Guest reports something broken, not working, or needing repair — AC not cooling, no hot water, plumbing, leak, water damage, appliance broken, electricity issue, insects, bugs, pests, cockroach, mold, smell, noise from neighbors.
Broken or malfunctioning items: Acknowledge the problem, assure guest someone will look into it, and escalate immediately.
**All maintenance/technical issues → urgency: "immediate"**`,

  'sop-wifi-doorcode': `Guest asks about WiFi password, WiFi network name, internet connection, door code, entry code, lock code, how to get in, or can't open the door.
WiFi credentials and door code are in PROPERTY & GUEST INFO under ACCESS & CONNECTIVITY. Give them directly.
If there's a **problem** (WiFi not working, code not working, can't connect, locked out) → escalate immediately.`,

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

  'pre-arrival-logistics': `PRE-ARRIVAL LOGISTICS: Guest is coordinating arrival — sharing ETA, asking for directions, requesting location. Share property address and location from your knowledge. If guest asks for directions from a specific location, share what you know. For airport transfer requests, tell them unfortunately we don't provide airport transfer. If guest shares arrival time, confirm and escalate as scheduled so someone can meet them only if needed. Check-in starts at 3pm. It's self check-in and the door code is provided.`,

  'sop-booking-modification': `BOOKING MODIFICATION: Guest wants to change dates, add/remove nights, change unit, or update guest count. Acknowledge the request. NEVER confirm modifications yourself. Escalate as info_request with: current booking details, requested changes, and reason if provided. For date changes within 48 hours of check-in, escalate as immediate. For guest count changes that might affect unit assignment, note the new count clearly.`,

  'sop-booking-confirmation': `BOOKING CONFIRMATION: Guest is verifying their reservation exists, checking dates/details, or asking about booking status. Check reservation details in your knowledge and confirm what you can see — dates, unit, guest count. If the booking isn't in your system, let them know you'll check with the team. For guests claiming they booked but no record found or there is a problem, escalate as immediate.`,

  'payment-issues': `PAYMENT ISSUES: Guest has questions about payment methods, failed transactions, receipts, billing disputes, or refund status. NEVER process payments, confirm receipt of payment, or authorize refunds yourself. For payment link issues, escalate as immediate-payment-issue. For receipt requests or invoice, escalate as info_request. For billing disputes or refund requests, acknowledge and escalate as immediate with full details. For deposit return questions, escalate as info_request. And inform the guest that you have notified the manager.`,

  'post-stay-issues': `POST-STAY ISSUES: Guest has checked out and contacts about lost items, post-stay complaints, damage deposit questions, or feedback. For lost items: ask for description. Escalate as immediate as post-stay-issue so staff can check. For damage deposit questions, escalate as info_request. For post-stay complaints, acknowledge with empathy and escalate as immediate. Never promise items will be found or deposits returned.`,

  'sop-long-term-rental': `LONG-TERM RENTAL: Guest is inquiring about monthly stays, corporate housing, or stays longer than 3 weeks. Ask: duration needed, move-in date, number of guests, any preferences. Share standard nightly rate if known, but note that monthly rates are different and need manager approval. Escalate as long-term-rental with all details. Tell the guest I will inform the manager for additional discount if there are any. Never quote monthly rates yourself.`,

  'sop-booking-cancellation': `BOOKING CANCELLATION: Guest wants to cancel their reservation or is asking about cancellation policy. Acknowledge the request. NEVER cancel bookings or confirm cancellation yourself. Escalate as booking-cancellation with booking details. For cancellation policy questions, escalate as info_request — policies vary by platform (Airbnb, Booking.com, direct). For refund-after-cancellation questions, also tag with payment-issues.`,

  'sop-property-viewing': `PROPERTY VIEWING: Guest wants to see the apartment before booking, requests photos/video, or asks about filming/photoshoot permission. First recommend that the photos are available online and comprehensive of the property. If wants videos, escalate to manager, and tell the guest I'll ask the manager if there are videos to provide.`,

  'non-actionable': `NON-ACTIONABLE: Greetings, test messages, wrong chat, or questions about topics already covered by your standard procedures (house rules, working hours, scheduling, escalation rules). For greetings, respond warmly and ask how you can help. For test messages, respond briefly. For wrong-chat messages, let them know politely. For house rules or scheduling questions, answer from your standard procedures.`,
};

/**
 * Retrieve SOP content for a classification category.
 * Returns empty string for categories without static SOP content (property-info, property-description, none, escalate).
 */
export function getSopContent(category: string, propertyAmenities?: string): string {
  let content = SOP_CONTENT[category] || '';

  // Template replacement for amenity SOP
  if (category === 'sop-amenity-request' && content.includes('{PROPERTY_AMENITIES}')) {
    if (propertyAmenities) {
      const list = propertyAmenities.split(',').map(a => `• ${a.trim()}`).filter(Boolean).join('\n');
      content = content.replace('{PROPERTY_AMENITIES}', list);
    } else {
      content = content.replace('{PROPERTY_AMENITIES}', 'No amenities data available for this property.');
    }
  }

  return content;
}

// ── Tool Schema Definition ──

export const SOP_TOOL_DEFINITION: any = {
  type: 'function',
  name: 'get_sop',
  description: 'Classifies a guest message to determine which Standard Operating Procedure should guide the response. Call this for EVERY guest message. Returns the SOP category that best matches the guest\'s primary intent. For simple greetings, acknowledgments, or messages that don\'t require procedure-based responses, use "none". For messages requiring human intervention, use "escalate".',
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
          enum: SOP_CATEGORIES as unknown as string[],
        },
        minItems: 1,
        maxItems: 3,
        description: `SOP categories matching the guest's intent(s), ordered by priority. Most messages have exactly one intent.\n\n` +
          `- 'sop-cleaning': Mid-stay cleaning or housekeeping requests, $20 fee. NOT for cleanliness complaints on arrival (use sop-complaint).\n` +
          `- 'sop-amenity-request': Requesting supplies (towels, pillows, hangers) or asking what amenities are available. NOT for general property info (use property-info).\n` +
          `- 'sop-maintenance': Broken items, plumbing, HVAC, electrical, pests, mold, smell. NOT for WiFi issues (use sop-wifi-doorcode).\n` +
          `- 'sop-wifi-doorcode': WiFi password, internet issues, door codes, locked out, building access.\n` +
          `- 'sop-visitor-policy': Visitor requests, guest count verification, passport submission for visitors. NOT for guest's own documents.\n` +
          `- 'sop-early-checkin': Arriving before 3PM, early access, bag drop-off.\n` +
          `- 'sop-late-checkout': Staying past 11AM on checkout day only. NOT for extending stay by days (use sop-booking-modification).\n` +
          `- 'sop-complaint': Guest dissatisfaction, review threats, quality complaints. NOT for specific broken items (use sop-maintenance).\n` +
          `- 'sop-booking-inquiry': New booking requests, availability checks, property search.\n` +
          `- 'pricing-negotiation': Discount requests, rate questions, budget concerns.\n` +
          `- 'sop-booking-modification': Extending stay, changing dates, adding nights, changing guest count, unit swaps.\n` +
          `- 'sop-booking-confirmation': Verifying reservation exists, checking booking status/details.\n` +
          `- 'sop-booking-cancellation': Cancel requests, cancellation policy questions.\n` +
          `- 'payment-issues': Payment failures, refund requests, receipts, billing disputes.\n` +
          `- 'sop-long-term-rental': Monthly rental inquiries, corporate stays, stays over 3 weeks.\n` +
          `- 'property-info': Address, parking, directions, floor, bedrooms, check-in/out times.\n` +
          `- 'property-description': General property overview, neighborhood info, compound description.\n` +
          `- 'pre-arrival-logistics': Arrival coordination, ETA sharing, airport transfer, directions.\n` +
          `- 'sop-property-viewing': Property tours, photo/video requests, filming permission.\n` +
          `- 'post-stay-issues': Lost items after checkout, post-stay complaints, damage deposit.\n` +
          `- 'none': Simple greeting, thank you, acknowledgment, or message fully answered by system knowledge.\n` +
          `- 'escalate': Safety concern, legal issue, billing dispute requiring human, or anything needing immediate manager attention.`,
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
