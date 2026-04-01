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

  io = new Server(httpServer, {
    cors: {
      origin: corsOrigins,
      credentials: true,
    },
    transports: ['websocket'],
    pingInterval: 25000,
    pingTimeout: 20000,
    connectionStateRecovery: {
      maxDisconnectionDuration: 60 * 60 * 1000, // 1 hour
      skipMiddlewares: true,
    },
  });

  // ── Redis Streams adapter (optional — graceful degradation) ──────────────
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    try {
      // Dynamic import to avoid crash if redis-streams-adapter not installed
      const Redis = require('ioredis');
      const { createAdapter } = require('@socket.io/redis-streams-adapter');
      const redisClient = new Redis(redisUrl, {
        lazyConnect: false,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        retryStrategy: (times: number) => Math.min(times * 200, 5000),
      });
      redisClient.on('error', (err: Error) => {
        console.warn('[Socket.IO] Redis adapter error:', err.message);
      });
      redisClient.on('connect', () => {
        console.log('[Socket.IO] Redis Streams adapter connected — multi-instance broadcasting enabled');
      });
      io.adapter(createAdapter(redisClient));
    } catch (err: any) {
      console.warn('[Socket.IO] Redis Streams adapter failed — falling back to single-instance:', err.message);
    }
  } else {
    console.warn('[Socket.IO] REDIS_URL not set — single-instance mode (no cross-instance broadcasting)');
  }

  // ── JWT Authentication middleware ────────────────────────────────────────
  io.use((socket: Socket, next) => {
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

    // Update stats
    _totalConnections++;
    _currentConnections++;
    _tenantConnections.set(tenantId, (_tenantConnections.get(tenantId) || 0) + 1);

    if (socket.recovered) {
      console.log(`[Socket.IO] Client recovered tenantId=${tenantId} userId=${userId} connections=${_currentConnections}`);
    } else {
      console.log(`[Socket.IO] Client connected tenantId=${tenantId} userId=${userId} connections=${_currentConnections}`);
    }

    socket.on('disconnect', (reason) => {
      _currentConnections--;
      const tenantCount = (_tenantConnections.get(tenantId) || 1) - 1;
      if (tenantCount <= 0) {
        _tenantConnections.delete(tenantId);
      } else {
        _tenantConnections.set(tenantId, tenantCount);
      }
      console.log(`[Socket.IO] Client disconnected tenantId=${tenantId} reason=${reason} connections=${_currentConnections}`);
    });
  });

  console.log('[Socket.IO] Server initialized — WebSocket transport, 1-hour recovery window');
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
