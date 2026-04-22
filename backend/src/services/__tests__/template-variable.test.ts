/**
 * Focused regression tests for template-variable resolver's content-block
 * path — specifically the 2026-04-22 fix that prevents duplicate
 * `{VAR}` references in the same block from leaking a raw token into
 * the rendered prompt.
 *
 * The old implementation called `blockText.replace(literal, value)` once
 * per regex match in the original template. That's N single-replace
 * calls in blockText, which works by accident if every iteration takes
 * the "in-scope + matches" branch — but any skip (unknown var, gate
 * missed) leaves a raw `{VAR}` in place. The new implementation walks
 * distinct referenced vars and uses split/join for a global substitute.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveVariables } from '../template-variable.service';

const CONTENT_BLOCKS_DELIMITER = '<!-- CONTENT_BLOCKS -->';
const BLOCK_DELIMITER = '<!-- BLOCK -->';

function buildPrompt(systemPart: string, blocks: string[]): string {
  return [
    systemPart,
    CONTENT_BLOCKS_DELIMITER,
    blocks.join(`\n${BLOCK_DELIMITER}\n`),
  ].join('\n');
}

test('content-block: single {VAR} replaced verbatim', () => {
  const prompt = buildPrompt('System part.', [
    'Reservation: {RESERVATION_DETAILS}',
  ]);
  const { contentBlocks } = resolveVariables(
    prompt,
    { RESERVATION_DETAILS: 'Jane Doe · 3 nights · CONFIRMED' },
    'coordinator',
  );
  assert.equal(contentBlocks.length, 1);
  assert.equal(
    contentBlocks[0].text,
    'Reservation: Jane Doe · 3 nights · CONFIRMED',
  );
});

test('content-block: DUPLICATE {VAR} in same block — both occurrences replaced (regression)', () => {
  // Regression for 2026-04-22: previously relied on per-match
  // `.replace(literal, value)` calls which are single-occurrence.
  // If any code-path early-skipped, the tail {VAR} could leak.
  const prompt = buildPrompt('System.', [
    'Context: {RESERVATION_DETAILS} — confirming {RESERVATION_DETAILS}.',
  ]);
  const { contentBlocks } = resolveVariables(
    prompt,
    { RESERVATION_DETAILS: 'J · CONFIRMED' },
    'coordinator',
  );
  assert.equal(contentBlocks.length, 1);
  assert.equal(
    contentBlocks[0].text,
    'Context: J · CONFIRMED — confirming J · CONFIRMED.',
  );
  // Explicit anti-leak assertion.
  assert.doesNotMatch(
    contentBlocks[0].text,
    /\{RESERVATION_DETAILS\}/,
    'no raw token survives',
  );
});

test('content-block: unknown {VAR} left as literal (so output-linter can flag typos)', () => {
  const prompt = buildPrompt('System.', [
    'Known: {RESERVATION_DETAILS}. Unknown: {BOGUS_TYPO}.',
  ]);
  const { contentBlocks } = resolveVariables(
    prompt,
    { RESERVATION_DETAILS: 'data' },
    'coordinator',
  );
  // Block rendered because at least one in-scope var resolved.
  assert.equal(contentBlocks.length, 1);
  assert.match(contentBlocks[0].text, /Known: data/);
  // Unknown stays literal rather than being silently stripped.
  assert.match(contentBlocks[0].text, /\{BOGUS_TYPO\}/);
});

test('content-block: empty value with non-null default uses the default', () => {
  const prompt = buildPrompt('System.', [
    'Recent: {CONVERSATION_HISTORY}',
  ]);
  const { contentBlocks } = resolveVariables(
    prompt,
    { CONVERSATION_HISTORY: '' },
    'coordinator',
  );
  assert.equal(contentBlocks.length, 1);
  // CONVERSATION_HISTORY default is 'No previous messages.'
  assert.match(contentBlocks[0].text, /No previous messages\./);
});

test('content-block: duplicate unknown {VAR} — ALL occurrences left literal', () => {
  // The split/join fix applies symmetrically: if a block has two
  // occurrences of an unknown var, both should survive as literals
  // rather than only the first.
  const prompt = buildPrompt('System.', [
    'First: {BOGUS}. Second: {BOGUS}. Third: {RESERVATION_DETAILS}.',
  ]);
  const { contentBlocks } = resolveVariables(
    prompt,
    { RESERVATION_DETAILS: 'ok' },
    'coordinator',
  );
  const text = contentBlocks[0].text;
  // Both {BOGUS} survive as literals.
  const bogusMatches = text.match(/\{BOGUS\}/g) ?? [];
  assert.equal(bogusMatches.length, 2, 'both unknown tokens survived');
  assert.match(text, /Third: ok/);
});

test('content-block: mixed data + duplicate tokens + unknowns — clean final render', () => {
  const prompt = buildPrompt('System.', [
    'Guest: {GUEST_NAME}. Dates: {DATES}. Guest again: {GUEST_NAME}. Typo: {MADE_UP}.',
  ]);
  // GUEST_NAME + DATES are not in TEMPLATE_VARIABLES so they'll stay literal
  // (this test captures the linter-friendly behaviour). The duplicate
  // {GUEST_NAME} must not cause a partial-leak — either both stay or (if
  // they'd been registered) both replace.
  const { contentBlocks } = resolveVariables(
    prompt,
    {},
    'coordinator',
  );
  // No in-scope var resolved, so no content blocks emitted.
  assert.equal(
    contentBlocks.length,
    0,
    'block with only unknown vars should not ship as a content block',
  );
});
