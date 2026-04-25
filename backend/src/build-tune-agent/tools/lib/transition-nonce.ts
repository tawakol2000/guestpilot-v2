/**
 * Sprint 060-C — HMAC-signed transition nonces.
 *
 * Distinct from `pointer.ts` (which signs reference URIs). This module
 * mints single-use tokens for `studio_propose_transition` proposals.
 *
 * Shape:    `<random-bytes-b64url>.<hmac-sig-b64url>`
 *
 * The nonce is stored in `TuningConversation.stateMachineSnapshot.
 * pending_transition.token`. On confirm, the host endpoint re-derives
 * the HMAC over the random part and timing-safe-compares it to the
 * incoming signature, then checks it matches the stored nonce
 * (single-use). Tampering trips signature verification before any DB
 * write happens.
 *
 * Falls back to JWT_SECRET if STUDIO_TRANSITION_HMAC_KEY isn't set —
 * matches the convention used by `pointer.ts`.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

function getKey(): Buffer {
  const k = process.env.STUDIO_TRANSITION_HMAC_KEY ?? process.env.STUDIO_POINTER_HMAC_KEY ?? process.env.JWT_SECRET;
  if (!k) {
    throw new Error('transition-nonce: neither STUDIO_TRANSITION_HMAC_KEY, STUDIO_POINTER_HMAC_KEY nor JWT_SECRET is set');
  }
  return Buffer.from(k, 'utf8');
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function sign(payload: string): string {
  const mac = createHmac('sha256', getKey());
  mac.update(payload);
  return base64UrlEncode(mac.digest());
}

/** Mint a fresh nonce. 16 random bytes → ~22 base64url chars + sig. */
export function mintTransitionNonce(): string {
  const random = base64UrlEncode(randomBytes(16));
  const sig = sign(random);
  return `${random}.${sig}`;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'bad_format' | 'bad_signature' };

/** Verify HMAC signature without checking single-use status (caller does that). */
export function verifyTransitionNonce(nonce: string): VerifyResult {
  if (typeof nonce !== 'string' || nonce.length < 4) {
    return { ok: false, reason: 'bad_format' };
  }
  const dotIdx = nonce.lastIndexOf('.');
  if (dotIdx <= 0) return { ok: false, reason: 'bad_format' };
  const payload = nonce.slice(0, dotIdx);
  const sig = nonce.slice(dotIdx + 1);
  const expectSig = sign(payload);
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expectSig, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true };
}
