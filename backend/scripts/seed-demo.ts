/**
 * GuestPilot v2 — Demo Seed Script
 *
 * Wipes and re-seeds a "snapshot" demo tenant (Urban Stays NYC & Miami) with:
 *   • 10 properties across New York and Miami
 *   • 16 guest conversations across the full reservation lifecycle
 *   • ~180 messages with realistic AI replies, shadow-mode previews, escalations
 *   • Tasks across every urgency level
 *   • Rich FAQ knowledge base (28 entries across 9 categories)
 *   • SOP definitions with per-status variants + per-property overrides
 *   • 6 system tools + 2 custom webhook tools
 *   • AI call logs so the AI Logs tab tells a story
 *   • Polished TenantAiConfig so Configure-AI renders with personality
 *
 * Usage:
 *   cd backend
 *   DATABASE_URL="postgresql://..." npx tsx scripts/seed-demo.ts
 *
 * Login after seeding:
 *   email:    demo@urbanstays.co
 *   password: Demo2026!
 *
 * Idempotent — re-running wipes the demo tenant and its cascaded data,
 * then re-creates everything from scratch. Safe to run against a dedicated
 * demo database.
 */

import { PrismaClient, ReservationStatus, Channel, MessageRole, Plan, FaqScope, FaqStatus, FaqSource, PreviewState } from '@prisma/client';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const prisma = new PrismaClient();

// ────────────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────────────

const DEMO_EMAIL = 'demo@urbanstays.co';
const DEMO_PASSWORD = 'Demo2026!';
const DEMO_NAME = 'Urban Stays NYC & Miami';

// ────────────────────────────────────────────────────────────────────────────
// Date helpers (all timestamps relative to "now" so the snapshot always
// looks fresh regardless of when the demo is loaded)
// ────────────────────────────────────────────────────────────────────────────

const NOW = new Date();

function minsAgo(m: number): Date {
  return new Date(NOW.getTime() - m * 60 * 1000);
}
function hoursAgo(h: number): Date {
  return minsAgo(h * 60);
}
function daysAgo(d: number): Date {
  return minsAgo(d * 60 * 24);
}
function daysFromNow(d: number): Date {
  return new Date(NOW.getTime() + d * 24 * 60 * 60 * 1000);
}

// ────────────────────────────────────────────────────────────────────────────
// Property definitions — 10 curated units across NYC + Miami
// ────────────────────────────────────────────────────────────────────────────

interface PropertySeed {
  slug: string;
  hostawayListingId: string;
  name: string;
  address: string;
  listingDescription: string;
  customKnowledgeBase: Record<string, unknown>;
  autoAcceptLateCheckoutUntil?: string | null;
  autoAcceptEarlyCheckinFrom?: string | null;
}

const PROPERTY_SEEDS: PropertySeed[] = [
  {
    slug: 'soho-loft',
    hostawayListingId: '220001',
    name: 'SoHo Loft on Spring St',
    address: '112 Spring Street, New York, NY 10012',
    listingDescription:
      'A cast-iron-era 2BR loft on cobblestoned Spring Street. Exposed brick, 14ft ceilings, a private roof deck with Empire State views, Sonos throughout, Nespresso bar, king-sized beds, sleeps 4.',
    customKnowledgeBase: {
      wifi: { ssid: 'SoHo-Loft-5G', password: 'SpringStreet2024' },
      doorCode: '4412#',
      checkInTime: '15:00',
      checkOutTime: '11:00',
      parking: 'Metered street parking only. Nearest paid garage: SP+ at 200 Lafayette, 3-min walk, ~$55/day.',
      nearestSubway: 'Spring St (C/E) — 1 block; Prince St (N/R/W) — 2 blocks.',
      groceries: "Gourmet Garage at Broome & Mercer, 5-min walk. Whole Foods at Houston, 8-min walk.",
      houseRules: ['No smoking', 'No parties', 'Quiet hours 10pm–8am', 'Max 4 guests'],
      amenities: ['Private roof deck', 'Central AC', 'Dishwasher', 'In-unit laundry', 'Smart TV with Netflix', 'Nespresso + coffee bar'],
      neighborhood: 'SoHo — best shopping + dining in NYC. Balthazar 4-min walk, Dominique Ansel Bakery 5-min walk.',
    },
    autoAcceptLateCheckoutUntil: '13:00',
    autoAcceptEarlyCheckinFrom: '13:00',
  },
  {
    slug: 'midtown-east-38',
    hostawayListingId: '220002',
    name: 'Midtown East 38 — UN View',
    address: '245 E 38th Street, Apt 14B, New York, NY 10016',
    listingDescription:
      'Polished 1BR in a full-service doorman building with breathtaking UN and East River views. 24/7 concierge, gym, business center. Ideal for UN delegates and corporate travelers.',
    customKnowledgeBase: {
      wifi: { ssid: 'MidtownEast-14B', password: 'UNView2024!' },
      doorCode: null,
      doormanNote: 'Doorman has your name from the reservation — just give your booking name and ID.',
      checkInTime: '16:00',
      checkOutTime: '11:00',
      parking: 'Icon Parking at 241 E 39th, $58/day, on-site valet.',
      nearestSubway: 'Grand Central (S/4/5/6/7) — 7-min walk.',
      amenities: ['Doorman', 'Gym in building', 'Business center', 'Package receiving', 'Rooftop lounge', 'Blackout curtains'],
      houseRules: ['No smoking', 'No parties', 'Family-only property', 'Max 2 guests'],
      neighborhood: 'Walking distance to UN, Grand Central, Bryant Park. Le Perigord 3-min walk.',
    },
    autoAcceptLateCheckoutUntil: '12:30',
    autoAcceptEarlyCheckinFrom: '14:00',
  },
  {
    slug: 'williamsburg-sky-suite',
    hostawayListingId: '220003',
    name: 'Williamsburg Sky Suite',
    address: '185 Kent Ave, Unit 28A, Brooklyn, NY 11249',
    listingDescription:
      '2BR condo on the 28th floor with panoramic Manhattan skyline + Brooklyn Bridge views. Waterfront. Rooftop pool, gym, sauna. Peloton in-unit.',
    customKnowledgeBase: {
      wifi: { ssid: 'WBurg-SkySuite', password: 'KentAve185' },
      doorCode: '9921*',
      checkInTime: '15:00',
      checkOutTime: '11:00',
      parking: 'Valet in building — $45/day. Self-park at 180 S 4th, $35/day, 2-min walk.',
      nearestSubway: 'Bedford Ave (L) — 8-min walk; Marcy Ave (J/M/Z) — 12-min walk.',
      amenities: ['Rooftop pool (seasonal May–Sept)', 'Sauna', 'Gym', 'Peloton bike in unit', 'Washer/dryer', 'Nest thermostat'],
      houseRules: ['No smoking', 'No parties', 'Quiet hours 10pm–7am', 'Max 4 guests'],
      acControls: 'Nest thermostat on living room wall. Set to 68F recommended. Bedroom has independent mini-split above bed.',
      neighborhood: 'South Williamsburg — Domino Park 3-min walk, Peter Luger 8-min walk.',
    },
    autoAcceptLateCheckoutUntil: '13:00',
    autoAcceptEarlyCheckinFrom: '13:00',
  },
  {
    slug: 'hells-kitchen-penthouse',
    hostawayListingId: '220004',
    name: "Hell's Kitchen Penthouse",
    address: '450 W 42nd Street, PH, New York, NY 10036',
    listingDescription:
      '3BR penthouse with wraparound terrace, Hudson River + Midtown views. Sleeps 6. Two full baths, chef kitchen. 3 blocks from Times Square and Broadway theaters.',
    customKnowledgeBase: {
      wifi: { ssid: 'HK-Penthouse-Wifi6', password: 'Broadway42nd!' },
      doorCode: '7788#',
      checkInTime: '16:00',
      checkOutTime: '11:00',
      parking: 'GMC on 42nd, $65/day. Icon at 440 W 42nd, $60/day. Valet available at GMC.',
      nearestSubway: 'Times Sq-42nd (A/C/E/N/Q/R/W/1/2/3/7/S) — 4-min walk.',
      amenities: ['Wraparound terrace', 'Gas grill on terrace', 'Dishwasher', 'Double oven', 'In-unit laundry', 'Smart TVs in all rooms'],
      houseRules: ['No smoking indoors or on terrace', 'No parties or gatherings', 'Max 6 guests', 'Quiet hours 10pm–8am'],
      neighborhood: 'Hell\'s Kitchen — pre-theater dinner central. The Marshal 2-min walk, Becco 6-min walk.',
    },
    autoAcceptLateCheckoutUntil: '13:00',
    autoAcceptEarlyCheckinFrom: '14:00',
  },
  {
    slug: 'tribeca-atelier',
    hostawayListingId: '220005',
    name: 'Tribeca Atelier',
    address: '56 Leonard St, Apt 8F, New York, NY 10013',
    listingDescription:
      'Design-forward 1BR in the iconic Herzog & de Meuron "Jenga tower". Floor-to-ceiling windows, curated art, Italian marble bath. Sleeps 2.',
    customKnowledgeBase: {
      wifi: { ssid: 'Tribeca-Atelier-8F', password: 'LeonardStreet56' },
      doorCode: null,
      doormanNote: 'Doorman will confirm your ID and show you to the elevator. Unit 8F.',
      checkInTime: '15:00',
      checkOutTime: '11:00',
      parking: 'Valet in building — $55/day. Champion Parking at 60 Leonard, $48/day.',
      nearestSubway: 'Franklin St (1) — 2-min walk; Canal St (A/C/E/J/N/Q/R/W/Z) — 6-min walk.',
      amenities: ['Bosch appliances', 'Heated bathroom floors', 'Concierge', 'Gym', '75th floor observation deck (building)', 'Italian linens'],
      houseRules: ['No smoking', 'No parties', 'No visitors after 10pm', 'Max 2 guests'],
      neighborhood: 'Tribeca — Michelin trifecta within 4 blocks. Bubby\'s for brunch, Frenchette for dinner.',
    },
    autoAcceptLateCheckoutUntil: null, // No auto-accept — always manual
    autoAcceptEarlyCheckinFrom: null,
  },
  {
    slug: 'south-beach-ocean-deco',
    hostawayListingId: '220006',
    name: 'South Beach Ocean Deco',
    address: '1220 Ocean Dr, Unit 307, Miami Beach, FL 33139',
    listingDescription:
      'Art-deco 2BR apartment directly on Ocean Drive. Beach access across the street. Pool, gym, rooftop lounge. Sleeps 4.',
    customKnowledgeBase: {
      wifi: { ssid: 'OceanDeco-307', password: 'SouthBeach1220' },
      doorCode: '5533#',
      checkInTime: '15:00',
      checkOutTime: '11:00',
      parking: 'Garage in building — $40/day, enter on 13th St side.',
      beachAccess: 'Walk out front door, cross Ocean Drive — public beach with lifeguards. Complimentary chairs at front desk (2 per unit).',
      amenities: ['Pool', 'Hot tub', 'Gym', 'Rooftop lounge', 'Beach chairs + umbrella', 'Cooler + beach bag provided'],
      houseRules: ['No smoking', 'No parties', 'Pool closes 10pm', 'Quiet hours 11pm–8am', 'Max 4 guests'],
      neighborhood: 'South Beach proper — Joe\'s Stone Crab 8-min walk, Lincoln Road 10-min walk.',
    },
    autoAcceptLateCheckoutUntil: '13:00',
    autoAcceptEarlyCheckinFrom: '13:00',
  },
  {
    slug: 'brickell-city-heights',
    hostawayListingId: '220007',
    name: 'Brickell City Heights',
    address: '1060 Brickell Ave, Unit 4102, Miami, FL 33131',
    listingDescription:
      'Corporate-friendly 1BR+den on the 41st floor. Bay views, business center, 24/7 fitness. Walk to Brickell City Centre.',
    customKnowledgeBase: {
      wifi: { ssid: 'Brickell-4102', password: 'BrickellAve1060' },
      doorCode: null,
      doormanNote: 'Reception on ground floor. Photo ID required. Elevator access pre-programmed to 41st floor.',
      checkInTime: '16:00',
      checkOutTime: '11:00',
      parking: 'Valet included in building — give ticket at reception.',
      amenities: ['41st-floor bay view', '24/7 gym', 'Business center', 'Pool deck', 'Valet included', 'Workspace desk + monitor'],
      houseRules: ['No smoking', 'No parties', 'Max 3 guests'],
      neighborhood: 'Brickell — walkable to Brickell City Centre, Mary Brickell Village. Zuma 5-min walk.',
    },
    autoAcceptLateCheckoutUntil: '14:00',
    autoAcceptEarlyCheckinFrom: '14:00',
  },
  {
    slug: 'wynwood-art-house',
    hostawayListingId: '220008',
    name: 'Wynwood Art House',
    address: '2601 NW 2nd Ave, Loft 4, Miami, FL 33127',
    listingDescription:
      'Open-plan studio loft in the heart of Wynwood Walls. Original artwork throughout, concrete floors, industrial kitchen. Sleeps 2.',
    customKnowledgeBase: {
      wifi: { ssid: 'WynwoodLoft4', password: 'ArtWalls2024' },
      doorCode: '2244*',
      checkInTime: '15:00',
      checkOutTime: '11:00',
      parking: 'Street parking on NW 2nd Ave and NW 26th — check signs. Paid lot at 2601 NW 1st Ave, $15/day.',
      amenities: ['Curated local artwork', 'Queen bed', 'Kitchenette', 'Industrial AC', 'Record player + vinyl collection'],
      houseRules: ['No smoking', 'No parties', 'Max 2 guests', 'Quiet hours 11pm–8am'],
      neighborhood: 'Wynwood — the graffiti capital. Kyu 4-min walk, Coyo Taco 3-min walk, Wynwood Walls 2-min walk.',
    },
    autoAcceptLateCheckoutUntil: null,
    autoAcceptEarlyCheckinFrom: '14:00',
  },
  {
    slug: 'coconut-grove-garden',
    hostawayListingId: '220009',
    name: 'Coconut Grove Garden Suite',
    address: '3350 SW 27th Ave, Villa 2, Miami, FL 33133',
    listingDescription:
      '2BR garden villa in quiet Coconut Grove. Private patio, BBQ, tropical landscaping. Walking distance to CocoWalk.',
    customKnowledgeBase: {
      wifi: { ssid: 'CoconutGrove-Villa2', password: 'GardenSuite3350' },
      doorCode: '1188#',
      checkInTime: '15:00',
      checkOutTime: '11:00',
      parking: 'Driveway parks 2 cars. No permit needed.',
      amenities: ['Private patio', 'Gas BBQ grill', 'Outdoor dining for 6', 'Washer/dryer', 'King + queen beds', 'Family-friendly'],
      houseRules: ['No smoking', 'No parties', 'Quiet hours 10pm–8am', 'Max 4 guests'],
      neighborhood: 'Coconut Grove — CocoWalk 8-min walk, GreenStreet Cafe 6-min walk, marina 12-min walk.',
    },
    autoAcceptLateCheckoutUntil: '13:00',
    autoAcceptEarlyCheckinFrom: '13:00',
  },
  {
    slug: 'edgewater-bayfront',
    hostawayListingId: '220010',
    name: 'Edgewater Bayfront 22',
    address: '2000 NE 4th Ave, Unit 2204, Miami, FL 33137',
    listingDescription:
      'Spacious 3BR on the 22nd floor with sweeping Biscayne Bay views. Pool, gym, kids playroom. Sleeps 6. Great for families.',
    customKnowledgeBase: {
      wifi: { ssid: 'Edgewater-2204', password: 'BiscayneBay22' },
      doorCode: null,
      doormanNote: 'Concierge will register your ID and issue 2 amenity wristbands (pool/gym access).',
      checkInTime: '16:00',
      checkOutTime: '11:00',
      parking: '2 spots included in valet. Extra spots $25/day.',
      amenities: ['Pool + hot tub', 'Gym', 'Kids playroom', 'Tennis court', 'Bay-view balcony', '3 full bathrooms'],
      houseRules: ['No smoking', 'No parties', 'Max 6 guests', 'Pool closes 10pm'],
      neighborhood: 'Edgewater — quiet residential, 10-min Uber to Wynwood/Design District.',
    },
    autoAcceptLateCheckoutUntil: '13:00',
    autoAcceptEarlyCheckinFrom: '14:00',
  },
];

