/**
 * Hostaway API Service
 * All Hostaway API calls live here — never scattered across other files.
 * Uses OAuth2 client_credentials flow, token cached in memory.
 */

import axios, { AxiosInstance } from 'axios';
import { HostawayListing, HostawayReservation, HostawayConversation, HostawayMessage } from '../types';

const HOSTAWAY_BASE_URL = 'https://api.hostaway.com';

// T032: Retry with exponential backoff for transient Hostaway API failures
async function retryWithBackoff<T>(fn: () => Promise<T>, maxAttempts = 3, baseDelayMs = 2000): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.response?.status;
      const isRetryable = !status || status === 408 || status === 429 || status === 503 || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
      if (!isRetryable || attempt === maxAttempts) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(`[Hostaway] Attempt ${attempt}/${maxAttempts} failed (${status || err.code}), retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('Unreachable');
}

// Per-tenant token cache
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getAccessToken(accountId: string, apiKey: string): Promise<string> {
  const cached = tokenCache.get(accountId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  const res = await retryWithBackoff(() => axios.post(
    `${HOSTAWAY_BASE_URL}/v1/accessTokens`,
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: accountId,
      client_secret: apiKey,
      scope: 'general',
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  ));

  const token: string = res.data.access_token;
  const expiresIn: number = (res.data.expires_in || 86400) - 60;
  tokenCache.set(accountId, { token, expiresAt: Date.now() + expiresIn * 1000 });
  return token;
}

async function getClient(accountId: string, apiKey: string): Promise<AxiosInstance> {
  const token = await getAccessToken(accountId, apiKey);
  return axios.create({
    baseURL: HOSTAWAY_BASE_URL,
    timeout: 20000,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });
}

// ─── Listings ────────────────────────────────────────────────────────────────

export async function listListings(
  accountId: string,
  apiKey: string
): Promise<{ result: HostawayListing[] }> {
  const client = await getClient(accountId, apiKey);
  // No fields filter — fetch all listing data including amenities, bedTypes, etc.
  const res = await client.get('/v1/listings?limit=100');
  return res.data;
}

export async function getListing(
  accountId: string,
  apiKey: string,
  listingId: number | string
): Promise<{ result: HostawayListing }> {
  const client = await getClient(accountId, apiKey);
  const res = await client.get(`/v1/listings/${listingId}`);
  return res.data;
}

export async function listAvailableListings(
  accountId: string,
  apiKey: string,
  startDate: string,
  endDate: string
): Promise<{ result: HostawayListing[] }> {
  const client = await getClient(accountId, apiKey);
  const res = await retryWithBackoff(() =>
    client.get(`/v1/listings?availabilityDateStart=${startDate}&availabilityDateEnd=${endDate}&limit=100`)
  );
  return res.data;
}

// ─── Calendar & Pricing ──────────────────────────────────────────────────────

export async function getListingCalendar(
  accountId: string,
  apiKey: string,
  listingId: string | number,
  startDate: string,
  endDate: string
): Promise<{ result: any[] }> {
  const client = await getClient(accountId, apiKey);
  const res = await retryWithBackoff(() =>
    client.get(`/v1/listings/${listingId}/calendar?startDate=${startDate}&endDate=${endDate}&includeResources=1`)
  );
  return res.data;
}

export async function calculateReservationPrice(
  accountId: string,
  apiKey: string,
  listingId: string | number,
  arrivalDate: string,
  departureDate: string,
  numberOfGuests: number
): Promise<{ result: any } | null> {
  try {
    const client = await getClient(accountId, apiKey);
    const res = await retryWithBackoff(() =>
      client.post('/v1/reservations/calculatePrice', {
        listingMapId: Number(listingId),
        arrivalDate,
        departureDate,
        numberOfGuests,
      })
    );
    return res.data;
  } catch (err) {
    console.error('[Hostaway] calculateReservationPrice failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ─── Reservations ─────────────────────────────────────────────────────────────

export async function listReservations(
  accountId: string,
  apiKey: string,
  statuses: string[] = ['confirmed', 'new', 'inquiry', 'pending']
): Promise<{ result: HostawayReservation[] }> {
  const client = await getClient(accountId, apiKey);
  const today = new Date().toISOString().slice(0, 10);

  async function fetchAll(url: string): Promise<HostawayReservation[]> {
    const all: HostawayReservation[] = [];
    let offset = 0;
    const limit = 100;
    while (true) {
      const res = await client.get(`${url}&limit=${limit}&offset=${offset}`).catch(() => ({ data: { result: [] } }));
      const batch: HostawayReservation[] = res.data.result || [];
      all.push(...batch);
      if (batch.length < limit) break;
      offset += limit;
    }
    return all;
  }

  const upcomingResults = await Promise.all(
    statuses.map(status => fetchAll(`/v1/reservations?status=${status}&departureStartDate=${today}`))
  );
  const checkedInRes = await fetchAll(`/v1/reservations?status=checkedin`);
  const allReservations = [...upcomingResults.flat(), ...checkedInRes];

  const seen = new Set<number>();
  return {
    result: allReservations.filter(r => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    }),
  };
}

export async function getReservation(
  accountId: string,
  apiKey: string,
  reservationId: number | string
): Promise<{ result: HostawayReservation }> {
  const client = await getClient(accountId, apiKey);
  const res = await retryWithBackoff(() => client.get(`/v1/reservations/${reservationId}`));
  return res.data;
}

// ─── Conversations ────────────────────────────────────────────────────────────

export async function getConversationByReservation(
  accountId: string,
  apiKey: string,
  reservationId: number | string
): Promise<{ result: HostawayConversation[] }> {
  const client = await getClient(accountId, apiKey);
  const res = await client.get(`/v1/conversations?reservationId=${reservationId}&limit=1`);
  return res.data;
}

export async function getConversation(
  accountId: string,
  apiKey: string,
  conversationId: number | string
): Promise<{ result: HostawayConversation }> {
  const client = await getClient(accountId, apiKey);
  const res = await client.get(`/v1/conversations/${conversationId}`);
  return res.data;
}

export async function listConversationMessages(
  accountId: string,
  apiKey: string,
  conversationId: number | string,
  limit = 20,
  includeScheduledMessages = false
): Promise<{ result: HostawayMessage[] }> {
  const client = await getClient(accountId, apiKey);
  const res = await retryWithBackoff(() =>
    client.get(`/v1/conversations/${conversationId}/messages`, {
      params: {
        limit,
        includeScheduledMessages: includeScheduledMessages ? 1 : 0,
      },
      timeout: 2000,
    })
  );
  return res.data;
}

export async function sendMessageToConversation(
  accountId: string,
  apiKey: string,
  conversationId: number | string,
  body: string,
  communicationType = 'channel'
): Promise<unknown> {
  // DRY_RUN env var controls outbound message filtering:
  //   DRY_RUN=false (or unset)        → send to anyone
  //   DRY_RUN="40570028,12345678"     → only allow listed conversation IDs
  const dryRun = process.env.DRY_RUN?.trim();
  if (dryRun && dryRun.toLowerCase() !== 'false') {
    const allowed = dryRun.split(',').map(id => id.trim());
    if (!allowed.includes(String(conversationId))) {
      console.log(`[DRY_RUN] Blocked send to conv ${conversationId} — allowed: [${allowed.join(', ')}]. Message: "${body.substring(0, 120)}"`);
      return { dryRun: true, blocked: true };
    }
    console.log(`[DRY_RUN] Allowing send to conv ${conversationId}`);
  }
  console.log(`[Hostaway] Sending to conv ${conversationId} (${communicationType}): "${body.substring(0, 80)}"`);
  const client = await getClient(accountId, apiKey);
  const res = await retryWithBackoff(() => client.post(`/v1/conversations/${conversationId}/messages`, {
    body,
    communicationType,
  }));
  console.log(`[Hostaway] Send success, status: ${res.status}`);
  return res.data;
}

export async function updateReservationStatus(
  accountId: string,
  apiKey: string,
  reservationId: number | string,
  status: 'confirmed' | 'cancelled'
): Promise<unknown> {
  console.log(`[Hostaway] Updating reservation ${reservationId} status → ${status}`);
  const client = await getClient(accountId, apiKey);
  const res = await client.put(`/v1/reservations/${reservationId}`, { status });
  console.log(`[Hostaway] Reservation update status: ${res.status}`);
  return res.data;
}

// ─── Automated Messages ───────────────────────────────────────────────────────

export interface HostawayAutomatedMessage {
  id: number;
  name: string;
  body: string;
  triggerType: string;
  triggerOffset: number;
  isEnabled: boolean;
  channelIds?: number[];
}

export async function listAutomatedMessages(
  accountId: string,
  apiKey: string
): Promise<{ result: HostawayAutomatedMessage[] }> {
  const client = await getClient(accountId, apiKey);
  const res = await client.get('/v1/automatedMessages?limit=100').catch(() => ({ data: { result: [] } }));
  return res.data;
}

// Invalidate token cache for a tenant (e.g., after credential update)
export function invalidateTokenCache(accountId: string): void {
  tokenCache.delete(accountId);
}
