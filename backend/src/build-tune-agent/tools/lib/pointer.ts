/**
 * Sprint 060-D Phase 7 — opaque HMAC-signed pointer utility.
 *
 * Encodes the index → detail handoff for the three split read tools:
 *   - studio_get_tenant_index → studio_get_artifact({pointer})
 *   - studio_get_evidence_index → studio_get_evidence_section({pointer})
 *   - studio_search_corrections → studio_get_correction({pointer})
 *
 * The pointer is a base64url-encoded JSON payload, signed with HMAC-SHA256
 * using `STUDIO_POINTER_HMAC_KEY`. The signature lives in the URI fragment,
 * so a tampered payload trips verification before the resource is looked up.
 *
 * 2026-05-15 (C2 + M2 + M4):
 *  - HMAC key must be explicitly set in production. We no longer fall back
 *    to JWT_SECRET when NODE_ENV === 'production'. Dev / test fall through.
 *  - tenantId is now part of the signed payload — a pointer minted for
 *    tenant A cannot be presented by tenant B. Per-tool tenantId filters
 *    remain as belt-and-braces.
 *  - Comma-separated key lists honoured on the verify path so operators
 *    can rotate keys (mint with first, verify accepts any).
 *
 * URI shape:    ref://<type>/<id>/<base64url-payload>.<base64url-sig>
 *
 * No DB persistence. The agent calls the index, receives pointers, and
 * passes them straight back to the detail tool. The signature carries
 * enough info to re-derive the resource without a server-side cache.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const URI_SCHEME = 'ref://';

export interface PointerPayload {
  /** Resource family — drives which detail tool can resolve. */
  type: string;
  /** Resource id (e.g. SOP cuid, evidence-bundle id, correction id). */
  id: string;
  /** Tenant scope — bound into the signed payload, enforced at decode. */
  tenantId?: string;
  /** Optional metadata that the detail tool needs for lookup. */
  metadata?: Record<string, unknown>;
  /** Encode-time epoch ms. Carried for analytics; not enforced for expiry. */
  ts?: number;
}

function readKeys(): Buffer[] {
  const raw = process.env.STUDIO_POINTER_HMAC_KEY ?? '';
  const explicit = raw
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  if (explicit.length > 0) return explicit.map((k) => Buffer.from(k, 'utf8'));

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'pointer: STUDIO_POINTER_HMAC_KEY must be set in production',
    );
  }
  const jwt = process.env.JWT_SECRET;
  if (!jwt) {
    throw new Error(
      'pointer: neither STUDIO_POINTER_HMAC_KEY nor JWT_SECRET is set',
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

function base64UrlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
  const normalised = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  return Buffer.from(normalised, 'base64');
}

function signWith(payloadB64: string, key: Buffer): string {
  const mac = createHmac('sha256', key);
  mac.update(payloadB64);
  return base64UrlEncode(mac.digest());
}

function signWithPrimary(payloadB64: string): string {
  return signWith(payloadB64, readKeys()[0]);
}

export function encodePointer(input: PointerPayload): string {
  if (!input.type || !input.id) {
    throw new Error('pointer: type + id are required');
  }
  const payload: PointerPayload = {
    type: input.type,
    id: input.id,
    ...(input.tenantId ? { tenantId: input.tenantId } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ts: input.ts ?? Date.now(),
  };
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = signWithPrimary(payloadB64);
  const safeType = encodeURIComponent(payload.type);
  const safeId = encodeURIComponent(payload.id);
  return `${URI_SCHEME}${safeType}/${safeId}/${payloadB64}.${sig}`;
}

export interface DecodeOk {
  ok: true;
  payload: PointerPayload;
}
export interface DecodeErr {
  ok: false;
  reason:
    | 'bad_scheme'
    | 'bad_format'
    | 'bad_signature'
    | 'bad_payload'
    | 'mismatch'
    | 'tenant_mismatch';
}
export type DecodeResult = DecodeOk | DecodeErr;

/**
 * Decode + verify a pointer. Returns `{ok: false, reason}` on any
 * failure path; callers map to a user-facing error. Never throws on
 * invalid input.
 *
 * Pass `expectedTenantId` to enforce that the pointer was minted for
 * this tenant. Omitting it preserves legacy behaviour (older pointers
 * minted without a bound tenantId still verify against their bare
 * payload).
 */
export function decodePointer(
  uri: string,
  expectedType?: string,
  expectedTenantId?: string,
): DecodeResult {
  if (typeof uri !== 'string' || !uri.startsWith(URI_SCHEME)) {
    return { ok: false, reason: 'bad_scheme' };
  }
  const rest = uri.slice(URI_SCHEME.length);
  const parts = rest.split('/');
  if (parts.length < 3) return { ok: false, reason: 'bad_format' };
  const sigBlob = parts[parts.length - 1];
  const dotIdx = sigBlob.lastIndexOf('.');
  if (dotIdx <= 0) return { ok: false, reason: 'bad_format' };
  const payloadB64 = sigBlob.slice(0, dotIdx);
  const sig = sigBlob.slice(dotIdx + 1);

  const keys = readKeys();
  const sigBuf = Buffer.from(sig, 'utf8');
  let signatureOk = false;
  for (const key of keys) {
    const expect = signWith(payloadB64, key);
    const expectBuf = Buffer.from(expect, 'utf8');
    if (sigBuf.length === expectBuf.length && timingSafeEqual(sigBuf, expectBuf)) {
      signatureOk = true;
      break;
    }
  }
  if (!signatureOk) return { ok: false, reason: 'bad_signature' };

  let payload: PointerPayload;
  try {
    const json = base64UrlDecode(payloadB64).toString('utf8');
    payload = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'bad_payload' };
  }
  if (!payload || typeof payload !== 'object' || !payload.type || !payload.id) {
    return { ok: false, reason: 'bad_payload' };
  }
  if (expectedType && payload.type !== expectedType) {
    return { ok: false, reason: 'mismatch' };
  }
  // Tenant scoping: if both sides carry a tenantId, they must match.
  // If the caller didn't pass one, accept whatever the pointer carries
  // (legacy callers / dev tooling).
  if (expectedTenantId && payload.tenantId && payload.tenantId !== expectedTenantId) {
    return { ok: false, reason: 'tenant_mismatch' };
  }
  return { ok: true, payload };
}

/** Convenience for tools: throws an asError-shaped reason on bad pointer. */
export function decodeOrThrow(
  uri: string,
  expectedType: string,
  expectedTenantId?: string,
): PointerPayload {
  const r = decodePointer(uri, expectedType, expectedTenantId);
  if (!r.ok) {
    throw new Error(`invalid pointer (${r.reason})`);
  }
  return r.payload;
}