// ────────────────────────────────────────────────────────────────────────────
// Conversation definitions — 16 realistic guest stories
// ────────────────────────────────────────────────────────────────────────────

interface GuestSeed {
  name: string;
  email: string;
  phone: string;
  nationality: string;
}

type MessageSeed = {
  role: MessageRole;
  content: string;
  sentMinsAgo: number; // relative to NOW
  channel?: Channel;
  imageUrls?: string[];
  previewState?: PreviewState; // For shadow-mode previews
  originalAiText?: string; // For edited sends (audit trail)
  aiConfidence?: number;
  aiMeta?: { sopCategories?: string[]; toolNames?: string[]; autopilotDowngraded?: boolean };
};

interface ConversationSeed {
  hostawayConversationId: string;
  propertySlug: string;
  guest: GuestSeed;
  channel: Channel;
  reservationStatus: ReservationStatus;
  checkInDaysFromNow: number;
  checkOutDaysFromNow: number;
  guestCount: number;
  totalPrice?: number;
  currency?: string;
  aiMode?: 'autopilot' | 'copilot' | 'off';
  aiEnabled?: boolean;
  starred?: boolean;
  unreadCount?: number;
  summary?: string; // Pre-written conversation summary
  screeningAnswers?: Record<string, unknown>;
  messages: MessageSeed[];
}

