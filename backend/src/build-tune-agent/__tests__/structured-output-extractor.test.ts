/**
 * Sprint 060-D Phase 5 — structured-output extractor unit tests.
 *
 * Run: JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/structured-output-extractor.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  feedExtractor,
  flushExtractor,
  makeExtractorState,
} from '../structured-output-extractor';

test('extractor: pure prose passes through unchanged', () => {
  const s = makeExtractorState();
  const out = feedExtractor(s, 'hello there, friend');
  assert.equal(out.safeText, 'hello there, friend');
  assert.deepEqual(out.emittedDataParts, []);
  assert.deepEqual(out.errors, []);
});

test('extractor: complete question-choices block emitted in one chunk', () => {
  const s = makeExtractorState();
  const json = '{"question":"Ready?","options":[{"id":"y","label":"Yes"}],"allowCustomInput":false}';
  const out = feedExtractor(
    s,
    `prefix <data-question-choices>${json}</data-question-choices> suffix`,
  );
  assert.equal(out.safeText, 'prefix  suffix');
  assert.equal(out.emittedDataParts.length, 1);
  assert.equal(out.emittedDataParts[0].partType, 'data-question-choices');
  assert.deepEqual(out.emittedDataParts[0].data, JSON.parse(json));
  assert.deepEqual(out.errors, []);
});

test('extractor: complete audit-report block emitted', () => {
  const s = makeExtractorState();
  const json = '{"rows":[{"artifact":"sop","label":"x","status":"ok","note":"n"}],"topFindingId":null}';
  const out = feedExtractor(s, `<data-audit-report>${json}</data-audit-report>`);
  assert.equal(out.safeText, '');
  assert.equal(out.emittedDataParts.length, 1);
  assert.equal(out.emittedDataParts[0].partType, 'data-audit-report');
});

test('extractor: block split across many small chunks reassembles', () => {
  const s = makeExtractorState();
  const json = '{"question":"Ready?","options":[{"id":"y","label":"Yes"}],"allowCustomInput":false}';
  const full = `before <data-question-choices>${json}</data-question-choices> after`;
  let collected = '';
  const allParts: any[] = [];
  // 5-char chunks — pathological case for chunk-boundary handling.
  for (let i = 0; i < full.length; i += 5) {
    const out = feedExtractor(s, full.slice(i, i + 5));
    collected += out.safeText;
    allParts.push(...out.emittedDataParts);
    assert.deepEqual(out.errors, []);
  }
  const flush = flushExtractor(s);
  collected += flush.safeText;
  assert.equal(collected, 'before  after');
  assert.equal(allParts.length, 1);
  assert.deepEqual(allParts[0].data, JSON.parse(json));
});

test('extractor: chunk ending in partial opening tag holds back', () => {
  const s = makeExtractorState();
  const out1 = feedExtractor(s, 'hello <da');
  // The '<da' is held back since it could complete to <data-...>.
  assert.equal(out1.safeText, 'hello ');
  assert.deepEqual(out1.emittedDataParts, []);
  const out2 = feedExtractor(s, 'ta-question-choices>{"question":"q","options":[{"id":"y","label":"Yes"}],"allowCustomInput":false}</data-question-choices>!');
  assert.equal(out2.safeText, '!');
  assert.equal(out2.emittedDataParts.length, 1);
});

test('extractor: stray < that does NOT match any tag flushes through', () => {
  const s = makeExtractorState();
  const out = feedExtractor(s, 'a < b');
  assert.equal(out.safeText, 'a < b');
});

test('extractor: chunk ending in partial CLOSING tag holds back inside block', () => {
  const s = makeExtractorState();
  const json = '{"question":"q","options":[{"id":"y","label":"Yes"}],"allowCustomInput":false}';
  const out1 = feedExtractor(s, `<data-question-choices>${json}</data-questi`);
  assert.equal(out1.safeText, '');
  assert.equal(out1.emittedDataParts.length, 0);
  const out2 = feedExtractor(s, 'on-choices>tail');
  assert.equal(out2.safeText, 'tail');
  assert.equal(out2.emittedDataParts.length, 1);
});

test('extractor: two adjacent blocks both emit', () => {
  const s = makeExtractorState();
  const j1 = '{"question":"q","options":[{"id":"y","label":"Yes"}],"allowCustomInput":false}';
  const j2 = '{"rows":[{"artifact":"sop","label":"x","status":"ok","note":"n"}],"topFindingId":null}';
  const out = feedExtractor(
    s,
    `<data-question-choices>${j1}</data-question-choices><data-audit-report>${j2}</data-audit-report>done`,
  );
  assert.equal(out.safeText, 'done');
  assert.equal(out.emittedDataParts.length, 2);
  assert.equal(out.emittedDataParts[0].partType, 'data-question-choices');
  assert.equal(out.emittedDataParts[1].partType, 'data-audit-report');
});

test('extractor: malformed JSON surfaces as an error, body dropped', () => {
  const s = makeExtractorState();
  const out = feedExtractor(s, '<data-question-choices>not json</data-question-choices>');
  assert.equal(out.safeText, '');
  assert.equal(out.emittedDataParts.length, 0);
  assert.equal(out.errors.length, 1);
});

test('extractor: flushExtractor with unclosed block surfaces error', () => {
  const s = makeExtractorState();
  feedExtractor(s, '<data-question-choices>{"unclosed":true');
  const flush = flushExtractor(s);
  assert.equal(flush.safeText, '');
  assert.equal(flush.errors.length, 1);
});

test('extractor: flushExtractor recovers held-back partial tag prefix as visible text', () => {
  const s = makeExtractorState();
  const out1 = feedExtractor(s, 'before <da');
  assert.equal(out1.safeText, 'before ');
  const flush = flushExtractor(s);
  assert.equal(flush.safeText, '<da');
  assert.deepEqual(flush.errors, []);
});
