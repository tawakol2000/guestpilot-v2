/**
 * Sprint 059-A F1.1 — MCP tool router unit tests.
 *
 * Run:  npx tsx --test src/build-tune-agent/__tests__/mcp-router.test.ts
 *
 * Scope: the router's contract surface — naming (wire vs bare), dispatch
 * semantics (happy path, unknown tool, handler throw), and
 * has()/dispatch() consistency.
 *
 * These tests DO NOT hit DB. They mock the tool shape the SDK produces
 * (`{ name, description, inputSchema, handler }`) with tiny in-memory
 * handlers so the router layer can be exercised in isolation.
 */
// Side-effect: satisfy auth middleware's top-level JWT_SECRET assertion so
// transitive imports don't process.exit() during test boot. Matches the
// pre-tool-use-hook test pattern.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-mcp-router';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod/v4';

import {
  buildMcpRouter,
  McpUnknownToolError,
  type McpDispatchContext,
  type McpToolResult,
} from '../direct/mcp-router';
import { TUNING_AGENT_SERVER_NAME } from '../tools/names';

// ─── Fixtures ──────────────────────────────────────────────────────────

const CTX: McpDispatchContext = {
  conversationId: 'conv-1',
  tenantId: 'tenant-1',
  mode: 'BUILD',
};

/**
 * Build a fake tool that mirrors the `SdkMcpToolDefinition` shape. The
 * handler receives `(args, extra)` — consistent with the SDK typedef. We
 * don't use `extra` but keep the arity correct.
 */
function fakeTool(
  name: string,
  inputSchema: Record<string, z.ZodTypeAny>,
  handler: (args: any) => Promise<unknown>,
): any {
  return {
    name,
    description: `fake tool: ${name}`,
    inputSchema,
    handler: async (args: any, _extra: unknown) => handler(args),
  };
}

function wireName(bare: string): string {
  return `mcp__${TUNING_AGENT_SERVER_NAME}__${bare}`;
}

// ─── Test 1 — Known-tool dispatch returns expected shape ───────────────

test('F1.1 dispatch returns tool_result shape for a known tool', async () => {
  const tools = [
    fakeTool('noop', {}, async () => ({
      content: [{ type: 'text', text: 'ok' }],
    })),
  ];
  const router = buildMcpRouter(tools);
  const result = await router.dispatch('noop', {}, CTX, 'tu_1');

  assert.equal(result.type, 'tool_result');
  assert.equal(result.tool_use_id, 'tu_1');
  assert.ok(Array.isArray(result.content));
  const content = result.content as Array<{ type: 'text'; text: string }>;
  assert.equal(content[0].text, 'ok');
  assert.equal(result.is_error, undefined);
});

// ─── Test 2 — Unknown-tool dispatch throws McpUnknownToolError ─────────

test('F1.1 dispatch throws McpUnknownToolError for an unregistered wire name', async () => {
  const tools = [fakeTool('exists', {}, async () => 'x')];
  const router = buildMcpRouter(tools);

  const bogus = wireName('does_not_exist');
  await assert.rejects(
    () => router.dispatch(bogus, {}, CTX, 'tu_2'),
    (err: any) => {
      assert.ok(err instanceof McpUnknownToolError, 'expected McpUnknownToolError');
      assert.equal(err.toolName, bogus, 'error carries the wire name');
      return true;
    },
  );
});

// ─── Test 3 — Handler throw becomes is_error:true tool_result ──────────

test('F1.1 handler throw is caught and returned as is_error:true tool_result (does NOT re-throw)', async () => {
  const tools = [
    fakeTool('boom', {}, async () => {
      throw new Error('kaboom');
    }),
  ];
  const router = buildMcpRouter(tools);

  // Must NOT throw.
  const result: McpToolResult = await router.dispatch('boom', {}, CTX, 'tu_3');
  assert.equal(result.type, 'tool_result');
  assert.equal(result.tool_use_id, 'tu_3');
  assert.equal(result.is_error, true);
  assert.equal(typeof result.content, 'string');
  assert.match(result.content as string, /kaboom/);
  assert.match(result.content as string, /^Error:/);
});

// ─── Test 4 — Wire and bare name resolve to the same handler ───────────

