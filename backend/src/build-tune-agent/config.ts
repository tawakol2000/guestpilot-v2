/**
 * Build+tune-agent runtime config (sprint 045).
 *
 * Default model is Claude Sonnet 4.6; allow override to Opus via
 * TUNING_AGENT_MODEL for intensive sessions. All env lookups are silent
 * when the key is missing — agent runtime degrades silently per CLAUDE.md
 * critical rule #2.
 */

export const TUNING_AGENT_DEFAULT_MODEL = 'claude-sonnet-4-6';
export const TUNING_AGENT_OPUS_MODEL = 'claude-opus-4-6';

export function resolveTuningAgentModel(): string {
  const override = process.env.TUNING_AGENT_MODEL;
  if (override && typeof override === 'string') return override;
  return TUNING_AGENT_DEFAULT_MODEL;
}

export function isTuningAgentEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Reason the agent is disabled, if any. Surfaced to the client as a data part
 * so the UI can show a calm "chat disabled" banner instead of an error.
 */
export function tuningAgentDisabledReason(): string | null {
  if (!process.env.ANTHROPIC_API_KEY) return 'ANTHROPIC_API_KEY missing';
  return null;
}

/**
 * Sprint 045: BUILD mode feature flag. Off by default in all environments.
 * Flip on in staging only after Gate 7 passes and the preview loop's
 * red-team pass rate is ≥0.85. See spec §"Out of scope" for gating
 * rationale.
 *
 * Any truthy string enables BUILD (so `ENABLE_BUILD_MODE=1` or `=true` work).
 */
export function isBuildModeEnabled(): boolean {
  const raw = process.env.ENABLE_BUILD_MODE;
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function buildModeDisabledReason(): string | null {
  if (!isTuningAgentEnabled()) return 'ANTHROPIC_API_KEY missing';
  if (!isBuildModeEnabled()) return 'ENABLE_BUILD_MODE not set';
  return null;
}

/**
 * Boundary markers embedded into the assembled system prompt. They cost
 * ~30 tokens each and serve as (1) visual debugging aids and (2) future
 * switch points: if a later sprint bypasses the Agent SDK and calls
 * @anthropic-ai/sdk directly, splitting at these markers and attaching
 * `cache_control: { type: 'ephemeral' }` is trivial. See
 * backend/src/build-tune-agent/system-prompt.ts for region semantics.
 */
export const SHARED_MODE_BOUNDARY_MARKER = '__SHARED_MODE_BOUNDARY__';
export const DYNAMIC_BOUNDARY_MARKER = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__';
