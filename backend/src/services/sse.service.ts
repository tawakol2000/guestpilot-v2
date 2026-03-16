/**
 * SSE (Server-Sent Events) service
 *
 * Uses Redis pub/sub so broadcasts work across multiple Railway instances.
 * Falls back to in-memory delivery if REDIS_URL is not set.
 */

import { Response } from 'express';
import Redis from 'ioredis';

// Per-instance registry of connected browser clients
const clients = new Map<string, Set<Response>>();

// ── Redis pub/sub ─────────────────────────────────────────────────────────────

let publisher: Redis | null = null;
let subscriber: Redis | null = null;

function makeRedis(url: string): Redis {
  return new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 200, 5000),
  });
}

function initRedis(): void {
  const url = process.env.REDIS_URL;
  if (!url) {
    console.warn('[SSE] REDIS_URL not set — in-memory broadcasting only (single-instance)');
    return;
  }
  try {
    publisher = makeRedis(url);
    subscriber = makeRedis(url);

    publisher.on('error', (err) => console.warn('[SSE] Redis publisher error:', err.message));
    subscriber.on('error', (err) => console.warn('[SSE] Redis subscriber error:', err.message));

    // psubscribe matches all tenant channels: sse:<tenantId>
    subscriber.psubscribe('sse:*', (err) => {
      if (err) {
        console.warn('[SSE] Redis psubscribe failed:', err.message);
        return;
      }
      console.log('[SSE] Redis pub/sub ready — broadcasts will reach all Railway instances');
    });

    subscriber.on('pmessage', (_pattern: string, channel: string, message: string) => {
      const tenantId = channel.slice(4); // strip 'sse:' prefix
      deliverToLocalClients(tenantId, message);
    });
  } catch (err: any) {
    console.warn('[SSE] Redis init error — falling back to in-memory:', err.message);
    publisher = null;
    subscriber = null;
  }
}

initRedis();

// ── Local delivery ────────────────────────────────────────────────────────────

function deliverToLocalClients(tenantId: string, msg: string): void {
  const tenantClients = clients.get(tenantId);
  if (!tenantClients?.size) return;
  console.log(`[SSE] Delivering to ${tenantClients.size} local client(s) tenantId=${tenantId}`);
  for (const res of tenantClients) {
    try { res.write(msg); } catch { tenantClients.delete(res); }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function registerSSEClient(tenantId: string, res: Response): void {
  if (!clients.has(tenantId)) clients.set(tenantId, new Set());
  clients.get(tenantId)!.add(res);
  const count = clients.get(tenantId)!.size;
  console.log(`[SSE] Client connected tenantId=${tenantId} totalClients=${count}`);
  res.on('close', () => {
    clients.get(tenantId)?.delete(res);
    const remaining = clients.get(tenantId)?.size ?? 0;
    console.log(`[SSE] Client disconnected tenantId=${tenantId} remainingClients=${remaining}`);
  });
}

export function broadcastToTenant(tenantId: string, event: string, data: unknown): void {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  if (publisher?.status === 'ready') {
    // Publish to Redis — every instance will receive and deliver to its local clients
    publisher.publish(`sse:${tenantId}`, msg).catch((err) => {
      console.warn(`[SSE] Redis publish failed, falling back in-memory:`, err.message);
      broadcastInMemory(tenantId, event, msg);
    });
  } else {
    broadcastInMemory(tenantId, event, msg);
  }
}

function broadcastInMemory(tenantId: string, event: string, msg: string): void {
  const tenantClients = clients.get(tenantId);
  if (!tenantClients?.size) {
    console.log(`[SSE] No local clients for tenantId=${tenantId} — dropping event="${event}"`);
    return;
  }
  console.log(`[SSE] In-memory broadcast event="${event}" to ${tenantClients.size} client(s) tenantId=${tenantId}`);
  for (const res of tenantClients) {
    try { res.write(msg); } catch { tenantClients.delete(res); }
  }
}
