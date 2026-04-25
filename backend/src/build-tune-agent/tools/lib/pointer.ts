/**
 * Sprint 060-D Phase 7 — opaque HMAC-signed pointer utility.
 *
 * Encodes the index → detail handoff for the three split read tools:
 *   - studio_get_tenant_index → studio_get_artifact({pointer})
 *   - studio_get_evidence_index → studio_get_evidence_section({pointer})
 *   - studio_search_corrections → studio_get_correction({pointer})
 *
 * The pointer is a base64url-encoded JSON payload, signed with HMAC-SHA256
 * using `STUDIO_POINTER_HMAC_KEY` (falls back to `JWT_SECRET` so prod is
 * always covered). The signature lives in the URI fragment, so a tampered
 * payload trips verification before the resource is looked up.
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
  /** Optional metadata that the detail tool needs for lookup. */
  metadata?: Record<string, unknown>;
  /** Encode-time epoch ms. Carried for analytics; not enforced for expiry. */
  ts?: number;
}

function getKey(): Buffer {
  const k = process.env.STUDIO_POINTER_HMAC_KEY ?? process.env.JWT_SECRET;
  if (!k) {
    throw new Error(
      'pointer: neither STUDIO_POINTER_HMAC_KEY nor JWT_SECRET is set',
    );
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

function base64UrlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
  const normalised = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  return Buffer.from(normalised, 'base64');
}

function sign(payloadB64: string): string {
  const mac = createHmac('sha256', getKey());
  mac.update(payloadB64);
  return base64UrlEncode(mac.digest());
}

export function encodePointer(input: PointerPayload): string {
  if (!input.type || !input.id) {
    throw new Error('pointer: type + id are required');
  }
  const payload: PointerPayload = {
    type: input.type,
    id: input.id,
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ts: input.ts ?? Date.now(),
  };
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = sign(payloadB64);
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
    | 'mismatch';
}
export type DecodeResult = DecodeOk | DecodeErr;

/**
 * Decode + verify a pointer. Returns `{ok: false, reason}` on any
 * failure path; callers map to a user-facing error. Never throws on
 * invalid input.
 */
export function decodePointer(uri: string, expectedType?: string): DecodeResult {
  if (typeof uri !== 'string' || !uri.startsWith(URI_SCHEME)) {
    return { ok: false, reason: 'bad_scheme' };
  }
  const rest = uri.slice(URI_SCHEME.length);
  // Parse the LAST two path segments — the type/id parts may contain
  // percent-encoded slashes, so split conservatively from the right.
  const parts = rest.split('/');
  if (parts.length < 3) return { ok: false, reason: 'bad_format' };
  const sigBlob = parts[parts.length - 1];
  const dotIdx = sigBlob.lastIndexOf('.');
  if (dotIdx <= 0) return { ok: false, reason: 'bad_format' };
  const payloadB64 = sigBlob.slice(0, dotIdx);
  const sig = sigBlob.slice(dotIdx + 1);

  const expectSig = sign(payloadB64);
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expectSig, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }

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
  return { ok: true, payload };
}

/** Convenience for tools: throws an asError-shaped reason on bad pointer. */
export function decodeOrThrow(uri: string, expectedType: string): PointerPayload {
  const r = decodePointer(uri, expectedType);
  if (!r.ok) {
    throw new Error(`invalid pointer (${r.reason})`);
  }
  return r.payload;
}
