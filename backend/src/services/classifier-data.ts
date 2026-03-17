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
  'sop-booking-inquiry': 90,
  'pricing-negotiation': 95,
  'pre-arrival-logistics': 95,
  'sop-booking-modification': 85,
  'sop-booking-confirmation': 85,
  'payment-issues': 85,
  'post-stay-issues': 90,
  'sop-long-term-rental': 85,
  'sop-booking-cancellation': 90,
  'sop-property-viewing': 85,
  'non-actionable': 60,
  'contextual': 0,
};

export const TOKEN_BUDGET = 500;

// Training examples — 284 total (159 base + 5 self-improvement + 120 new categories)
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
  { text: 'Can I smoke on the balcony?', labels: ['contextual'] },
  { text: 'Is there a quiet hours policy?', labels: ['contextual'] },
  { text: 'What are the house rules?', labels: ['contextual'] },
  { text: 'We want to have a small birthday gathering', labels: ['contextual'] },
  { text: 'Can we have a party?', labels: ['contextual'] },

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
  { text: 'What are the working hours?', labels: ['contextual'] },
  { text: 'What are the working hours for maintenance?', labels: ['contextual'] },
  { text: 'Can someone come at 2pm?', labels: ['contextual'] },
  { text: 'Is it possible to arrange something for tomorrow?', labels: ['contextual'] },
  { text: 'Is it possible to arrange something for tomorrow morning?', labels: ['contextual'] },

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
  { text: 'I want to speak to a manager', labels: ['contextual'] },
  { text: 'I want to speak to a manager right now', labels: ['contextual'] },
  { text: "I'm going to leave a terrible review", labels: ['contextual'] },
  { text: "I'm going to leave a terrible review if this isn't fixed today", labels: ['contextual'] },
  { text: 'This is unacceptable nobody is helping', labels: ['contextual'] },
  { text: 'This is unacceptable. Nothing works in this apartment and nobody is helping.', labels: ['contextual'] },
  { text: 'I smell gas in the apartment!', labels: ['contextual'] },
  { text: 'I smell gas in the apartment!!!', labels: ['contextual'] },
  { text: 'Someone is trying to get into our apartment', labels: ['contextual'] },
  { text: "Someone is trying to get into our apartment, we're scared", labels: ['contextual'] },

  // ── EMERGENCY (2) ──
  { text: 'Water flooding from bathroom into hallway', labels: ['sop-maintenance'] },
  { text: "There's water flooding from the bathroom into the hallway", labels: ['sop-maintenance'] },

  // ── NOISE → contextual (4) ──
  { text: "The neighbors are so loud we can't sleep", labels: ['contextual'] },
  { text: "The neighbors upstairs are so loud we can't sleep", labels: ['contextual'] },
  { text: 'Construction noise starting at 7am every day', labels: ['contextual'] },
  { text: "There's construction noise starting at 7am every day, is this normal?", labels: ['contextual'] },

  // ── CONTEXTUAL (19) ──
  { text: 'Ok thanks', labels: ['contextual'] },
  { text: 'Yes', labels: ['contextual'] },
  { text: "No that's fine", labels: ['contextual'] },
  { text: 'Great see you then', labels: ['contextual'] },
  { text: 'Great, see you then', labels: ['contextual'] },
  { text: 'Got it', labels: ['contextual'] },
  { text: 'Got it 👍', labels: ['contextual'] },
  { text: 'Alright', labels: ['contextual'] },
  { text: 'Tomorrow works', labels: ['contextual'] },
  { text: 'That would be great thank you', labels: ['contextual'] },
  { text: 'That would be great thank you so much', labels: ['contextual'] },
  { text: '5am', labels: ['contextual'] },
  { text: 'Sure', labels: ['contextual'] },
  { text: 'When will you bring it', labels: ['contextual'] },
  { text: 'When will u bring it', labels: ['contextual'] },
  { text: 'اه', labels: ['contextual'] },
  { text: 'ok 👍', labels: ['contextual'] },
  { text: 'شكرا', labels: ['contextual'] },
  { text: 'تمام', labels: ['contextual'] },
  // Short contextual follow-ups / impatient prompts
  { text: 'So?', labels: ['contextual'] },
  { text: 'And?', labels: ['contextual'] },
  { text: 'Well?', labels: ['contextual'] },
  { text: 'Yeah', labels: ['contextual'] },
  { text: 'Yep', labels: ['contextual'] },
  { text: 'Nope', labels: ['contextual'] },
  { text: 'No', labels: ['contextual'] },
  { text: 'Hmm', labels: ['contextual'] },
  { text: 'Please', labels: ['contextual'] },
  { text: 'Okay?', labels: ['contextual'] },
  { text: 'Any update?', labels: ['contextual'] },
  { text: 'Any updates?', labels: ['contextual'] },
  { text: 'Hello?', labels: ['contextual'] },
  { text: '?', labels: ['contextual'] },
  { text: '??', labels: ['contextual'] },
  { text: 'What about it?', labels: ['contextual'] },
  { text: 'Is that possible?', labels: ['contextual'] },
  { text: 'Can you?', labels: ['contextual'] },
  { text: 'When?', labels: ['contextual'] },
  { text: 'How much?', labels: ['contextual'] },
  { text: 'How long?', labels: ['contextual'] },
  { text: 'Really?', labels: ['contextual'] },
  { text: 'Are you sure?', labels: ['contextual'] },
  { text: 'طيب؟', labels: ['contextual'] },
  { text: 'وبعدين؟', labels: ['contextual'] },
  { text: 'يعني؟', labels: ['contextual'] },

  // ── SELF-IMPROVEMENT EXAMPLES (5) — added from v7 failures ──
  { text: "What time is check in?", labels: ['sop-early-checkin', 'property-info'] },
  { text: "What time do we need to leave?", labels: ['sop-late-checkout', 'property-info'] },
  { text: "When is checkout?", labels: ['sop-late-checkout', 'property-info'] },
  { text: "What's the WiFi password?", labels: ['sop-wifi-doorcode', 'property-info'] },
  { text: "How do I connect to the internet?", labels: ['sop-wifi-doorcode', 'property-info'] },

  // ── NEW CATEGORY EXAMPLES (120) — v7-full 11 new SOP categories ──

  // ── BOOKING INQUIRY (15) ──
  { text: 'Do you have apartments available next weekend?', labels: ['sop-booking-inquiry'] },
  { text: 'I want to book for 3 nights', labels: ['sop-booking-inquiry'] },
  { text: 'Do you have a 2 bedroom?', labels: ['sop-booking-inquiry'] },
  { text: 'Is there anything available for tonight?', labels: ['sop-booking-inquiry'] },
  { text: 'I need a place for a family of 5', labels: ['sop-booking-inquiry'] },
  { text: 'عندكم شقة فاضية؟', labels: ['sop-booking-inquiry'] },
  { text: 'Do you have availability from March 20-25?', labels: ['sop-booking-inquiry'] },
  { text: 'We need 2 apartments next to each other', labels: ['sop-booking-inquiry'] },
  { text: 'Is the 3BR available for next month?', labels: ['sop-booking-inquiry'] },
  { text: 'I want to book please', labels: ['sop-booking-inquiry'] },
  { text: 'Any units available for this Thursday?', labels: ['sop-booking-inquiry'] },
  { text: 'What are the options for a week-long stay?', labels: ['sop-booking-inquiry'] },
  { text: 'محتاج شقة غرفتين لمدة 4 ليالي', labels: ['sop-booking-inquiry'] },
  { text: 'Can I book through you directly?', labels: ['sop-booking-inquiry'] },
  { text: 'Do you have anything with a balcony?', labels: ['sop-booking-inquiry'] },

  // ── PRICING NEGOTIATION (15) ──
  { text: "What's the nightly rate?", labels: ['pricing-negotiation'] },
  { text: "That's too expensive", labels: ['pricing-negotiation'] },
  { text: 'Can you give me a better price?', labels: ['pricing-negotiation'] },
  { text: "What's the best you can do?", labels: ['pricing-negotiation'] },
  { text: 'Do you have a discount for a week?', labels: ['pricing-negotiation'] },
  { text: 'How much per night?', labels: ['pricing-negotiation'] },
  { text: "We're on a budget, any cheaper options?", labels: ['pricing-negotiation'] },
  { text: 'Is there a weekly rate?', labels: ['pricing-negotiation'] },
  { text: 'كم السعر؟', labels: ['pricing-negotiation'] },
  { text: 'غالي شوية', labels: ['pricing-negotiation'] },
  { text: 'Can you match the Airbnb price?', labels: ['pricing-negotiation'] },
  { text: "What's the rate for 5 nights?", labels: ['pricing-negotiation'] },
  { text: 'Is the price negotiable?', labels: ['pricing-negotiation'] },
  { text: 'Do corporate rates apply?', labels: ['pricing-negotiation', 'sop-long-term-rental'] },
  { text: 'Best offer please', labels: ['pricing-negotiation'] },

  // ── PRE-ARRIVAL LOGISTICS (12) ──
  { text: 'How do I get there from the airport?', labels: ['pre-arrival-logistics', 'property-info'] },
  { text: 'Can you send me the location?', labels: ['pre-arrival-logistics', 'property-info'] },
  { text: 'We arrive at 9pm on Friday', labels: ['pre-arrival-logistics'] },
  { text: 'Can someone meet us at the gate?', labels: ['pre-arrival-logistics'] },
  { text: 'Do you offer airport pickup?', labels: ['pre-arrival-logistics'] },
  { text: "I'll send the location to my driver", labels: ['pre-arrival-logistics'] },
  { text: 'ممكن تبعتلي اللوكيشن', labels: ['pre-arrival-logistics', 'property-info'] },
  { text: "We're on our way, ETA 30 minutes", labels: ['pre-arrival-logistics'] },
  { text: 'How far from City Stars?', labels: ['pre-arrival-logistics', 'property-info'] },
  { text: 'Can you share the Google Maps pin?', labels: ['pre-arrival-logistics', 'property-info'] },
  { text: "We'll arrive around midnight", labels: ['pre-arrival-logistics'] },
  { text: 'Is there an Uber from the airport?', labels: ['pre-arrival-logistics'] },

  // ── BOOKING MODIFICATION (12) ──
  { text: 'I need to change my dates', labels: ['sop-booking-modification'] },
  { text: 'Can we add one more night?', labels: ['sop-booking-modification'] },
  { text: 'I want to switch to a bigger apartment', labels: ['sop-booking-modification'] },
  { text: 'Can we change to March 20-23 instead?', labels: ['sop-booking-modification'] },
  { text: "We'll be 5 instead of 4", labels: ['sop-booking-modification'] },
  { text: 'ابي اغير التاريخ', labels: ['sop-booking-modification'] },
  { text: 'Can I extend by 2 more nights?', labels: ['sop-booking-modification'] },
  { text: 'I want to remove one night from my booking', labels: ['sop-booking-modification'] },
  { text: 'Can we move to a different unit?', labels: ['sop-booking-modification'] },
  { text: 'Actually make it 3 nights not 2', labels: ['sop-booking-modification'] },
  { text: 'My plans changed, can we adjust the dates?', labels: ['sop-booking-modification'] },
  { text: 'We need to add another person to the reservation', labels: ['sop-booking-modification'] },

  // ── BOOKING CONFIRMATION (10) ──
  { text: 'Is my booking confirmed?', labels: ['sop-booking-confirmation'] },
  { text: 'I booked through Airbnb, is it showing?', labels: ['sop-booking-confirmation'] },
  { text: 'Can you confirm my reservation details?', labels: ['sop-booking-confirmation'] },
  { text: 'I made a booking 2 hours ago', labels: ['sop-booking-confirmation'] },
  { text: 'Just want to make sure it went through', labels: ['sop-booking-confirmation'] },
  { text: 'Check Airbnb I already booked', labels: ['sop-booking-confirmation'] },
  { text: "Here's my booking confirmation number", labels: ['sop-booking-confirmation'] },
  { text: 'هل الحجز مؤكد؟', labels: ['sop-booking-confirmation'] },
  { text: 'I booked through Booking.com is that ok?', labels: ['sop-booking-confirmation'] },
  { text: 'Did you receive my reservation?', labels: ['sop-booking-confirmation'] },

  // ── PAYMENT ISSUES (10) ──
  { text: "The payment didn't go through", labels: ['payment-issues'] },
  { text: 'How do I pay?', labels: ['payment-issues'] },
  { text: 'Can I get a receipt?', labels: ['payment-issues'] },
  { text: 'I was overcharged', labels: ['payment-issues'] },
  { text: "Where's my refund?", labels: ['payment-issues'] },
  { text: "The payment link isn't working", labels: ['payment-issues'] },
  { text: 'Can I pay by credit card?', labels: ['payment-issues'] },
  { text: 'I sent the bank transfer', labels: ['payment-issues'] },
  { text: 'Can you email me the invoice?', labels: ['payment-issues'] },
  { text: "My deposit hasn't been returned", labels: ['payment-issues', 'post-stay-issues'] },

  // ── POST-STAY ISSUES (8) ──
  { text: 'I left my charger in the apartment', labels: ['post-stay-issues'] },
  { text: 'We checked out but forgot a bag', labels: ['post-stay-issues'] },
  { text: 'When do I get my deposit back?', labels: ['post-stay-issues'] },
  { text: 'I want to file a complaint about my stay', labels: ['post-stay-issues'] },
  { text: 'We left groceries in the fridge', labels: ['post-stay-issues'] },
  { text: 'Can someone check if my laptop is still there?', labels: ['post-stay-issues'] },
  { text: 'نسيت شنطتي في الشقة', labels: ['post-stay-issues'] },
  { text: 'The apartment was not as advertised', labels: ['post-stay-issues'] },

  // ── LONG-TERM RENTAL (5) ──
  { text: 'Do you have monthly rates?', labels: ['sop-long-term-rental'] },
  { text: "I'm relocating for 3 months", labels: ['sop-long-term-rental'] },
  { text: "What's the rate for a month?", labels: ['sop-long-term-rental', 'pricing-negotiation'] },
  { text: 'I need corporate housing', labels: ['sop-long-term-rental'] },
  { text: 'سعر شهري كام؟', labels: ['sop-long-term-rental', 'pricing-negotiation'] },

  // ── BOOKING CANCELLATION (5) ──
  { text: 'I need to cancel my reservation', labels: ['sop-booking-cancellation'] },
  { text: "What's the cancellation policy?", labels: ['sop-booking-cancellation'] },
  { text: "Something came up, I can't make it", labels: ['sop-booking-cancellation'] },
  { text: 'Can I cancel and get a refund?', labels: ['sop-booking-cancellation', 'payment-issues'] },
  { text: 'ابي الغي الحجز', labels: ['sop-booking-cancellation'] },

  // ── PROPERTY VIEWING (5) ──
  { text: 'Can I see the apartment first?', labels: ['sop-property-viewing'] },
  { text: 'Do you have photos of the kitchen?', labels: ['sop-property-viewing'] },
  { text: 'Can we do a photoshoot inside?', labels: ['sop-property-viewing'] },
  { text: 'I want to view the apartment before deciding', labels: ['sop-property-viewing'] },
  { text: 'Do you have a video tour?', labels: ['sop-property-viewing'] },

  // ── NON-ACTIONABLE (5) ──
  { text: 'Test', labels: ['contextual'] },
  { text: 'Hello', labels: ['contextual'] },
  { text: 'مرحبا', labels: ['contextual'] },
  { text: 'Sorry wrong chat', labels: ['contextual'] },
  { text: 'Hi Omar', labels: ['contextual'] },
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

  'sop-booking-inquiry': `BOOKING INQUIRY: Guest is asking about availability, unit options, or making a new reservation. Ask: dates, number of guests, any preferences (bedrooms, floor, view). Check if property/dates are available in your knowledge. If available, share rate and unit details. If not available or unsure, escalate as info_request with guest requirements. Never confirm a booking yourself — escalate with all details for manager to finalize. For urgent same-day requests, escalate as immediate.`,

  'pricing-negotiation': `PRICING/NEGOTIATION: Guest is asking about rates, requesting discounts, or expressing budget concerns. Share the standard rate from your knowledge if available. NEVER offer discounts, special rates, or price matches yourself. If guest asks for better price, weekly/monthly rate, or says it's too expensive, acknowledge and escalate as info_request with the guest's budget/request details. Don't apologize for pricing — present it neutrally. For long-term stay pricing, also tag with sop-long-term-rental.`,

  'pre-arrival-logistics': `PRE-ARRIVAL LOGISTICS: Guest is coordinating arrival — sharing ETA, asking for directions, requesting location pin, or arranging airport transfer. Share property address and location from your knowledge. If guest asks for directions from a specific location, share what you know. For airport transfer requests, escalate as info_request. If guest shares arrival time, confirm and escalate as scheduled so someone can meet them if needed. For late arrivals (after 10pm), escalate as immediate.`,

  'sop-booking-modification': `BOOKING MODIFICATION: Guest wants to change dates, add/remove nights, change unit, or update guest count. Acknowledge the request. NEVER confirm modifications yourself. Escalate as info_request with: current booking details, requested changes, and reason if provided. For date changes within 48 hours of check-in, escalate as immediate. For guest count changes that might affect unit assignment, note the new count clearly.`,

  'sop-booking-confirmation': `BOOKING CONFIRMATION: Guest is verifying their reservation exists, checking dates/details, or asking about booking status. Check reservation details in your knowledge and confirm what you can see — dates, unit, guest count. If the booking isn't in your system, ask which platform they booked through (Airbnb, Booking.com, direct) and escalate as info_request. For guests claiming they booked but no record found, escalate as immediate.`,

  'payment-issues': `PAYMENT ISSUES: Guest has questions about payment methods, failed transactions, receipts, billing disputes, or refund status. NEVER process payments, confirm receipt of payment, or authorize refunds yourself. For payment link issues, escalate as immediate. For receipt requests, escalate as info_request. For billing disputes or refund requests, acknowledge and escalate as immediate with full details. For deposit return questions, escalate as info_request.`,

  'post-stay-issues': `POST-STAY ISSUES: Guest has checked out and contacts about lost items, post-stay complaints, damage deposit questions, or feedback. For lost items: ask for description and location where they think they left it. Escalate as immediate so staff can check. For damage deposit questions, escalate as info_request. For post-stay complaints, acknowledge with empathy and escalate as immediate. Never promise items will be found or deposits returned.`,

  'sop-long-term-rental': `LONG-TERM RENTAL: Guest is inquiring about monthly stays, corporate housing, or stays longer than 2 weeks. Ask: duration needed, move-in date, number of guests, any preferences. Share standard nightly rate if known, but note that monthly rates are different and need manager approval. Escalate as info_request with all details. For corporate stays, ask if they need a contract or invoice. Never quote monthly rates yourself.`,

  'sop-booking-cancellation': `BOOKING CANCELLATION: Guest wants to cancel their reservation or is asking about cancellation policy. Acknowledge the request. NEVER cancel bookings or confirm cancellation yourself. Ask which booking/dates they want to cancel if not clear. Escalate as info_request with booking details and reason for cancellation. For cancellation policy questions, escalate as info_request — policies vary by platform (Airbnb, Booking.com, direct). For refund-after-cancellation questions, also tag with payment-issues.`,

  'sop-property-viewing': `PROPERTY VIEWING: Guest wants to see the apartment before booking, requests photos/video, or asks about filming/photoshoot permission. For viewing requests: ask preferred date/time, escalate as info_request. Share existing photos from your knowledge if available. For video requests, escalate as info_request. For photoshoot/filming requests, ask about scope (how many people, duration, commercial or personal) and escalate as immediate — needs manager approval.`,

  'non-actionable': `NON-ACTIONABLE: Message has no real intent — test messages, wrong chat, system messages, or greetings with no question. For greetings ('Hi', 'Hello'), respond with a friendly greeting and ask how you can help. For test messages, respond briefly. For wrong-chat messages, let them know politely. For system/automated messages, ignore (guest_message: '', escalation: null).`,
};
