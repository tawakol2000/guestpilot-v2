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

function deriveKey(): Buffer {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required for encryption');
  return crypto.pbkdf2Sync(secret, SALT, KEY_ITERATIONS, 32, 'sha256');
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
