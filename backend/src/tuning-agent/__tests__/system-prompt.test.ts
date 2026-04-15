/**
 * Sprint 04 — system-prompt assembler unit tests.
 *
 * Run:  npx tsx --test src/tuning-agent/__tests__/system-prompt.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assembleSystemPrompt,
  buildStaticPrefix,
  buildDynamicSuffix,
  type SystemPromptContext,
} from '../system-prompt';
import { DYNAMIC_BOUNDARY_MARKER } from '../config';

function ctx(overrides: Partial<SystemPromptContext> = {}): SystemPromptContext {
  return {
    tenantId: 't1',
    conversationId: 'c1',
    anchorMessageId: null,
    selectedSuggestionId: null,
    memorySnapshot: [],
    pending: { total: 0, topThree: [], countsByCategory: {} },
    ...overrides,
  };
}

test('assembleSystemPrompt embeds the boundary marker between static prefix and dynamic suffix', () => {
  const prompt = assembleSystemPrompt(ctx());
  assert.ok(prompt.includes(DYNAMIC_BOUNDARY_MARKER), 'boundary marker must be present');
  const idx = prompt.indexOf(DYNAMIC_BOUNDARY_MARKER);
  const prefix = prompt.slice(0, idx);
  const suffix = prompt.slice(idx + DYNAMIC_BOUNDARY_MARKER.length);
  assert.ok(prefix.includes('<persona>'), 'prefix must carry persona');
  assert.ok(prefix.includes('<taxonomy>'), 'prefix must carry taxonomy');
  assert.ok(prefix.includes('<tools>'), 'prefix must carry tool docs');
  assert.ok(suffix.includes('<memory_snapshot>'), 'suffix must carry memory');
  assert.ok(suffix.includes('<session_state>'), 'suffix must carry session_state');
});

test('static prefix is byte-identical across calls (cacheable)', () => {
  const a = buildStaticPrefix();
  const b = buildStaticPrefix();
  const c = buildStaticPrefix();
  assert.equal(a, b);
  assert.equal(b, c);
});

test('anti-sycophancy clause is present verbatim', () => {
  const p = buildStaticPrefix();
  assert.ok(
    p.includes('If no artifact change is warranted, return NO_FIX'),
    'verbatim anti-sycophancy phrase must appear'
  );
  assert.ok(p.includes('Do not invent suggestions to satisfy requests.'));
  assert.ok(p.includes('Refuse directly without lecturing.'));
});

test('dynamic suffix reflects pending + memory context', () => {
  const suffix = buildDynamicSuffix(
    ctx({
      memorySnapshot: [
        { key: 'preferences/tone', value: 'concise', source: null, updatedAt: '2026-04-15T00:00:00Z' },
      ],
      pending: {
        total: 2,
        countsByCategory: { SOP_CONTENT: 2 },
        topThree: [
          {
            id: 's1',
            diagnosticCategory: 'SOP_CONTENT',
            diagnosticSubLabel: 'parking-info-missing',
            confidence: 0.82,
            rationale: 'Guest asked about parking; SOP had no coverage.',
            createdAt: '2026-04-15T00:00:00Z',
          },
        ],
      },
      anchorMessageId: 'm1',
    })
  );
  assert.ok(suffix.includes('preferences/tone'));
  assert.ok(suffix.includes('SOP_CONTENT=2'));
  assert.ok(suffix.includes('parking-info-missing'));
  assert.ok(suffix.includes('anchorMessageId=m1'));
});

test('empty queue + empty memory produce safe fallbacks', () => {
  const suffix = buildDynamicSuffix(ctx());
  assert.ok(suffix.includes('Queue is empty'));
  assert.ok(suffix.includes('No durable preferences on file'));
});
