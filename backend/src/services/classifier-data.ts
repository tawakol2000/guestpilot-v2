/**
 * Classifier training data and SOP content.
 * Ported from run_embedding_eval_v2.py (v7, 99/100 score).
 *
 * DO NOT EDIT training examples without re-running the eval script.
 * Each example is a guest message paired with the chunk IDs that should be retrieved.
 */

// Chunks baked into system prompt (never retrieved by classifier)
export const BAKED_IN_CHUNKS = new Set([
  'sop-scheduling',
  'sop-house-rules',
  'sop-escalation-immediate',
  'sop-escalation-scheduled',
]);

// Token costs for RAG-retrieved chunks
export const CHUNK_TOKENS: Record<string, number> = {
  'sop-cleaning': 195,
  'sop-amenity-request': 155,
  'sop-maintenance': 250,
  'sop-wifi-doorcode': 140,
  'sop-visitor-policy': 170,
  'sop-early-checkin': 220,
  'sop-late-checkout': 140,
  'sop-escalation-info': 160,
  'property-info': 120,
  'property-description': 185,
  'property-amenities': 175,
};

export const TOKEN_BUDGET = 500;

// Training examples — 164 total (159 base + 5 self-improvement)
export interface TrainingExample {
  text: string;
  labels: string[];
}

