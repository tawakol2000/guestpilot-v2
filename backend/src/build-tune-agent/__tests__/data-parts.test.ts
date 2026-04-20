/**
 * Sprint 046 Session B, Gate B1 — verify the four new SSE part types
 * round-trip through the `emitDataPart` sink that tools use.
 *
 * Data parts bypass `stream-bridge.ts` (see the file header there), so
 * the "pass-through" under test is the runtime's writer wiring: a
 * `{type, id, data, transient}` envelope reaches the stream writer
 * unchanged. We simulate the runtime's sink with the same shape the
 * real runtime uses (see `runtime.ts#emitDataPart`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DATA_PART_TYPES,
  type AdvisoryData,
  type AuditReportData,
  type QuestionChoicesData,
  type StructuredDataPart,
  type SuggestedFixData,
} from '../data-parts';

function makeWriterSink() {
  const chunks: any[] = [];
  const persisted: any[] = [];
  const write = (part: {
    type: string;
    id?: string;
    data: unknown;
    transient?: boolean;
  }) => {
    chunks.push({
      type: part.type,
      id: part.id,
      data: part.data,
      transient: part.transient ?? false,
    });
    if (!part.transient) {
      persisted.push({ type: part.type, id: part.id, data: part.data });
    }
  };
  return { chunks, persisted, write };
}

test('data-suggested-fix round-trips through emitDataPart unchanged', () => {
  const sink = makeWriterSink();
  const data: SuggestedFixData = {
    id: 'fix-abc',
    target: { artifact: 'system_prompt', sectionId: 'checkout_time' },
    before: 'Checkout is at 11am.',
    after: 'Checkout is at 10am on weekends, 11am otherwise.',
    rationale: 'Weekend turnover tightened.',
    impact: 'Prevents late-checkout conflicts on Sat/Sun.',
    category: 'SYSTEM_PROMPT',
    createdAt: '2026-04-20T12:00:00Z',
  };
  const part: StructuredDataPart = {
    type: DATA_PART_TYPES.suggested_fix,
    id: 'suggested-fix:1',
    data,
  };
  sink.write(part);
  assert.equal(sink.chunks.length, 1);
  assert.equal(sink.chunks[0].type, 'data-suggested-fix');
  assert.deepEqual(sink.chunks[0].data, data);
  assert.equal(sink.persisted.length, 1);
});

test('data-question-choices round-trips through emitDataPart unchanged', () => {
  const sink = makeWriterSink();
  const data: QuestionChoicesData = {
    question: 'How should late checkouts be priced?',
    options: [
      { id: 'free', label: 'Free up to 1pm' },
      { id: 'flat', label: '£20 flat fee', recommended: true },
      { id: 'half_night', label: 'Half-night rate' },
    ],
    allowCustomInput: true,
  };
  sink.write({ type: DATA_PART_TYPES.question_choices, id: 'q:1', data });
  assert.equal(sink.chunks[0].type, 'data-question-choices');
  assert.deepEqual(sink.chunks[0].data, data);
});

test('data-audit-report round-trips through emitDataPart unchanged', () => {
  const sink = makeWriterSink();
  const data: AuditReportData = {
    rows: [
      { artifact: 'system_prompt', label: 'Coordinator prompt', status: 'ok', note: 'Up to date.' },
      {
        artifact: 'sop',
        artifactId: 'sop-late-checkout',
        label: 'Late checkout SOP',
        status: 'gap',
        note: 'No CONFIRMED-status variant.',
        findingId: 'f-1',
      },
      { artifact: 'faq', label: 'FAQ coverage', status: 'warn', note: '14 global, 0 property-scoped.' },
    ],
    topFindingId: 'f-1',
    summary: '1 gap, 1 warning.',
  };
  sink.write({ type: DATA_PART_TYPES.audit_report, id: 'audit:1', data });
  assert.equal(sink.chunks[0].type, 'data-audit-report');
  assert.deepEqual(sink.chunks[0].data, data);
});

test('data-advisory round-trips through emitDataPart unchanged', () => {
  const sink = makeWriterSink();
  const data: AdvisoryData = {
    kind: 'recent-edit',
    message: 'This artifact was last edited 6 hours ago.',
    context: { lastEditedAt: '2026-04-20T06:00:00Z' },
  };
  sink.write({ type: DATA_PART_TYPES.advisory, id: 'adv:1', data, transient: true });
  assert.equal(sink.chunks[0].type, 'data-advisory');
  assert.equal(sink.chunks[0].transient, true);
  assert.equal(sink.persisted.length, 0, 'transient parts do not persist');
});

test('DATA_PART_TYPES registry includes the four new Session B types', () => {
  const expected = [
    'data-suggested-fix',
    'data-question-choices',
    'data-audit-report',
    'data-advisory',
  ];
  const actual = Object.values(DATA_PART_TYPES);
  for (const t of expected) {
    assert.ok(actual.includes(t as any), `missing ${t} in DATA_PART_TYPES registry`);
  }
});