const CONVERSATIONS: ConversationSeed[] = [
  // 1. SoHo — Elena Rodriguez — INQUIRY, price negotiation for July 4th
  {
    hostawayConversationId: 'hc-220001-elena',
    propertySlug: 'soho-loft',
    guest: { name: 'Elena Rodriguez', email: 'elena.r@gmail.com', phone: '+1-415-555-0121', nationality: 'US' },
    channel: 'AIRBNB',
    reservationStatus: 'INQUIRY',
    checkInDaysFromNow: 18,
    checkOutDaysFromNow: 22,
    guestCount: 4,
    totalPrice: 3280,
    currency: 'USD',
    unreadCount: 1,
    starred: true,
    summary: 'Returning Airbnb user inquiring about SoHo Loft for July 4 weekend, 4 guests. Asked about price flex; AI offered 10% weekly discount framing. Guest mentioned family with two kids — confirmed property is family-friendly with max 4 occupancy.',
    messages: [
      { role: 'GUEST', content: "Hi! We're a family of four looking at your SoHo Loft for July 3rd–7th. Is it still available? And is there any flexibility on the nightly price? Seeing $820/night feels steep for 4 nights.", sentMinsAgo: 180, channel: 'AIRBNB' },
      { role: 'AI', content: "Hi Elena! Great news — those dates (Jul 3–7) are open on the SoHo Loft and it comfortably sleeps 4 with two king bedrooms + a pullout in the living room. For four nights over the July 4th holiday weekend, I can offer a 10% long-weekend discount, which brings your total to $2,952 before cleaning and taxes. Would that work?", sentMinsAgo: 175, channel: 'AIRBNB', aiConfidence: 0.91, aiMeta: { sopCategories: ['sop-booking-inquiry', 'pricing-negotiation'] } },
      { role: 'GUEST', content: "That's better, thanks. A couple of questions before we book: (1) is the roof deck private to our unit or shared? (2) our kids are 6 and 9 — any cribs, baby gear, or gates in the unit? (3) is parking easy in the area?", sentMinsAgo: 140, channel: 'AIRBNB' },
      { role: 'AI', content: "Great questions!\n\n(1) **Roof deck is private to your unit** — you get the keys at check-in. Loungers, a bistro table for 4, and it's where everyone wants to watch the fireworks over the East River on July 4th.\n\n(2) There's no crib or baby gear in the unit (it's set up for adults), but I can arrange a pack-n-play from BabyQuip for around $45 for the stay — just let me know. For 6 and 9, both kids will be fine with the existing beds.\n\n(3) Parking is the weakest part of SoHo — street parking exists but you'll circle. The best paid option is SP+ at 200 Lafayette (3-min walk), around $55/day. If you're driving in, I'd plan on using that.\n\nReady to lock it in?", sentMinsAgo: 90, channel: 'AIRBNB', aiConfidence: 0.94, aiMeta: { sopCategories: ['property-info', 'pre-arrival-logistics', 'sop-amenity-request'], toolNames: ['get_faq'] } },
      { role: 'GUEST', content: "Perfect, that helps. One more — what's the cancellation policy if the kids get sick? And can we bring our dog (small, 12lbs, well-behaved)?", sentMinsAgo: 12, channel: 'AIRBNB' },
    ],
  },

  // 2. Midtown East — James Carter — CONFIRMED, arriving in 2 days
  {
    hostawayConversationId: 'hc-220002-james',
    propertySlug: 'midtown-east-38',
    guest: { name: 'James Carter', email: 'j.carter@deloitte.com', phone: '+1-202-555-0187', nationality: 'US' },
    channel: 'BOOKING',
    reservationStatus: 'CONFIRMED',
    checkInDaysFromNow: 2,
    checkOutDaysFromNow: 7,
    guestCount: 1,
    totalPrice: 1950,
    currency: 'USD',
    unreadCount: 0,
    summary: 'Confirmed corporate traveler, Deloitte consultant arriving Wed for UN General Assembly week. Confirmed arrival details: doorman check-in (no code), suggested Uber routes from JFK, provided building parking + business center info. Guest travels without luggage beyond a carry-on.',
    messages: [
      { role: 'GUEST', content: "Hi, booked through Booking.com. I arrive at JFK Wed at 4pm. Few questions: (1) do I need to call ahead or just show up at the building? (2) is there workspace in the unit for Zoom calls? (3) nearest dry cleaner?", sentMinsAgo: 60 * 8, channel: 'BOOKING' },
      { role: 'AI', content: "Hi James, welcome ahead of time.\n\n(1) Just show up — the doorman has your name from your booking. Bring a photo ID and ask for apt 14B. Check-in is 4pm, so your arrival should line up perfectly. From JFK, Uber to 245 E 38th is typically $55–$75, 45–60 min depending on traffic.\n\n(2) Yes — the unit has a dedicated workspace with a 27\" external monitor, wired ethernet, and a proper office chair. WiFi is 1Gbps. The dining table also seats 4 if you prefer. For all-day calls, I'd recommend the building's business center on the 3rd floor — it's quieter.\n\n(3) Best dry cleaner within 3 blocks is Clean Rite at 250 E 40th (same-day if dropped before 10am). There's a Tide Dry Cleaners at Grand Central if you're going that way.\n\nAnything else before Wednesday?", sentMinsAgo: 60 * 7, channel: 'BOOKING', aiConfidence: 0.93, aiMeta: { sopCategories: ['pre-arrival-logistics', 'property-info'], toolNames: ['get_faq'] } },
      { role: 'GUEST', content: "Super helpful, thank you. Last thing — breakfast in the building or nearby? I have a 9am call every day.", sentMinsAgo: 60 * 4, channel: 'BOOKING' },
      { role: 'AI', content: "Breakfast in the building: no — but there are two solid options within 2 blocks:\n\n• **Court Cafe** at 213 E 38th — classic NY deli, 3-min walk, open 6:30am. Egg sandwiches + coffee ~$10.\n• **Joe Coffee** at 2nd Ave & 38th — 2-min walk, great espresso, pastries. Opens 7am.\n\nFor a sit-down with decent WiFi if you want to take your 9am call there, **Le Pain Quotidien** on 3rd Ave & 40th has communal tables and opens 7:30am.\n\nSafe travels tomorrow!", sentMinsAgo: 60 * 3.8, channel: 'BOOKING', aiConfidence: 0.96, aiMeta: { sopCategories: ['property-info'], toolNames: ['get_faq'] } },
    ],
  },

  // 3. Williamsburg — Priya Shah — CHECKED_IN, BROKEN AC, escalated
  {
    hostawayConversationId: 'hc-220003-priya',
    propertySlug: 'williamsburg-sky-suite',
    guest: { name: 'Priya Shah', email: 'priya.shah88@outlook.com', phone: '+44-7700-900123', nationality: 'GB' },
    channel: 'AIRBNB',
    reservationStatus: 'CHECKED_IN',
    checkInDaysFromNow: -3,
    checkOutDaysFromNow: 2,
    guestCount: 2,
    totalPrice: 2850,
    currency: 'USD',
    unreadCount: 2,
    starred: true,
    summary: 'UK traveler on day 3 of 5. AC in master bedroom stopped cooling this afternoon — guest sent a thermostat photo showing 81F set to 68F. AI escalated immediately as maintenance. Manager dispatched technician; ETA confirmed for 7pm today. Guest has been patient but anxious about tonight\'s sleep.',
    messages: [
      { role: 'GUEST', content: "Hi, checking in tomorrow — just wanted to confirm the door code works and what time we can arrive. Flight lands JFK at 2pm.", sentMinsAgo: 60 * 24 * 4 + 30, channel: 'AIRBNB' },
      { role: 'AI', content: "Hi Priya! Welcome to NYC. Door code for Williamsburg Sky Suite is **9921*** — pressing 9921 then the star key on the keypad. It's active 24/7 starting at 3pm tomorrow (check-in time). From JFK, Uber will be ~$70 and take 45–75 min depending on BQE traffic. The doorman at 185 Kent lets you into the building; 9921* gets you into the unit. Enjoy your stay!", sentMinsAgo: 60 * 24 * 4, channel: 'AIRBNB', aiConfidence: 0.95, aiMeta: { sopCategories: ['sop-wifi-doorcode', 'pre-arrival-logistics'] } },
      { role: 'GUEST', content: "Just arrived — door code worked perfectly. The place is stunning!", sentMinsAgo: 60 * 24 * 3 + 60 * 6, channel: 'AIRBNB' },
      { role: 'AI', content: "So glad to hear, Priya! Enjoy — if you need anything at all, just message here. The rooftop pool opens at 8am and closes at 10pm if you want to catch sunset views.", sentMinsAgo: 60 * 24 * 3 + 60 * 5.8, channel: 'AIRBNB', aiConfidence: 0.97, aiMeta: { sopCategories: ['property-info'] } },
      { role: 'GUEST', content: "Hi, the AC in the master bedroom has stopped cooling. Thermostat says 81F, I've had it set to 68 for the last two hours. Living room mini-split still works. Can someone check?", sentMinsAgo: 180, channel: 'AIRBNB', imageUrls: ['https://demo.urbanstays.co/assets/thermostat-81f.jpg'] },
      { role: 'AI', content: "I'm sorry Priya — that's not acceptable. I'm escalating this to our maintenance team right now. Someone will be in touch within 20 minutes with a technician ETA. In the meantime, please turn off the master bedroom unit fully (switch at thermostat) — running it while malfunctioning can strain the compressor. The living room mini-split + bedroom ceiling fan should keep air moving.", sentMinsAgo: 175, channel: 'AIRBNB', aiConfidence: 0.92, aiMeta: { sopCategories: ['sop-maintenance'], autopilotDowngraded: false } },
      { role: 'HOST', content: "Hi Priya, this is Sarah from the ops team. Our tech Javi will be at the building at 7:00pm tonight with replacement parts. If cooling can't be restored within 60 minutes, we'll move you to our Tribeca unit for tonight at no cost. Apologies for the disruption.", sentMinsAgo: 155, channel: 'AIRBNB' },
      { role: 'GUEST', content: "Thank you both. 7pm works. We'll be in all evening.", sentMinsAgo: 140, channel: 'AIRBNB' },
    ],
  },

  // 4. Hell's Kitchen — Sofia Martinez — CHECKED_IN, late-checkout request (auto-approved path)
  {
    hostawayConversationId: 'hc-220004-sofia',
    propertySlug: 'hells-kitchen-penthouse',
    guest: { name: 'Sofia Martinez', email: 'sofia.m@mexicana.com', phone: '+52-55-5555-0167', nationality: 'MX' },
    channel: 'DIRECT',
    reservationStatus: 'CHECKED_IN',
    checkInDaysFromNow: -5,
    checkOutDaysFromNow: 1,
    guestCount: 5,
    totalPrice: 5400,
    currency: 'USD',
    unreadCount: 0,
    summary: 'Multi-generational family from Mexico City, wrapping up a 6-night stay tomorrow. Requested 1pm late checkout due to 8pm JFK flight — auto-approved because 1pm falls within the property\'s 1pm tenant threshold. Welcome book questions answered in Spanish on request; guest has loved the terrace.',
    messages: [
      { role: 'GUEST', content: "Hola, quick one — our flight is 8pm tomorrow. Can we check out at 1pm instead of 11? Kids are small and we don't want to be at JFK for 5 hours.", sentMinsAgo: 60 * 2, channel: 'DIRECT' },
      { role: 'AI', content: "Hola Sofia — approved, 1pm late checkout confirmed for tomorrow. No extra charge. Your door code stays active until 1pm, so you can take your time packing. A couple of small asks: (a) please strip the master bed before you leave (sheets in a pile on the floor is perfect) and (b) start the dishwasher if there are dishes in it. That's it — enjoy your last day! Joe Allen on 46th has an incredible kids' menu if you need a lunch idea before heading to JFK.", sentMinsAgo: 60 * 1.9, channel: 'DIRECT', aiConfidence: 0.97, aiMeta: { sopCategories: ['sop-late-checkout'] } },
      { role: 'GUEST', content: "Perfecto, thank you!! And yes we already booked Joe Allen 😊", sentMinsAgo: 60 * 1.5, channel: 'DIRECT' },
    ],
  },

  // 5. Tribeca — Michael Chen — CHECKED_OUT, left charger
  {
    hostawayConversationId: 'hc-220005-michael',
    propertySlug: 'tribeca-atelier',
    guest: { name: 'Michael Chen', email: 'mchen.design@icloud.com', phone: '+1-650-555-0199', nationality: 'US' },
    channel: 'AIRBNB',
    reservationStatus: 'CHECKED_OUT',
    checkInDaysFromNow: -8,
    checkOutDaysFromNow: -1,
    guestCount: 2,
    totalPrice: 2600,
    currency: 'USD',
    unreadCount: 1,
    summary: 'Former guest, checked out yesterday. Reports leaving a MacBook charger plugged into the bedroom wall. AI acknowledged and committed to having cleaning crew confirm and ship via FedEx with flat $25 fee. Awaiting cleaning crew visual confirmation (scheduled 2pm today).',
    messages: [
      { role: 'GUEST', content: "Hey — think I left my MacBook charger plugged in next to the bedroom nightstand. Any chance someone can grab it and ship to SF? I'll cover the cost.", sentMinsAgo: 60 * 3, channel: 'AIRBNB' },
      { role: 'AI', content: "Hi Michael, no worries — our cleaning crew is at the Atelier at 2pm today. I'll have them do a sweep of the bedroom nightstand first and confirm. Assuming we find it, standard ship back to SF is $25 flat (FedEx Ground, 5–7 business days). I'll message you a tracking number once it ships. What's the best shipping address?", sentMinsAgo: 60 * 2.9, channel: 'AIRBNB', aiConfidence: 0.89, aiMeta: { sopCategories: ['post-stay-issues'] } },
      { role: 'GUEST', content: "Thanks. 418 Hayes St, Apt 3, San Francisco CA 94102. Michael Chen.", sentMinsAgo: 60 * 2.7, channel: 'AIRBNB' },
    ],
  },

  // 6. SoHo (2nd convo) — David Goldberg — CONFIRMED, early check-in tomorrow
  {
    hostawayConversationId: 'hc-220001-david',
    propertySlug: 'soho-loft',
    guest: { name: 'David Goldberg', email: 'd.goldberg@gs.com', phone: '+1-212-555-0145', nationality: 'US' },
    channel: 'DIRECT',
    reservationStatus: 'CONFIRMED',
    checkInDaysFromNow: 1,
    checkOutDaysFromNow: 4,
    guestCount: 2,
    totalPrice: 2460,
    currency: 'USD',
    unreadCount: 0,
    summary: 'Corporate guest arriving tomorrow. Red-eye from SFO lands at 6am; requested 9am early check-in. Auto-approved (1pm threshold not applied because 9am early check-in is outside the early-window; actually routed to manager and approved within 4 minutes based on property calendar showing nobody checking out today).',
    messages: [
      { role: 'GUEST', content: "Arriving red-eye from SFO tomorrow, landing JFK 6am. Any chance we can check in at 9am instead of 3pm? We're exhausted.", sentMinsAgo: 60 * 5, channel: 'DIRECT' },
      { role: 'AI', content: "Hi David, let me check the property calendar for a 9am check-in request. One moment.", sentMinsAgo: 60 * 4.95, channel: 'DIRECT', aiConfidence: 0.82, aiMeta: { sopCategories: ['sop-early-checkin'], toolNames: ['check_extend_availability'] } },
      { role: 'AI', content: "Good news — the unit is vacant today, cleaning crew is scheduled for 11am–1pm, so the earliest guaranteed ready time is 1pm. I can offer 1pm early check-in (confirmed), plus I'll arrange luggage storage with the building super from 9am if you want to drop bags and grab breakfast. Black Seed Bagels is 3 blocks away and opens at 7. Does that work?", sentMinsAgo: 60 * 4.88, channel: 'DIRECT', aiConfidence: 0.91, aiMeta: { sopCategories: ['sop-early-checkin'] } },
      { role: 'GUEST', content: "That works perfectly, thank you. We'll grab breakfast and come back at 1pm.", sentMinsAgo: 60 * 4.7, channel: 'DIRECT' },
      { role: 'AI', content: "Great — 1pm early check-in is locked in. The door code **4412#** will be active starting 1pm tomorrow. Luggage room is to the right of the main entrance, just buzz \"Super\" when you arrive. Safe flight!", sentMinsAgo: 60 * 4.65, channel: 'DIRECT', aiConfidence: 0.96, aiMeta: { sopCategories: ['sop-early-checkin', 'sop-wifi-doorcode'] } },
    ],
  },

  // 7. South Beach — Isabella Romano — CHECKED_IN, NOISE COMPLAINT escalated
  {
    hostawayConversationId: 'hc-220006-isabella',
    propertySlug: 'south-beach-ocean-deco',
    guest: { name: 'Isabella Romano', email: 'isabella.romano@libero.it', phone: '+39-06-5555-0178', nationality: 'IT' },
    channel: 'AIRBNB',
    reservationStatus: 'CHECKED_IN',
    checkInDaysFromNow: -1,
    checkOutDaysFromNow: 4,
    guestCount: 2,
    totalPrice: 2240,
    currency: 'USD',
    unreadCount: 1,
    starred: true,
    summary: 'Italian traveler on day 2 of 5. Reported loud music + shouting from unit 309 at 2am. AI escalated immediately. Ops team contacted 309 and issued noise warning; also contacted building security. Guest was offered a 1-night credit ($280). Resolution confirmed at 2:40am.',
    messages: [
      { role: 'GUEST', content: "It's 2am here and unit 309 is having what sounds like a party. Music is loud enough that the floor is shaking. We can't sleep. Please help.", sentMinsAgo: 60 * 6.5, channel: 'AIRBNB' },
      { role: 'AI', content: "Isabella, I'm so sorry. I'm escalating this immediately — a manager will be in touch within 5 minutes, and we're notifying building security. This kind of noise is a hard violation of our quiet-hours policy (11pm–8am). Please stay in your unit; security will handle 309 directly.", sentMinsAgo: 60 * 6.4, channel: 'AIRBNB', aiConfidence: 0.94, aiMeta: { sopCategories: ['sop-complaint'] } },
      { role: 'HOST', content: "Hi Isabella, this is Marco on call. I just spoke to 309 and to building security. The noise is being shut down now. As an apology I'm comping tonight's rate ($280) — you'll see a refund within 5 business days. Again, deeply sorry.", sentMinsAgo: 60 * 6.3, channel: 'AIRBNB' },
      { role: 'GUEST', content: "Thank you Marco, it's quiet now. I appreciate how fast you handled it.", sentMinsAgo: 60 * 6.15, channel: 'AIRBNB' },
      { role: 'GUEST', content: "Quick follow-up — can we get a late checkout on Saturday? Our flight isn't until 9pm and we lost two hours of sleep last night.", sentMinsAgo: 30, channel: 'AIRBNB' },
    ],
  },

  // 8. Brickell — Robert Thompson — INQUIRY, corporate rate
  {
    hostawayConversationId: 'hc-220007-robert',
    propertySlug: 'brickell-city-heights',
    guest: { name: 'Robert Thompson', email: 'rthompson@bain.com', phone: '+1-617-555-0192', nationality: 'US' },
    channel: 'DIRECT',
    reservationStatus: 'INQUIRY',
    checkInDaysFromNow: 14,
    checkOutDaysFromNow: 44,
    guestCount: 1,
    totalPrice: 8400,
    currency: 'USD',
    unreadCount: 0,
    summary: 'Bain consultant requesting 30-night corporate stay. AI pulled corporate-rate SOP, offered 20% monthly discount = $240/night. Guest confirmed his office will handle payment through corporate card. Awaiting rate card/invoice from ops team.',
    messages: [
      { role: 'GUEST', content: "Hi, Bain sending me to Miami for a 30-day project. Do you offer corporate or monthly rates on Brickell City Heights? Need a full month starting May 5.", sentMinsAgo: 60 * 24 * 2, channel: 'DIRECT' },
      { role: 'AI', content: "Hi Robert — yes, for 30-night stays we offer a 20% monthly corporate rate. For May 5 – June 4 that brings the nightly from $300 to $240, total $7,200 + $150 cleaning + FL taxes. I can have our ops team send a formal rate card + invoice under your company name. What's the best email address for that?", sentMinsAgo: 60 * 24 * 2 - 60 * 0.5, channel: 'DIRECT', aiConfidence: 0.93, aiMeta: { sopCategories: ['pricing-negotiation', 'sop-long-term-rental'] } },
      { role: 'GUEST', content: "Send to rthompson@bain.com and cc ap@bain.com. Company name: Bain & Company. Thanks.", sentMinsAgo: 60 * 24 * 1.8, channel: 'DIRECT' },
      { role: 'AI', content: "Great — I've routed the rate card request to our ops team. You'll have a formal invoice in your inbox within 24 business hours. Anything else about the unit in the meantime — commute to Brickell City Centre, gym access, etc.?", sentMinsAgo: 60 * 24 * 1.7, channel: 'DIRECT', aiConfidence: 0.95, aiMeta: { sopCategories: ['sop-long-term-rental'] } },
      { role: 'GUEST', content: "Actually yes — business center hours and whether I can get a second monitor set up.", sentMinsAgo: 60 * 24 * 1.5, channel: 'DIRECT' },
      { role: 'AI', content: "Business center is 24/7 with keycard access (you'll have one). The unit already has a 27\" external monitor on the workspace desk + USB-C hub that powers MacBook + monitor off a single cable. If you need a *second* monitor, we can arrange a second 27\" delivered to the unit for a one-time $85 rental for your stay. Let me know.", sentMinsAgo: 60 * 24 * 1.4, channel: 'DIRECT', aiConfidence: 0.94, aiMeta: { sopCategories: ['property-info', 'sop-amenity-request'] } },
    ],
  },

  // 9. Wynwood — Camille Dubois — CONFIRMED, SHADOW PREVIEW PENDING
  {
    hostawayConversationId: 'hc-220008-camille',
    propertySlug: 'wynwood-art-house',
    guest: { name: 'Camille Dubois', email: 'cdubois@sciences-po.fr', phone: '+33-6-5555-0156', nationality: 'FR' },
    channel: 'AIRBNB',
    reservationStatus: 'CONFIRMED',
    checkInDaysFromNow: 3,
    checkOutDaysFromNow: 7,
    guestCount: 2,
    totalPrice: 1560,
    currency: 'USD',
    unreadCount: 1,
    summary: 'Paris-based guest, arriving in 3 days. Asked for non-touristy dinner recommendations near Wynwood. AI drafted a response with three specific suggestions — currently sitting as a Shadow Mode preview awaiting manager review before send.',
    messages: [
      { role: 'GUEST', content: "Bonjour! We arrive Saturday. Looking for 2–3 dinner recommendations near the Wynwood apartment that are NOT tourist traps — more where locals go. We like good wine, not fussy atmosphere.", sentMinsAgo: 60 * 0.5, channel: 'AIRBNB' },
      {
        role: 'AI',
        content: "Bonjour Camille! Three Wynwood/Design District spots locals actually eat at:\n\n1. **Phuc Yea** (2727 NW 2nd Ave, 3-min walk) — Vietnamese-Cajun, the whole snapper is a benchmark, their natural wine list punches above its weight.\n\n2. **Boia De** (5205 NE 2nd Ave, 8-min Uber) — 20-seat Italian in the Upper Buena Vista. Tasting menu + one killer pasta flight. Book now, they\'re tight on availability.\n\n3. **Michael's Genuine** (130 NE 40th St, 6-min Uber) — Design District stalwart, James Beard winner, never changes because it doesn\'t need to. Great by-the-glass list.\n\nLet me know if you want me to help with reservations — Boia De books up two weeks out.",
        sentMinsAgo: 60 * 0.45,
        channel: 'AIRBNB',
        previewState: 'PREVIEW_PENDING',
        originalAiText: "Bonjour Camille! Three Wynwood/Design District spots locals actually eat at:\n\n1. **Phuc Yea** (2727 NW 2nd Ave, 3-min walk) — Vietnamese-Cajun, the whole snapper is a benchmark, their natural wine list punches above its weight.\n\n2. **Boia De** (5205 NE 2nd Ave, 8-min Uber) — 20-seat Italian in the Upper Buena Vista. Tasting menu + one killer pasta flight. Book now, they\'re tight on availability.\n\n3. **Michael's Genuine** (130 NE 40th St, 6-min Uber) — Design District stalwart, James Beard winner, never changes because it doesn\'t need to. Great by-the-glass list.\n\nLet me know if you want me to help with reservations — Boia De books up two weeks out.",
        aiConfidence: 0.88,
        aiMeta: { sopCategories: ['property-info'], toolNames: ['get_faq'] },
      },
    ],
  },

  // 10. Coconut Grove — Emma Williams — CHECKED_IN, cleaning mid-stay
  {
    hostawayConversationId: 'hc-220009-emma',
    propertySlug: 'coconut-grove-garden',
    guest: { name: 'Emma Williams', email: 'emmaw.travel@gmail.com', phone: '+61-4-5555-0134', nationality: 'AU' },
    channel: 'AIRBNB',
    reservationStatus: 'CHECKED_IN',
    checkInDaysFromNow: -4,
    checkOutDaysFromNow: 6,
    guestCount: 4,
    totalPrice: 3800,
    currency: 'USD',
    unreadCount: 0,
    summary: 'Australian family of 4 on day 4 of a 10-night stay. Requested mid-stay cleaning (standard +$65). AI confirmed + scheduled for Tuesday 11am–1pm with the cleaning crew. Guest mentioned they are hosting a small dinner Saturday night — confirmed that 4 guests (no outside visitors) is within the no-parties / max-occupancy rule.',
    messages: [
      { role: 'GUEST', content: "G'day! We're loving the villa. Can we book a cleaning mid-stay? Maybe Tuesday if possible. Would be great to get fresh sheets before my parents arrive Wednesday.", sentMinsAgo: 60 * 24 * 1 + 60 * 4, channel: 'AIRBNB' },
      { role: 'AI', content: "Hi Emma! So glad you're enjoying the villa. Mid-stay cleaning is $65 and includes a full clean + fresh linens on all beds + replenishment of toiletries and coffee. I can book the team for Tuesday 11am–1pm — they'll need roughly 2 hours. Want me to lock that in? (Also, lovely that your parents are joining — just a reminder that max occupancy on the villa is 4 people total, so if they're replacing 2 of your group for a few days we're good.)", sentMinsAgo: 60 * 24 * 1 + 60 * 3.95, channel: 'AIRBNB', aiConfidence: 0.96, aiMeta: { sopCategories: ['sop-cleaning'] } },
      { role: 'GUEST', content: "Yes, Tuesday 11am works. Kids + I will be at the beach. And yes — my partner and I head back to Sydney Thursday so the parents are 'taking over' as it were. Max 4 at any time confirmed 😊", sentMinsAgo: 60 * 24 * 1 + 60 * 3.8, channel: 'AIRBNB' },
      { role: 'AI', content: "Perfect — cleaning locked in, Tuesday 11am–1pm. $65 charge will appear on your reservation. The crew has a key so you don't need to be there. Enjoy the beach — if you haven't been to Vizcaya Gardens yet, 10-min drive, kids tend to love the mazes.", sentMinsAgo: 60 * 24 * 1 + 60 * 3.6, channel: 'AIRBNB', aiConfidence: 0.98, aiMeta: { sopCategories: ['sop-cleaning', 'property-info'] } },
    ],
  },

  // 11. Edgewater — Carlos Mendes — CONFIRMED, group, passport docs needed
  {
    hostawayConversationId: 'hc-220010-carlos',
    propertySlug: 'edgewater-bayfront',
    guest: { name: 'Carlos Mendes', email: 'carlos.m@corporativo.br', phone: '+55-11-5555-0190', nationality: 'BR' },
    channel: 'BOOKING',
    reservationStatus: 'CONFIRMED',
    checkInDaysFromNow: 6,
    checkOutDaysFromNow: 13,
    guestCount: 6,
    totalPrice: 6720,
    currency: 'USD',
    unreadCount: 0,
    summary: 'Brazilian family, 6 guests arriving in 6 days for 1-week stay. Screening flow triggered: requested passports for all 6 adults + marriage certificate (since property is family-only). Guest has uploaded 4/6 passports and a marriage certificate. Awaiting 2 more passport scans.',
    screeningAnswers: {
      travelingWithFamily: true,
      adults: 4,
      children: 2,
      documentChecklist: {
        passportsNeeded: 6,
        passportsReceived: 4,
        marriageCertNeeded: true,
        marriageCertReceived: true,
      },
    },
    messages: [
      { role: 'GUEST', content: "Olá, we are Carlos + wife + my parents + two kids. 6 of us total. Arriving on the 27th for Edgewater Bayfront. What documents do you need?", sentMinsAgo: 60 * 24 * 3, channel: 'BOOKING' },
      { role: 'AI', content: "Hi Carlos! Welcome ahead of time. For groups of 4+ we do a quick screening to keep the property family-friendly. We'll need:\n\n• Passport scans for all 4 adults (you, your wife, both parents) — just front page is fine.\n• A marriage certificate (yours + your wife's) — to confirm the family-only nature of the stay.\n• Kids under 12 don't need documentation.\n\nYou can reply to this message with photos of each. Everything is encrypted end-to-end and deleted 30 days post-stay.", sentMinsAgo: 60 * 24 * 3 - 60 * 0.1, channel: 'BOOKING', aiConfidence: 0.94, aiMeta: { sopCategories: [], toolNames: ['create_document_checklist'] } },
      { role: 'GUEST', content: "Sending now", sentMinsAgo: 60 * 24 * 2.5, channel: 'BOOKING', imageUrls: ['https://demo.urbanstays.co/assets/pp-carlos.jpg'] },
      { role: 'GUEST', content: "", sentMinsAgo: 60 * 24 * 2.48, channel: 'BOOKING', imageUrls: ['https://demo.urbanstays.co/assets/pp-patricia.jpg'] },
      { role: 'GUEST', content: "", sentMinsAgo: 60 * 24 * 2.45, channel: 'BOOKING', imageUrls: ['https://demo.urbanstays.co/assets/marriage-cert.jpg'] },
      { role: 'AI', content: "Received — 2 passports (you + Patricia) and marriage certificate logged. Still need passports for your parents. No rush — anytime before check-in.", sentMinsAgo: 60 * 24 * 2.4, channel: 'BOOKING', aiConfidence: 0.93, aiMeta: { toolNames: ['mark_document_received'] } },
      { role: 'GUEST', content: "Two more", sentMinsAgo: 60 * 24 * 2, channel: 'BOOKING', imageUrls: ['https://demo.urbanstays.co/assets/pp-marcos.jpg', 'https://demo.urbanstays.co/assets/pp-lucia.jpg'] },
      { role: 'AI', content: "Got them — all 4 adults documented, marriage certificate on file. You're cleared for check-in. Door code and final logistics will come 24 hours before arrival. Obrigado!", sentMinsAgo: 60 * 24 * 1.9, channel: 'BOOKING', aiConfidence: 0.96, aiMeta: { toolNames: ['mark_document_received'] } },
    ],
  },

  // 12. South Beach (2nd convo) — Jun Park — PENDING (waiting for booking confirmation)
  {
    hostawayConversationId: 'hc-220006-jun',
    propertySlug: 'south-beach-ocean-deco',
    guest: { name: 'Jun Park', email: 'jun.park@samsung.com', phone: '+82-10-5555-0128', nationality: 'KR' },
    channel: 'BOOKING',
    reservationStatus: 'PENDING',
    checkInDaysFromNow: 10,
    checkOutDaysFromNow: 14,
    guestCount: 2,
    totalPrice: 1800,
    currency: 'USD',
    unreadCount: 0,
    summary: 'Booking.com request submitted yesterday, payment authorized but awaiting host acceptance. Guest asked about confirmation timing. AI explained 24-hour window + offered to ping ops.',
    messages: [
      { role: 'GUEST', content: "Hello, I booked Ocean Deco 2 days ago through Booking.com. Payment went through but status still says Pending. When will it be confirmed?", sentMinsAgo: 60 * 5, channel: 'BOOKING' },
      { role: 'AI', content: "Hi Jun — I see your Booking.com reservation for May 5–9. Booking.com requests sit in \"Pending\" until we confirm on our end, typically within 24 hours of submission. You're at 18 hours so you should hear back today. Want me to flag it for our ops team to confirm sooner? If it helps, your payment hold is fully refundable until we confirm — no risk on your side.", sentMinsAgo: 60 * 4.9, channel: 'BOOKING', aiConfidence: 0.93, aiMeta: { sopCategories: ['sop-booking-confirmation'] } },
      { role: 'GUEST', content: "Yes please, that would help — flying in from Seoul, want to book flights once confirmed.", sentMinsAgo: 60 * 4.7, channel: 'BOOKING' },
      { role: 'AI', content: "Flagged — ops team will confirm within the next hour. You'll get an email from Booking.com and a message here the moment it's live.", sentMinsAgo: 60 * 4.65, channel: 'BOOKING', aiConfidence: 0.95 },
    ],
  },

  // 13. Brickell (2nd convo) — Rachel Kim — CHECKED_IN, WIFI down
  {
    hostawayConversationId: 'hc-220007-rachel',
    propertySlug: 'brickell-city-heights',
    guest: { name: 'Rachel Kim', email: 'rkim.remote@gmail.com', phone: '+1-206-555-0152', nationality: 'US' },
    channel: 'AIRBNB',
    reservationStatus: 'CHECKED_IN',
    checkInDaysFromNow: -2,
    checkOutDaysFromNow: 5,
    guestCount: 1,
    totalPrice: 2700,
    currency: 'USD',
    unreadCount: 0,
    summary: 'Remote worker, 1-week stay, day 2. WiFi dropped — troubleshooting steps provided, then escalated when basic reboot didn\'t fix. Building tech dispatched; 30-min ETA. Guest using phone hotspot in the meantime.',
    messages: [
      { role: 'GUEST', content: "WiFi just stopped working. I tried the password again, no dice. I have a noon call.", sentMinsAgo: 60 * 2, channel: 'AIRBNB' },
      { role: 'AI', content: "Sorry Rachel — let's fix this fast. Two quick steps before I dispatch a tech:\n\n1. Router is in the kitchen cabinet under the coffee machine. Unplug power for 30 sec, plug back in, wait 2 minutes.\n2. Reconnect to **Brickell-4102**, password **BrickellAve1060** (case-sensitive).\n\nIf still down after 2 min, reply and I'll get building tech up immediately.", sentMinsAgo: 60 * 1.95, channel: 'AIRBNB', aiConfidence: 0.91, aiMeta: { sopCategories: ['sop-wifi-doorcode'] } },
      { role: 'GUEST', content: "Rebooted, still nothing. Router lights are on but no internet signal.", sentMinsAgo: 60 * 1.85, channel: 'AIRBNB' },
      { role: 'AI', content: "On it — dispatching building tech now, ETA 25–30 minutes. In the meantime, I'll ask reception to send up a 5G hotspot (~60Mbps, free for today) so your noon call isn't at risk. Someone will knock within 15 min.", sentMinsAgo: 60 * 1.8, channel: 'AIRBNB', aiConfidence: 0.93, aiMeta: { sopCategories: ['sop-wifi-doorcode', 'sop-maintenance'] } },
      { role: 'HOST', content: "Hi Rachel, Marco from ops. Hotspot is on its way up, reception just confirmed. Tech will fix the WiFi within the next 30 min. Your call is covered.", sentMinsAgo: 60 * 1.7, channel: 'AIRBNB' },
      { role: 'GUEST', content: "Got the hotspot — you guys are heroes. Call in 40 min, all good.", sentMinsAgo: 60 * 1.5, channel: 'AIRBNB' },
    ],
  },

  // 14. Wynwood (2nd convo) — Tomás Silva — CHECKED_OUT, review follow-up
  {
    hostawayConversationId: 'hc-220008-tomas',
    propertySlug: 'wynwood-art-house',
    guest: { name: 'Tomás Silva', email: 'tomas.silva@gmail.com', phone: '+351-91-5555-0176', nationality: 'PT' },
    channel: 'AIRBNB',
    reservationStatus: 'CHECKED_OUT',
    checkInDaysFromNow: -6,
    checkOutDaysFromNow: -2,
    guestCount: 2,
    totalPrice: 780,
    currency: 'USD',
    unreadCount: 0,
    summary: 'Checked out 2 days ago. Left positive 5-star review mentioning the art curation. AI sent thank-you reply + offered 10% returning-guest discount.',
    messages: [
      { role: 'GUEST', content: "Left a 5-star review. Great place, loved the art. Will be back for Art Basel.", sentMinsAgo: 60 * 28, channel: 'AIRBNB' },
      { role: 'AI', content: "Tomás — thank you so much, the 5-star review means a lot. For Art Basel: book early, Wynwood sells out 4–6 months ahead. As a returning guest I can hold a 10% discount for you anytime in the next 12 months — just message when you have dates and I'll apply it. Até logo!", sentMinsAgo: 60 * 27, channel: 'AIRBNB', aiConfidence: 0.92, aiMeta: { sopCategories: ['post-stay-issues'] } },
    ],
  },

  // 15. Edgewater (2nd convo) — Hannah Blake — INQUIRY, pets
  {
    hostawayConversationId: 'hc-220010-hannah',
    propertySlug: 'edgewater-bayfront',
    guest: { name: 'Hannah Blake', email: 'hannah.blake@kcl.ac.uk', phone: '+44-7700-900234', nationality: 'GB' },
    channel: 'AIRBNB',
    reservationStatus: 'INQUIRY',
    checkInDaysFromNow: 35,
    checkOutDaysFromNow: 42,
    guestCount: 3,
    unreadCount: 1,
    summary: 'UK guest inquiring about pets policy for Edgewater. AI politely declined (no-pet property) but offered SoHo Loft (pet-friendly) as alternative — though SoHo is NYC, so guest declined and the thread is cold.',
    messages: [
      { role: 'GUEST', content: "Is Edgewater Bayfront pet friendly? Traveling with our golden retriever (trained, 65lbs).", sentMinsAgo: 60 * 48, channel: 'AIRBNB' },
      { role: 'AI', content: "Hi Hannah — unfortunately Edgewater Bayfront is not pet-friendly (HOA restriction, not ours). I'm sorry! If you're flexible on location, our **SoHo Loft in NYC** does accept one dog under 40lbs — but your golden would be over the limit there too. Realistically, for Miami + 65lb dog I'd point you to pet-focused rentals on Rover or BringFido. Sorry we can't accommodate this one.", sentMinsAgo: 60 * 47.5, channel: 'AIRBNB', aiConfidence: 0.96, aiMeta: { sopCategories: ['property-info'] } },
    ],
  },

  // 16. Midtown East (2nd convo) — Aiko Tanaka — CHECKED_IN, extend stay (BOOKING ALTERATION)
  {
    hostawayConversationId: 'hc-220002-aiko',
    propertySlug: 'midtown-east-38',
    guest: { name: 'Aiko Tanaka', email: 'aiko.tanaka@dentsu.co.jp', phone: '+81-90-5555-0144', nationality: 'JP' },
    channel: 'AIRBNB',
    reservationStatus: 'CHECKED_IN',
    checkInDaysFromNow: -6,
    checkOutDaysFromNow: 1,
    guestCount: 1,
    totalPrice: 2730,
    currency: 'USD',
    unreadCount: 0,
    summary: 'Japanese corporate guest, day 6 of 7. Project extended 2 nights; requested to extend stay. AI ran check_extend_availability tool — unit available Wed + Thu, total +$680 → BookingAlteration created in PENDING state, awaiting guest approval of modified terms. Guest confirmed; alteration accepted.',
    messages: [
      { role: 'GUEST', content: "Good morning. My project has extended 2 days. Can I stay through Friday instead of Wednesday? Same unit if possible.", sentMinsAgo: 60 * 26, channel: 'AIRBNB' },
      { role: 'AI', content: "Good morning Aiko — let me check availability.", sentMinsAgo: 60 * 25.95, channel: 'AIRBNB', aiConfidence: 0.88, aiMeta: { toolNames: ['check_extend_availability'] } },
      { role: 'AI', content: "Good news — the unit is open Wednesday and Thursday nights, so you can stay through Friday morning. Two additional nights at the same nightly rate = +$680 ($340/night × 2). No cleaning fee since it's an extension. I've drafted the modification; you'll see it pop up in Airbnb as a booking change request — accept and you're set through Friday 11am.", sentMinsAgo: 60 * 25.9, channel: 'AIRBNB', aiConfidence: 0.94, aiMeta: { sopCategories: ['sop-booking-modification'], toolNames: ['check_extend_availability'] } },
      { role: 'GUEST', content: "Accepted. Arigato gozaimasu.", sentMinsAgo: 60 * 25.5, channel: 'AIRBNB' },
      { role: 'AI', content: "どういたしまして! Your new checkout is Friday 11am. All logistics stay the same — same door code, same WiFi. Safe and productive last two days.", sentMinsAgo: 60 * 25.4, channel: 'AIRBNB', aiConfidence: 0.95, aiMeta: { sopCategories: ['sop-booking-modification'] } },
    ],
  },
];

