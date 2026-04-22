/**
 * Socket.IO Real-Time Service — Replaces SSE for all real-time event delivery.
 *
 * Features:
 *   - WebSocket-only transport (Railway has no sticky sessions)
 *   - JWT authentication on connection
 *   - Room-based tenant isolation (tenant:${tenantId})
 *   - Connection State Recovery (1-hour buffer via Redis Streams)
 *   - Delivery acknowledgment for critical events (message, ai_suggestion)
 *   - Graceful Redis degradation (single-instance mode without Redis)
 */

import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../middleware/auth';

let io: Server | null = null;

// ── Stats tracking ───────────────────────────────────────────────────────────

let _totalConnections = 0;
let _currentConnections = 0;
const _tenantConnections = new Map<string, number>();

export function getSocketStats() {
  return {
    connections: _currentConnections,
    tenants: _tenantConnections.size,
    totalConnections: _totalConnections,
  };
}

// ── Initialization ──────────────────────────────────────────────────────────

export function initSocketIO(httpServer: HttpServer): void {
  // Parse CORS origins from environment (same as Express CORS config)
  const corsOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
    : ['http://localhost:3000', 'http://127.0.0.1:3000'];

  // ── Check Redis availability for adapter + Connection State Recovery ─────
  const redisUrl = process.env.REDIS_URL;
  let redisAdapter: any = null;
  let redisAvailable = false;

  if (redisUrl) {
    try {
      const Redis = require('ioredis');
      const { createAdapter } = require('@socket.io/redis-adapter');
      // enableOfflineQueue must be true for the subscriber (needs to queue SUBSCRIBE before connected)
      const pubClient = new Redis(redisUrl, {
        retryStrategy: (times: number) => Math.min(times * 200, 5000),
      });
      const subClient = new Redis(redisUrl, {
        retryStrategy: (times: number) => Math.min(times * 200, 5000),
      });
      pubClient.on('error', (err: Error) => console.warn('[Socket.IO] Redis pub error:', err.message));
      subClient.on('error', (err: Error) => console.warn('[Socket.IO] Redis sub error:', err.message));
      redisAdapter = createAdapter(pubClient, subClient);
      redisAvailable = true;
    } catch (err: any) {
      console.warn('[Socket.IO] Redis adapter failed — single-instance mode:', err.message);
    }
  } else {
    console.warn('[Socket.IO] REDIS_URL not set — single-instance mode');
  }

  // No CSR — it requires Redis Streams adapter which is too memory-heavy.
  // Missed events are handled by REST API fallback on reconnect (client-side).
  const serverOpts: any = {
    cors: { origin: corsOrigins, credentials: true },
    transports: ['websocket'] as const,
    pingInterval: 25000,
    pingTimeout: 60000,  // 60s tolerance for Railway proxy latency (was 20s → frequent ping timeouts)
  };

  io = new Server(httpServer, serverOpts);

  if (redisAdapter) {
    io.adapter(redisAdapter);
  }

  // ── JWT Authentication middleware ────────────────────────────────────────
  io.use((socket: Socket, next: (err?: Error) => void) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }
    try {
      const payload = jwt.verify(token, JWT_SECRET) as { tenantId: string; sub?: string; email?: string };
      socket.data.tenantId = payload.tenantId;
      socket.data.userId = payload.sub || payload.email || 'unknown';
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  // ── Connection handler ───────────────────────────────────────────────────
  io.on('connection', (socket: Socket) => {
    const tenantId = socket.data.tenantId as string;
    const userId = socket.data.userId as string;

    // Join tenant room for isolated broadcasting
    socket.join(`tenant:${tenantId}`);

    // Update stats. Bugfix (2026-04-23): use a per-socket flag to
    // guard against double-disconnect-counting. Socket.IO can emit
    // 'disconnect' more than once for the same socket under Redis
    // adapter reconnects + transport close races; the previous
    // unconditional decrement would silently drift counts negative
    // (with no surface warning) and the `(_tenantConnections.get
    // || 1) - 1` defaulted missing keys to 1, masking accounting
    // bugs entirely.
    _totalConnections++;
    _currentConnections++;
    _tenantConnections.set(tenantId, (_tenantConnections.get(tenantId) || 0) + 1);
    (socket.data as any)._counted = true;

    if (socket.recovered) {
      console.log(`[Socket.IO] Client recovered tenantId=${tenantId} userId=${userId} connections=${_currentConnections}`);
    } else {
      console.log(`[Socket.IO] Client connected tenantId=${tenantId} userId=${userId} connections=${_currentConnections}`);
    }

    socket.on('disconnect', (reason: string) => {
      if (!(socket.data as any)._counted) {
        // Already accounted for — second disconnect for the same
        // socket. Skip silently.
        return;
      }
      (socket.data as any)._counted = false;
      _currentConnections = Math.max(0, _currentConnections - 1);
      const current = _tenantConnections.get(tenantId);
      if (typeof current === 'number') {
        const tenantCount = current - 1;
        if (tenantCount <= 0) {
          _tenantConnections.delete(tenantId);
        } else {
          _tenantConnections.set(tenantId, tenantCount);
        }
      }
      console.log(`[Socket.IO] Client disconnected tenantId=${tenantId} reason=${reason} connections=${_currentConnections}`);
    });
  });

  console.log(`[Socket.IO] Server initialized — WebSocket transport, Redis=${redisAvailable ? 'yes' : 'no'}`);
}

// ── Broadcasting ────────────────────────────────────────────────────────────

/**
 * Fire-and-forget broadcast to all sockets in a tenant room.
 * Used for non-critical events: typing indicators, status toggles, etc.
 * IDENTICAL signature to the old sse.service.ts broadcastToTenant.
 */
export function broadcastToTenant(tenantId: string, event: string, data: unknown): void {
  if (!io) {
    console.warn(`[Socket.IO] Not initialized — dropping event="${event}" for tenantId=${tenantId}`);
    return;
  }
  io.to(`tenant:${tenantId}`).emit(event, data);
}

/**
 * Broadcast with delivery acknowledgment — retries once on timeout.
 * Used for critical events: message, ai_suggestion.
 * If no ACK within 5 seconds, retries once (fire-and-forget on retry).
 */
export function broadcastCritical(tenantId: string, event: string, data: unknown): void {
  if (!io) {
    console.warn(`[Socket.IO] Not initialized — dropping critical event="${event}" for tenantId=${tenantId}`);
    return;
  }
  io.to(`tenant:${tenantId}`).timeout(5000).emit(event, data, (err: Error | null) => {
    if (err) {
      console.warn(`[Socket.IO] ACK timeout for event=${event} tenantId=${tenantId} — retrying once`);
      io!.to(`tenant:${tenantId}`).emit(event, data);
    }
  });
}
