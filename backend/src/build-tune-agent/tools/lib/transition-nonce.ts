/**
 * Sprint 060-C — HMAC-signed transition nonces, scoped by conversationId.
 *
 * Distinct from `pointer.ts` (which signs reference URIs). This module
 * mints single-use tokens for `studio_propose_transition` proposals.
 *
 * Shape:    `<random-bytes-b64url>.<hmac-sig-b64url>`
 *
 * 2026-05-15 (M3): the HMAC payload now binds conversationId so a nonce
 * minted for conversation A cannot be presented to a confirm/reject
 * handler for conversation B. Backward-compatible verification accepts
 * tokens minted without a bound conversationId (older sessions) but
 * those become unrebindable across requests; new mints always bind.
 *
 * 2026-05-15 (C2 + M4): keys must be explicit in production. We no
 * longer fall back to `JWT_SECRET` when `NODE_ENV === 'production'` —
 * one leaked secret should not compromise both auth and state-transition
 * integrity. Dev and test continue to fall through to JWT_SECRET so
 * local setups don't break. Comma-separated key lists (current,old,…)
 * are honoured on the verify path so operators can rotate the key
 * without invalidating in-flight nonces.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

function readKeys(): Buffer[] {
  const raw =
    process.env.STUDIO_TRANSITION_HMAC_KEY ??
    process.env.STUDIO_POINTER_HMAC_KEY ??
    '';
  const explicit = raw
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  if (explicit.length > 0) return explicit.map((k) => Buffer.from(k, 'utf8'));

  // No explicit key configured. Fall back to JWT_SECRET only outside prod.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'transition-nonce: STUDIO_TRANSITION_HMAC_KEY (or STUDIO_POINTER_HMAC_KEY) must be set in production',
    );
  }
  const jwt = process.env.JWT_SECRET;
  if (!jwt) {
    throw new Error(
      'transition-nonce: neither STUDIO_TRANSITION_HMAC_KEY, STUDIO_POINTER_HMAC_KEY nor JWT_SECRET is set',
    );
  }
  return [Buffer.from(jwt, 'utf8')];
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function signWith(payload: string, key: Buffer): string {
  const mac = createHmac('sha256', key);
  mac.update(payload);
  return base64UrlEncode(mac.digest());
}

function signWithPrimary(payload: string): string {
  return signWith(payload, readKeys()[0]);
}

/** Mint a fresh nonce bound to a conversation. 16 random bytes → ~22 base64url chars + sig. */
export function mintTransitionNonce(conversationId?: string): string {
  const random = base64UrlEncode(randomBytes(16));
  // Bind conversationId into the signed payload so the nonce can't be
  // replayed onto another conversation. Old callers may still pass
  // undefined; those mint unbound tokens (legacy verify path).
  const payload = conversationId ? `${conversationId}:${random}` : random;
  const sig = signWithPrimary(payload);
  // The wire form keeps `<random>.<sig>` so old verifiers continue to
  // parse. ConversationId is implicit in the signature, not carried.
  return `${random}.${sig}`;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'bad_format' | 'bad_signature' };

/**
 * Verify HMAC signature without checking single-use status (caller does that).
 *
 * Pass `conversationId` to enforce that the nonce was bound to this
 * conversation when minted. Omitting it preserves legacy behaviour for
 * unbound (older) nonces — those still verify against the bare random
 * payload.
 */
export function verifyTransitionNonce(
  nonce: string,
  conversationId?: string,
): VerifyResult {
  if (typeof nonce !== 'string' || nonce.length < 4) {
    return { ok: false, reason: 'bad_format' };
  }
  const dotIdx = nonce.lastIndexOf('.');
  if (dotIdx <= 0) return { ok: false, reason: 'bad_format' };
  const random = nonce.slice(0, dotIdx);
  const sig = nonce.slice(dotIdx + 1);

  // Candidate payloads — try conversation-bound first, then legacy
  // unbound — so old in-flight nonces continue to work until they expire.
  const candidates: string[] = [];
  if (conversationId) candidates.push(`${conversationId}:${random}`);
  candidates.push(random);

  const keys = readKeys();
  const sigBuf = Buffer.from(sig, 'utf8');
  for (const payload of candidates) {
    for (const key of keys) {
      const expect = signWith(payload, key);
      const expectBuf = Buffer.from(expect, 'utf8');
      if (sigBuf.length === expectBuf.length && timingSafeEqual(sigBuf, expectBuf)) {
        return { ok: true };
      }
    }
  }
  return { ok: false, reason: 'bad_signature' };
}
