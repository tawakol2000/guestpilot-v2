import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import type { Store } from 'express-rate-limit';
import type { Request } from 'express';

// 2026-05-16: production Railway logs were flooded with
//   ValidationError: Custom keyGenerator appears to use request IP
//   without calling the ipKeyGenerator helper function for IPv6 addresses.
// every container start. Cause: every limiter below falls back to
// `req.ip` for unauthenticated callers. Under IPv6 the raw remote
// address is a single /128 — a single client can bypass per-IP
// limits by rotating addresses within its /64 prefix. The library's
// `ipKeyGenerator(req)` collapses /64 to a stable bucket.
//
// This helper applies the same normalisation everywhere the limiter
// needs to fall back to IP. Stable across IPv4 + IPv6 callers and
// silences the validation warnings in prod logs.
function ipFallbackKey(req: Request): string {
  const reqAny = req as unknown as Parameters<typeof ipKeyGenerator>[0];
  return ipKeyGenerator(reqAny) ?? 'unknown';
}

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
  keyGenerator: (req) => req.params.tenantId || ipFallbackKey(req),
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
  keyGenerator: (req) => (req as any).tenantId || ipFallbackKey(req),
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
  keyGenerator: (req) => (req as any).tenantId || ipFallbackKey(req),
  store: createRedisStore('rl:res-action:'),
  passOnStoreError: true,
});

// Bugfix (2026-04-23): push-subscribe / push-unsubscribe had no rate
// limit. A misbehaving (or malicious) client could spam the
// subscribe endpoint with many fake endpoints to bloat the
// PushSubscription table. 10/min per tenant matches the message
// send limiter — push registrations should be rare in practice
// (one per device install).
export const pushSubscribeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded. Try again in a minute.' },
  keyGenerator: (req) => (req as any).tenantId || ipFallbackKey(req),
  store: createRedisStore('rl:push-sub:'),
  passOnStoreError: true,
});

// 2026-05-16: dedicated limiter for the read-only display-translate
// endpoint `POST /api/messages/:messageId/translate`. This fires
// automatically on every inbox render of an inbound non-English
// message (Arabic guest messages translated to English for the
// operator). It was previously sharing `messageSendLimiter`'s
// 10/min/tenant budget with actual outbound sends — meaning a
// tenant viewing 6+ Arabic conversations in their inbox would burn
// the entire send budget before they could click Send on anything.
// In production this surfaced as: open inbox → translate fires N
// times → Send button returns 429 with body { error: "Rate limit
// exceeded..." } → frontend's specific-code matchers miss → toast
// shows the opaque "Send failed." with no rate-limit explanation.
//
// 200/min/tenant comfortably covers an inbox-load burst (one
// translate per visible inbound message) plus background refetches
// without affecting the actual write budget. Results are cached on
// `Message.contentTranslationEn` so the second view of the same
// message is a DB hit, not a Google call — the rate limit is a
// shield against runaway loops, not a quota on legitimate use.
export const messageTranslateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 200,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Translation rate limit exceeded. Try again in a minute.' },
  keyGenerator: (req) => (req as any).tenantId || ipFallbackKey(req),
  store: createRedisStore('rl:msg-translate:'),
  passOnStoreError: true,
});

// 2026-05-16: studio agent turn endpoint. Each call kicks off an
// Anthropic / OpenAI request + up to 5 tool rounds + (optionally) a
// 3-variant pipeline judge. A bug or abusive script that fires
// /api/build/turn in a tight loop could burn thousands of dollars
// per hour. 30/min per user is far above human studio cadence
// (each turn takes 5-30s wall) but cheaply trips runaway loops.
export const buildTurnLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: 'Studio agent rate limit hit. Wait a minute before sending another turn.',
  },
  keyGenerator: (req) =>
    (req as any).userId || (req as any).tenantId || ipFallbackKey(req),
  store: createRedisStore('rl:build-turn:'),
  passOnStoreError: true,
});
