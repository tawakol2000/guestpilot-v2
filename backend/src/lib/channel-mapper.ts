import { Channel } from '@prisma/client';

// Known Hostaway channelIds (their API returns these on reservations).
// Kept small and conservative — only the ones we have been able to confirm
// from real API payloads. Unknown ids fall through to OTHER rather than
// guessing; it is cheap to add entries later with direct evidence.
// Confirmed 2026-04-18: channelId=2018 + channelName="airbnbOfficial" on
// an Airbnb reservation, so 2018 is the Airbnb Official API channel.
const HOSTAWAY_CHANNEL_ID_MAP: Record<number, Channel> = {
  2000: Channel.AIRBNB,
  2005: Channel.BOOKING,
  2018: Channel.AIRBNB,
};

/**
 * Resolve Hostaway's channel hints to our Channel enum.
 *
 * Order of precedence:
 * 1. channelName substring match (most specific when Hostaway sends a string).
 * 2. channelId lookup (Hostaway sometimes sends only the numeric id — payloads
 *    on certain webhook events and inquiry-phase reservations).
 * 3. Fallback: OTHER.
 */
export function mapHostawayChannel(
  channelName?: string | null,
  channelId?: number | null
): Channel {
  if (channelName) {
    const name = channelName.toLowerCase();
    if (name.includes('airbnb')) return Channel.AIRBNB;
    if (name.includes('booking')) return Channel.BOOKING;
    if (name.includes('whatsapp')) return Channel.WHATSAPP;
    if (name.includes('direct')) return Channel.DIRECT;
  }
  if (typeof channelId === 'number' && HOSTAWAY_CHANNEL_ID_MAP[channelId]) {
    return HOSTAWAY_CHANNEL_ID_MAP[channelId];
  }
  return Channel.OTHER;
}