// ────────────────────────────────────────────────────────────────────────────
// FAQ seed data — 28 entries across 9 categories
// ────────────────────────────────────────────────────────────────────────────

interface FaqSeed {
  question: string;
  answer: string;
  category: string;
  scope: FaqScope;
  propertySlug?: string;
  status?: FaqStatus;
  source?: FaqSource;
  usageCount?: number;
}

const FAQ_SEEDS: FaqSeed[] = [
  // check-in-access
  { question: 'What time is check-in?', answer: 'Standard check-in is 3pm (NYC properties) or 4pm (doorman buildings). Early check-in may be available — just ask the day before.', category: 'check-in-access', scope: 'GLOBAL', usageCount: 58 },
  { question: 'Where do I get the key?', answer: 'Most units use a keyless digital code — you\'ll receive the code 24 hours before check-in. Doorman buildings use a concierge check-in where you show ID.', category: 'check-in-access', scope: 'GLOBAL', usageCount: 42 },
  { question: 'Can I check in early?', answer: 'Early check-in depends on the previous guest\'s checkout and cleaning schedule. We can usually confirm 24 hours in advance. Before noon is rare; after 1pm often works.', category: 'check-in-access', scope: 'GLOBAL', usageCount: 37 },
  { question: 'What if I arrive after midnight?', answer: 'All our units support 24/7 self check-in via keyless code. Doorman buildings also have a night doorman — no issue with late arrivals.', category: 'check-in-access', scope: 'GLOBAL', usageCount: 19 },
  { question: 'Door code for SoHo Loft', answer: 'Door code is 4412# — press 4412 then the # key. Active from 3pm on check-in day through 11am on checkout day.', category: 'check-in-access', scope: 'PROPERTY', propertySlug: 'soho-loft', usageCount: 8 },

  // wifi-technology
  { question: 'What\'s the WiFi password?', answer: 'Each property has its own WiFi. You\'ll receive the SSID and password in your check-in instructions email + texted at 3pm on check-in day.', category: 'wifi-technology', scope: 'GLOBAL', usageCount: 94 },
  { question: 'How do I use the smart TV?', answer: 'All TVs are Samsung smart TVs with Netflix, Hulu, Amazon Prime, Disney+, and Apple TV pre-installed. Log into your own account — no unit account. Remote is on the coffee table.', category: 'wifi-technology', scope: 'GLOBAL', usageCount: 33 },
  { question: 'The WiFi is slow', answer: 'All properties have 500Mbps–1Gbps fiber. If speeds drop below 100Mbps, reboot the router (30 sec unplug) in the kitchen. If still slow after reboot, message us — we\'ll dispatch a tech.', category: 'wifi-technology', scope: 'GLOBAL', usageCount: 14 },

  // parking-transportation
  { question: 'Is there parking?', answer: 'Parking varies by property. Brickell City Heights and Edgewater include valet. Coconut Grove has a driveway. NYC units have paid garages nearby ($45–$65/day). See your specific property\'s welcome email for the closest option.', category: 'parking-transportation', scope: 'GLOBAL', usageCount: 68 },
  { question: 'How do I get from the airport?', answer: 'NYC: JFK → Uber ~$65 / LGA → Uber ~$40 / EWR → Uber ~$75 with tolls. Miami: MIA → Uber ~$30 / FLL → Uber ~$45. All are faster than taxi queues.', category: 'parking-transportation', scope: 'GLOBAL', usageCount: 51 },
  { question: 'What\'s the nearest subway station?', answer: 'NYC properties range from 1 to 8 minute walks to the nearest subway. Check your welcome email for the exact station + lines serving your property.', category: 'parking-transportation', scope: 'GLOBAL', usageCount: 29 },
  { question: 'Can I order an Uber from the building?', answer: 'Yes — most buildings have a designated rideshare pickup area (usually the main entrance). Doorman buildings will flag your Uber for you.', category: 'parking-transportation', scope: 'GLOBAL', usageCount: 17 },

  // local-recommendations
  { question: 'Where should we eat nearby?', answer: 'Each property has a curated local guide in the welcome book. Ask Sienna for specific recommendations (e.g. "date-night Italian near Tribeca") — she knows the neighborhoods.', category: 'local-recommendations', scope: 'GLOBAL', usageCount: 76 },
  { question: 'Best coffee near the SoHo Loft', answer: 'La Cabra (152 Spring St) for the best espresso in NYC, period. Joe Coffee (141 Waverly) if you want a quick walk-up. Gasoline Alley (325 Lafayette) for cold brew and people-watching.', category: 'local-recommendations', scope: 'PROPERTY', propertySlug: 'soho-loft', usageCount: 21 },
  { question: 'Where to go out in Wynwood?', answer: '1306 (1306 N Miami Ave) for drinks. Wynwood Brewing for craft beer. R House for brunch + drag. If you want to dance: Club Space (downtown, 10-min Uber).', category: 'local-recommendations', scope: 'PROPERTY', propertySlug: 'wynwood-art-house', usageCount: 12 },
  { question: 'Grocery options?', answer: 'NYC: Whole Foods and Trader Joe\'s are within 10 min of every property. Miami: Publix is the local staple; Whole Foods exists in Brickell and South Beach.', category: 'local-recommendations', scope: 'GLOBAL', usageCount: 43 },

  // house-rules
  { question: 'Can we have guests over?', answer: 'Maximum occupancy per the booking applies at all times. Small dinner gatherings (friends visiting for a few hours, staying within occupancy cap) are fine. Overnight guests beyond the booking headcount are not permitted. No parties — this is a hard rule.', category: 'house-rules', scope: 'GLOBAL', usageCount: 39 },
  { question: 'Can I smoke?', answer: 'All properties are strictly non-smoking — indoors, balconies, and terraces. Smoking violations result in a $500 cleaning fee. Vaping is also prohibited.', category: 'house-rules', scope: 'GLOBAL', usageCount: 24 },
  { question: 'What are quiet hours?', answer: 'Quiet hours are 10pm–8am (NYC) or 11pm–8am (Miami). We have zero tolerance for noise complaints. Building security will be called if needed.', category: 'house-rules', scope: 'GLOBAL', usageCount: 19 },

  // kitchen-cooking
  { question: 'What appliances are in the kitchen?', answer: 'Full kitchens include: fridge/freezer, oven, stovetop, microwave, dishwasher, Nespresso or drip coffee maker, toaster, electric kettle, and a stocked set of pots/pans + utensils. Specifics vary by unit.', category: 'kitchen-cooking', scope: 'GLOBAL', usageCount: 31 },
  { question: 'Is there a welcome pack?', answer: 'Yes — all units have starter coffee (6 pods or ground), 2 bottles of water, basic pantry (salt, pepper, olive oil, sugar), dish soap, and paper towels. Grocery shopping deliveries can be pre-arranged for $35 service fee.', category: 'kitchen-cooking', scope: 'GLOBAL', usageCount: 22 },

  // amenities-supplies
  { question: 'Can I get more towels?', answer: 'Starter set is 2 bath + 2 hand + 2 washcloths per bedroom. Additional sets available free — just message and we\'ll drop off within 2 hours (standard) or same-day.', category: 'amenities-supplies', scope: 'GLOBAL', usageCount: 37 },
  { question: 'Is there a hair dryer?', answer: 'Yes — every unit has a hair dryer in the master bathroom. Higher-end units (Tribeca, Brickell, Edgewater) have Dyson Supersonic.', category: 'amenities-supplies', scope: 'GLOBAL', usageCount: 18 },
  { question: 'Do you provide toiletries?', answer: 'Each unit has shampoo, conditioner, body wash (bulk-sized bottles from Aesop or Malin+Goetz), bar soap, and a basic first-aid kit. No toothbrushes or razors.', category: 'amenities-supplies', scope: 'GLOBAL', usageCount: 28 },

  // safety-emergencies
  { question: 'Emergency contact?', answer: 'For emergencies (fire, medical, break-in): call 911 first, then message us. For urgent issues (AC, plumbing, lockout): message us 24/7 — average response is under 5 minutes.', category: 'safety-emergencies', scope: 'GLOBAL', usageCount: 8 },
  { question: 'Is there a first-aid kit?', answer: 'Every unit has a first-aid kit in the bathroom cabinet or under the kitchen sink — bandaids, antiseptic, gauze, basic OTC meds.', category: 'safety-emergencies', scope: 'GLOBAL', usageCount: 6 },

  // cleaning-housekeeping
  { question: 'Is mid-stay cleaning available?', answer: 'Yes. Stays 7+ nights include one optional mid-stay cleaning for $65 (includes fresh linens + replenishment of toiletries). Book via message.', category: 'cleaning-housekeeping', scope: 'GLOBAL', usageCount: 31 },
  { question: 'Where do I put the trash?', answer: 'Each unit has 2 trash cans (kitchen + bathroom). Garbage + recycling chute is on every floor in NYC/Miami high-rises (usually marked "T" near the elevator). Coconut Grove: bins in the driveway, collection Mon/Thu.', category: 'cleaning-housekeeping', scope: 'GLOBAL', usageCount: 15 },
];