test('F1.1 wire and bare names both resolve — has() and dispatch() agree', async () => {
  let callCount = 0;
  const tools = [
    fakeTool('create_faq', {}, async () => {
      callCount += 1;
      return { content: [{ type: 'text', text: `hit #${callCount}` }] };
    }),
  ];
  const router = buildMcpRouter(tools);

  // has() on both forms.
  assert.equal(router.has('create_faq'), true, 'bare name has()');
  assert.equal(router.has(wireName('create_faq')), true, 'wire name has()');

  // dispatch() on both forms routes to the same handler.
  const r1 = await router.dispatch('create_faq', {}, CTX, 'tu_a');
  const r2 = await router.dispatch(wireName('create_faq'), {}, CTX, 'tu_b');
  assert.equal(callCount, 2, 'both forms invoked the same handler');

  const c1 = (r1.content as Array<{ text: string }>)[0].text;
  const c2 = (r2.content as Array<{ text: string }>)[0].text;
  assert.equal(c1, 'hit #1');
  assert.equal(c2, 'hit #2');
});

// ─── Test 5 — has()/dispatch() consistency across all registered tools ─

test('F1.1 has() and dispatch() are consistent for every registered tool (both wire + bare)', async () => {
  const tools = [
    fakeTool('alpha', {}, async () => ({ content: [{ type: 'text', text: 'a' }] })),
    fakeTool('beta', {}, async () => ({ content: [{ type: 'text', text: 'b' }] })),
    fakeTool('gamma', {}, async () => ({ content: [{ type: 'text', text: 'c' }] })),
  ];
  const router = buildMcpRouter(tools);

  for (const t of tools) {
    const bare = t.name;
    const wire = wireName(bare);
    assert.equal(router.has(bare), true, `has(${bare})`);
    assert.equal(router.has(wire), true, `has(${wire})`);

    // For every `has(x) === true` name, dispatch(x) must NOT throw
    // McpUnknownToolError. (It may still return an is_error tool_result on
    // handler throw, but that's a different failure mode.)
    const rBare = await router.dispatch(bare, {}, CTX, `tu_${bare}_b`);
    const rWire = await router.dispatch(wire, {}, CTX, `tu_${bare}_w`);
    assert.equal(rBare.type, 'tool_result');
    assert.equal(rWire.type, 'tool_result');
    assert.notEqual(rBare.is_error, true, `bare dispatch not error for ${bare}`);
    assert.notEqual(rWire.is_error, true, `wire dispatch not error for ${bare}`);
  }
});

// ─── Bonus test — Zod-invalid input is surfaced as is_error, not thrown ─

test('F1.1 input failing Zod validation is returned as is_error:true tool_result', async () => {
  const tools = [
    fakeTool(
      'with_schema',
      { name: z.string().min(1) },
      async (args: any) => ({ content: [{ type: 'text', text: `hi ${args.name}` }] }),
    ),
  ];
  const router = buildMcpRouter(tools);

  // Missing required `name` → Zod throws at the router boundary → is_error.
  const result = await router.dispatch('with_schema', {}, CTX, 'tu_zod');
  assert.equal(result.type, 'tool_result');
  assert.equal(result.is_error, true);
});

// ─── Bonus test — string handler return is normalized to content string ─

test('F1.1 handler returning a plain string is normalized onto tool_result.content', async () => {
  const tools = [fakeTool('str', {}, async () => 'just a string')];
  const router = buildMcpRouter(tools);
  const result = await router.dispatch('str', {}, CTX, 'tu_str');
  assert.equal(result.content, 'just a string');
  assert.equal(result.is_error, undefined);
});

// ─── Bonus test — isError on handler result carries through ────────────

test('F1.1 handler returning {isError:true} is preserved on tool_result.is_error', async () => {
  const tools = [
    fakeTool('err_shape', {}, async () => ({
      content: [{ type: 'text', text: 'ERROR: something went wrong' }],
      isError: true,
    })),
  ];
  const router = buildMcpRouter(tools);
  const result = await router.dispatch('err_shape', {}, CTX, 'tu_err');
  assert.equal(result.is_error, true);
});

// ─── Bonus test — duplicate tool names at build time are rejected ──────

test('F1.1 buildMcpRouter throws if two tools share a bare name', () => {
  const dupes = [
    fakeTool('same', {}, async () => 'a'),
    fakeTool('same', {}, async () => 'b'),
  ];
  assert.throws(
    () => buildMcpRouter(dupes),
    /duplicate tool name "same"/,
  );
});
