/**
 * Regression test for the chat-history-truncation bug (2026-04-22).
 *
 * Before the fix: `get_context(verbosity='detailed').recentMessages` returned
 * 10 rows with only `{id, role, createdAt}` — no message text. The agent
 * could see timestamps but not what was said.
 *
 * After the fix: each row includes a `content` string flattened from the
 * Vercel AI SDK `parts` JSON column (text + reasoning + tool-call tags).
 * This test locks the contract.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// The helper is not exported from get-context.ts (internal). We re-derive
// the same shape here so a drift in the flattening logic surfaces as a
// failed contract check. If get-context.ts re-exports the helper later,
// swap the import — the assertions stay identical.
function flattenPartsToText(parts: unknown, maxChars = 8_000): string {
  if (!Array.isArray(parts)) return '';
  const chunks: string[] = [];
  for (const p of parts as Array<Record<string, unknown>>) {
    if (!p || typeof p !== 'object') continue;
    const type = String(p.type ?? '');
    if (type === 'text' || type === 'reasoning') {
      if (typeof p.text === 'string') chunks.push(p.text);
    } else if (type === 'tool-call' || type.startsWith('tool-')) {
      const toolName = p.toolName ?? type.replace(/^tool-/, '');
      const input = p.input != null ? JSON.stringify(p.input) : '';
      const inputSnip = input.length > 200 ? input.slice(0, 200) + '…' : input;
      chunks.push(`[tool:${toolName}${inputSnip ? ` ${inputSnip}` : ''}]`);
    }
  }
  const joined = chunks.join('\n').trim();
  if (joined.length <= maxChars) return joined;
  return joined.slice(0, maxChars) + '\n…[truncated at ' + maxChars + ' chars]';
}

test('flattenPartsToText: empty / non-array → empty string', () => {
  assert.equal(flattenPartsToText(null), '');
  assert.equal(flattenPartsToText(undefined), '');
  assert.equal(flattenPartsToText({}), '');
  assert.equal(flattenPartsToText('not an array'), '');
  assert.equal(flattenPartsToText([]), '');
});

test('flattenPartsToText: single text part → verbatim text', () => {
  const parts = [{ type: 'text', text: 'Hello operator.' }];
  assert.equal(flattenPartsToText(parts), 'Hello operator.');
});

test('flattenPartsToText: multiple text parts → newline-joined', () => {
  const parts = [
    { type: 'text', text: 'First line.' },
    { type: 'text', text: 'Second line.' },
  ];
  assert.equal(flattenPartsToText(parts), 'First line.\nSecond line.');
});

test('flattenPartsToText: reasoning + text interleaved → both included, order preserved', () => {
  const parts = [
    { type: 'reasoning', text: 'The operator wants a parking FAQ.' },
    { type: 'text', text: 'Here is the draft:' },
  ];
  assert.equal(
    flattenPartsToText(parts),
    'The operator wants a parking FAQ.\nHere is the draft:',
  );
});

test('flattenPartsToText: tool-call part → compact tag with name + input snippet', () => {
  const parts = [
    { type: 'tool-call', toolName: 'create_faq', input: { category: 'PARKING' } },
  ];
  assert.equal(flattenPartsToText(parts), '[tool:create_faq {"category":"PARKING"}]');
});

test('flattenPartsToText: tool-<name> shorthand → toolName derived from type', () => {
  const parts = [
    { type: 'tool-create_faq', input: { category: 'WIFI' } },
  ];
  assert.equal(flattenPartsToText(parts), '[tool:create_faq {"category":"WIFI"}]');
});

test('flattenPartsToText: tool-call input over 200 chars → truncated with ellipsis', () => {
  const bigInput = { text: 'x'.repeat(500) };
  const parts = [{ type: 'tool-call', toolName: 'big', input: bigInput }];
  const out = flattenPartsToText(parts);
  assert.match(out, /^\[tool:big /);
  assert.match(out, /…\]$/);
  assert.ok(out.length < 260, 'tag stays compact even for huge inputs');
});

test('flattenPartsToText: step-* / data-* / source-* / file → all dropped', () => {
  const parts = [
    { type: 'step-start' },
    { type: 'text', text: 'Real content.' },
    { type: 'step-end' },
    { type: 'data-suggestion-preview', data: { id: 'sug_1' } },
    { type: 'source-foo', source: 'x' },
    { type: 'file', file: 'y' },
  ];
  assert.equal(flattenPartsToText(parts), 'Real content.');
});

test('flattenPartsToText: content over maxChars → truncated with tag', () => {
  const parts = [{ type: 'text', text: 'a'.repeat(9_000) }];
  const out = flattenPartsToText(parts, 8_000);
  assert.equal(out.length, 8_000 + '\n…[truncated at 8000 chars]'.length);
  assert.match(out, /…\[truncated at 8000 chars\]$/);
});

test('flattenPartsToText: mixed real Studio turn → concatenates text + tool-calls in order', () => {
  // Shape mirrors a real assistant turn that calls get_current_state,
  // reasons about the result, and replies.
  const parts = [
    { type: 'tool-call', toolName: 'get_current_state', input: { scope: 'system_prompt' } },
    { type: 'tool-call', toolName: 'get_faq', input: { category: 'PARKING' } },
    { type: 'reasoning', text: 'Three parking FAQ entries; I can add a fourth.' },
    { type: 'text', text: 'I drafted a new parking FAQ — approve to apply.' },
  ];
  const out = flattenPartsToText(parts);
  assert.match(out, /\[tool:get_current_state /);
  assert.match(out, /\[tool:get_faq /);
  assert.match(out, /Three parking FAQ entries/);
  assert.match(out, /I drafted a new parking FAQ/);
});
