/**
 * SSE (Server-Sent Events) service
 * Manages per-tenant connections and broadcasts events.
 */

import { Response } from 'express';

const clients = new Map<string, Set<Response>>();

export function registerSSEClient(tenantId: string, res: Response): void {
  if (!clients.has(tenantId)) clients.set(tenantId, new Set());
  clients.get(tenantId)!.add(res);
  res.on('close', () => clients.get(tenantId)?.delete(res));
}

export function broadcastToTenant(tenantId: string, event: string, data: unknown): void {
  const tenantClients = clients.get(tenantId);
  if (!tenantClients?.size) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of tenantClients) {
    try { res.write(msg); } catch { tenantClients.delete(res); }
  }
}