// ────────────────────────────────────────────────────────────────────────────
// SOP seed data — categories pulled from sop_descriptions.json
// ────────────────────────────────────────────────────────────────────────────

interface SopVariantSeed {
  status: 'DEFAULT' | 'INQUIRY' | 'CONFIRMED' | 'CHECKED_IN';
  content: string;
}

interface SopDefinitionSeed {
  category: string;
  toolDescription: string;
  variants: SopVariantSeed[];
  propertyOverrides?: Array<{
    propertySlug: string;
    status: 'DEFAULT' | 'INQUIRY' | 'CONFIRMED' | 'CHECKED_IN';
    content: string;
  }>;
}

const SOP_SEEDS: SopDefinitionSeed[] = [
  {
    category: 'sop-wifi-doorcode',
    toolDescription:
      'Requesting WiFi credentials, digital lock PIN codes, building entry instructions, or reporting connectivity failures / lockouts.',
    variants: [
      {
        status: 'DEFAULT',
        content:
          '# WiFi & Door Code Protocol\n\n**Policy:** Never share door codes or WiFi passwords with INQUIRY-status guests. Only CONFIRMED/CHECKED_IN.\n\n**On request:**\n1. Verify reservation status before sharing credentials.\n2. Share SSID + password verbatim from property.customKnowledgeBase.wifi.\n3. Share door code verbatim from property.customKnowledgeBase.doorCode. If null, direct to doorman + explain pickup.\n4. For connectivity issues, give reboot steps (router location, 30-sec unplug). If still down after one reboot, escalate as maintenance.\n5. For lockouts, escalate immediately — manager + building locksmith.',
      },
      {
        status: 'INQUIRY',
        content:
          '# WiFi & Door Code — Pre-booking\n\nDo NOT share WiFi password or door code. Instead:\n- "Credentials are shared 24 hours before check-in to confirmed guests."\n- Confirm general building security (doorman, keypad, smart lock) in abstract terms without specifics.',
      },
    ],
  },
  {
    category: 'sop-maintenance',
    toolDescription:
      'Reporting something broken, malfunctioning, or in need of urgent repair (AC, plumbing, appliances, pests).',
    variants: [
      {
        status: 'DEFAULT',
        content:
          '# Maintenance Protocol\n\n**Always escalate urgency: "immediate"**\n\n1. Apologize sincerely. No guest should be inconvenienced by a broken unit.\n2. Gather diagnostic info in one message: what + when started + photo if possible.\n3. Give the guest an immediate mitigation step (e.g., turn off malfunctioning unit to prevent damage).\n4. Commit to a technician dispatch within 20 minutes with ETA.\n5. For severe issues (AC out in summer, water leak, no hot water), offer move to alternate unit.\n6. NEVER leave a guest in limbo. Every message should include a next step with a time commitment.',
      },
      {
        status: 'CHECKED_IN',
        content:
          '# Maintenance — Active Stay\n\nSame as DEFAULT, plus:\n- Confirm technician ETA within the first response. No "we\'ll get back to you."\n- If ETA > 2 hours and the issue is livability-critical (no AC in summer, no hot water, major leak), proactively offer move to another unit at no cost.\n- Follow up 15 min after technician leaves to confirm resolution.',
      },
    ],
    propertyOverrides: [
      {
        propertySlug: 'williamsburg-sky-suite',
        status: 'CHECKED_IN',
        content:
          '# Maintenance — Williamsburg Sky Suite\n\nBuilding-specific notes:\n- Nest thermostat is temperamental above 80F ambient — if cooling fails, FIRST check if bedroom mini-split is set to "fan only" mode (common misconfiguration).\n- Unit 28A has a known hot-water booster; if hot water is weak, contact building super extension 2280 first.\n- Tech on call for building: Javi, (718) 555-0188, direct line.',
      },
    ],
  },
  {
    category: 'sop-late-checkout',
    toolDescription:
      'Requesting to stay past the standard 11 AM vacate hour on the final day.',
    variants: [
      {
        status: 'DEFAULT',
        content:
          '# Late Checkout Protocol\n\n**Policy:**\n- Until 1pm: free, auto-approved (if property.autoAcceptLateCheckoutUntil allows).\n- 1pm–3pm: $40 flat fee, approved by manager (check calendar).\n- 3pm+: $80 flat fee OR decline if next guest arrives same day.\n\n**Script:**\n1. Confirm what time they\'d like to leave.\n2. If within auto-accept window, confirm immediately. Tell them what\'s needed on their end (strip beds, start dishwasher).\n3. If outside window, thank them for asking and state the fee or offer an alternative time.\n4. Never promise something the calendar can\'t support — always verify next arrival.',
      },
      {
        status: 'CHECKED_IN',
        content:
          '# Late Checkout — Active Stay\n\nSame as DEFAULT. Tone: warm + decisive. Use guest\'s first name. Mention a small local touch (nearby brunch spot) when approving a mid-day departure.',
      },
    ],
  },
  {
    category: 'sop-early-checkin',
    toolDescription:
      'Requesting access to the unit before the standard 3 PM move-in hour.',
    variants: [
      {
        status: 'DEFAULT',
        content:
          '# Early Check-in Protocol\n\n**Policy:**\n- Cleaning crew typically in unit 11am–1pm day-of.\n- Earliest guaranteed: 1pm (most units).\n- Pre-1pm: ALWAYS verify previous checkout status + cleaning timing. Do not promise unilaterally.\n- Offer luggage storage with building super OR curated coffee/breakfast spot nearby if early entry not possible.',
      },
      {
        status: 'CONFIRMED',
        content:
          '# Early Check-in — Confirmed Reservation\n\n1. Thank guest for the heads-up.\n2. Check calendar for previous-day checkout (use check_extend_availability tool).\n3. If unit is free (no prior-day checkout) → offer 1pm confirmed, free.\n4. If prior-day CHECKED_OUT → offer 1pm OR luggage storage starting at time requested.\n5. Never promise pre-1pm on a cleaning-day unit.',
      },
    ],
  },
  {
    category: 'sop-cleaning',
    toolDescription:
      'Requesting housekeeping, mid-stay maid service, or deep-clean during the stay.',
    variants: [
      {
        status: 'DEFAULT',
        content:
          '# Cleaning Protocol\n\n**Pricing:** Mid-stay cleaning is $65 flat for stays of 7+ nights; $90 for shorter stays (not typically offered <7 nights).\n\n**Script:**\n1. Confirm desired day + time window (crew needs 2 hours).\n2. Quote the fee explicitly.\n3. Confirm what\'s included: full clean, fresh linens on all beds, toiletry replenishment.\n4. Escalate urgency: "scheduled" after time + fee confirmed.\n5. Remind guest the crew has a key, so they don\'t need to be there.',
      },
    ],
  },
  {
    category: 'sop-complaint',
    toolDescription:
      'Noise, cleanliness, misleading photos, manager demands, negative review threats.',
    variants: [
      {
        status: 'DEFAULT',
        content:
          '# Complaint Handling\n\n**Always escalate urgency: "immediate". Never "resolve" a complaint without manager touch.**\n\n1. Acknowledge + apologize in the first sentence. Never defensive.\n2. Commit to manager contact within 5 minutes.\n3. Take concrete action (contact security, dispatch tech, etc.) — tell the guest what you\'re doing.\n4. After resolution, offer goodwill gesture ($-credit scaled to disruption).\n5. Follow up within 12 hours to confirm satisfaction.\n\n**Never:**\n- Argue or rationalize.\n- Promise refunds without manager approval.\n- Delay — the first 15 minutes define the resolution trajectory.',
      },
    ],
  },
  {
    category: 'sop-booking-inquiry',
    toolDescription:
      'Pre-booking availability, price, and suitability questions (no reservation exists yet).',
    variants: [
      {
        status: 'INQUIRY',
        content:
          '# Pre-booking Inquiry\n\n**Goals:** convert. Be warm, specific, unhurried.\n\n1. Confirm dates + guest count + stay length in first response.\n2. Quote total (nightly × nights + cleaning + taxes) with clear breakdown.\n3. For 7+ nights, mention weekly discount (10–15%).\n4. For 30+ nights, mention corporate/monthly rate (20% off).\n5. Answer property-fit questions with real specifics (floor plan, beds, neighborhood character).\n6. Close with a clear call-to-action: "Want me to lock it in?"\n\n**Never:**\n- Share door codes, WiFi, or exact address pre-booking.\n- Commit to flexibility on price without calendar context.',
      },
    ],
  },
  {
    category: 'sop-amenity-request',
    toolDescription:
      'Requesting extra pillows, towels, baby gear, coffee pods, kitchen items, toiletries.',
    variants: [
      {
        status: 'DEFAULT',
        content:
          '# Amenity Request Protocol\n\n**Policy:** Standard requests (extra towels, pillows, coffee pods) are complimentary.\n**SLA:** 2 hours during working hours (10am–5pm), next morning for after-hours asks.\n\n**Script:**\n1. Confirm exactly what + quantity.\n2. Give time commitment ("within 2 hours" or "before 10am tomorrow").\n3. Escalate urgency: "scheduled" after time confirmed.\n\n**Special items (baby gear, air mattress, high chair, pack-n-play):**\n- Route via BabyQuip or equivalent third-party. Guest pays direct; we facilitate booking.',
      },
    ],
  },
  {
    category: 'pricing-negotiation',
    toolDescription:
      'Guest asking for discount, price-matching competitor platform, or corporate/volume rate.',
    variants: [
      {
        status: 'INQUIRY',
        content:
          '# Pricing Negotiation\n\n**Authority:**\n- 7+ nights: up to 10% off (weekly discount).\n- 14+ nights: up to 15%.\n- 30+ nights: up to 20% (corporate/monthly).\n- Last-minute (<72hrs, low occupancy): up to 15% (check calendar first).\n- Returning guests: 10% anytime.\n\n**Never promise discounts on peak dates** (holidays, major events) without ops approval.\n\n**Script:**\n1. Thank them for asking.\n2. Quote the discount with a reason ("weekly rate for 7+ nights").\n3. Give the updated total.\n4. Soft close: "Ready to lock it in?"',
      },
    ],
  },
  {
    category: 'post-stay-issues',
    toolDescription:
      'Left items, disputed damage charges, review-related follow-ups after the stay has ended.',
    variants: [
      {
        status: 'DEFAULT',
        content:
          '# Post-stay Protocol\n\n**Left items:**\n1. Apologize + commit to a cleaning-crew sweep.\n2. Standard ship-back fee: $25 flat (FedEx Ground, 5–7 days).\n3. Ask for shipping address.\n4. Confirm when crew arrives + update with tracking when shipped.\n\n**Disputed damage charge:**\n- Escalate to ops IMMEDIATELY. Never negotiate directly.\n\n**Negative review:**\n- Listen + acknowledge. Offer goodwill gesture only if complaint is valid.\n- Never ask the guest to edit or remove a review.',
      },
    ],
  },
  {
    category: 'sop-booking-modification',
    toolDescription:
      'Altering confirmed reservation — extending, shortening, date shift, adding guests, unit upgrade.',
    variants: [
      {
        status: 'DEFAULT',
        content:
          '# Booking Modification Protocol\n\n1. Use check_extend_availability tool to verify calendar.\n2. Quote the delta explicitly (new total – old total = $X).\n3. If same unit: NO new cleaning fee (extension only).\n4. If different unit: full re-book with cleaning fee.\n5. Submit booking change through Hostaway; guest accepts on their end.\n6. Confirm final dates + any changed logistics (door codes stay the same for same-unit extensions).',
      },
    ],
  },
];

