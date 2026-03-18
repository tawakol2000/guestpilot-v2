/**
 * Classifier training data and SOP content.
 * v8: Updated SOPs, added sop-complaint, removed sop-escalation-info,
 * merged property-amenities into sop-amenity-request, restructured contextual vs non-actionable.
 */

// Chunks baked into system prompt (never retrieved by classifier)
export const BAKED_IN_CHUNKS = new Set([
  'sop-scheduling',
  'sop-house-rules',
  'sop-escalation-immediate',
  'sop-escalation-scheduled',
]);

// Token costs for RAG-retrieved chunks (reference only — no budget cap enforced)
export const CHUNK_TOKENS: Record<string, number> = {
  'sop-cleaning': 150,
  'sop-amenity-request': 200,
  'sop-maintenance': 260,
  'sop-wifi-doorcode': 140,
  'sop-visitor-policy': 300,
  'sop-early-checkin': 380,
  'sop-late-checkout': 280,
  'sop-complaint': 200,
  'property-info': 120,
  'property-description': 185,
  'sop-booking-inquiry': 120,
  'pricing-negotiation': 150,
  'pre-arrival-logistics': 150,
  'sop-booking-modification': 110,
  'sop-booking-confirmation': 110,
  'payment-issues': 120,
  'post-stay-issues': 110,
  'sop-long-term-rental': 110,
  'sop-booking-cancellation': 110,
  'sop-property-viewing': 100,
  'non-actionable': 80,
  'contextual': 0,
};