export const TRAINING_EXAMPLES: TrainingExample[] = [
  // ── CLEANING (9) ──
  { text: 'Can we get cleaning today?', labels: ['sop-cleaning'] },
  { text: 'I need housekeeping', labels: ['sop-cleaning'] },
  { text: 'Can someone clean the apartment?', labels: ['sop-cleaning'] },
  { text: 'How much does cleaning cost?', labels: ['sop-cleaning'] },
  { text: 'I need extra cleaning', labels: ['sop-cleaning'] },
  { text: 'Can you send someone to clean every other day?', labels: ['sop-cleaning'] },
  { text: 'Can someone mop tomorrow morning?', labels: ['sop-cleaning'] },
  { text: 'The place is filthy I want it cleaned NOW', labels: ['sop-cleaning'] },
  { text: 'تنظيف الشقة', labels: ['sop-cleaning'] },

  // ── AMENITY (13) ──
  { text: 'I need a pillow', labels: ['sop-amenity-request', 'property-amenities'] },
  { text: 'Do you have a baby crib?', labels: ['sop-amenity-request', 'property-amenities'] },
  { text: 'Can I get extra towels?', labels: ['sop-amenity-request', 'property-amenities'] },
  { text: 'Is there a blender?', labels: ['sop-amenity-request', 'property-amenities'] },
  { text: 'Do you have a phone charger?', labels: ['sop-amenity-request', 'property-amenities'] },
  { text: 'We need more blankets', labels: ['sop-amenity-request', 'property-amenities'] },
  { text: 'Is there an iron?', labels: ['sop-amenity-request', 'property-amenities'] },
  { text: 'Can I get hangers?', labels: ['sop-amenity-request', 'property-amenities'] },
  { text: 'Do you have kids plates and cups?', labels: ['sop-amenity-request', 'property-amenities'] },
  { text: 'What amenities does this apartment have?', labels: ['property-amenities'] },
  { text: "What's available in the apartment?", labels: ['property-amenities'] },
  { text: 'محتاج مخدة', labels: ['sop-amenity-request', 'property-amenities'] },
  { text: 'محتاج فوط', labels: ['sop-amenity-request', 'property-amenities'] },

  // ── MAINTENANCE (37) ──
  { text: "The TV remote isn't working", labels: ['sop-maintenance'] },
  { text: 'Something is broken in the apartment', labels: ['sop-maintenance'] },
  { text: "The washing machine won't spin", labels: ['sop-maintenance'] },
  { text: "Fridge isn't cooling", labels: ['sop-maintenance'] },
  { text: "The oven doesn't turn on", labels: ['sop-maintenance'] },
  { text: 'The shower head is broken', labels: ['sop-maintenance'] },
  { text: 'The door is stuck', labels: ['sop-maintenance'] },
  { text: 'The toilet is clogged', labels: ['sop-maintenance'] },
  { text: 'The toilet is clogged and overflowing please help immediately', labels: ['sop-maintenance'] },
  { text: 'There is no hair dryer in the property', labels: ['sop-maintenance', 'property-amenities'] },
  { text: 'The hair dryer is missing', labels: ['sop-maintenance', 'property-amenities'] },
  { text: "There's supposed to be an iron but it's not here", labels: ['sop-maintenance', 'property-amenities'] },
  { text: "There's no hot water", labels: ['sop-maintenance'] },
  { text: 'There is a leak under the sink', labels: ['sop-maintenance'] },
  { text: 'Water is dripping from the ceiling', labels: ['sop-maintenance'] },
  { text: 'Water is dripping from the ceiling in the bathroom', labels: ['sop-maintenance'] },
  { text: 'The water pressure is very low', labels: ['sop-maintenance'] },
  { text: "The AC isn't cooling", labels: ['sop-maintenance'] },
  { text: 'How do I turn on the heating?', labels: ['sop-maintenance'] },
  { text: 'AC is making a loud noise', labels: ['sop-maintenance'] },
  { text: "It's too hot the air conditioning doesn't work", labels: ['sop-maintenance'] },
  { text: "The AC isn't cooling at all it's 40 degrees outside", labels: ['sop-maintenance'] },
  { text: 'There are insects in the apartment', labels: ['sop-maintenance'] },
  { text: 'I found cockroaches in the kitchen', labels: ['sop-maintenance'] },
  { text: 'I found cockroaches in the kitchen this is disgusting', labels: ['sop-maintenance'] },
  { text: 'There are ants everywhere', labels: ['sop-maintenance'] },
  { text: 'There are ants everywhere near the sugar', labels: ['sop-maintenance'] },
  { text: 'حشرات في الشقة', labels: ['sop-maintenance'] },
  { text: 'في حشرات في الشقة محتاج حد يجي يشوف', labels: ['sop-maintenance'] },
  { text: 'The lights keep flickering', labels: ['sop-maintenance'] },
  { text: 'Power went out in the apartment', labels: ['sop-maintenance'] },
  { text: 'Power went out in the whole apartment', labels: ['sop-maintenance'] },
  { text: "The outlets don't work", labels: ['sop-maintenance'] },
  { text: "None of the outlets in the living room work", labels: ['sop-maintenance'] },
  { text: "There's a bad smell from the drain", labels: ['sop-maintenance'] },
  { text: "There's a terrible smell coming from the bathroom drain", labels: ['sop-maintenance'] },
  { text: 'I noticed mold on the wall', labels: ['sop-maintenance'] },
  { text: 'I noticed some mold on the wall behind the bed', labels: ['sop-maintenance'] },

  // ── WIFI credentials (3) ──
  { text: "What's the WiFi password?", labels: ['sop-wifi-doorcode', 'property-info'] },
  { text: "What's the wifi name?", labels: ['sop-wifi-doorcode', 'property-info'] },
  { text: 'How do I connect to the internet?', labels: ['sop-wifi-doorcode', 'property-info'] },

  // ── WIFI problems (5) ──
  { text: 'Internet is super slow', labels: ['sop-wifi-doorcode', 'sop-maintenance'] },
  { text: 'The wifi keeps disconnecting', labels: ['sop-wifi-doorcode', 'sop-maintenance'] },
  { text: 'The wifi keeps disconnecting every few minutes', labels: ['sop-wifi-doorcode', 'sop-maintenance'] },
  { text: "Can't connect to wifi wrong password", labels: ['sop-wifi-doorcode', 'sop-maintenance'] },
  { text: "I can't connect to the wifi at all it says wrong password", labels: ['sop-wifi-doorcode', 'sop-maintenance'] },

  // ── DOOR (3) ──
  { text: "What's the door code?", labels: ['sop-wifi-doorcode', 'property-info'] },
  { text: 'How do I get into the building?', labels: ['sop-wifi-doorcode', 'property-info'] },
  { text: "The door code isn't working I'm locked out", labels: ['sop-wifi-doorcode', 'sop-maintenance'] },

  // ── HOUSE RULES → contextual (5) ──
  { text: 'Can I smoke on the balcony?', labels: [] },
  { text: 'Is there a quiet hours policy?', labels: [] },
  { text: 'What are the house rules?', labels: [] },
  { text: 'We want to have a small birthday gathering', labels: [] },
  { text: 'Can we have a party?', labels: [] },

  // ── VISITOR (11) ──
  { text: 'Can I have a friend over?', labels: ['sop-visitor-policy'] },
  { text: 'My colleague needs to drop something off', labels: ['sop-visitor-policy'] },
  { text: 'Can a friend visit for dinner?', labels: ['sop-visitor-policy'] },
  { text: 'My colleague needs to drop something off can they come up?', labels: ['sop-visitor-policy'] },
  { text: 'My sister wants to visit for dinner', labels: ['sop-visitor-policy'] },
  { text: 'My sister wants to come visit for dinner is that allowed?', labels: ['sop-visitor-policy'] },
  { text: 'Can my brother stay with us?', labels: ['sop-visitor-policy'] },
  { text: 'Can my brother stay with us? He just arrived in Cairo', labels: ['sop-visitor-policy'] },
  { text: 'My family member is coming to visit', labels: ['sop-visitor-policy'] },
  { text: "That's unfair it's just one friend for an hour", labels: ['sop-visitor-policy'] },
  { text: 'ممكن حد يزورني', labels: ['sop-visitor-policy'] },

  // ── CHECK-IN (8) ──
  { text: 'Can I check in early?', labels: ['sop-early-checkin'] },
  { text: 'Can do an early check in', labels: ['sop-early-checkin'] },
  { text: 'Our flight lands at 8am can we come early?', labels: ['sop-early-checkin'] },
  { text: 'Our flight lands at 8am is there any way we can check in early?', labels: ['sop-early-checkin'] },
  { text: 'Can I drop my bags before check-in?', labels: ['sop-early-checkin'] },
  { text: 'Can I drop my bags before check-in time?', labels: ['sop-early-checkin'] },
  { text: 'What time is check in?', labels: ['sop-early-checkin', 'property-info'] },
  { text: 'When can I arrive?', labels: ['sop-early-checkin', 'property-info'] },

  // ── CHECKOUT (6) ──
  { text: 'Can I do a late check out?', labels: ['sop-late-checkout'] },
  { text: 'Is it possible to stay until 3pm?', labels: ['sop-late-checkout'] },
  { text: 'Is it possible to stay until 3pm on my last day?', labels: ['sop-late-checkout'] },
  { text: 'What time do we need to leave?', labels: ['sop-late-checkout', 'property-info'] },
  { text: 'When is checkout?', labels: ['sop-late-checkout', 'property-info'] },
  { text: 'Can we extend our stay by 2 more nights?', labels: ['sop-late-checkout', 'sop-escalation-info'] },

  // ── PROPERTY (8) ──
  { text: 'What floor is the apartment?', labels: ['property-info', 'property-description'] },
  { text: 'What floor is the apartment', labels: ['property-info', 'property-description'] },
  { text: 'How many bedrooms are there?', labels: ['property-info'] },
  { text: "Where is the apartment? What's the address?", labels: ['property-info'] },
  { text: "Where exactly is the apartment? What's the address?", labels: ['property-info'] },
  { text: 'Is there parking available?', labels: ['property-description', 'property-amenities'] },
  { text: 'Is there a pool we can use?', labels: ['property-description', 'property-amenities'] },
  { text: 'Is there a gym?', labels: ['property-description', 'property-amenities'] },

  // ── SCHEDULING → contextual (5) ──
  { text: 'What are the working hours?', labels: [] },
  { text: 'What are the working hours for maintenance?', labels: [] },
  { text: 'Can someone come at 2pm?', labels: [] },
  { text: 'Is it possible to arrange something for tomorrow?', labels: [] },
  { text: 'Is it possible to arrange something for tomorrow morning?', labels: [] },

  // ── ESCALATION INFO (10) ──
  { text: 'Can you recommend a restaurant nearby?', labels: ['sop-escalation-info'] },
  { text: 'Can you recommend a good restaurant nearby?', labels: ['sop-escalation-info'] },
  { text: "What's there to do around here?", labels: ['sop-escalation-info'] },
  { text: "Where's the nearest pharmacy?", labels: ['sop-escalation-info'] },
  { text: 'How do I get to the airport?', labels: ['sop-escalation-info'] },
  { text: 'How do I get to the airport from here?', labels: ['sop-escalation-info'] },
  { text: 'I want a refund', labels: ['sop-escalation-info'] },
  { text: 'I want a refund. This is not what was advertised.', labels: ['sop-escalation-info'] },
  { text: 'I want a discount for the problems', labels: ['sop-escalation-info'] },
  { text: "I want a discount for all the problems we've had", labels: ['sop-escalation-info'] },

  // ── ESCALATION IMMEDIATE → contextual (10) ──
  { text: 'I want to speak to a manager', labels: [] },
  { text: 'I want to speak to a manager right now', labels: [] },
  { text: "I'm going to leave a terrible review", labels: [] },
  { text: "I'm going to leave a terrible review if this isn't fixed today", labels: [] },
  { text: 'This is unacceptable nobody is helping', labels: [] },
  { text: 'This is unacceptable. Nothing works in this apartment and nobody is helping.', labels: [] },
  { text: 'I smell gas in the apartment!', labels: [] },
  { text: 'I smell gas in the apartment!!!', labels: [] },
  { text: 'Someone is trying to get into our apartment', labels: [] },
  { text: "Someone is trying to get into our apartment, we're scared", labels: [] },

  // ── EMERGENCY (2) ──
  { text: 'Water flooding from bathroom into hallway', labels: ['sop-maintenance'] },
  { text: "There's water flooding from the bathroom into the hallway", labels: ['sop-maintenance'] },

  // ── NOISE → contextual (4) ──
  { text: "The neighbors are so loud we can't sleep", labels: [] },
  { text: "The neighbors upstairs are so loud we can't sleep", labels: [] },
  { text: 'Construction noise starting at 7am every day', labels: [] },
  { text: "There's construction noise starting at 7am every day, is this normal?", labels: [] },

  // ── CONTEXTUAL (19) ──
  { text: 'Ok thanks', labels: [] },
  { text: 'Yes', labels: [] },
  { text: "No that's fine", labels: [] },
  { text: 'Great see you then', labels: [] },
  { text: 'Great, see you then', labels: [] },
  { text: 'Got it', labels: [] },
  { text: 'Got it 👍', labels: [] },
  { text: 'Alright', labels: [] },
  { text: 'Tomorrow works', labels: [] },
  { text: 'That would be great thank you', labels: [] },
  { text: 'That would be great thank you so much', labels: [] },
  { text: '5am', labels: [] },
  { text: 'Sure', labels: [] },
  { text: 'When will you bring it', labels: [] },
  { text: 'When will u bring it', labels: [] },
  { text: 'اه', labels: [] },
  { text: 'ok 👍', labels: [] },
  { text: 'شكرا', labels: [] },
  { text: 'تمام', labels: [] },

  // ── SELF-IMPROVEMENT EXAMPLES (5) — added from v7 failures ──
  { text: "What time is check in?", labels: ['sop-early-checkin', 'property-info'] },
  { text: "What time do we need to leave?", labels: ['sop-late-checkout', 'property-info'] },
  { text: "When is checkout?", labels: ['sop-late-checkout', 'property-info'] },
  { text: "What's the WiFi password?", labels: ['sop-wifi-doorcode', 'property-info'] },
  { text: "How do I connect to the internet?", labels: ['sop-wifi-doorcode', 'property-info'] },
];

