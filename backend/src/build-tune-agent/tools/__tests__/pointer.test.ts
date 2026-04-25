/**
 * Sprint 060-D Phase 7 — opaque pointer unit tests.
 *
 * Run: JWT_SECRET=test npx tsx --test src/build-tune-agent/tools/__tests__/pointer.test.ts
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-pointer';

import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePointer, decodePointer } from '../lib/pointer';

test('pointer: encode + decode roundtrip preserves type, id, metadata', () => {
  const uri = encodePointer({
    type: 'sop',
    id: 'sop_clx12ab',
    metadata: { variant: 'CONFIRMED' },
  });
  assert.ok(uri.startsWith('ref://sop/sop_clx12ab/'));
  const r = decodePointer(uri);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.payload.type, 'sop');
  assert.equal(r.payload.id, 'sop_clx12ab');
  assert.deepEqual(r.payload.metadata, { variant: 'CONFIRMED' });
  assert.ok(typeof r.payload.ts === 'number');
});

test('pointer: tampered payload trips signature check', () => {
  const uri = encodePointer({ type: 'sop', id: 'sop_a' });
  // Mutate one char in the payload portion (between last `/` and `.`).
  const lastSlash = uri.lastIndexOf('/');
  const dot = uri.lastIndexOf('.');
  const original = uri[lastSlash + 1];
  const swap = original === 'a' ? 'b' : 'a';
  const tampered = uri.slice(0, lastSlash + 1) + swap + uri.slice(lastSlash + 2, dot) + uri.slice(dot);
  const r = decodePointer(tampered);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'bad_signature');
});

test('pointer: tampered signature trips verification', () => {
  const uri = encodePointer({ type: 'sop', id: 'sop_a' });
  const dot = uri.lastIndexOf('.');
  const tampered = `${uri.slice(0, dot + 1)}AAAAAAAA`;
  const r = decodePointer(tampered);
  assert.equal(r.ok, false);
});

test('pointer: unknown URI scheme rejected', () => {
  const r = decodePointer('http://example.com/bad');
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'bad_scheme');
});

test('pointer: malformed (missing dot in sig blob) rejected as bad_format', () => {
  const r = decodePointer('ref://sop/abc/payload-without-sig');
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'bad_format');
});

test('pointer: type mismatch rejected when expectedType supplied', () => {
  const uri = encodePointer({ type: 'sop', id: 'sop_a' });
  const r = decodePointer(uri, 'evidence');
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'mismatch');
});

test('pointer: type match passes when expectedType supplied', () => {
  const uri = encodePointer({ type: 'evidence', id: 'evb_1' });
  const r = decodePointer(uri, 'evidence');
  assert.equal(r.ok, true);
});

test('pointer: encoding requires type + id', () => {
  assert.throws(() => encodePointer({ type: '', id: 'x' } as any));
  assert.throws(() => encodePointer({ type: 'x', id: '' } as any));
});
