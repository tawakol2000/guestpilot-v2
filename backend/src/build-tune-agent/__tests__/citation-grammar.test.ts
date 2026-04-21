/**
 * Sprint 051 A B3 — regression test for the citation grammar prompt
 * section. The marker format is a contract with
 * frontend/components/studio/citation-parser.ts; any change here is a
 * breaking change for already-rendered sessions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSharedPrefix } from '../system-prompt';

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
