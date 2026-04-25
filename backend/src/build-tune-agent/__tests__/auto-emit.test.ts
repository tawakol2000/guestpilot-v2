/**
 * Sprint 060-D Phase 6 — auto-emit unit tests.
 *
 * Run: JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/auto-emit.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSessionDiffSummary,
  hasTurnActivity,
  maybeEmitSessionDiffSummary,
  buildInterviewProgressData,
  snapshotsDiffer,
} from '../auto-emit';

test('buildSessionDiffSummary: counts create-* tool calls into written.created', () => {
  const summary = buildSessionDiffSummary([
    'mcp__tuning-agent__studio_create_sop',
    'mcp__tuning-agent__studio_create_faq',
    'mcp__tuning-agent__studio_create_system_prompt',
  ]);
  assert.equal(summary.written.created, 3);
  assert.equal(summary.written.edited, 0);
  assert.equal(summary.written.reverted, 0);
});

test('buildSessionDiffSummary: counts studio_suggestion as edited', () => {
  const summary = buildSessionDiffSummary([
    'mcp__tuning-agent__studio_suggestion',
    'mcp__tuning-agent__studio_suggestion',
  ]);
  assert.equal(summary.written.edited, 2);
});

test('buildSessionDiffSummary: counts rollback as reverted, test_pipeline as runs', () => {
  const summary = buildSessionDiffSummary([
    'mcp__tuning-agent__studio_rollback',
    'mcp__tuning-agent__studio_test_pipeline',
    'mcp__tuning-agent__studio_test_pipeline',
  ]);
  assert.equal(summary.written.reverted, 1);
  assert.equal(summary.tested.runs, 2);
});

test('buildSessionDiffSummary: ignores non-tracked tool calls', () => {
  const summary = buildSessionDiffSummary([
    'mcp__tuning-agent__studio_get_context',
    'mcp__tuning-agent__studio_memory',
  ]);
  assert.equal(summary.written.created, 0);
  assert.equal(summary.tested.runs, 0);
  assert.equal(hasTurnActivity(summary), false);
});

test('hasTurnActivity: true on any tracked count', () => {
  assert.equal(
    hasTurnActivity({
      written: { created: 1, edited: 0, reverted: 0 },
      tested: { runs: 0, totalVariants: 0, passed: 0 },
      plans: { cancelled: 0 },
      note: null,
    }),
    true,
  );
  assert.equal(
    hasTurnActivity({
      written: { created: 0, edited: 0, reverted: 0 },
      tested: { runs: 1, totalVariants: 0, passed: 0 },
      plans: { cancelled: 0 },
      note: null,
    }),
    true,
  );
});

test('maybeEmitSessionDiffSummary: emits data-session-diff-summary when active', () => {
  const emitted: any[] = [];
  const summary = maybeEmitSessionDiffSummary({
    toolCallsInvoked: ['mcp__tuning-agent__studio_create_sop'],
    emitDataPart: (p) => emitted.push(p),
    assistantMessageId: 'msg_1',
  });
  assert.ok(summary);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].type, 'data-session-diff-summary');
  assert.equal(emitted[0].id, 'session-summary:msg_1');
});

test('maybeEmitSessionDiffSummary: emits nothing on pure-conversation turns', () => {
  const emitted: any[] = [];
  const summary = maybeEmitSessionDiffSummary({
    toolCallsInvoked: ['mcp__tuning-agent__studio_get_context'],
    emitDataPart: (p) => emitted.push(p),
    assistantMessageId: 'msg_1',
  });
  assert.equal(summary, null);
  assert.equal(emitted.length, 0);
});

test('snapshotsDiffer: detects added, removed, and changed slots', () => {
  assert.equal(snapshotsDiffer({}, { checkin_time: '3pm' }), true);
  assert.equal(snapshotsDiffer({ checkin_time: '3pm' }, {}), true);
  assert.equal(snapshotsDiffer({ checkin_time: '3pm' }, { checkin_time: '4pm' }), true);
  assert.equal(snapshotsDiffer({ checkin_time: '3pm' }, { checkin_time: '3pm' }), false);
  assert.equal(snapshotsDiffer({}, {}), false);
});

test('buildInterviewProgressData: marks filled vs pending; flags load-bearing', () => {
  const data = buildInterviewProgressData(
    { property_identity: 'Beach Cottage', checkin_time: '3pm' },
    'Interview',
  );
  assert.equal(data.title, 'Interview');
  const propertyIdentity = data.slots.find((s) => s.id === 'property_identity');
  assert.ok(propertyIdentity);
  assert.equal(propertyIdentity.status, 'filled');
  assert.equal(propertyIdentity.loadBearing, true);
  assert.equal(propertyIdentity.answer, 'Beach Cottage');

  const noisePolicy = data.slots.find((s) => s.id === 'noise_policy');
  assert.ok(noisePolicy);
  assert.equal(noisePolicy.status, 'pending');
  assert.equal(noisePolicy.loadBearing, false);
});

test('buildInterviewProgressData: defaulted slots show "(default)" answer', () => {
  const data = buildInterviewProgressData(
    { checkin_time: '<!-- DEFAULT: change me --> 3pm' },
    'X',
  );
  const ci = data.slots.find((s) => s.id === 'checkin_time');
  assert.ok(ci);
  assert.equal(ci.status, 'filled');
  assert.equal(ci.answer, '(default)');
});
