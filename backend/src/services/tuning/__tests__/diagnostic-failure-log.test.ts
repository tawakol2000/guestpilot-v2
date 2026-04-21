/**
 * Sprint 049 Session A — A7.
 *
 * Each of the four controller fire-and-forget sites (shadow-preview
 * diagnostic, shadow-preview compaction, messages.controller Path A
 * diagnostic, conversations.controller Path B diagnostic) calls
 * `logTuningDiagnosticFailure` inside its catch block. This spec pins
 * the log shape + field mapping for all four phase/path/trigger
 * combinations so the Railway grep handle
 *     grep -rn TUNING_DIAGNOSTIC_FAILURE backend/src
 * stays stable as the helper is the single source of truth. Drift in
 * the tag string or the field set fails here before it reaches prod.
 *
 * Pattern: monkey-patch console.error to capture, call the helper with
 * a throw, assert the tag + structured fields. Restore console.error
 * after each case (finally) so failures don't leak into sibling specs.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  logTuningDiagnosticFailure,
  type TuningDiagnosticFailureContext,
} from '../diagnostic-failure-log';

interface CaptureResult {
  args: any[][];
  restore: () => void;
}

function captureConsoleError(): CaptureResult {
  const original = console.error;
  const args: any[][] = [];
  console.error = (...a: any[]) => {
    args.push(a);
  };
  return {
    args,
    restore() {
      console.error = original;
    },
  };
}

function runOnce(ctx: TuningDiagnosticFailureContext): any[] {
  const cap = captureConsoleError();
  try {
    logTuningDiagnosticFailure(ctx);
  } finally {
    cap.restore();
  }
  assert.equal(cap.args.length, 1, 'exactly one console.error call');
  return cap.args[0];
}

test('A7 site 1 — shadow-preview diagnostic: logs structured [TUNING_DIAGNOSTIC_FAILURE] with phase/path/trigger', () => {
  const err = new Error('mocked diagnostic OpenAI timeout');
  const [tag, payload] = runOnce({
    phase: 'diagnostic',
    path: 'shadow-preview',
    tenantId: 'tenant-1',
    messageId: 'msg-shadow-1',
    triggerType: 'EDIT_TRIGGERED',
    error: err,
  });
  assert.equal(tag, '[TUNING_DIAGNOSTIC_FAILURE]');
  assert.equal(payload.phase, 'diagnostic');
  assert.equal(payload.path, 'shadow-preview');
  assert.equal(payload.tenantId, 'tenant-1');
  assert.equal(payload.messageId, 'msg-shadow-1');
  assert.equal(payload.triggerType, 'EDIT_TRIGGERED');
  assert.equal(payload.reason, 'mocked diagnostic OpenAI timeout');
  assert.ok(typeof payload.stack === 'string' && payload.stack.length > 0);
});

test('A7 site 2 — shadow-preview compaction: triggerType null, phase=compaction', () => {
  const err = new Error('mocked compaction service crash');
  const [tag, payload] = runOnce({
    phase: 'compaction',
    path: 'shadow-preview',
    tenantId: 'tenant-2',
    messageId: 'msg-shadow-2',
    triggerType: null,
    error: err,
  });
  assert.equal(tag, '[TUNING_DIAGNOSTIC_FAILURE]');
  assert.equal(payload.phase, 'compaction');
  assert.equal(payload.path, 'shadow-preview');
  assert.equal(payload.triggerType, null);
  assert.equal(payload.reason, 'mocked compaction service crash');
});

test('A7 site 3 — messages Path A diagnostic: REJECT_TRIGGERED propagates', () => {
  const err = new Error('mocked writeSuggestion Prisma error');
  const [tag, payload] = runOnce({
    phase: 'diagnostic',
    path: 'messages',
    tenantId: 'tenant-3',
    messageId: 'msg-path-a',
    triggerType: 'REJECT_TRIGGERED',
    error: err,
  });
  assert.equal(tag, '[TUNING_DIAGNOSTIC_FAILURE]');
  assert.equal(payload.path, 'messages');
  assert.equal(payload.triggerType, 'REJECT_TRIGGERED');
  assert.equal(payload.reason, 'mocked writeSuggestion Prisma error');
});

test('A7 site 4 — conversations Path B diagnostic: non-Error thrown still logs reason/stack', () => {
  // Production has seen `throw "string"` cases from older libs — make sure
  // the helper coerces without crashing and still emits the structured log.
  const [tag, payload] = runOnce({
    phase: 'diagnostic',
    path: 'conversations',
    tenantId: 'tenant-4',
    messageId: 'msg-path-b',
    triggerType: 'EDIT_TRIGGERED',
    error: 'literal string thrown by third-party lib',
  });
  assert.equal(tag, '[TUNING_DIAGNOSTIC_FAILURE]');
  assert.equal(payload.path, 'conversations');
  assert.equal(payload.reason, 'literal string thrown by third-party lib');
  assert.equal(payload.stack, undefined, 'non-Error has no stack');
});
