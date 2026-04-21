/**
 * Sprint 051 A B4 — quote-emit helper unit tests.
 *
 * Covers: happy path (builds a well-formed part), empty-body suppression,
 * secret-like value redaction, and emit fire-and-forget semantics (emit
 * throwing does not propagate).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildArtifactQuotePart,
  emitArtifactQuoteIfPossible,
  normaliseQuoteArtifactType,
  sanitiseQuoteBody,
} from '../quote-emit';

test('buildArtifactQuotePart returns a typed part on a non-empty body', () => {
  const part = buildArtifactQuotePart({
    artifact: 'sop',
    artifactId: 'v1',
    sourceLabel: 'SOP · early-checkin · CONFIRMED',
    body: 'Arrival window 14:00–22:00.',
  });
  assert.ok(part);
  assert.equal(part!.type, 'data-artifact-quote');
  assert.equal(part!.data.artifactId, 'v1');
  assert.equal(part!.data.body, 'Arrival window 14:00–22:00.');
});

test('buildArtifactQuotePart returns null when the body is empty or whitespace', () => {
  assert.equal(
    buildArtifactQuotePart({
      artifact: 'sop',
      artifactId: 'v1',
      sourceLabel: '',
      body: '',
    }),
    null,
  );
  assert.equal(
    buildArtifactQuotePart({
      artifact: 'sop',
      artifactId: 'v1',
      sourceLabel: '',
      body: '   \n\t ',
    }),
    null,
  );
});

test('sanitiseQuoteBody middle-redacts likely-secret values', () => {
  const scrubbed = sanitiseQuoteBody(
    'The webhook uses apiKey=A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6 — keep private.',
  );
  assert.match(scrubbed, /\[likely-secret\]/);
  assert.ok(!scrubbed.includes('A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6'));
  // Prose around the secret survives.
  assert.match(scrubbed, /The webhook uses apiKey=/);
  assert.match(scrubbed, /keep private/);
});

test('sanitiseQuoteBody leaves ordinary prose untouched', () => {
  const prose = 'Check-in is at 14:00. Please ask the concierge for keys.';
  assert.equal(sanitiseQuoteBody(prose), prose);
});

test('emitArtifactQuoteIfPossible fires exactly once on a valid input', () => {
  const captured: any[] = [];
  const emit = (part: any) => captured.push(part);
  const ok = emitArtifactQuoteIfPossible(emit, {
    artifact: 'faq',
    artifactId: 'f1',
    sourceLabel: 'FAQ · wifi',
    body: 'Network: Guest.',
  });
  assert.equal(ok, true);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].type, 'data-artifact-quote');
});

test('emitArtifactQuoteIfPossible suppresses empty bodies', () => {
  const captured: any[] = [];
  const emit = (part: any) => captured.push(part);
  const ok = emitArtifactQuoteIfPossible(emit, {
    artifact: 'faq',
    artifactId: 'f1',
    sourceLabel: 'FAQ · wifi',
    body: '',
  });
  assert.equal(ok, false);
  assert.equal(captured.length, 0);
});

test('emitArtifactQuoteIfPossible swallows emit errors (fire-and-forget)', () => {
  const emit = () => {
    throw new Error('stream closed');
  };
  const ok = emitArtifactQuoteIfPossible(emit, {
    artifact: 'sop',
    artifactId: 'v1',
    sourceLabel: '',
    body: 'body',
  });
  assert.equal(ok, false);
});

test('normaliseQuoteArtifactType maps drawer + audit-row aliases', () => {
  assert.equal(normaliseQuoteArtifactType('tool'), 'tool_definition');
  assert.equal(normaliseQuoteArtifactType('tool_definition'), 'tool_definition');
  assert.equal(normaliseQuoteArtifactType('sop'), 'sop');
  assert.equal(normaliseQuoteArtifactType('bogus'), null);
  assert.equal(normaliseQuoteArtifactType(undefined), null);
});
