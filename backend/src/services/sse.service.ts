/**
 * SSE (Server-Sent Events) service
 * Manages per-tenant connections and broadcasts events.
 */

import { Response } from 'express';

const clients = new Map<string, Set<Response>>();

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
  const tenantClients = clients.get(tenantId);
  if (!tenantClients?.size) {
    console.log(`[SSE] No clients for tenantId=${tenantId} — dropping event="${event}"`);
    return;
  }
  console.log(`[SSE] Broadcasting event="${event}" to ${tenantClients.size} client(s) tenantId=${tenantId}`);
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of tenantClients) {
    try { res.write(msg); } catch { tenantClients.delete(res); }
  }
}
