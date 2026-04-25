/**
 * Sprint 059-A F1.5 — Direct-transport wiring layer.
 *
 * Builds the full `DirectRunInput` shape from a `RunTurnInput` so the
 * runtime.ts dispatcher can branch on `isDirectTransportEnabled()`.
 *
 * Scope today:
 *   - The direct-path runner (`runDirectTurn`) is fully implemented and
 *     unit-tested (see `__tests__/direct-runner.test.ts`). What this
 *     wiring layer produces — an Anthropic SDK client, MCP router, hook
 *     dispatcher, and the pre-computed DirectRunInput — is load-bearing
 *     for the staging canary (F1.6).
 *   - Full wire-up with a live Anthropic client + building the MCP tool
 *     array from `buildTuningAgentMcpServer()`'s output + the tool
 *     Anthropic-shape conversion is intentionally conservative: on any
 *     failure (missing ANTHROPIC_API_KEY, an unknown tool shape, a
 *     history-replay throw) we return `{ status: 'fallback', ... }` so
 *     the dispatcher can run the SDK path. The fallback is the
 *     non-negotiable safety net per spec §3 F1.5.
 *
 * Not yet wired in this module (follow-up sprint):
 *   - The `buildTuningAgentMcpServer()` output is a `McpSdkServerConfigWithInstance`
 *     (wrapper around a live `McpServer`). To build the MCP router we
 *     need the underlying `SdkMcpToolDefinition<any>[]` array. That
 *     requires either plumbing a dedicated "tools array" export out of
 *     `tools/index.ts` OR reading the McpServer instance's registered
 *     handlers. Both are mechanical but touch the untouchable `tools/**`
 *     boundary for this sprint (spec §4 Discipline 5 + DO NOT TOUCH).
 *     Until that export lands we return a `fallback` with reason
 *     'api_error' (tools unavailable) and the SDK path runs. This means
 *     `BUILD_AGENT_DIRECT_TRANSPORT=true` on staging today runs the SDK
 *     path via the fallback — which is the exact behaviour the flag
 *     guard documents — but the direct runner + dispatcher composition
 *     is fully unit-test-covered so the wire is ready for the 060
 *     follow-up to flip.
 *
 * This module is the ONE place that reconciles `DirectRunResult` (direct)
 * with `RunTurnResult` (SDK). Today the return shape is a stub
 * indicating fallback; when the tool-array export lands it will convert
 * the direct runner's aggregated output into a `RunTurnResult` compatible
 * payload.
 */
import type { RunTurnInput, RunTurnResult } from '../sdk-runner';
import type { DirectFallbackReason } from './runner';

/**
 * Result envelope the runtime dispatcher consumes.
 *   - `success`   : the direct path ran end-to-end; `sdkResult` is a
 *                   RunTurnResult-shaped payload the dispatcher returns
 *                   verbatim (today this branch is unreachable — see
 *                   module header).
 *   - `fallback`  : direct path signalled a known fallback reason; the
 *                   runtime runs the SDK path on the SAME input next.
 *   - `error`     : unexpected error; runtime also runs SDK path.
 */
export type DirectWiringResult =
  | { status: 'success'; sdkResult: RunTurnResult }
  | { status: 'fallback'; fallbackReason: DirectFallbackReason }
  | { status: 'error'; fallbackReason: DirectFallbackReason; message: string };

/**
 * Run the direct path for this turn. Conservative: any setup failure
 * returns a `fallback` envelope rather than throwing — the runtime
 * dispatcher knows to run `runSdkTurn(input)` next.
 *
 * On staging + production today this ALWAYS returns a fallback (tools
 * array export is not yet plumbed). The dispatcher-level test in
 * `__tests__/runtime-dispatcher.test.ts` pins that behaviour.
 */
export async function runDirectTurnWithFullSetup(
  _input: RunTurnInput,
): Promise<DirectWiringResult> {
  // Today — tools array is not exposed out of `tools/index.ts` (see
  // module header). Returning a fallback keeps the dispatcher on the
  // SDK path while the rest of the wiring is in place + unit-tested.
  //
  // When the tools-array export lands, replace this with:
  //   1. buildDirectRunInputFromRunTurnInput(input)
  //   2. runDirectTurn(directInput, write)
  //   3. If result.status === 'success', synthesise RunTurnResult from
  //      aggregatedAssistant + persistedDataParts captured during the turn.
  //
  // CONTRACT — the direct-path implementation MUST allocate a fresh
  // `turnFlags: Record<string, boolean> = {}` per call and attach it
  // to the ToolContext that the MCP router resolves to (mirroring
  // sdk-runner.ts). Tools like `studio_test_pipeline` enforce a
  // "once per turn" invariant via `c.turnFlags[<flag>]`. If the
  // direct path reuses a single ctx across turns, the invariant
  // silently degrades from "once per turn" to "once per process"
  // and tools stop firing for the rest of the session.
  return {
    status: 'fallback',
    fallbackReason: 'api_error',
  };
}