// ────────────────────────────────────────────────────────────────────────────
// Tool definitions — 6 system + 2 custom
// ────────────────────────────────────────────────────────────────────────────

interface ToolSeed {
  name: string;
  displayName: string;
  description: string;
  defaultDescription: string;
  parameters: Record<string, unknown>;
  agentScope: 'screening' | 'coordinator' | 'both';
  type: 'system' | 'custom';
  enabled?: boolean;
  webhookUrl?: string | null;
}

const TOOL_SEEDS: ToolSeed[] = [
  {
    name: 'get_sop',
    displayName: 'Get SOP',
    description: 'Retrieve standard operating procedure content for a specific situation category (e.g., late checkout, maintenance).',
    defaultDescription: 'Retrieve SOP content by category.',
    parameters: { type: 'object', properties: { category: { type: 'string' } }, required: ['category'] },
    agentScope: 'both',
    type: 'system',
  },
  {
    name: 'get_faq',
    displayName: 'Get FAQ',
    description: 'Retrieve FAQ knowledge base entries by category. Used for routine property questions where an SOP is overkill.',
    defaultDescription: 'Retrieve FAQ entries by category.',
    parameters: { type: 'object', properties: { category: { type: 'string' } }, required: ['category'] },
    agentScope: 'both',
    type: 'system',
  },
  {
    name: 'search_available_properties',
    displayName: 'Search Available Properties',
    description: 'Cross-sell matching properties for an INQUIRY/PENDING guest whose primary choice is unavailable.',
    defaultDescription: 'Search available properties by date + criteria.',
    parameters: { type: 'object', properties: { checkIn: { type: 'string' }, checkOut: { type: 'string' }, guestCount: { type: 'number' }, bedrooms: { type: 'number' } }, required: ['checkIn', 'checkOut', 'guestCount'] },
    agentScope: 'screening',
    type: 'system',
  },
  {
    name: 'create_document_checklist',
    displayName: 'Create Document Checklist',
    description: 'Set up passport/marriage-certificate screening checklist for a guest group.',
    defaultDescription: 'Create document checklist for screening.',
    parameters: { type: 'object', properties: { passportsNeeded: { type: 'number' }, marriageCertNeeded: { type: 'boolean' } }, required: ['passportsNeeded'] },
    agentScope: 'screening',
    type: 'system',
  },
  {
    name: 'check_extend_availability',
    displayName: 'Check Extend Availability',
    description: 'Verify calendar availability for extending a current reservation by N nights in the same unit.',
    defaultDescription: 'Check extend-stay availability.',
    parameters: { type: 'object', properties: { reservationId: { type: 'string' }, additionalNights: { type: 'number' } }, required: ['reservationId', 'additionalNights'] },
    agentScope: 'coordinator',
    type: 'system',
  },
  {
    name: 'mark_document_received',
    displayName: 'Mark Document Received',
    description: 'Log that a passport or marriage certificate has been received for the guest screening checklist.',
    defaultDescription: 'Mark a screening document as received.',
    parameters: { type: 'object', properties: { reservationId: { type: 'string' }, documentType: { type: 'string', enum: ['passport', 'marriage_cert'] }, guestLabel: { type: 'string' } }, required: ['reservationId', 'documentType'] },
    agentScope: 'coordinator',
    type: 'system',
  },
  {
    name: 'check_airport_transfer_pricing',
    displayName: 'Airport Transfer Pricing',
    description: 'Get a live quote for an airport transfer to/from the property using our preferred car-service partner. Returns price + ETA in minutes.',
    defaultDescription: 'Custom: airport transfer quote.',
    parameters: { type: 'object', properties: { airport: { type: 'string', enum: ['JFK', 'LGA', 'EWR', 'MIA', 'FLL'] }, propertyId: { type: 'string' }, direction: { type: 'string', enum: ['to-property', 'to-airport'] }, passengers: { type: 'number' } }, required: ['airport', 'propertyId', 'direction'] },
    agentScope: 'both',
    type: 'custom',
    webhookUrl: 'https://api.urbanstays.co/tools/airport-transfer',
  },
  {
    name: 'query_building_amenities',
    displayName: 'Query Building Amenities',
    description: 'Live-check operational status of in-building amenities (pool, gym, rooftop lounge) for a specific property — e.g., is the pool open right now, is the rooftop reserved for a private event tonight.',
    defaultDescription: 'Custom: live building amenity status.',
    parameters: { type: 'object', properties: { propertyId: { type: 'string' }, amenity: { type: 'string', enum: ['pool', 'gym', 'rooftop', 'business-center', 'sauna'] } }, required: ['propertyId', 'amenity'] },
    agentScope: 'coordinator',
    type: 'custom',
    webhookUrl: 'https://api.urbanstays.co/tools/amenity-status',
  },
];

// ────────────────────────────────────────────────────────────────────────────
// Reply template seeds (feature 043)
// ────────────────────────────────────────────────────────────────────────────

const REPLY_TEMPLATE_SEEDS: Array<{ escalationType: string; decision: string; body: string }> = [
  {
    escalationType: 'late_checkout_request',
    decision: 'approve',
    body: "Hi {GUEST_FIRST_NAME}! All set — late checkout at {REQUESTED_TIME} is confirmed. Your door code stays active until then. Two small asks: please strip the master bed and start the dishwasher if there are dishes in it. Safe travels!",
  },
  {
    escalationType: 'late_checkout_request',
    decision: 'reject',
    body: "Hi {GUEST_FIRST_NAME}, unfortunately we can't extend your checkout past {CHECK_OUT_TIME} today — another guest is arriving and our cleaning crew needs the full window. If you need somewhere to decompress, the rooftop lounge is open 8am–10pm and you can leave your bags with the front desk. Sorry we couldn't do more this time.",
  },
  {
    escalationType: 'early_checkin_request',
    decision: 'approve',
    body: "Hi {GUEST_FIRST_NAME}! Early check-in at {REQUESTED_TIME} is approved — your door code will be active starting then. If you arrive before that, feel free to drop luggage with the building super (main entrance, 9am+).",
  },
  {
    escalationType: 'early_checkin_request',
    decision: 'reject',
    body: "Hi {GUEST_FIRST_NAME}, I'm sorry — we can't guarantee access before {CHECK_IN_TIME} today because cleaning wraps at 1pm. You're welcome to drop bags at the front desk after 9am and grab breakfast nearby — happy to recommend a spot. See you at {CHECK_IN_TIME}!",
  },
];

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────

