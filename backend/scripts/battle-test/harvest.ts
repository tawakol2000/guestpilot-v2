/**
 * Battle Test — Harvest Script
 * Pulls real conversations from Hostaway across all reservation statuses.
 * Saves to battle-test-data.json for agent consumption.
 *
 * Usage: cd backend && npx ts-node scripts/battle-test/harvest.ts
 */

import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const HOSTAWAY_BASE_URL = 'https://api.hostaway.com';
const ACCOUNT_ID = '162575';
const API_KEY = '9a3d8d83db74d0dd28da88044bbffc9a70fd2b9f7b5fcd86aceb0fd495aa2ded';

const MIN_GUEST_MESSAGES = 3;
const TARGET_CONVERSATIONS = 100;

// Token cache
let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;

  const res = await axios.post(
    `${HOSTAWAY_BASE_URL}/v1/accessTokens`,
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: ACCOUNT_ID,
      client_secret: API_KEY,
      scope: 'general',
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  const token: string = res.data.access_token;
  const expiresIn: number = (res.data.expires_in || 86400) - 60;
  cachedToken = { token, expiresAt: Date.now() + expiresIn * 1000 };
  return token;
}

async function getClient(): Promise<AxiosInstance> {
  const token = await getAccessToken();
  return axios.create({
    baseURL: HOSTAWAY_BASE_URL,
    timeout: 30000,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });
}

async function fetchReservations(status: string, includePast: boolean): Promise<any[]> {
  const client = await getClient();
  const all: any[] = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    let url = `/v1/reservations?status=${status}&limit=${limit}&offset=${offset}`;
    // Don't filter by departure date — we want historical conversations too
    if (!includePast) {
      const today = new Date().toISOString().slice(0, 10);
      url += `&departureStartDate=${today}`;
    }

    try {
      const res = await client.get(url);
      const batch = res.data.result || [];
      all.push(...batch);
      console.log(`  [${status}] offset=${offset}, got ${batch.length}`);
      if (batch.length < limit) break;
      offset += limit;
    } catch (err: any) {
      console.warn(`  [${status}] Error at offset=${offset}: ${err.message}`);
      break;
    }
  }

  return all;
}

async function getConversationForReservation(reservationId: number): Promise<any | null> {
  try {
    const client = await getClient();
    const res = await client.get(`/v1/conversations?reservationId=${reservationId}&limit=1`);
    const convs = res.data.result || [];
    return convs.length > 0 ? convs[0] : null;
  } catch {
    return null;
  }
}

async function getMessages(conversationId: number): Promise<any[]> {
  try {
    const client = await getClient();
    const res = await client.get(`/v1/conversations/${conversationId}/messages?limit=100`);
    return res.data.result || [];
  } catch {
    return [];
  }
}

async function main() {
  console.log('=== Battle Test Harvest ===\n');

  // Fetch reservations across ALL statuses
  const statuses = ['confirmed', 'new', 'inquiry', 'pending', 'checkedin', 'cancelled'];
  console.log('Phase 1: Fetching reservations across all statuses...');

  const allReservations: any[] = [];
  for (const status of statuses) {
    console.log(`\nFetching ${status} reservations (including past)...`);
    const reservations = await fetchReservations(status, true);
    allReservations.push(...reservations);
    console.log(`  Total ${status}: ${reservations.length}`);
  }

  // Deduplicate
  const seen = new Set<number>();
  const uniqueReservations = allReservations.filter(r => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
  console.log(`\nTotal unique reservations: ${uniqueReservations.length}`);

  // Shuffle for randomness
  for (let i = uniqueReservations.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [uniqueReservations[i], uniqueReservations[j]] = [uniqueReservations[j], uniqueReservations[i]];
  }

  // Phase 2: Fetch conversations and messages
  console.log('\nPhase 2: Fetching conversations and messages...');
  const harvestedConversations: any[] = [];
  let processed = 0;
  let skippedNoConv = 0;
  let skippedFewMsgs = 0;

  for (const reservation of uniqueReservations) {
    if (harvestedConversations.length >= TARGET_CONVERSATIONS) break;

    processed++;
    if (processed % 10 === 0) {
      console.log(`  Processed ${processed}/${uniqueReservations.length}, harvested ${harvestedConversations.length}/${TARGET_CONVERSATIONS}`);
    }

    // Rate limit: small delay between requests
    await new Promise(r => setTimeout(r, 200));

    const conv = await getConversationForReservation(reservation.id);
    if (!conv) {
      skippedNoConv++;
      continue;
    }

    await new Promise(r => setTimeout(r, 200));
    const messages = await getMessages(conv.id);

    const guestMessages = messages.filter((m: any) => m.isIncoming === 1);
    if (guestMessages.length < MIN_GUEST_MESSAGES) {
      skippedFewMsgs++;
      continue;
    }

    harvestedConversations.push({
      reservationId: reservation.id,
      hostawayConversationId: conv.id,
      guestName: reservation.guestName || reservation.guestFirstName || 'Unknown',
      status: reservation.status || 'unknown',
      channel: reservation.channelName || 'unknown',
      arrivalDate: reservation.arrivalDate,
      departureDate: reservation.departureDate,
      numberOfGuests: reservation.numberOfGuests || 1,
      listingMapId: reservation.listingMapId,
      guestCountry: reservation.guestCountry,
      messages: messages.map((m: any) => ({
        id: m.id,
        body: m.body || '',
        isIncoming: m.isIncoming,
        insertedOn: m.insertedOn || m.createdAt,
        type: m.type,
        attachments: m.attachments || [],
      })).sort((a: any, b: any) => {
        const dateA = new Date(a.insertedOn || 0).getTime();
        const dateB = new Date(b.insertedOn || 0).getTime();
        return dateA - dateB;
      }),
      totalMessages: messages.length,
      guestMessageCount: guestMessages.length,
    });
  }

  console.log(`\n=== Harvest Complete ===`);
  console.log(`Processed: ${processed}`);
  console.log(`Harvested: ${harvestedConversations.length}`);
  console.log(`Skipped (no conversation): ${skippedNoConv}`);
  console.log(`Skipped (< ${MIN_GUEST_MESSAGES} guest messages): ${skippedFewMsgs}`);

  // Status breakdown
  const statusCounts: Record<string, number> = {};
  for (const conv of harvestedConversations) {
    const s = conv.status;
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  }
  console.log('\nStatus breakdown:', JSON.stringify(statusCounts, null, 2));

  // Save to file
  const outPath = path.join(__dirname, 'battle-test-data.json');
  fs.writeFileSync(outPath, JSON.stringify(harvestedConversations, null, 2));
  console.log(`\nSaved to ${outPath}`);
}

main().catch(err => {
  console.error('Harvest failed:', err);
  process.exit(1);
});