// Training examples
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

  // ── AMENITY (13) — property-amenities merged into sop-amenity-request ──
  { text: 'I need a pillow', labels: ['sop-amenity-request'] },
  { text: 'Do you have a baby crib?', labels: ['sop-amenity-request'] },
  { text: 'Can I get extra towels?', labels: ['sop-amenity-request'] },
  { text: 'Is there a blender?', labels: ['sop-amenity-request'] },
  { text: 'Do you have a phone charger?', labels: ['sop-amenity-request'] },
  { text: 'We need more blankets', labels: ['sop-amenity-request'] },
  { text: 'Is there an iron?', labels: ['sop-amenity-request'] },
  { text: 'Can I get hangers?', labels: ['sop-amenity-request'] },
  { text: 'Do you have kids plates and cups?', labels: ['sop-amenity-request'] },
  { text: 'What amenities does this apartment have?', labels: ['sop-amenity-request'] },
  { text: "What's available in the apartment?", labels: ['sop-amenity-request'] },
  { text: 'محتاج مخدة', labels: ['sop-amenity-request'] },
  { text: 'محتاج فوط', labels: ['sop-amenity-request'] },

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
  { text: 'There is no hair dryer in the property', labels: ['sop-maintenance', 'sop-amenity-request'] },
  { text: 'The hair dryer is missing', labels: ['sop-maintenance', 'sop-amenity-request'] },
  { text: "There's supposed to be an iron but it's not here", labels: ['sop-maintenance', 'sop-amenity-request'] },
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

  // ── HOUSE RULES → non-actionable (baked-in) (5) ──
  { text: 'Can I smoke on the balcony?', labels: ['non-actionable'] },
  { text: 'Is there a quiet hours policy?', labels: ['non-actionable'] },
  { text: 'What are the house rules?', labels: ['non-actionable'] },
  { text: 'We want to have a small birthday gathering', labels: ['non-actionable'] },
  { text: 'Can we have a party?', labels: ['non-actionable'] },

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
  { text: 'Can we extend our stay by 2 more nights?', labels: ['sop-booking-modification'] },

  // ── PROPERTY (8) ──
  { text: 'What floor is the apartment?', labels: ['property-info', 'property-description'] },
  { text: 'What floor is the apartment', labels: ['property-info', 'property-description'] },
  { text: 'How many bedrooms are there?', labels: ['property-info'] },
  { text: "Where is the apartment? What's the address?", labels: ['property-info'] },
  { text: "Where exactly is the apartment? What's the address?", labels: ['property-info'] },
  { text: 'Is there parking available?', labels: ['property-description', 'sop-amenity-request'] },
  { text: 'Is there a pool we can use?', labels: ['property-description', 'sop-amenity-request'] },
  { text: 'Is there a gym?', labels: ['property-description', 'sop-amenity-request'] },

  // ── SCHEDULING → non-actionable (baked-in) (5) ──
  { text: 'What are the working hours?', labels: ['non-actionable'] },
  { text: 'What are the working hours for maintenance?', labels: ['non-actionable'] },
  { text: 'Can someone come at 2pm?', labels: ['non-actionable'] },
  { text: 'Is it possible to arrange something for tomorrow?', labels: ['non-actionable'] },
  { text: 'Is it possible to arrange something for tomorrow morning?', labels: ['non-actionable'] },

  // ── FORMER ESCALATION INFO (10) — re-routed ──
  { text: 'Can you recommend a restaurant nearby?', labels: ['non-actionable'] },
  { text: 'Can you recommend a good restaurant nearby?', labels: ['non-actionable'] },
  { text: "What's there to do around here?", labels: ['non-actionable'] },
  { text: "Where's the nearest pharmacy?", labels: ['non-actionable'] },
  { text: 'How do I get to the airport?', labels: ['pre-arrival-logistics'] },
  { text: 'How do I get to the airport from here?', labels: ['pre-arrival-logistics'] },
  { text: 'I want a refund', labels: ['payment-issues'] },
  { text: 'I want a refund. This is not what was advertised.', labels: ['payment-issues', 'sop-complaint'] },
  { text: 'I want a discount for the problems', labels: ['pricing-negotiation'] },
  { text: "I want a discount for all the problems we've had", labels: ['pricing-negotiation'] },

  // ── COMPLAINT (10) — NEW ──
  { text: "I'm not happy with this apartment", labels: ['sop-complaint'] },
  { text: 'This place is nothing like the photos', labels: ['sop-complaint'] },
  { text: 'The apartment is terrible', labels: ['sop-complaint'] },
  { text: "I'm very disappointed with the property", labels: ['sop-complaint'] },
  { text: 'Not satisfied at all', labels: ['sop-complaint'] },
  { text: 'This is not worth what we paid', labels: ['sop-complaint', 'pricing-negotiation'] },
  { text: 'مش راضي عن الشقة', labels: ['sop-complaint'] },
  { text: 'الشقة مش زي الصور', labels: ['sop-complaint'] },
  { text: "We're really unhappy with the place", labels: ['sop-complaint'] },
  { text: 'I expected much better for this price', labels: ['sop-complaint'] },

  // ── FORMER ESCALATION IMMEDIATE → complaint / non-actionable (10) ──
  { text: 'I want to speak to a manager', labels: ['sop-complaint'] },
  { text: 'I want to speak to a manager right now', labels: ['sop-complaint'] },
  { text: "I'm going to leave a terrible review", labels: ['sop-complaint'] },
  { text: "I'm going to leave a terrible review if this isn't fixed today", labels: ['sop-complaint'] },
  { text: 'This is unacceptable nobody is helping', labels: ['sop-complaint'] },
  { text: 'This is unacceptable. Nothing works in this apartment and nobody is helping.', labels: ['sop-complaint', 'sop-maintenance'] },
  { text: 'I smell gas in the apartment!', labels: ['non-actionable'] },
  { text: 'I smell gas in the apartment!!!', labels: ['non-actionable'] },
  { text: 'Someone is trying to get into our apartment', labels: ['non-actionable'] },
  { text: "Someone is trying to get into our apartment, we're scared", labels: ['non-actionable'] },

  // ── EMERGENCY (2) ──
  { text: 'Water flooding from bathroom into hallway', labels: ['sop-maintenance'] },
  { text: "There's water flooding from the bathroom into the hallway", labels: ['sop-maintenance'] },

  // ── NOISE → non-actionable (baked-in escalation handles) (4) ──
  { text: "The neighbors are so loud we can't sleep", labels: ['non-actionable'] },
  { text: "The neighbors upstairs are so loud we can't sleep", labels: ['non-actionable'] },
  { text: 'Construction noise starting at 7am every day', labels: ['non-actionable'] },
  { text: "There's construction noise starting at 7am every day, is this normal?", labels: ['non-actionable'] },

  // ── CONTEXTUAL — short follow-ups only (Tier 3 re-injects last SOP) ──
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

  // ── ARABIC EXPANSION (21) — covers key SOPs in Arabic/Gulf dialect ──
  // Maintenance
  { text: 'التكييف مش شغال', labels: ['sop-maintenance'] },
  { text: 'مفيش ماء ساخن', labels: ['sop-maintenance'] },
  { text: 'في تسريب مياه في الحمام', labels: ['sop-maintenance'] },
  { text: 'الغسالة مش بتشتغل', labels: ['sop-maintenance'] },
  { text: 'في ريحة وحشة في الشقة', labels: ['sop-maintenance'] },
  // Booking & pricing
  { text: 'عندكم شقق فاضية الاسبوع الجاي؟', labels: ['sop-booking-inquiry'] },
  { text: 'كم سعر الليلة؟', labels: ['pricing-negotiation'] },
  { text: 'نبي نمدد الإقامة', labels: ['sop-booking-modification'] },
  { text: 'ابي الغي الحجز واسترجع فلوسي', labels: ['sop-booking-cancellation', 'payment-issues'] },
  { text: 'هل الحجز مأكد ولا لا؟', labels: ['sop-booking-confirmation'] },
  // Check-in/checkout & logistics
  { text: 'ممكن نوصل بدري الساعة 10؟', labels: ['sop-early-checkin'] },
  { text: 'نبي نطلع متأخر شوي', labels: ['sop-late-checkout'] },
  { text: 'وين الشقة بالضبط؟ ابي اللوكيشن', labels: ['pre-arrival-logistics', 'property-info'] },
  { text: 'كيف ادخل الشقة؟ وش كود الباب؟', labels: ['sop-wifi-doorcode', 'property-info'] },
  // Amenities & cleaning (including room-specific amenity questions)
  { text: 'محتاجين تنظيف الشقة', labels: ['sop-cleaning'] },
  { text: 'في مكواة في الشقة؟', labels: ['sop-amenity-request'] },
  { text: 'محتاج فوط زيادة وشراشف', labels: ['sop-amenity-request'] },
  { text: 'الحمام فيه شطاف؟', labels: ['sop-amenity-request'] },
  { text: 'هل في غسالة في الشقة؟', labels: ['sop-amenity-request'] },
  { text: 'في سشوار في الحمام؟', labels: ['sop-amenity-request'] },
  { text: 'هل يوجد ميكرويف؟', labels: ['sop-amenity-request'] },
  { text: 'هل يوجد بيديه في الحمام؟', labels: ['sop-amenity-request'] },
  { text: 'الشقة فيها غسالة صحون؟', labels: ['sop-amenity-request'] },
  { text: 'الشقة مش نظيفة ابدا', labels: ['sop-complaint', 'sop-cleaning'] },
  // Complaints & visitors
  { text: 'مش راضي عن الخدمة ابد', labels: ['sop-complaint'] },
  { text: 'ممكن اخوي يزورنا؟', labels: ['sop-visitor-policy'] },
  { text: 'ابي اكلم المدير', labels: ['sop-complaint'] },

  // ── SELF-IMPROVEMENT EXAMPLES (5) ──
  { text: "What time is check in?", labels: ['sop-early-checkin', 'property-info'] },
  { text: "What time do we need to leave?", labels: ['sop-late-checkout', 'property-info'] },
  { text: "When is checkout?", labels: ['sop-late-checkout', 'property-info'] },
  { text: "What's the WiFi password?", labels: ['sop-wifi-doorcode', 'property-info'] },
  { text: "How do I connect to the internet?", labels: ['sop-wifi-doorcode', 'property-info'] },

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

  // ── BOOKING MODIFICATION (18) — includes stay extension examples ──
  { text: 'We want to extend our stay for 2 more weeks', labels: ['sop-booking-modification'] },
  { text: 'Can we extend for another week?', labels: ['sop-booking-modification'] },
  { text: 'Planning to extend for 2 more weeks', labels: ['sop-booking-modification'] },
  { text: "We'd like to stay longer, maybe 5 more nights", labels: ['sop-booking-modification'] },
  { text: 'Is it possible to extend our booking?', labels: ['sop-booking-modification'] },
  { text: 'نبي نمدد الإقامة أسبوعين', labels: ['sop-booking-modification'] },
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
  { text: 'I want to file a complaint about my stay', labels: ['post-stay-issues', 'sop-complaint'] },
  { text: 'We left groceries in the fridge', labels: ['post-stay-issues'] },
  { text: 'Can someone check if my laptop is still there?', labels: ['post-stay-issues'] },
  { text: 'نسيت شنطتي في الشقة', labels: ['post-stay-issues'] },
  { text: 'The apartment was not as advertised', labels: ['post-stay-issues', 'sop-complaint'] },

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

  // ── NON-ACTIONABLE: greetings / test / wrong chat (5) ──
  { text: 'Test', labels: ['non-actionable'] },
  { text: 'Hello', labels: ['non-actionable'] },
  { text: 'مرحبا', labels: ['non-actionable'] },
  { text: 'Sorry wrong chat', labels: ['non-actionable'] },
  { text: 'Hi Omar', labels: ['non-actionable'] },
];