async function wipeExistingDemoTenant() {
  const existing = await prisma.tenant.findUnique({ where: { email: DEMO_EMAIL } });
  if (!existing) {
    console.log('• No existing demo tenant — clean slate.');
    return;
  }
  console.log(`• Deleting existing demo tenant (${existing.id}) — cascade will clear children.`);
  await prisma.tenant.delete({ where: { id: existing.id } });
  console.log('• Wipe complete.');
}

async function seedTenant() {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
  const webhookSecret = crypto.randomBytes(32).toString('hex');
  const tenant = await prisma.tenant.create({
    data: {
      email: DEMO_EMAIL,
      name: DEMO_NAME,
      passwordHash,
      hostawayApiKey: 'demo_hostaway_not_used',
      hostawayAccountId: '000000',
      webhookSecret,
      plan: 'PRO',
      propertyCount: PROPERTY_SEEDS.length,
      lastSyncedAt: minsAgo(4),
      defaultAutoAcceptLateCheckoutUntil: '13:00',
      defaultAutoAcceptEarlyCheckinFrom: '13:00',
      docHandoffEnabled: false,
    },
  });
  console.log(`✓ Tenant created: ${tenant.id} (${tenant.email})`);
  return tenant;
}

async function seedAiConfig(tenantId: string) {
  const coordinatorPrompt = `# SIENNA — Lead Guest Coordinator, Urban Stays NYC & Miami

You are Sienna, the lead guest coordinator for Urban Stays, a portfolio of 10 design-forward
serviced apartments across New York City and Miami. You speak with warmth, specificity, and
unhurried confidence — the tone of a well-traveled concierge at a boutique hotel.

## Voice
- Use the guest's first name.
- Be specific: name restaurants, streets, walk times. Never generic.
- Short paragraphs. One idea per paragraph.
- English default; respond in guest's language if they write in theirs (Spanish, Portuguese,
  French, Italian, Japanese, Korean are common).

## Available context
Every message has:
{PROPERTY_NAME}, {PROPERTY_ADDRESS}, {GUEST_FIRST_NAME}, {GUEST_LAST_NAME}, {CHECK_IN_DATE},
{CHECK_OUT_DATE}, {GUEST_COUNT}, {RESERVATION_STATUS}, {PROPERTY_KNOWLEDGE_BASE}.

## Tools
- get_sop — policy content
- get_faq — routine property questions
- search_available_properties — cross-sell
- check_extend_availability — modification / extension requests
- create_document_checklist / mark_document_received — screening flow
- check_airport_transfer_pricing — airport transfers
- query_building_amenities — live pool/gym/rooftop status

## Escalation
Escalate any of the following IMMEDIATELY via a Task with urgency "immediate":
- Broken unit (AC, plumbing, WiFi after one reboot, lockouts)
- Noise / neighbor / cleanliness complaints
- Rule violations or pushback on house rules
- Any image that needs human eyes
- Anything ambiguous — when in doubt, escalate.

Escalate with urgency "scheduled" after a confirmed time:
- Mid-stay cleaning booked ($65)
- Late checkout confirmed
- Early check-in confirmed
- Amenity delivery (extra pillows, baby gear)

## Hard rules
- NEVER share door codes or WiFi passwords with INQUIRY guests.
- NEVER promise discounts on peak dates (holidays, major events) without ops approval.
- NEVER negotiate a disputed damage charge directly — always escalate.
- NEVER argue with a guest complaint. Acknowledge, apologize, act.

{BAKED_IN_SOPS}`;

  const screeningPrompt = `# SIENNA — Pre-booking Screening, Urban Stays NYC & Miami

You handle pre-booking inquiries. Your job is to convert quality bookings while filtering out
any party-risk or rule-violation risk guests.

## Voice
Same warmth and specificity as the main coordinator. But slightly faster pace — pre-booking
guests are shopping, so answer their question, quote a total, and close.

## Signals to watch
Red flags (escalate to manager BEFORE confirming any booking):
- "Just me and my friends for my bachelor/bachelorette party"
- "Throwing a small gathering, maybe 10 people"
- Party-size mismatch with bedroom count (e.g., 1BR, 6 guests)
- "Pets — unregistered emotional support animal"
- Short bookings on holiday weekends with vague travel purpose

Green flags (auto-approve if calendar clears):
- Corporate travel (clear employer name)
- Family travel with specific kid ages
- Known return guests
- Long stays (30+ days)

## Tools
- get_sop — pricing / screening protocols
- search_available_properties — cross-sell if primary unit unavailable
- create_document_checklist — 4+ guest group → passport + marriage-cert flow

## Cross-sell
If primary unit is unavailable or guest is on the fence, proactively surface 1–2 alternative
properties. Emphasize specific fit (e.g., "South Beach Ocean Deco is 3 minutes from the beach
and sleeps 4 — your same dates are open").

{BAKED_IN_SOPS}`;

  await prisma.tenantAiConfig.create({
    data: {
      tenantId,
      agentName: 'Sienna',
      agentPersonality:
        'Warm, specific, unhurried. Tone of a well-traveled boutique-hotel concierge. Uses first names. Names specific restaurants and streets. Short paragraphs, one idea each.',
      customInstructions:
        'Default English. Mirror the guest\'s language when they write in Spanish, Portuguese, French, Italian, Japanese, or Korean. For NYC recommendations, favor neighborhood-specific spots over chains. For Miami, lean into the art/design scene where relevant.',
      model: 'gpt-5.4-mini-2026-03-17',
      temperature: 0.25,
      maxTokens: 1024,
      debounceDelayMs: 30000,
      adaptiveDebounce: true,
      aiEnabled: true,
      screeningEnabled: true,
      memorySummaryEnabled: true,
      workingHoursEnabled: true,
      workingHoursStart: '08:00',
      workingHoursEnd: '23:00',
      workingHoursTimezone: 'America/New_York',
      reasoningCoordinator: 'auto',
      reasoningScreening: 'low',
      systemPromptCoordinator: coordinatorPrompt,
      systemPromptScreening: screeningPrompt,
      systemPromptVersion: 3,
      shadowModeEnabled: true,
      autopilotMinConfidence: 0.78,
      judgeThreshold: 0.75,
      judgeMode: 'evaluate_all',
      highConfidenceThreshold: 0.85,
      lowConfidenceThreshold: 0.55,
      imageHandlingInstructions:
        'When a guest sends an image, do not attempt to interpret it. Acknowledge receipt, ask whether it relates to a maintenance issue, and escalate immediately with urgency "immediate" so a human can review.',
      systemPromptHistory: [
        { version: 1, timestamp: daysAgo(14).toISOString(), note: 'Initial prompt imported from defaults.' },
        { version: 2, timestamp: daysAgo(7).toISOString(), note: 'Tightened escalation rules after noise-complaint review.', coordinator: coordinatorPrompt.slice(0, 200) + '…' },
        { version: 3, timestamp: daysAgo(2).toISOString(), note: 'Added multi-language mirroring instruction.' },
      ],
    },
  });
  console.log('✓ TenantAiConfig seeded (Sienna, shadowMode on).');
}

async function seedProperties(tenantId: string) {
  const byId: Record<string, string> = {};
  for (const seed of PROPERTY_SEEDS) {
    const row = await prisma.property.create({
      data: {
        tenantId,
        hostawayListingId: seed.hostawayListingId,
        name: seed.name,
        address: seed.address,
        listingDescription: seed.listingDescription,
        customKnowledgeBase: seed.customKnowledgeBase as any,
        autoAcceptLateCheckoutUntil: seed.autoAcceptLateCheckoutUntil ?? null,
        autoAcceptEarlyCheckinFrom: seed.autoAcceptEarlyCheckinFrom ?? null,
      },
    });
    byId[seed.slug] = row.id;
  }
  console.log(`✓ ${PROPERTY_SEEDS.length} properties seeded.`);
  return byId;
}

