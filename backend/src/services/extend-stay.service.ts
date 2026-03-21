/**
 * Extend Stay Tool Handler
 * Checks property availability for date extensions/modifications,
 * calculates pricing, and generates channel-specific alteration instructions.
 */

import { getListingCalendar, calculateReservationPrice } from './hostaway.service';

interface ExtendStayInput {
  new_checkout: string;    // YYYY-MM-DD
  new_checkin?: string;    // YYYY-MM-DD (optional, for date shifts)
  reason?: string;
}

interface ExtendStayContext {
  listingId: string;       // Hostaway listing ID
  currentCheckIn: string;  // YYYY-MM-DD
  currentCheckOut: string; // YYYY-MM-DD
  channel: string;         // AIRBNB | BOOKING | DIRECT | OTHER | WHATSAPP
  numberOfGuests: number;
  hostawayAccountId: string;
  hostawayApiKey: string;
}

interface ExtendStayResult {
  available: boolean;
  current_dates: string;
  requested_dates: string;
  additional_nights: number;
  price_per_night?: number | null;
  total_additional_cost?: number | null;
  currency?: string | null;
  channel: string;
  channel_instructions: string | null;
  max_available_extension?: number | null;
  conflict_starts?: string | null;
  message?: string;
  is_shortening?: boolean;
}

// ─── Channel instruction generator ──────────────────────────────────────────

function getChannelInstructions(channel: string, newCheckout: string, newCheckin?: string): string {
  const dateDesc = newCheckin
    ? `new dates (${newCheckin} to ${newCheckout})`
    : `new checkout date (${newCheckout})`;

  switch (channel.toUpperCase()) {
    case 'AIRBNB':
      return `Please submit an alteration request through Airbnb for the ${dateDesc}. We'll approve it right away.`;
    case 'BOOKING':
      return `Please modify your reservation dates through Booking.com to the ${dateDesc}.`;
    case 'DIRECT':
    case 'WHATSAPP':
    case 'OTHER':
    default:
      return `I'll arrange the date change for you. Our team will confirm the ${dateDesc} shortly.`;
  }
}

// ─── Date helpers ───────────────────────────────────────────────────────────

function daysBetween(start: string, end: string): number {
  const s = new Date(start + 'T00:00:00Z');
  const e = new Date(end + 'T00:00:00Z');
  return Math.round((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24));
}

