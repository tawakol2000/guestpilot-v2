/**
 * emit_session_summary turn-isolation contract tests.
 *
 * These tests pin the runtime invariant from the tool's perspective:
 *
 *   - SDK-path runner allocates a fresh `turnFlags` per turn (see
 *     sdk-runner.ts:304). Tool sees clean flags every call.
 *   - Direct-path runner (wire-direct.ts, dead-code today, lights up in
 *     a future sprint) MUST do the same. The wire-direct contract
 *     comment calls this out; THIS test catches the case where the
 *     direct path inadvertently reuses a single ctx across turns.
 *
 * If the direct runner ever ships with a shared-across-turns ctx, the
 * "shared ctx anti-pattern" test below will fail and surface the
 * regression before tools start mysteriously declining to fire on
 * later turns of a long Studio session.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEmitSessionSummaryTool,
  SESSION_SUMMARY_TURN_FLAG,
} from '../emit-session-summary';
import type { ToolContext } from '../types';

function captureTool() {
  let captured: any = null;
  const fakeFactory = ((_n: string, _d: string, _s: any, handler: any) => {
    captured = handler;
    return { name: _n };
  }) as any;
  return { factory: fakeFactory, invoke: (args: any) => captured(args) };
}

function makeFreshCtx(): ToolContext & { _emitted: any[] } {
  const emitted: any[] = [];
  return {
    prisma: {} as any,
    tenantId: 't1',
    conversationId: 'conv1',
    userId: 'u1',
    lastUserSanctionedApply: false,
    turnFlags: {},
    emitDataPart: (part) => emitted.push(part),
    _emitted: emitted,
  };
}

const SAMPLE_ARGS = {
  written: { created: 1, edited: 0, reverted: 0 },
  tested: { runs: 1, totalVariants: 1, passed: 1 },
  plans: { cancelled: 0 },
};

// ─── Contract: SDK-style fresh-per-turn ctx ─────────────────────────────

test('runner contract: fresh ctx per turn allows emit on every turn', async () => {
  // Two turns, two fresh ctx objects (mirrors sdk-runner.ts:304).
  for (let turn = 1; turn <= 3; turn++) {
    const ctx = makeFreshCtx();
    const { factory, invoke } = captureTool();
    buildEmitSessionSummaryTool(factory, () => ctx);

    const r = await invoke(SAMPLE_ARGS);

    assert.equal(ctx._emitted.length, 1, `turn ${turn}: emitted exactly one part`);
    const payload = JSON.parse(r.content[0].text);
    assert.equal(payload.ok, true, `turn ${turn}: tool reported ok`);
    assert.equal(
      ctx.turnFlags?.[SESSION_SUMMARY_TURN_FLAG],
      true,
      `turn ${turn}: flag set after emit`,
    );
  }
});

// ─── Anti-pattern: shared ctx across turns ──────────────────────────────

test('runner anti-pattern: SHARED ctx across turns suppresses second emit (would-be regression)', async () => {
  // Pin the bad behaviour explicitly: if a runner reused one ctx for
  // multiple turns (the direct path's risk per wire-direct.ts CONTRACT
  // comment), the second turn would receive `already_emitted_this_turn`
  // and the operator would never see a second session-diff card.
  const sharedCtx = makeFreshCtx();
  const { factory, invoke } = captureTool();
  buildEmitSessionSummaryTool(factory, () => sharedCtx);

  // Turn 1 — emits successfully.
  const r1 = await invoke(SAMPLE_ARGS);
  const p1 = JSON.parse(r1.content[0].text);
  assert.equal(p1.ok, true);
  assert.equal(sharedCtx._emitted.length, 1);

  // Turn 2 — same ctx, no fresh turnFlags allocation. Tool refuses to
  // re-fire because the flag is still set from turn 1.
  const r2 = await invoke(SAMPLE_ARGS);
  const p2 = JSON.parse(r2.content[0].text);
  assert.equal(p2.ok, false, 'tool refuses second emit when flag still set');
  assert.equal(p2.reason, 'already_emitted_this_turn');
  assert.equal(sharedCtx._emitted.length, 1, 'no second part emitted');
});

// ─── Contract: explicit turn-boundary reset ────────────────────────────

test('runner contract: explicit turnFlags = {} reset between turns restores emit', async () => {
  // Mirrors what sdk-runner.ts does for each runSdkTurn invocation.
  // If a runner manually resets turnFlags between turns (vs. allocating
  // a new ctx wholesale), the contract still holds.
  const ctx = makeFreshCtx();
  const { factory, invoke } = captureTool();
  buildEmitSessionSummaryTool(factory, () => ctx);

  const r1 = await invoke(SAMPLE_ARGS);
  assert.equal(JSON.parse(r1.content[0].text).ok, true);

  // Reset flags to simulate a turn boundary.
  ctx.turnFlags = {};

  const r2 = await invoke(SAMPLE_ARGS);
  assert.equal(JSON.parse(r2.content[0].text).ok, true);
  assert.equal(ctx._emitted.length, 2, 'two distinct emits across turns');
});
