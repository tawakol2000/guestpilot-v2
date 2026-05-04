/**
 * Feature 047 PR 2 — verbosity in studio_get_artifact.
 *
 * Run:  JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/get-artifact.test.ts
 *
 * Tests the pure helpers exported via the __test escape hatch. The handler
 * itself depends on Prisma; the helpers capture the verbosity-respecting
 * shape transformation which is the load-bearing behavior change.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../tools/get-artifact';
import type {
  CurrentSopPayload,
  CurrentFaqPayload,
  CurrentToolPayload,
} from '../tools/get-current-state';

const { HEAD_EXCERPT_CHARS, conciseText, conciseSop, conciseFaq, conciseTool } = __test;

// ─── conciseText ─────────────────────────────────────────────────────────

test('conciseText: short body passes through unchanged', () => {
  const body = 'A short SOP body of 50 chars.';
  assert.equal(conciseText(body), body);
});

test('conciseText: long body truncated at HEAD_EXCERPT_CHARS with re-fetch hint', () => {
  const body = 'x'.repeat(5000);
  const out = conciseText(body);
  assert.ok(out.length < body.length);
  assert.ok(out.includes('truncated'));
  assert.ok(out.includes("verbosity:'detailed'"));
  // Head excerpt is exactly HEAD_EXCERPT_CHARS chars + the hint suffix
  assert.ok(out.startsWith('x'.repeat(HEAD_EXCERPT_CHARS)));
});

test('conciseText: null/empty produces empty string (no crash)', () => {
  assert.equal(conciseText(null), '');
  assert.equal(conciseText(undefined), '');
  assert.equal(conciseText(''), '');
});

// ─── conciseSop ──────────────────────────────────────────────────────────

test('conciseSop: short variant content unchanged; long content gets head excerpt + fullCharLength', () => {
  const sop: CurrentSopPayload = {
    id: 'sop-1',
    category: 'cleaning',
    toolDescription: 'Cleaning SOP',
    enabled: true,
    variants: [
      { id: 'v-short', status: 'DEFAULT', content: 'short body', enabled: true },
      { id: 'v-long', status: 'INQUIRY', content: 'y'.repeat(5000), enabled: true },
    ],
    propertyOverrides: [],
  };
  const out = conciseSop(sop);
  assert.equal(out.variants[0].content, 'short body');
  assert.equal((out.variants[0] as any).fullCharLength, undefined, 'short variant must not carry fullCharLength');
  assert.ok(out.variants[1].content.length < 5000);
  assert.equal((out.variants[1] as any).fullCharLength, 5000, 'long variant carries original char length');
});

test('conciseSop: property overrides also truncated when long', () => {
  const sop: CurrentSopPayload = {
    id: 'sop-2',
    category: 'parking',
    toolDescription: 'Parking SOP',
    enabled: true,
    variants: [{ id: 'v', status: 'DEFAULT', content: 'short', enabled: true }],
    propertyOverrides: [
      {
        id: 'o-1',
        propertyId: 'p-1',
        status: 'DEFAULT',
        content: 'z'.repeat(8000),
        enabled: true,
      },
    ],
  };
  const out = conciseSop(sop);
  assert.ok(out.propertyOverrides[0].content.length < 8000);
  assert.equal((out.propertyOverrides[0] as any).fullCharLength, 8000);
});

// ─── conciseFaq ──────────────────────────────────────────────────────────

test('conciseFaq: short answer passes through; long answer truncated', () => {
  const short: CurrentFaqPayload = {
    id: 'faq-1',
    category: 'wifi',
    scope: 'GLOBAL',
    propertyId: null,
    question: 'What is the wifi password?',
    answer: 'The password is in the welcome packet.',
    status: 'ACTIVE',
  };
  assert.equal(conciseFaq(short), short, 'short FAQ passes through unchanged (no truncation)');

  const long: CurrentFaqPayload = { ...short, answer: 'q'.repeat(5000) };
  const out = conciseFaq(long);
  assert.ok(out.answer.length < 5000);
  assert.equal((out as any).fullCharLength, 5000);
});

// ─── conciseTool ─────────────────────────────────────────────────────────

test('conciseTool: short description passes through; long description truncated', () => {
  const short: CurrentToolPayload = {
    id: 't-1',
    name: 'webhook_x',
    displayName: 'Webhook X',
    description: 'Calls X.',
    type: 'WEBHOOK',
    agentScope: 'INQUIRY',
    enabled: true,
    isCustom: true,
  };
  assert.equal(conciseTool(short), short);

  const long: CurrentToolPayload = { ...short, description: 'r'.repeat(5000) };
  const out = conciseTool(long);
  assert.ok(out.description.length < 5000);
  assert.equal((out as any).fullCharLength, 5000);
});