function formatDateRange(start: string, end: string): string {
  const s = new Date(start + 'T00:00:00Z');
  const e = new Date(end + 'T00:00:00Z');
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${fmt(s)}–${fmt(e)}`;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

// ─── Main handler ───────────────────────────────────────────────────────────

export async function checkExtendAvailability(
  input: unknown,
  context: unknown
): Promise<string> {
  const typedInput = input as ExtendStayInput;
  const ctx = context as ExtendStayContext;

  const { currentCheckIn, currentCheckOut, channel, listingId, numberOfGuests } = ctx;
  const newCheckout = typedInput.new_checkout;
  const newCheckin = typedInput.new_checkin || currentCheckIn;

  const currentDates = formatDateRange(currentCheckIn, currentCheckOut);
  const requestedDates = formatDateRange(newCheckin, newCheckout);

  // ─── Shortened stay: no availability check needed ─────────────────────
  if (newCheckout <= currentCheckOut && newCheckin >= currentCheckIn) {
    const nightsReduced = daysBetween(newCheckout, currentCheckOut);
    const result: ExtendStayResult = {
      available: true,
      current_dates: currentDates,
      requested_dates: requestedDates,
      additional_nights: -nightsReduced,
      channel,
      channel_instructions: getChannelInstructions(channel, newCheckout, typedInput.new_checkin),
      is_shortening: true,
      message: `Shortened stay by ${nightsReduced} night${nightsReduced !== 1 ? 's' : ''}. No availability check needed.`,
    };
    return JSON.stringify(result);
  }

  // ─── Extension or date shift: check availability ──────────────────────
  // Determine which dates need checking (only the NEW dates, not existing ones)
  let checkStart: string;
  let checkEnd: string;

  if (newCheckout > currentCheckOut) {
    // Extension: check from current checkout to new checkout
    checkStart = currentCheckOut;
    checkEnd = newCheckout;
  } else if (newCheckin < currentCheckIn) {
    // Earlier arrival: check from new checkin to current checkin
    checkStart = newCheckin;
    checkEnd = currentCheckIn;
  } else {
    // Date shift within existing range — check the full new range
    checkStart = newCheckin;
    checkEnd = newCheckout;
  }

  // Call Hostaway calendar to check availability
  let calendarDays: any[] = [];
  try {
    const calRes = await getListingCalendar(
      ctx.hostawayAccountId, ctx.hostawayApiKey,
      listingId, checkStart, checkEnd
    );
    calendarDays = calRes.result || [];
  } catch (err) {
    console.error('[ExtendStay] Calendar check failed:', err);
    const errorResult: ExtendStayResult = {
      available: false,
      current_dates: currentDates,
      requested_dates: requestedDates,
      additional_nights: 0,
      channel,
      channel_instructions: null,
      message: 'Could not check availability at this time. Please escalate to the property manager.',
    };
    return JSON.stringify(errorResult);
  }

  // Check if any day has a conflicting reservation
  let firstConflictDate: string | null = null;
  let availableDays = 0;

  for (const day of calendarDays) {
    const date = day.date || day.calendarDate;
    const reservations = day.reservations || [];
    const isBlocked = day.isBlocked === 1 || day.isBlocked === true;
    const status = day.status;

    if (reservations.length > 0 || isBlocked || status === 'booked' || status === 'blocked') {
      if (!firstConflictDate) firstConflictDate = date;
      break;
    }
    availableDays++;
  }

  const totalRequestedDays = daysBetween(checkStart, checkEnd);
  const isFullyAvailable = !firstConflictDate && availableDays >= totalRequestedDays;

  if (!isFullyAvailable) {
    const maxExtension = availableDays;
    const result: ExtendStayResult = {
      available: false,
      current_dates: currentDates,
      requested_dates: requestedDates,
      additional_nights: totalRequestedDays,
      channel,
      channel_instructions: null,
      conflict_starts: firstConflictDate,
      max_available_extension: maxExtension > 0 ? maxExtension : 0,
      message: maxExtension > 0
        ? `Property is booked starting ${firstConflictDate}. Maximum extension is ${maxExtension} night${maxExtension !== 1 ? 's' : ''} (until ${addDays(checkStart, maxExtension)}).`
        : `Property is not available for the requested dates.`,
    };
    return JSON.stringify(result);
  }

  // ─── Available! Calculate price ───────────────────────────────────────
  const additionalNights = totalRequestedDays;
  let totalCost: number | null = null;
  let perNight: number | null = null;
  let currency: string | null = null;

  const priceRes = await calculateReservationPrice(
    ctx.hostawayAccountId, ctx.hostawayApiKey,
    listingId, checkStart, checkEnd, numberOfGuests
  );

  if (priceRes?.result) {
    const p = priceRes.result;
    totalCost = p.totalPrice ?? p.price ?? p.basePrice ?? null;
    currency = p.currency ?? 'USD';
    if (totalCost && additionalNights > 0) {
      perNight = Math.round(totalCost / additionalNights);
    }
  }

  const result: ExtendStayResult = {
    available: true,
    current_dates: currentDates,
    requested_dates: requestedDates,
    additional_nights: additionalNights,
    price_per_night: perNight,
    total_additional_cost: totalCost,
    currency,
    channel,
    channel_instructions: getChannelInstructions(channel, newCheckout, typedInput.new_checkin),
  };

  console.log(`[ExtendStay] Available: ${additionalNights} nights, cost: ${totalCost ?? 'unknown'}, channel: ${channel}`);

  return JSON.stringify(result);
}
