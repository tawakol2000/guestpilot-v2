/**
 * Sprint 051 A B3 — regression test for the citation grammar prompt
 * section. The marker format is a contract with
 * frontend/components/studio/citation-parser.ts; any change here is a
 * breaking change for already-rendered sessions.
 *
 * Sprint 052 A C4 — extended to regression-lock the slug rule (shared
 * contract between this prompt block, frontend `lib/slug.ts`, and the
 * backend mirror `lib/slug.ts`). Drift here would silently break B3
 * citation scroll for every future session.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSharedPrefix } from '../system-prompt';
import { slug } from '../lib/slug';

test('shared prefix contains the citation_grammar block', () => {
  const prompt = buildSharedPrefix();
  assert.ok(
    prompt.includes('<citation_grammar>'),
    'citation_grammar section missing from shared prefix',
  );
  assert.ok(
    prompt.includes('[[cite:<type>:<id>]]'),
    'whole-artifact marker example missing',
  );
  assert.ok(
    prompt.includes('[[cite:<type>:<id>#<section>]]'),
    'section-anchored marker example missing',
  );
  // Wrapping can insert a newline mid-enum — check each type
  // individually so the formatting isn't part of the contract.
  for (const type of ['sop', 'faq', 'system_prompt', 'tool', 'property_override']) {
    assert.ok(
      prompt.includes(type),
      `artifact type "${type}" missing from citation grammar`,
    );
  }
});

test('citation grammar warns against fabricating artifact ids', () => {
  const prompt = buildSharedPrefix();
  assert.match(prompt, /never fabricate an artifact id/i);
});

test('citation grammar teaches the explicit slug rule (052-C4)', () => {
  const prompt = buildSharedPrefix();
  // Rule is expressed as three bullet steps — check each fragment so
  // formatting drift doesn't break the test but a rule change does.
  assert.match(
    prompt,
    /lowercase the heading text/i,
    'slug rule step 1 (lowercase) missing',
  );
  assert.match(
    prompt,
    /non-alphanumeric characters with a single '-'/i,
    'slug rule step 2 (non-alphanumeric collapse) missing',
  );
  assert.match(
    prompt,
    /strip leading\/trailing '-'/i,
    'slug rule step 3 (strip dashes) missing',
  );
  // The prompt must anchor both the frontend + backend implementation
  // paths so the next reader can find the contract surface.
  assert.match(
    prompt,
    /frontend\/lib\/slug\.ts/,
    'frontend slug.ts path missing',
  );
  assert.match(
    prompt,
    /backend\/src\/build-tune-agent\/lib\/slug\.ts/,
    'backend slug.ts path missing',
  );
});

test('prompt examples match the backend slug function output (052-C4)', () => {
  const prompt = buildSharedPrefix();
  // The two canonical examples in the prompt are the assertion of the
  // contract. If the backend slug function produces a different output
  // for either, the frontend/backend contract has silently drifted and
  // B3 citation scroll is broken for every future session.
  const cases: Array<[string, string]> = [
    ['Early Check-in', 'early-check-in'],
    ['Overnight guests?', 'overnight-guests'],
  ];
  // Collapse whitespace so line-wrapped "→" in the prompt still matches.
  const promptFlat = prompt.replace(/\s+/g, ' ');
  for (const [heading, expected] of cases) {
    assert.equal(
      slug(heading),
      expected,
      `backend slug("${heading}") should equal "${expected}"`,
    );
    assert.ok(
      promptFlat.includes(`"${heading}" → "${expected}"`),
      `prompt example for "${heading}" → "${expected}" missing`,
    );
  }
});

test('slug function handles edge cases (052-C4)', () => {
  assert.equal(slug(''), '', 'empty input');
  assert.equal(slug('---'), '', 'only dashes');
  assert.equal(slug('!!!'), '', 'only non-alnum');
  assert.equal(slug('Hello World'), 'hello-world', 'basic case');
  assert.equal(slug('  spaces  '), 'spaces', 'leading/trailing whitespace');
  assert.equal(slug('multiple   spaces'), 'multiple-spaces', 'whitespace run');
  assert.equal(slug('café-résumé'), 'caf-r-sum', 'unicode stripped to ascii');
  assert.equal(slug('A/B/C'), 'a-b-c', 'slash separator');
  assert.equal(slug('__underscore__'), 'underscore', 'underscores trimmed');
});
