/**
 * Feature 047 PR 3 — section-extractor unit tests.
 *
 * Run:  JWT_SECRET=test npx tsx --test src/build-tune-agent/tools/lib/__tests__/section-extractor.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSections } from '../section-extractor';

const SIGN_CTX = { tenantId: 't-1', artifactId: 'art-1', secret: 'test-secret' };

test('extractSections: ## headings — splits into one section per heading', () => {
  const body = [
    '## Voice',
    'Tone and politeness rules go here.',
    '',
    '## Screening',
    'Eligibility checks live here.',
    'Multi-line section body.',
    '',
    '## Closing',
    'Final pleasantries.',
  ].join('\n');

  const sections = extractSections(body, 'Fallback', SIGN_CTX);
  assert.equal(sections.length, 3);
  assert.equal(sections[0].name, 'Voice');
  assert.equal(sections[1].name, 'Screening');
  assert.equal(sections[2].name, 'Closing');
  assert.equal(sections[0].summary, 'Tone and politeness rules go here.');
  assert.equal(sections[1].summary, 'Eligibility checks live here.');
  assert.equal(sections[2].summary, 'Final pleasantries.');
});

test('extractSections: ## + ### mixed depths — both treated as section boundaries', () => {
  const body = [
    '## Top section',
    'Top body.',
    '',
    '### Sub section',
    'Sub body.',
  ].join('\n');

  const sections = extractSections(body, 'Fallback', SIGN_CTX);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].name, 'Top section');
  assert.equal(sections[1].name, 'Sub section');
});

test('extractSections: no headings — single-section fallback with artifact title', () => {
  const body = 'Just a flat body with no markdown headings at all.\n\nSecond paragraph.';
  const sections = extractSections(body, 'My SOP Title', SIGN_CTX);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, 'My SOP Title');
  assert.equal(sections[0].summary, 'Just a flat body with no markdown headings at all.');
  assert.equal(sections[0].body, body);
});

test('extractSections: empty body → empty array', () => {
  assert.deepEqual(extractSections('', 'Title', SIGN_CTX), []);
});

test('extractSections: heading at EOF with empty body — section emitted with empty body', () => {
  const body = '## First\nFirst body.\n## Second\n';
  const sections = extractSections(body, 'Fallback', SIGN_CTX);
  assert.equal(sections.length, 2);
  assert.equal(sections[1].name, 'Second');
  assert.equal(sections[1].body, ''); // trailing whitespace stripped
});

test('extractSections: heading with code-block fence in body — fence line itself skipped from summary', () => {
  const body = [
    '## With code',
    '```ts',
    'const x = 1;',
    '```',
    'After the fence.',
    '',
    '## Next',
    'Next body.',
  ].join('\n');
  const sections = extractSections(body, 'Fallback', SIGN_CTX);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].name, 'With code');
  assert.ok(sections[0].body.includes('const x = 1'));
  // Summary skips the ```ts fence line. The first non-empty non-fence
  // content line (the code itself) wins. Heuristic limitation: we don't
  // track fence-open/close state, so a code line still surfaces. That's
  // fine — for triage, "this section has code" is informative; the agent
  // can fetch verbosity:'detailed' if it needs the actual content.
  assert.equal(sections[0].summary, 'const x = 1;');
  assert.equal(sections[1].name, 'Next');
});

test('extractSections: long summary truncated at 80 chars with ellipsis', () => {
  const body = [
    '## Long Para',
    'a'.repeat(200),
  ].join('\n');
  const sections = extractSections(body, 'Fallback', SIGN_CTX);
  assert.equal(sections[0].summary.length, 80);
  assert.ok(sections[0].summary.endsWith('…'));
});

test('extractSections: hashId is HMAC-stable for same (tenant, artifact, name, body)', () => {
  const body = '## A\nbody A.\n## B\nbody B.';
  const a = extractSections(body, 'F', SIGN_CTX);
  const b = extractSections(body, 'F', SIGN_CTX);
  assert.equal(a[0].hashId, b[0].hashId);
  assert.equal(a[1].hashId, b[1].hashId);
  // Different tenant → different hash
  const otherTenant = extractSections(body, 'F', { ...SIGN_CTX, tenantId: 't-2' });
  assert.notEqual(a[0].hashId, otherTenant[0].hashId);
});

test('extractSections: tokens approximation ≈ ceil(body.length / 3.6)', () => {
  const body = '## Test\n' + 'x'.repeat(360);
  const sections = extractSections(body, 'Fallback', SIGN_CTX);
  // body.length = 360 (the 'x' repeats); ceil(360/3.6) = 100
  assert.equal(sections[0].tokens, 100);
});