// SOP content map — the actual text injected into the prompt when a chunk ID is selected.
export const SOP_CONTENT: Record<string, string> = {
  'sop-cleaning': `Guest asks for cleaning, housekeeping, maid service, tidying up, or mopping.
Cleaning costs $20 per session. Available during working hours only (10am–5pm). Recurring cleaning is OK ($20 each session). If the guest mentions anything that the unit was not cleaned, waive and don't mention the $20 fee.`,

  'sop-amenity-request': `Guest requests towels, extra towels, pillows, blankets, baby crib, extra bed, hair dryer, blender, kids dinnerware, espresso machine, hangers, or any item/amenity.

## AVAILABLE PROPERTY AMENITIES

{PROPERTY_AMENITIES}

Check the property amenities list for available items. Only confirm items explicitly listed there.
- Item on the amenities list → confirm availability, ask for delivery time during working hours (10am–5pm), then escalate as "scheduled"
- Item NOT on the list → say "Let me check on that" → escalate as "info_request"`,

  'sop-maintenance': `Guest reports something broken, not working, or needing repair — AC not cooling, no hot water, plumbing, leak, water damage, appliance broken, electricity issue, insects, bugs, pests, cockroach, mold, smell, noise from neighbors.
Broken or malfunctioning items: Acknowledge the problem, assure guest someone will look into it, and escalate immediately.
**All maintenance/technical issues → urgency: "immediate"**`,

  'sop-wifi-doorcode': `Guest asks about WiFi password, WiFi network name, internet connection, door code, entry code, lock code, how to get in, or can't open the door.
WiFi credentials and door code are in PROPERTY & GUEST INFO under ACCESS & CONNECTIVITY. Give them directly.
If there's a **problem** (WiFi not working, code not working, can't connect, locked out) → escalate immediately.`,

  'sop-visitor-policy': `Guest wants to invite someone over, have a friend visit, bring a visitor, asks about visitor rules, or asks if someone can come to the apartment.

## VISITOR POLICY
- ONLY immediate family members allowed as visitors
- Guest must send visitor's passport through the chat
- Family names must match guest's family name
Collect passport image → escalate for manager verification
Non-family visitors (friends, colleagues, etc.) = NOT allowed

**Examples:**
Guest: "Can my someone come over for dinner?"
{"guest_message":"We only allow immediate family members as visitors. If they're family, please send their passport through the chat and we'll arrange access.","escalation":null}

Guest: "That's unfair, it's just one friend"
{"guest_message":"I understand, but this is a strict policy we need to follow. I'll pass your feedback along.","escalation":{"title":"house-rule-pushback","note":"Guest [Name] in [Unit] pushing back on visitor policy. Wants non-family friend. Needs manager.","urgency":"immediate"}}`,

  'sop-early-checkin': `Guest asks for early check-in, arriving early, wants to check in before 3pm, or asks if they can come earlier.

## EARLY CHECK-IN
Standard check-in: 3:00 PM. Back-to-back bookings mean early check-in can only be confirmed 2 days before.
**More than 2 days before check-in:** Do NOT escalate. Tell guest:
"We can only confirm early check-in 2 days before your date since there may be guests checking out. You're welcome to leave your bags with housekeeping and grab coffee at O1 Mall — it's a 1-minute walk."
**Within 2 days of check-in:** Tell guest you'll check → escalate as "info_request"
**Never confirm early check-in yourself.**

**Examples:**
Guest: "Can I check in at noon?" (check-in is far away)
{"guest_message":"We can only confirm early check-in 2 days before your date since there may be guests checking out. You're welcome to leave your bags with housekeeping and grab something at O1 Mall — it's a 1-minute walk.","escalation":null}

Guest: "I arrive tomorrow at 10am, early check-in?" (within 2 days)
{"guest_message":"Let me check on that for you and get back to you shortly.","escalation":{"title":"early-checkin","note":"Guest [Name] in [Unit] — early check-in tomorrow 10am. Within 2-day window.","urgency":"info_request"}}`,

  'sop-late-checkout': `Guest asks for late checkout — wants to leave later on their checkout day, check out after 11am, or stay past checkout time on their last day.
Standard check-out: 11:00 AM. Back-to-back bookings mean late checkout can only be confirmed 2 days before.
**More than 2 days before checkout:** Do NOT escalate. Tell guest the same 2-day rule.
**Within 2 days of checkout:** Tell guest you'll check → escalate as "info_request"
**Never confirm late checkout yourself.**

**Example:**
Guest: "Can I check out at 2pm instead of 11?"
{"guest_message":"Let me check on that for you and get back to you shortly.","escalation":{"title":"late-checkout","note":"Guest [Name] in [Unit] — wants late checkout at 2pm. Needs manager approval.","urgency":"info_request"}}`,

  'sop-complaint': `COMPLAINT: Guest is unhappy, dissatisfied, or complaining about their experience — property quality, cleanliness on arrival, misleading photos/listing, noise from neighbors, uncomfortable beds, bad smell, or general dissatisfaction.
Acknowledge the complaint with genuine empathy. Do NOT be defensive or dismissive. Ask what specifically is wrong if not clear.
- Cleanliness complaints → offer immediate cleaning (waive $20 fee) and escalate as immediate
- Noise complaints → acknowledge and escalate as immediate
- Review threats or requests to speak to manager → acknowledge their frustration, escalate as immediate
- Property-quality complaints (misleading listing, broken promises, not as advertised) → escalate as immediate with full details
- General dissatisfaction → empathize, ask for specifics, escalate as immediate
Never offer refunds, discounts, or compensation yourself. Inform the guest you have notified the manager.`,

  'sop-booking-inquiry': `BOOKING INQUIRY: Guest is asking about availability, unit options, or making a new reservation. Ask: dates, number of guests, any preferences (bedrooms, floor, view). Check if property/dates are available in your knowledge. If available, share property links. If not available or unsure, escalate as info_request with guest requirements. Never confirm a booking yourself — escalate with all details for manager to finalize. For urgent same-day requests, escalate as immediate.`,

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
