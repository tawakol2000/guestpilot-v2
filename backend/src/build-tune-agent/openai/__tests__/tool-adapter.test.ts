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

/**
 * 2026-05-15 regression guard. OpenAI Responses API rejects any `array`
 * schema whose `items` field is missing — Zod's `z.tuple` produces
 * `prefixItems` instead of `items` under JSON Schema 2020-12, and the
 * legacy adapter shipped that straight through, surfacing as a 400 to
 * the user mid-Drafting. Walk every tool's parameters tree and assert
 * the normalisation pass has rewritten tuples into legacy form.
 */
test('tool-adapter: every array schema has items (no raw prefixItems leak)', async () => {
  const reg = buildOpenAiToolRegistry(ctxStub());
  const offenders: string[] = [];
  for (const tool of reg.tools) {
    walkAndCheckArrays(tool.parameters, [tool.name], offenders);
  }
  assert.deepEqual(offenders, [], `arrays without items found: ${offenders.join(', ')}`);
});

test('tool-adapter: studio_suggestion target.lineRange becomes a legacy array of numbers', async () => {
  const reg = buildOpenAiToolRegistry(ctxStub());
  const t = reg.tools.find((t) => t.name === 'studio_suggestion');
  const target = (t!.parameters as any)?.properties?.target;
  // target is an optional object — find the lineRange schema inside it.
  // The shape varies depending on how zod renders optional unions, so
  // probe a few likely paths.
  const candidates: any[] = [target?.properties?.lineRange, target?.anyOf, target?.oneOf]
    .flat()
    .filter(Boolean);
  let lineRange: any = null;
  for (const c of candidates) {
    if (c?.properties?.lineRange) lineRange = c.properties.lineRange;
    else if (c?.type === 'array') lineRange = c;
  }
  if (lineRange) {
    assert.equal(lineRange.type, 'array', 'lineRange must be array');
    assert.ok(lineRange.items, 'lineRange.items must be present (no prefixItems leak)');
    assert.ok(!('prefixItems' in lineRange), 'lineRange.prefixItems must be normalised away');
  }
});

function walkAndCheckArrays(node: unknown, path: string[], offenders: string[]): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((el, i) => walkAndCheckArrays(el, [...path, String(i)], offenders));
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj.type === 'array' && obj.items === undefined) {
    offenders.push(path.join('.'));
  }
  if ('prefixItems' in obj) {
    offenders.push(`${path.join('.')}:prefixItems-leak`);
  }
  for (const k of Object.keys(obj)) {
    walkAndCheckArrays(obj[k], [...path, k], offenders);
  }
}
