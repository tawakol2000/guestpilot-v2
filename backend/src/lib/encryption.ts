/**
 * AES-256-GCM encryption utility for storing sensitive tokens at rest.
 * Key derived from JWT_SECRET via PBKDF2.
 */

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SALT = 'guestpilot-dashboard-token'; // static salt — key uniqueness comes from JWT_SECRET
const KEY_ITERATIONS = 100_000;

/**
 * Bugfix (2026-04-23): memoize the derived key. PBKDF2 with 100k
 * iterations is intentionally CPU-expensive (~20-50ms per call) — the
 * previous implementation re-derived on every encrypt/decrypt, which
 * is a real latency tax on hot paths (Hostaway dashboard JWT
 * encryption / decryption fires on alteration accept, alteration
 * reject, login-assist).
 *
 * Cache the key keyed on the JWT_SECRET value so a test that swaps the
 * env var mid-process still works (re-derive on secret change). In
 * production JWT_SECRET is constant for the process lifetime, so this
 * is effectively a one-shot derivation.
 *
 * Future: if JWT_SECRET is ever rotated in production, every existing
 * encrypted token becomes undecryptable until the rotation includes a
 * decrypt-with-old-key + re-encrypt-with-new-key migration step.
 * Tracked in DEFERRED_BUGS / FEATURE_SUGGESTIONS.
 */
let _cachedKeySecret: string | null = null;
let _cachedKey: Buffer | null = null;

function deriveKey(): Buffer {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required for encryption');
  if (_cachedKey && _cachedKeySecret === secret) return _cachedKey;
  _cachedKey = crypto.pbkdf2Sync(secret, SALT, KEY_ITERATIONS, 32, 'sha256');
  _cachedKeySecret = secret;
  return _cachedKey;
}

export function encrypt(plaintext: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Format: iv:authTag:ciphertext (all hex)
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decrypt(encoded: string): string {
  const key = deriveKey();
  const [ivHex, authTagHex, ciphertextHex] = encoded.split(':');
  if (!ivHex || !authTagHex || !ciphertextHex) throw new Error('Invalid encrypted token format');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext).toString('utf8') + decipher.final('utf8');
}
