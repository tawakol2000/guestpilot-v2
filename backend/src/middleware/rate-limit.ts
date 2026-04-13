import { rateLimit } from 'express-rate-limit';
import type { Store } from 'express-rate-limit';

function createRedisStore(prefix: string): Store | undefined {
  if (!process.env.REDIS_URL) return undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { RedisStore } = require('rate-limit-redis');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const IORedis = require('ioredis');
    const client = new IORedis(process.env.REDIS_URL);
    return new RedisStore({
      sendCommand: (command: string, ...args: string[]) =>
        client.call(command, ...args),
      prefix,
    });
  } catch (err: any) {
    console.warn('[RateLimit] Redis store unavailable, falling back to memory:', err?.message);
    return undefined;
  }
}

// FR-014: 5 failed login attempts per minute per IP
export const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again in 1 minute.' },
  skipSuccessfulRequests: true,
  store: createRedisStore('rl:login:'),
  passOnStoreError: true,
});

// FR-014: 3 signup attempts per minute per IP
export const signupLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 3,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many signup attempts. Please try again in 1 minute.' },
  store: createRedisStore('rl:signup:'),
  passOnStoreError: true,
});

// 100 webhook calls per minute per tenantId
export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.params.tenantId || req.ip || 'unknown',
  store: createRedisStore('rl:webhook:'),
  passOnStoreError: true,
});

// 10 outbound message sends per minute per tenant (covers messages, notes, translate, approve, shadow send)
export const messageSendLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded. Try again in a minute.' },
  keyGenerator: (req) => (req as any).tenantId || req.ip || 'unknown',
  store: createRedisStore('rl:msg-send:'),
  passOnStoreError: true,
});

// 5 reservation actions (approve/reject) per minute per tenant
export const reservationActionLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded. Try again in a minute.' },
  keyGenerator: (req) => (req as any).tenantId || req.ip || 'unknown',
  store: createRedisStore('rl:res-action:'),
  passOnStoreError: true,
});
