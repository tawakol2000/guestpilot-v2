/**
 * test-judge — unit tests.
 *
 * Run: npx tsx --test src/build-tune-agent/preview/__tests__/test-judge.test.ts
 *
 * Covers: happy path JSON parsing, score clamping, missing JSON fallback,
 * deterministic paragraph shuffling, network/API failure fallback.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runTestJudge,
  parseJudgeJson,
  shuffleTenantContext,
  formatPipelineAction,
  JUDGE_PROMPT_VERSION,
  JUDGE_MODEL,
} from '../test-judge';

function fakeClient(reply: string | Error) {
  return {
    messages: {
      create: async () => {
        if (reply instanceof Error) throw reply;
        return { content: [{ type: 'text' as const, text: reply }] } as any;
      },
    },
  } as any;
}

test('parseJudgeJson: extracts well-formed JSON', () => {
  const parsed = parseJudgeJson(
    '{"score": 0.85, "rationale": "Good reply.", "failureCategory": null}'
  );
  assert.equal(parsed.score, 0.85);
  assert.equal(parsed.rationale, 'Good reply.');
  assert.equal(parsed.failureCategory, undefined);
});

test('parseJudgeJson: strips ```json fences', () => {
  const parsed = parseJudgeJson(
    '```json\n{"score": 0.6, "rationale": "Partial.", "failureCategory": "missing-sop-reference"}\n```'
  );
  assert.equal(parsed.score, 0.6);
  assert.equal(parsed.failureCategory, 'missing-sop-reference');
});

test('parseJudgeJson: falls back gracefully on non-JSON', () => {
  const parsed = parseJudgeJson('I think it was a good reply.');
  assert.equal(parsed.score, 0);
  assert.match(parsed.rationale, /not JSON/);
});

test('shuffleTenantContext: single paragraph returns unchanged', () => {
  const inp = 'one paragraph only';
  assert.equal(shuffleTenantContext(inp, 'seed'), inp);
});

test('shuffleTenantContext: deterministic for same seed', () => {
  const ctx = 'para A\n\npara B\n\npara C\n\npara D';
  const a = shuffleTenantContext(ctx, 'message-1');
  const b = shuffleTenantContext(ctx, 'message-1');
  assert.equal(a, b);
});

test('shuffleTenantContext: preserves all paragraphs', () => {
  const ctx = 'para A\n\npara B\n\npara C';
  const shuffled = shuffleTenantContext(ctx, 'seed').split('\n\n').sort();
  assert.deepEqual(shuffled, ['para A', 'para B', 'para C']);
});

test('runTestJudge: happy path returns score + rationale + version stamp', async () => {
  const client = fakeClient(
    '{"score": 0.82, "rationale": "Reply addresses the question and references the late-checkout SOP.", "failureCategory": null}'
  );
  const r = await runTestJudge(
    {
      tenantContext: 'Late-checkout SOP: available until 2pm free.',
      guestMessage: 'Can I check out at 2pm?',
      aiReply: 'Yes, 2pm late checkout is free at this property.',
    },
    { client }
  );
  assert.equal(r.score, 0.82);
  assert.match(r.rationale, /late-checkout/);
  assert.equal(r.failureCategory, undefined);
  assert.equal(r.promptVersion, JUDGE_PROMPT_VERSION);
  assert.equal(r.judgeModel, JUDGE_MODEL);
});

test('runTestJudge: low score surfaces failureCategory', async () => {
  const client = fakeClient(
    '{"score": 0.3, "rationale": "Reply ignored the wifi SOP.", "failureCategory": "missing-sop-reference"}'
  );
  const r = await runTestJudge(
    {
      tenantContext: 'Wifi SOP: password is ROOM_WIFI_PASSWORD.',
      guestMessage: "What's the wifi password?",
      aiReply: 'Let me check.',
    },
    { client }
  );
  assert.equal(r.score, 0.3);
  assert.equal(r.failureCategory, 'missing-sop-reference');
});

test('runTestJudge: clamps scores out of [0,1]', async () => {
  const client = fakeClient(
    '{"score": 1.5, "rationale": "Excellent.", "failureCategory": null}'
  );
  const r = await runTestJudge(
    { tenantContext: 'x', guestMessage: 'y', aiReply: 'z' },
    { client }
  );
  assert.equal(r.score, 1);
});

test('runTestJudge: network failure returns score=0 with judge-error category', async () => {
  const client = fakeClient(new Error('ECONNRESET'));
  const r = await runTestJudge(
    { tenantContext: 'x', guestMessage: 'y', aiReply: 'z' },
    { client }
  );
  assert.equal(r.score, 0);
  assert.equal(r.failureCategory, 'judge-error');
  assert.match(r.rationale, /ECONNRESET/);
});

test('formatPipelineAction: undefined → legacy-caller placeholder', () => {
  const s = formatPipelineAction(undefined);
  assert.match(s, /None provided/);
});

test('formatPipelineAction: escalation object renders title + urgency + note', () => {
  const s = formatPipelineAction({
    escalation: {
      title: 'document_verification',
      note: 'Guest sent passport for compound permit',
      urgency: 'info_request',
    },
    scheduledTime: null,
    resolveTaskId: null,
    updateTaskId: null,
  });
  assert.match(s, /title: "document_verification"/);
  assert.match(s, /urgency: "info_request"/);
  assert.match(s, /compound permit/);
});

test('formatPipelineAction: null escalation is rendered as null (not omitted)', () => {
  const s = formatPipelineAction({
    escalation: null,
    scheduledTime: null,
    resolveTaskId: null,
    updateTaskId: null,
  });
  assert.match(s, /escalation: null/);
});

test('formatPipelineAction: includes scheduledTime and task ids when set', () => {
  const s = formatPipelineAction({
    escalation: null,
    scheduledTime: { kind: 'check_out', time: '14:00' },
    resolveTaskId: 'task-42',
    updateTaskId: 'task-99',
  });
  assert.match(s, /kind: "check_out"/);
  assert.match(s, /time: "14:00"/);
  assert.match(s, /resolveTaskId: "task-42"/);
  assert.match(s, /updateTaskId: "task-99"/);
});

test('runTestJudge: passes pipelineAction into the user prompt', async () => {
  let capturedPrompt = '';
  const client = {
    messages: {
      create: async (opts: any) => {
        capturedPrompt = opts.messages[0].content;
        return {
          content: [
            {
              type: 'text' as const,
              text: '{"score": 0.8, "rationale": "Short ack + escalation is fine.", "failureCategory": null}',
            },
          ],
        } as any;
      },
    },
  } as any;
  await runTestJudge(
    {
      tenantContext: 'SOP: acknowledge and escalate passport submissions.',
      guestMessage: '[Guest sends passport] Here is my passport.',
      aiReply: 'Thanks for sending the passport.',
      pipelineAction: {
        escalation: {
          title: 'document_verification',
          note: 'Passport received for visitor',
          urgency: 'info_request',
        },
        scheduledTime: null,
        resolveTaskId: null,
        updateTaskId: null,
      },
    },
    { client }
  );
  // Judge must see the action block so it can credit the escalation.
  assert.match(capturedPrompt, /<pipeline_action>/);
  assert.match(capturedPrompt, /document_verification/);
  assert.match(capturedPrompt, /info_request/);
});

test('runTestJudge: absent pipelineAction falls back to legacy placeholder', async () => {
  let capturedPrompt = '';
  const client = {
    messages: {
      create: async (opts: any) => {
        capturedPrompt = opts.messages[0].content;
        return {
          content: [
            {
              type: 'text' as const,
              text: '{"score": 0.8, "rationale": "ok", "failureCategory": null}',
            },
          ],
        } as any;
      },
    },
  } as any;
  await runTestJudge(
    { tenantContext: 'x', guestMessage: 'y', aiReply: 'z' },
    { client }
  );
  assert.match(capturedPrompt, /None provided/);
});

test('runTestJudge: failureCategory only set when score <0.7', async () => {
  const client = fakeClient(
    '{"score": 0.85, "rationale": "Good.", "failureCategory": "missing-sop-reference"}'
  );
  const r = await runTestJudge(
    { tenantContext: 'x', guestMessage: 'y', aiReply: 'z' },
    { client }
  );
  // Score ≥0.7 — failureCategory should be stripped even if the model
  // mistakenly returns one.
  assert.equal(r.failureCategory, undefined);
});
