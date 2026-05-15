/**
 * Tuning-agent runtime — provider-aware dispatcher.
 *
 * Three execution paths exist:
 *
 *   1. **OpenAI Responses API** (`./openai-runner.ts`) — gated by
 *      `STUDIO_PROVIDER=openai`. Runs gpt-5.4-mini against the same
 *      tool registry + system prompt; produces byte-identical SSE
 *      data-parts so the frontend works either way.
 *
 *   2. **Anthropic direct transport** (`./direct/wire-direct.ts`) — gated
 *      by `BUILD_AGENT_DIRECT_TRANSPORT=true`. Bypasses the Claude Agent
 *      SDK and calls `@anthropic-ai/sdk.messages.create` directly with
 *      explicit `cache_control` markers. May fall back to the SDK path on
 *      error.
 *
 *   3. **Claude Agent SDK** (`./sdk-runner.ts`) — default path. Used when
 *      provider=anthropic and direct transport is off, OR as a fallback
 *      when the direct path returns `{status:'fallback'}`.
 *
 * The external API (`runTuningAgentTurn(input)`) is unchanged.
 */
import { runSdkTurn, type RunTurnInput, type RunTurnResult } from './sdk-runner';
import { isDirectTransportEnabled } from './prompt-cache-blocks';
import { runDirectTurnWithFullSetup } from './direct/wire-direct';
import { runOpenAiTurn } from './openai-runner';
import { resolveStudioProvider } from './config';

export type { RunTurnInput, RunTurnResult } from './sdk-runner';

export async function runTuningAgentTurn(input: RunTurnInput): Promise<RunTurnResult> {
  // Per-request override (from the frontend's ProviderToggle) wins over
  // the env-resolved default so an operator can A/B providers without a
  // redeploy. When unset, fall back to STUDIO_PROVIDER env.
  const provider = input.providerOverride ?? resolveStudioProvider();
  if (provider === 'openai') {
    return runOpenAiTurn(input);
  }

  if (isDirectTransportEnabled()) {
    try {
      const direct = await runDirectTurnWithFullSetup(input);
      if (direct.status === 'success') {
        return direct.sdkResult;
      }
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
