/**
 * Regression tests for the 2026-04-22 sanitiseArtifactPayload slug
 * false-positive fix. The blanket length-heuristic
 * (LIKELY_SECRET_REGEX = ≥32 chars of [A-Za-z0-9_-]) was middle-redacting
 * legitimate hyphenated slugs / kebab-case identifiers (e.g. webhook
 * URLs, parameter descriptions, regex patterns), producing mangled
 * previews and corrupted history rows.
 *
 * The fix adds two cheap filters:
 *   - hyphen ratio > 15% → treat as slug, don't redact
 *   - vowel ratio > 25% → treat as human-readable, don't redact
 *
 * Real opaque tokens (API keys, JWTs, base64 hashes) virtually never
 * trigger these filters, so the secret-redaction safety net is
 * preserved for the cases it was designed for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sanitiseArtifactPayload } from '../sanitise-artifact-payload';

test('sanitiser: real opaque API key still redacted', () => {
  // 64-char alphanumeric (typical API key shape — 1 vowel, no hyphens).
  const apiKey = 'sk789bcdfghjklmnpqrstvwxyz0123456789BCDFGHJKLMNPQRSTVWXYZ23456789';
  const out = sanitiseArtifactPayload({ value: apiKey });
  assert.match((out as any).value, /^sk78…\[likely-secret\]…6789$/);
});

test('sanitiser: real-shaped JWT-like token still redacted', () => {
  // ~120 chars, no vowels grouped, no hyphens — looks like a JWT body.
  const jwt = 'xyzwq123456789BCDFGHJKLMNPQRSTVWXYZ234zyxwvutsrqponmkjhgfdcb987654321zXYWVUTSRQPNMLKJHGFDCB876543210AB';
  const out = sanitiseArtifactPayload({ token: jwt });
  // Key-name match wins first ("token" → REDACTED), so the value is
  // hard-replaced. That's the canonical path; this test confirms the
  // length heuristic doesn't fight with it.
  assert.equal((out as any).token, '[redacted]');
});

test('sanitiser: hyphenated slug NOT redacted (regression case)', () => {
  // The exact example the bug-hunt called out: 40-char hyphenated slug.
  const slug = 'aws-prod-eu-west-webhook-for-bookings-v3';
  const out = sanitiseArtifactPayload({ webhookName: slug });
  assert.equal((out as any).webhookName, slug);
});

test('sanitiser: lowercase identifier with vowels NOT redacted', () => {
  // 35 chars, no hyphens, but plenty of vowels (~30%).
  const human = 'thisIsAVeryLongIdentifierForTheTestSuite';
  assert.ok(human.length >= 32);
  const out = sanitiseArtifactPayload({ name: human });
  assert.equal((out as any).name, human);
});

test('sanitiser: SOP category concatenation NOT redacted', () => {
  const cats = 'sop-late-checkout-default-cleared';
  const out = sanitiseArtifactPayload({ category: cats });
  assert.equal((out as any).category, cats);
});

test('sanitiser: regex pattern stored verbatim NOT redacted', () => {
  // 45 chars with hyphens AND special chars — wouldn't even match the
  // base regex (which requires only alnum/_/-) but worth confirming
  // pass-through.
  const pattern = '^(en-US|en-GB|fr-FR|de-DE|es-ES|it-IT|pt-PT)$';
  const out = sanitiseArtifactPayload({ pattern });
  assert.equal((out as any).pattern, pattern);
});

test('sanitiser: edge case — exactly 32 alphanumeric, no hyphens, mostly consonants → still redacted', () => {
  // Conservative: 32 chars, very few vowels, no hyphens — looks like a
  // hash. Should still redact.
  const hashLike = 'XYZWQ123456789BCDFGHJKLMNPQRSTVW';
  assert.equal(hashLike.length, 32);
  const out = sanitiseArtifactPayload({ hash: hashLike });
  assert.match((out as any).hash, /^XYZW…\[likely-secret\]…STVW$/);
});

test('sanitiser: nested in webhook config — webhookUrl stays readable', () => {
  // Real-world create_tool_definition shape.
  const config = {
    name: 'create-booking-quote',
    webhookUrl: 'https://api.tenant-fleet-pricing.com/v3/quote-for-booking-id',
    parameters: {
      checkInDate: { type: 'string' },
      reservationCategory: { type: 'enum', values: 'inquiry-paid-confirmed' },
    },
    // Real secret nested inside a non-canonical key:
    customAuth: 'sk789bcdfghjklmnpqrstvwxyz0123456789BCDFGHJKLMNPQRSTVWXYZ23456789',
  };
  const out = sanitiseArtifactPayload(config) as any;
  // Slugs preserved.
  assert.match(out.webhookUrl, /\/quote-for-booking-id$/);
  assert.equal(out.parameters.reservationCategory.values, 'inquiry-paid-confirmed');
  // Real key still redacted by length heuristic.
  assert.match(out.customAuth, /^sk78…\[likely-secret\]…6789$/);
});
