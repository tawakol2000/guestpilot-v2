/**
 * Tests for openai/tool-adapter.ts.
 *
 * Run: npx tsx --test src/build-tune-agent/openai/__tests__/tool-adapter.test.ts
 *
 * Pin the invariants that have caused real bugs:
 *   - legacy `propose_suggestion` / `suggestion_action` are filtered out
 *     so they never reach OpenAI's tools array (300054a D7).
 *   - every captured tool name appears in TUNING_AGENT_TOOL_NAMES.
 *   - JSON Schema output is well-formed for each tool.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-tool-adapter';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOpenAiToolRegistry,
  filterRegistryByAllowedTools,
} from '../tool-adapter';
import { TUNING_AGENT_TOOL_NAMES } from '../../tools/names';

function ctxStub() {
  return () => ({
    prisma: {} as any,
    tenantId: 't',
    conversationId: 'c',
    userId: null,
    lastUserSanctionedApply: false,
    emitDataPart: () => {},
    turnFlags: {},
  });
}

test('tool-adapter: registry exposes 19 canonical tools', async () => {
  const reg = buildOpenAiToolRegistry(ctxStub());
  assert.equal(reg.tools.length, 19);
  assert.equal(reg.handlers.size, 19);
  assert.equal(reg.prefixedNames.size, 19);
});

test('tool-adapter: legacy propose_suggestion + suggestion_action are NOT registered', async () => {
  const reg = buildOpenAiToolRegistry(ctxStub());
  const names = reg.tools.map((t) => t.name);
  assert.ok(!names.includes('propose_suggestion'), 'propose_suggestion leaked into registry');
  assert.ok(!names.includes('suggestion_action'), 'suggestion_action leaked into registry');
});

test('tool-adapter: every registered tool name maps to TUNING_AGENT_TOOL_NAMES', async () => {
  const reg = buildOpenAiToolRegistry(ctxStub());
  const canonicalRaw = new Set(
    Object.values(TUNING_AGENT_TOOL_NAMES).map((prefixed) => {
      const m = prefixed.match(/^mcp__[^_]+(?:_[^_]+)*__(.+)$/);
      return m ? m[1] : prefixed;
    }),
  );
  for (const t of reg.tools) {
    assert.ok(canonicalRaw.has(t.name), `unregistered name leaked: ${t.name}`);
  }
});

test('tool-adapter: every tool has type:"function" and a parameters object schema', async () => {
  const reg = buildOpenAiToolRegistry(ctxStub());
  for (const t of reg.tools) {
    assert.equal(t.type, 'function');
    assert.equal((t.parameters as any)?.type, 'object');
  }
});

test('tool-adapter: prefixedNames map uses the mcp__tuning-agent__ prefix', async () => {
  const reg = buildOpenAiToolRegistry(ctxStub());
  for (const [raw, prefixed] of reg.prefixedNames.entries()) {
    assert.ok(prefixed.startsWith('mcp__tuning-agent__'), `bad prefix: ${prefixed}`);
    assert.equal(prefixed, `mcp__tuning-agent__${raw}`);
  }
});

test('tool-adapter: filterRegistryByAllowedTools keeps only the named tools', async () => {
  const reg = buildOpenAiToolRegistry(ctxStub());
  const allowed = [
    TUNING_AGENT_TOOL_NAMES.studio_get_context,
    TUNING_AGENT_TOOL_NAMES.studio_get_tenant_index,
  ];
  const filtered = filterRegistryByAllowedTools(reg, allowed);
  assert.equal(filtered.tools.length, 2);
  const names = filtered.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['studio_get_context', 'studio_get_tenant_index']);
});

test('tool-adapter: studio_suggestion schema includes op enum', async () => {
  const reg = buildOpenAiToolRegistry(ctxStub());
  const t = reg.tools.find((t) => t.name === 'studio_suggestion');
  assert.ok(t, 'studio_suggestion missing');
  const opSchema = (t!.parameters as any)?.properties?.op;
  assert.ok(opSchema, 'op missing from schema');
  assert.ok(Array.isArray(opSchema.enum), 'op must be enum');
  assert.ok(opSchema.enum.includes('propose'));
  assert.ok(opSchema.enum.includes('apply'));
  assert.ok(opSchema.enum.includes('reject'));
});
