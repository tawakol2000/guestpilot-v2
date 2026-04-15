/**
 * Tuning-agent runtime config.
 *
 * Per sprint-04 brief §1: default model is Claude Sonnet 4.6; allow override
 * to Opus via TUNING_AGENT_MODEL for intensive sessions.
 *
 * All env lookups are silent when the key is missing — agent runtime degrades
 * silently per CLAUDE.md critical rule #2.
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
 * Short literal inserted into the system prompt string. Used as a visual
 * marker separating the static prefix from the dynamic suffix. Anthropic's
 * automatic prompt caching is what actually saves tokens; this marker is a
 * documentation + future-processing aid (e.g. if we later split the prompt
 * into multiple content blocks with explicit `cache_control`).
 */
export const DYNAMIC_BOUNDARY_MARKER = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__';