// SOP content map — the actual text injected into the prompt when a chunk ID is selected.
// These mirror the SOP_CHUNKS in rag.service.ts but are used by the classifier for direct lookup.
export const SOP_CONTENT: Record<string, string> = {
  'sop-cleaning': `Guest asks for cleaning, housekeeping, maid service, tidying up, or mopping.

## CLEANING REQUESTS

Cleaning costs $20 per session. Available during working hours only (10am–5pm). Recurring cleaning is OK ($20 each session).

**Flow:**
1. Ask guest for preferred time (between 10am–5pm)
2. Guest confirms time → mention the $20 fee
3. Escalate as "scheduled" with time and fee confirmed

Mention the fee on confirmation, NOT on the first ask.

**After hours (after 5 PM):** Arrange for tomorrow. Ask for preferred time between 10am–5pm.`,

  'sop-amenity-request': `Guest requests towels, extra towels, pillows, blankets, baby crib, extra bed, hair dryer, blender, kids dinnerware, espresso machine, hangers, or any item/amenity.

## AMENITY REQUESTS

Check the property amenities list for available items. Only confirm items explicitly listed there.
- Item on the amenities list → confirm availability, ask for delivery time during working hours (10am–5pm), then escalate as "scheduled"
- Item NOT on the list → say "Let me check on that" → escalate as "info_request"`,

  'sop-maintenance': `Guest reports something broken, not working, or needing repair — AC not cooling, no hot water, plumbing, leak, water damage, appliance broken, electricity issue.

## MAINTENANCE & TECHNICAL ISSUES

Broken or malfunctioning items: Acknowledge the problem, assure guest someone will look into it, and escalate immediately.

**All maintenance/technical issues → urgency: "immediate"**`,

  'sop-wifi-doorcode': `Guest asks about WiFi password, WiFi network name, internet connection, door code, entry code, lock code, how to get in, or can't open the door.

## WIFI & DOOR CODE

WiFi credentials and door code are in PROPERTY & GUEST INFO under ACCESS & CONNECTIVITY. Give them directly.

If there's a **problem** (WiFi not working, code not working, can't connect, locked out) → escalate immediately.`,

  'sop-visitor-policy': `Guest wants to invite someone over, have a friend visit, bring a visitor, asks about visitor rules, or asks if someone can come to the apartment.

## VISITOR POLICY

- ONLY immediate family members allowed as visitors
- Guest must send visitor's passport through the chat
- Family names must match guest's family name
- Collect passport image → escalate for manager verification
- Non-family visitors (friends, colleagues, etc.) = NOT allowed`,

  'sop-early-checkin': `Guest asks for early check-in, arriving early, wants to check in before 3pm, or asks if they can come earlier.

## EARLY CHECK-IN

Standard check-in: 3:00 PM. Back-to-back bookings mean early check-in can only be confirmed 2 days before.

**More than 2 days before check-in:** Do NOT escalate. Tell guest:
"We can only confirm early check-in 2 days before your date since there may be guests checking out. You're welcome to leave your bags with housekeeping and grab coffee at O1 Mall — it's a 1-minute walk."

**Within 2 days of check-in:** Tell guest you'll check → escalate as "info_request"

**Never confirm early check-in yourself.**`,

  'sop-late-checkout': `Guest asks for late checkout, wants to leave later, stay longer on checkout day, check out after 11am, or extend their stay on the last day.

## LATE CHECKOUT

Standard check-out: 11:00 AM. Back-to-back bookings mean late checkout can only be confirmed 2 days before.

**More than 2 days before checkout:** Do NOT escalate. Tell guest the same 2-day rule.

**Within 2 days of checkout:** Tell guest you'll check → escalate as "info_request"

**Never confirm late checkout yourself.**`,

  'sop-escalation-info': `Guest asks something you can't answer — local recommendations, restaurants, pricing, discounts, refunds, reservation changes, or availability.

## ESCALATION — urgency: "info_request"

Use "info_request" when the manager needs to provide information:
- Local recommendations (restaurants, shops, activities)
- Reservation changes (dates, guest count)
- Early check-in/late checkout within 2-day window
- Refund or discount requests (NEVER authorize yourself)
- Any question not covered by your knowledge`,
};
