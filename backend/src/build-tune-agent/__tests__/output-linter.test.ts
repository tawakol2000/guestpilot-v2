/**
 * Output linter — unit tests (sprint 046 Session A).
 *
 * Run: npx tsx --test src/build-tune-agent/__tests__/output-linter.test.ts
 *
 * Six cases: each of R1/R2/R3 pass + fail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lintAgentOutput, buildLinterAdvisories } from '../output-linter';

test('R1 pass: short prose without a structured part is fine', () => {
  const findings = lintAgentOutput({
    finalText: 'Got it — switching modes.',
    dataPartTypes: [],
  });
  assert.equal(findings.filter((f) => f.rule === 'R1').length, 0);
});

test('R1 fail: >120 words prose + zero structured parts', () => {
  const text = Array.from({ length: 125 }, (_, i) => `word${i}`).join(' ');
  const findings = lintAgentOutput({
    finalText: text,
    dataPartTypes: ['data-advisory'], // transient advisories don't count
  });
  const r1 = findings.filter((f) => f.rule === 'R1');
  assert.equal(r1.length, 1);
  assert.equal(r1[0].severity, 'warn');
  assert.equal((r1[0].detail as any)?.words, 125);
});

test('R2 pass: exactly one suggested-fix is allowed', () => {
  const findings = lintAgentOutput({
    finalText: 'Here is the top fix.',
    dataPartTypes: ['data-suggested-fix'],
  });
  assert.equal(findings.filter((f) => f.rule === 'R2').length, 0);
});

test('R2 fail: two suggested-fix parts on one turn', () => {
  const findings = lintAgentOutput({
    finalText: 'Two fixes.',
    dataPartTypes: ['data-suggested-fix', 'data-suggested-fix'],
  });
  const r2 = findings.filter((f) => f.rule === 'R2');
  assert.equal(r2.length, 1);
  assert.equal((r2[0].detail as any)?.suggestedFixCount, 2);
});

test('R3 pass: two-or-fewer bullet lines is fine', () => {
  const findings = lintAgentOutput({
    finalText: 'Couple of points:\n- first\n- second',
    dataPartTypes: ['data-audit-report'],
  });
  assert.equal(findings.filter((f) => f.rule === 'R3').length, 0);
});

test('R3 fail: three ordered-list lines trips the rule', () => {
  const findings = lintAgentOutput({
    finalText: '1. one\n2. two\n3. three\nall done.',
    dataPartTypes: [],
  });
  const r3 = findings.filter((f) => f.rule === 'R3');
  assert.equal(r3.length, 1);
  assert.ok(((r3[0].detail as any)?.orderedLineCount ?? 0) >= 3);
});

test('R3 fail: three bulleted lines also trips the rule', () => {
  const findings = lintAgentOutput({
    finalText: '- alpha\n- bravo\n- charlie',
    dataPartTypes: [],
  });
  assert.ok(findings.some((f) => f.rule === 'R3'));
});

test('R1 pass when a structured part is present regardless of word count', () => {
  const text = Array.from({ length: 200 }, () => 'word').join(' ');
  const findings = lintAgentOutput({
    finalText: text,
    dataPartTypes: ['data-audit-report'],
  });
  assert.equal(findings.filter((f) => f.rule === 'R1').length, 0);
});

// ─── Sprint 046 Session D — enforcement advisories ───────────────────

test('buildLinterAdvisories returns a linter-drop for R1', () => {
  const findings = lintAgentOutput({
    finalText: Array.from({ length: 130 }, () => 'word').join(' '),
    dataPartTypes: ['data-advisory'],
  });
  const advisories = buildLinterAdvisories(findings);
  const r1 = advisories.find((a) => (a.context as any)?.rule === 'R1');
  assert.ok(r1, 'expected a linter-drop advisory for R1');
  assert.equal(r1!.kind, 'linter-drop');
  // Sprint 047 Session A — Path A message, no "omitted" phrasing.
  assert.match(r1!.message, /long-form prose without a structured card/i);
  assert.doesNotMatch(r1!.message, /omitted/i);
});

test('buildLinterAdvisories returns a drop-count advisory for R2', () => {
  const findings = lintAgentOutput({
    finalText: 'two fixes',
    dataPartTypes: ['data-suggested-fix', 'data-suggested-fix', 'data-suggested-fix'],
  });
  const advisories = buildLinterAdvisories(findings, { droppedSuggestedFixCount: 2 });
  const r2 = advisories.find((a) => (a.context as any)?.rule === 'R2');
  assert.ok(r2, 'expected a linter-drop advisory for R2');
  assert.match(r2!.message, /Dropped 2 additional suggested fixes/);
});

test('buildLinterAdvisories does NOT return an advisory for R3 (log-only)', () => {
  const findings = lintAgentOutput({
    finalText: '1. one\n2. two\n3. three',
    dataPartTypes: [],
  });
  const advisories = buildLinterAdvisories(findings);
  const r3 = advisories.find((a) => (a.context as any)?.rule === 'R3');
  assert.equal(r3, undefined, 'R3 must remain log-only per plan §5.5');
});
