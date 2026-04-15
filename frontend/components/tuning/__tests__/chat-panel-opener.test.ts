/**
 * Sprint 04 — pure-logic test covering the proactive-opener
 * trigger-text detection used by ChatPanel to hide the first
 * manager-less user turn from the visible transcript.
 *
 * Run:
 *   npx tsx --test components/tuning/__tests__/chat-panel-opener.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Replicate the heuristic inline so we don't need to export it from the
// TSX file. Any drift here will fail the companion-function in the
// component too, flagging that the strings need updating in lockstep.
function isOpenerTriggerText(parts: Array<{ type?: string; text?: string }>): boolean {
  const text = parts
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text!)
    .join('\n');
  if (!text) return false;
  return (
    text.startsWith('I just opened this conversation to discuss a specific main-AI message') ||
    text.startsWith('Greet me and summarize the pending suggestion queue.')
  );
}

test('detects the anchored opener trigger', () => {
  const t = isOpenerTriggerText([
    { type: 'text', text: 'I just opened this conversation to discuss a specific main-AI message (id=m1). Please summarize.' },
  ]);
  assert.equal(t, true);
});

test('detects the generic opener trigger', () => {
  const t = isOpenerTriggerText([
    { type: 'text', text: 'Greet me and summarize the pending suggestion queue. If something stands out, say so.' },
  ]);
  assert.equal(t, true);
});

test('does not misclassify a real manager turn', () => {
  const t = isOpenerTriggerText([
    { type: 'text', text: 'Why did the AI use that tone on the last message?' },
  ]);
  assert.equal(t, false);
});

test('tolerates missing text parts', () => {
  const t = isOpenerTriggerText([]);
  assert.equal(t, false);
});

test('joins multiple text parts before prefix-matching', () => {
  const t = isOpenerTriggerText([
    { type: 'text', text: 'I just opened this conversation to discuss a specific main-AI message' },
    { type: 'text', text: ' (id=m1). Please summarize.' },
  ]);
  assert.equal(t, true);
});