async function seedConversations(tenantId: string, propertyIdBySlug: Record<string, string>) {
  const createdTasks: Array<{ title: string; note: string; urgency: string; type: string; conversationId: string; propertyId: string; status: string; source: string }> = [];
  const aiLogsToCreate: Array<{ conversationId: string; agentName: string; model: string; sentAt: Date; systemPromptLen: number; ragContext: Record<string, unknown> }> = [];

  for (const [i, convo] of CONVERSATIONS.entries()) {
    const propertyId = propertyIdBySlug[convo.propertySlug];
    if (!propertyId) throw new Error(`Unknown property slug: ${convo.propertySlug}`);

    // Guest
    const guest = await prisma.guest.create({
      data: {
        tenantId,
        hostawayGuestId: `hg-${convo.hostawayConversationId}`,
        name: convo.guest.name,
        email: convo.guest.email,
        phone: convo.guest.phone,
        nationality: convo.guest.nationality,
      },
    });

    // Reservation
    const checkIn = daysFromNow(convo.checkInDaysFromNow);
    const checkOut = daysFromNow(convo.checkOutDaysFromNow);
    const reservation = await prisma.reservation.create({
      data: {
        tenantId,
        propertyId,
        guestId: guest.id,
        hostawayReservationId: `hr-${convo.hostawayConversationId}`,
        checkIn,
        checkOut,
        guestCount: convo.guestCount,
        channel: convo.channel,
        status: convo.reservationStatus,
        screeningAnswers: (convo.screeningAnswers ?? {}) as any,
        aiEnabled: convo.aiEnabled ?? true,
        aiMode: convo.aiMode ?? 'autopilot',
        totalPrice: convo.totalPrice ?? undefined,
        currency: convo.currency ?? undefined,
        createdAt: daysAgo(Math.max(1, Math.abs(convo.checkInDaysFromNow) + 5)),
      },
    });

    // Conversation
    const sortedMessages = [...convo.messages].sort((a, b) => b.sentMinsAgo - a.sentMinsAgo); // oldest → newest by iterating reverse
    const oldestFirst = [...convo.messages].sort((a, b) => b.sentMinsAgo - a.sentMinsAgo);
    const newestFirst = [...convo.messages].sort((a, b) => a.sentMinsAgo - b.sentMinsAgo);
    const lastMessageAt = minsAgo(newestFirst[0]?.sentMinsAgo ?? 60);

    const conversation = await prisma.conversation.create({
      data: {
        tenantId,
        reservationId: reservation.id,
        guestId: guest.id,
        propertyId,
        channel: convo.channel,
        status: 'OPEN',
        starred: convo.starred ?? false,
        unreadCount: convo.unreadCount ?? 0,
        lastMessageAt,
        hostawayConversationId: convo.hostawayConversationId,
        conversationSummary: convo.summary ?? null,
        summaryUpdatedAt: convo.summary ? daysAgo(0.5) : null,
        summaryMessageCount: convo.summary ? convo.messages.length : 0,
        lastSyncedAt: minsAgo(5),
        createdAt: daysAgo(Math.max(1, Math.abs(convo.checkInDaysFromNow) + 5)),
      },
    });

    // Messages (oldest first)
    for (const msg of oldestFirst) {
      const sentAt = minsAgo(msg.sentMinsAgo);
      const msgRow = await prisma.message.create({
        data: {
          conversationId: conversation.id,
          tenantId,
          role: msg.role,
          content: msg.content,
          channel: msg.channel ?? convo.channel,
          sentAt,
          hostawayMessageId: `hm-${conversation.id}-${Math.floor(sentAt.getTime() / 1000)}`,
          imageUrls: msg.imageUrls ?? [],
          previewState: msg.previewState ?? null,
          originalAiText: msg.originalAiText ?? null,
          aiConfidence: msg.aiConfidence ?? (msg.role === 'AI' ? 0.9 : null),
          deliveryStatus: msg.role === 'AI' || msg.role === 'HOST' ? (msg.previewState ? 'pending' : 'sent') : null,
          deliveredAt: (msg.role === 'AI' || msg.role === 'HOST') && !msg.previewState ? sentAt : null,
          source: msg.role === 'AI' ? 'ai' : msg.role === 'HOST' ? 'web' : null,
        },
      });

      // Push an AiApiLog for each AI message (approx)
      if (msg.role === 'AI' && !msg.previewState) {
        aiLogsToCreate.push({
          conversationId: conversation.id,
          agentName: convo.reservationStatus === 'INQUIRY' || convo.reservationStatus === 'PENDING' ? 'guestScreening' : 'guestCoordinator',
          model: 'gpt-5.4-mini-2026-03-17',
          sentAt: new Date(sentAt.getTime() - 3000),
          systemPromptLen: 4200,
          ragContext: {
            sopCategories: msg.aiMeta?.sopCategories ?? [],
            toolNames: msg.aiMeta?.toolNames ?? [],
            confidence: msg.aiConfidence ?? 0.9,
            autopilotDowngraded: msg.aiMeta?.autopilotDowngraded ?? false,
          },
        });
      }
    }

    // Tasks derived from conversation content
    if (convo.propertySlug === 'williamsburg-sky-suite' && convo.reservationStatus === 'CHECKED_IN') {
      createdTasks.push({
        title: 'Master bedroom AC not cooling — unit 28A',
        note: 'Guest (Priya Shah) reported AC set to 68F but reading 81F. Thermostat photo attached in conversation. Tech Javi dispatched, ETA 7pm. If unresolved by 8pm, move guest to Tribeca Atelier.',
        urgency: 'immediate',
        type: 'maintenance',
        conversationId: conversation.id,
        propertyId,
        status: 'open',
        source: 'ai',
      });
    }
    if (convo.propertySlug === 'south-beach-ocean-deco' && convo.reservationStatus === 'CHECKED_IN' && convo.guest.name === 'Isabella Romano') {
      createdTasks.push({
        title: 'Noise complaint — unit 309 loud music 2am',
        note: 'Guest Isabella Romano (307) reported 2am noise from unit 309. Marco from ops contacted, security dispatched, 1-night credit offered ($280). Resolved at 2:40am but follow-up with 309 required — formal warning on file.',
        urgency: 'immediate',
        type: 'noise_complaint',
        conversationId: conversation.id,
        propertyId,
        status: 'resolved',
        source: 'ai',
      });
    }
    if (convo.propertySlug === 'brickell-city-heights' && convo.guest.name === 'Rachel Kim') {
      createdTasks.push({
        title: 'WiFi down — unit 4102',
        note: 'Guest Rachel Kim, remote worker with noon call. Basic reboot didn\'t resolve. Building tech dispatched, ETA 30 min. Hotspot delivered for immediate coverage.',
        urgency: 'immediate',
        type: 'maintenance',
        conversationId: conversation.id,
        propertyId,
        status: 'in_progress',
        source: 'ai',
      });
    }
    if (convo.propertySlug === 'hells-kitchen-penthouse' && convo.reservationStatus === 'CHECKED_IN') {
      createdTasks.push({
        title: '1pm late checkout — Sofia Martinez',
        note: 'Auto-approved (within 1pm threshold). No fee. Guest reminded to strip master bed + start dishwasher.',
        urgency: 'scheduled',
        type: 'late_checkout_request',
        conversationId: conversation.id,
        propertyId,
        status: 'resolved',
        source: 'ai',
      });
    }
    if (convo.propertySlug === 'coconut-grove-garden' && convo.guest.name === 'Emma Williams') {
      createdTasks.push({
        title: 'Mid-stay cleaning — Tuesday 11am–1pm',
        note: '$65 charged. Fresh linens on all beds. Crew has key.',
        urgency: 'scheduled',
        type: 'cleaning_request',
        conversationId: conversation.id,
        propertyId,
        status: 'open',
        source: 'ai',
      });
    }
    if (convo.propertySlug === 'soho-loft' && convo.guest.name === 'David Goldberg') {
      createdTasks.push({
        title: '1pm early check-in — David Goldberg',
        note: 'Approved. Cleaning 11am–1pm, door code active from 1pm. Luggage storage from 9am with building super.',
        urgency: 'scheduled',
        type: 'early_checkin_request',
        conversationId: conversation.id,
        propertyId,
        status: 'open',
        source: 'ai',
      });
    }
    if (convo.propertySlug === 'tribeca-atelier' && convo.guest.name === 'Michael Chen') {
      createdTasks.push({
        title: 'Left item — MacBook charger',
        note: 'Cleaning crew 2pm today. If found, ship FedEx Ground to 418 Hayes St, Apt 3, San Francisco CA 94102. $25 flat fee.',
        urgency: 'info_request',
        type: 'left_item',
        conversationId: conversation.id,
        propertyId,
        status: 'open',
        source: 'ai',
      });
    }
    if (convo.propertySlug === 'edgewater-bayfront' && convo.guest.name === 'Carlos Mendes') {
      createdTasks.push({
        title: 'Passport screening — Mendes family (complete)',
        note: 'All 4 adults documented. Marriage certificate on file. Cleared for check-in.',
        urgency: 'info_request',
        type: 'screening',
        conversationId: conversation.id,
        propertyId,
        status: 'resolved',
        source: 'ai',
      });
    }
    if (convo.propertySlug === 'midtown-east-38' && convo.guest.name === 'Aiko Tanaka') {
      createdTasks.push({
        title: 'Booking extension +2 nights — Aiko Tanaka',
        note: 'Wed + Thu nights. +$680 total. Alteration accepted through Airbnb. Checkout moved to Fri 11am.',
        urgency: 'scheduled',
        type: 'booking_modification',
        conversationId: conversation.id,
        propertyId,
        status: 'resolved',
        source: 'ai',
      });
    }
    if (convo.propertySlug === 'brickell-city-heights' && convo.guest.name === 'Robert Thompson') {
      createdTasks.push({
        title: 'Corporate rate card — Bain, 30 nights',
        note: '20% off = $240/night × 30 = $7,200. Send formal invoice to rthompson@bain.com cc ap@bain.com. Company name: Bain & Company.',
        urgency: 'info_request',
        type: 'pricing_quote',
        conversationId: conversation.id,
        propertyId,
        status: 'in_progress',
        source: 'ai',
      });
    }
    if (convo.propertySlug === 'wynwood-art-house' && convo.guest.name === 'Tomás Silva') {
      createdTasks.push({
        title: 'Returning-guest discount offered — Tomás Silva',
        note: '5-star review. 10% discount offered for Art Basel dates. Flag for CRM.',
        urgency: 'info_request',
        type: 'returning_guest',
        conversationId: conversation.id,
        propertyId,
        status: 'resolved',
        source: 'ai',
      });
    }

    if ((i + 1) % 4 === 0) console.log(`  … ${i + 1}/${CONVERSATIONS.length} conversations seeded`);
  }

  // Create tasks
  for (const task of createdTasks) {
    await prisma.task.create({
      data: {
        tenantId,
        conversationId: task.conversationId,
        propertyId: task.propertyId,
        title: task.title,
        note: task.note,
        urgency: task.urgency,
        type: task.type,
        status: task.status,
        source: task.source,
      },
    });
  }
  console.log(`✓ ${createdTasks.length} tasks seeded.`);

  // Create AI logs
  for (const log of aiLogsToCreate) {
    await prisma.aiApiLog.create({
      data: {
        tenantId,
        conversationId: log.conversationId,
        agentName: log.agentName,
        model: log.model,
        temperature: 0.25,
        maxTokens: 1024,
        systemPrompt: '(system prompt — ~4200 chars, full prompt snapshot persisted)',
        userContent: '(rolled-up conversation history)',
        responseText: '(structured JSON response with reply + tasks + rag)',
        inputTokens: Math.floor(2800 + Math.random() * 1400),
        outputTokens: Math.floor(180 + Math.random() * 240),
        costUsd: 0.012 + Math.random() * 0.009,
        durationMs: Math.floor(1400 + Math.random() * 2200),
        ragContext: log.ragContext as any,
        createdAt: log.sentAt,
      },
    });
  }
  console.log(`✓ ${aiLogsToCreate.length} AI API logs seeded.`);

  return { createdTasks, aiLogsToCreate };
}

async function seedFaqs(tenantId: string, propertyIdBySlug: Record<string, string>) {
  let count = 0;
  for (const faq of FAQ_SEEDS) {
    const propertyId = faq.propertySlug ? propertyIdBySlug[faq.propertySlug] ?? null : null;
    await prisma.faqEntry.create({
      data: {
        tenantId,
        propertyId,
        question: faq.question,
        answer: faq.answer,
        category: faq.category,
        scope: faq.scope,
        status: faq.status ?? 'ACTIVE',
        source: faq.source ?? 'MANUAL',
        usageCount: faq.usageCount ?? 0,
        lastUsedAt: faq.usageCount ? daysAgo(Math.random() * 7) : null,
      },
    });
    count++;
  }
  // Plus a couple of SUGGESTED entries (auto-suggested by the nano model, awaiting manager approval)
  await prisma.faqEntry.create({
    data: {
      tenantId,
      question: 'Do you offer airport pickup?',
      answer: 'Yes — we\'ve partnered with a local car service for fixed-price airport transfers. Use the check_airport_transfer_pricing tool for a live quote.',
      category: 'parking-transportation',
      scope: 'GLOBAL',
      status: 'SUGGESTED',
      source: 'AUTO_SUGGESTED',
      usageCount: 0,
    },
  });
  await prisma.faqEntry.create({
    data: {
      tenantId,
      question: 'Can I get extra coffee pods?',
      answer: 'Yes, complimentary — we\'ll drop off a fresh sleeve of Nespresso pods within 2 hours during working hours.',
      category: 'amenities-supplies',
      scope: 'GLOBAL',
      status: 'SUGGESTED',
      source: 'AUTO_SUGGESTED',
      usageCount: 0,
    },
  });
  count += 2;
  console.log(`✓ ${count} FAQ entries seeded (${count - 2} active, 2 suggested).`);
}

async function seedSops(tenantId: string, propertyIdBySlug: Record<string, string>) {
  let defCount = 0;
  let variantCount = 0;
  let overrideCount = 0;

  for (const sop of SOP_SEEDS) {
    const def = await prisma.sopDefinition.create({
      data: {
        tenantId,
        category: sop.category,
        toolDescription: sop.toolDescription,
        enabled: true,
      },
    });
    defCount++;

    for (const v of sop.variants) {
      await prisma.sopVariant.create({
        data: {
          sopDefinitionId: def.id,
          status: v.status,
          content: v.content,
          enabled: true,
        },
      });
      variantCount++;
    }

    if (sop.propertyOverrides) {
      for (const ovr of sop.propertyOverrides) {
        const propertyId = propertyIdBySlug[ovr.propertySlug];
        if (!propertyId) continue;
        await prisma.sopPropertyOverride.create({
          data: {
            sopDefinitionId: def.id,
            propertyId,
            status: ovr.status,
            content: ovr.content,
            enabled: true,
          },
        });
        overrideCount++;
      }
    }
  }
  console.log(`✓ SOPs: ${defCount} definitions, ${variantCount} variants, ${overrideCount} property overrides.`);
}

async function seedTools(tenantId: string) {
  for (const tool of TOOL_SEEDS) {
    await prisma.toolDefinition.create({
      data: {
        tenantId,
        name: tool.name,
        displayName: tool.displayName,
        description: tool.description,
        defaultDescription: tool.defaultDescription,
        parameters: tool.parameters as any,
        agentScope: tool.agentScope,
        type: tool.type,
        enabled: tool.enabled ?? true,
        webhookUrl: tool.webhookUrl ?? null,
        webhookTimeout: 10000,
      },
    });
  }
  console.log(`✓ ${TOOL_SEEDS.length} tools seeded (6 system + 2 custom webhook).`);
}

async function seedReplyTemplates(tenantId: string) {
  for (const t of REPLY_TEMPLATE_SEEDS) {
    await prisma.automatedReplyTemplate.create({
      data: {
        tenantId,
        escalationType: t.escalationType,
        decision: t.decision,
        body: t.body,
      },
    });
  }
  console.log(`✓ ${REPLY_TEMPLATE_SEEDS.length} reply templates seeded (feature 043).`);
}

async function seedPendingReplies(tenantId: string) {
  // Find Hannah's INQUIRY conversation (pet question) — still unanswered; simulate an active debounce
  const pending = await prisma.conversation.findFirst({
    where: { tenantId, hostawayConversationId: 'hc-220001-elena' },
  });
  if (pending) {
    await prisma.pendingAiReply.create({
      data: {
        conversationId: pending.id,
        tenantId,
        scheduledAt: new Date(NOW.getTime() + 18 * 1000), // fires in 18 seconds
        fired: false,
        suggestion: 'Will confirm cancellation policy (48hr for full refund on this unit) and clarify pet policy (small dogs under 20lbs OK with $150 pet fee) once debounce completes.',
      },
    });
    console.log('✓ PendingAiReply seeded (Elena — debouncing).');
  }
}

async function seedWebhookLogs(tenantId: string) {
  const events = [
    { event: 'reservation.created', hostawayId: 'hr-hc-220001-david', status: 'processed' },
    { event: 'message.received', hostawayId: 'hm-5511', status: 'processed' },
    { event: 'message.received', hostawayId: 'hm-5512', status: 'processed' },
    { event: 'reservation.modified', hostawayId: 'hr-hc-220002-aiko', status: 'processed' },
    { event: 'message.received', hostawayId: 'hm-5513', status: 'processed' },
    { event: 'message.received', hostawayId: 'hm-5514', status: 'processed' },
    { event: 'reservation.created', hostawayId: 'hr-hc-220007-robert', status: 'processed' },
    { event: 'alteration.requested', hostawayId: 'hr-hc-220002-aiko', status: 'processed' },
  ];
  for (const [i, e] of events.entries()) {
    await prisma.webhookLog.create({
      data: {
        tenantId,
        event: e.event,
        hostawayId: e.hostawayId,
        status: e.status,
        durationMs: Math.floor(80 + Math.random() * 340),
        createdAt: hoursAgo(i + 1),
        payload: { demo: true, event: e.event, id: e.hostawayId },
      },
    });
  }
  console.log(`✓ ${events.length} webhook logs seeded.`);
}

async function main() {
  console.log('\n==================================================');
  console.log(' GuestPilot v2 — Demo Seed (Urban Stays NYC & Miami)');
  console.log('==================================================\n');

  await wipeExistingDemoTenant();
  const tenant = await seedTenant();
  await seedAiConfig(tenant.id);
  const propertyIdBySlug = await seedProperties(tenant.id);
  await seedConversations(tenant.id, propertyIdBySlug);
  await seedFaqs(tenant.id, propertyIdBySlug);
  await seedSops(tenant.id, propertyIdBySlug);
  await seedTools(tenant.id);
  await seedReplyTemplates(tenant.id);
  await seedPendingReplies(tenant.id);
  await seedWebhookLogs(tenant.id);

  console.log('\n==================================================');
  console.log(' ✓ DEMO SEED COMPLETE');
  console.log('==================================================');
  console.log(`  Tenant ID:  ${tenant.id}`);
  console.log(`  Email:      ${DEMO_EMAIL}`);
  console.log(`  Password:   ${DEMO_PASSWORD}`);
  console.log(`  Properties: ${PROPERTY_SEEDS.length}`);
  console.log(`  Convos:     ${CONVERSATIONS.length}`);
  console.log(`  Agent name: Sienna`);
  console.log('==================================================\n');
  console.log(' Next steps:');
  console.log('  1. Set NEXT_PUBLIC_API_URL in frontend Vercel to this backend\'s URL');
  console.log('  2. In frontend, visit /login and sign in with the credentials above');
  console.log('  3. Leave ENABLE_BUILD_MODE unset — Agent page returns 404 as intended');
  console.log('  4. Set OPENAI_API_KEY if you want Sandbox tab to live-call the pipeline');
  console.log('  5. Leave HOSTAWAY_API_KEY unset — no real Hostaway calls in the demo');
  console.log('');
}

main()
  .catch((err) => {
    console.error('\n❌ Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
