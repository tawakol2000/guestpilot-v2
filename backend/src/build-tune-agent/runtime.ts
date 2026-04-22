/**
 * Tuning-agent runtime — thin dispatcher.
 *
 * Sprint 059-A F1.5 split the original monolithic `runTuningAgentTurn()`
 * into three modules:
 *
 *   - `./sdk-runner.ts`  — the Claude Agent SDK path (pure rename, zero
 *                          behavioural delta from pre-059).
 *   - `./direct/runner.ts` — the direct `@anthropic-ai/sdk` path, wired
 *                          with the MCP router (F1.1), hook dispatcher
 *                          (F1.2), history replay (F1.3), and raw-stream
 *                          bridge (F1.4).
 *   - This file — branches on `isDirectTransportEnabled()`. If the direct
 *                 path returns `{ status: 'fallback' }` (spec §3 F1.5) we
 *                 run the SDK path for the same turn. The external API
 *                 (`runTuningAgentTurn(input)`) is unchanged — all three
 *                 controllers that call it are untouched.
 *
 * Flag default is OFF (see prompt-cache-blocks.ts::isDirectTransportEnabled).
 * Flip on in staging only after canary validation (see PROGRESS.md).
 */
import { runSdkTurn, type RunTurnInput, type RunTurnResult } from './sdk-runner';
import { isDirectTransportEnabled } from './prompt-cache-blocks';
import { runDirectTurnWithFullSetup } from './direct/wire-direct';

export type { RunTurnInput, RunTurnResult } from './sdk-runner';

export async function runTuningAgentTurn(input: RunTurnInput): Promise<RunTurnResult> {
  if (isDirectTransportEnabled()) {
    try {
      const direct = await runDirectTurnWithFullSetup(input);
      if (direct.status === 'success') {
        return direct.sdkResult;
      }
      // 'fallback' | 'error' — fall through to the SDK path with the same
      // input. The user still gets a working reply; telemetry in the
      // direct runner already logged the reason.
      console.warn(
        `[TuningAgent] direct fell back: ${direct.fallbackReason ?? 'unknown'} — running SDK path`,
      );
    } catch (err) {
      console.warn(
        `[TuningAgent] direct path threw before fallback could be signalled; running SDK path`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return runSdkTurn(input);
}
