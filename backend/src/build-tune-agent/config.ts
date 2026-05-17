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

export type StudioProvider = 'anthropic' | 'openai';

// 2026-05-16: bumped default from gpt-5.4-mini to gpt-5.4. The Studio
// agent is the manager-facing authoring surface (BUILD interview, TUNE
// suggestion review, ritual verification). It runs orders of magnitude
// less often than the guest-reply pipeline — a manager configures the
// AI maybe a dozen times a week — so the ~3.3× per-token cost of the
// full model is well-spent for tighter slot questions, sharper SOP
// drafts, and better suggestion reasoning. The guest-reply hot path
// (ai.service.ts) stays on gpt-5.4-mini for unit economics.
// Override via STUDIO_OPENAI_MODEL env if needed.
export const STUDIO_OPENAI_DEFAULT_MODEL = 'gpt-5.4';

/**
 * Provider toggle for the Studio agent. Default is `anthropic` (the Claude
 * Agent SDK path). Set `STUDIO_PROVIDER=openai` to run the OpenAI Responses
 * API path against gpt-5.4. Both paths share Region A/B prefix and
 * produce byte-identical SSE data-parts so the frontend works either way.
 */
export function resolveStudioProvider(): StudioProvider {
  const raw = (process.env.STUDIO_PROVIDER ?? '').trim().toLowerCase();
  if (raw === 'openai') return 'openai';
  return 'anthropic';
}

export function resolveStudioOpenAiModel(): string {
  const override = process.env.STUDIO_OPENAI_MODEL;
  if (override && typeof override === 'string') return override;
  return STUDIO_OPENAI_DEFAULT_MODEL;
}

/**
 * 2026-05-15 polish: accept an explicit provider so the per-request
 * frontend toggle (providerOverride) can be checked correctly. Without
 * this, a request with providerOverride='openai' would still consult
 * `STUDIO_PROVIDER` env when deciding which API key to require — so a
 * tenant with only OPENAI_API_KEY set would see "ANTHROPIC_API_KEY
 * missing" when forcing OpenAI from the UI.
 */
export function isTuningAgentEnabled(provider?: 'openai' | 'anthropic'): boolean {
  const effective = provider ?? resolveStudioProvider();
  if (effective === 'openai') return Boolean(process.env.OPENAI_API_KEY);
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Reason the agent is disabled, if any. Surfaced to the client as a data part
 * so the UI can show a calm "chat disabled" banner instead of an error.
 */
export function tuningAgentDisabledReason(provider?: 'openai' | 'anthropic'): string | null {
  const effective = provider ?? resolveStudioProvider();
  if (effective === 'openai') {
    if (!process.env.OPENAI_API_KEY) return 'OPENAI_API_KEY missing';
    return null;
  }
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
  // Delegate to the provider-aware tuningAgentDisabledReason() so the
  // OpenAI path surfaces "OPENAI_API_KEY missing" rather than the
  // Anthropic key name.
  const agentReason = tuningAgentDisabledReason();
  if (agentReason) return agentReason;
  if (!isBuildModeEnabled()) return 'ENABLE_BUILD_MODE not set';
  return null;
}

/**
 * Sprint 047 Session B: admin-only BuildToolCallLog trace view feature
 * flag. Kept separate from ENABLE_BUILD_MODE so tenant admins can't see
 * raw tool calls by accident — a platform operator must explicitly flip
 * ENABLE_BUILD_TRACE_VIEW on, AND the requesting Tenant must have
 * isAdmin=true in the DB.
 *
 * Off by default everywhere.
 */
export function isBuildTraceViewEnabled(): boolean {
  const raw = process.env.ENABLE_BUILD_TRACE_VIEW;
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return (
    normalized === '1' ||
    normalized === 'true' ||
    normalized === 'yes' ||
    normalized === 'on'
  );
}

/**
 * Sprint 047 Session C: admin-only raw-prompt editor drawer flag. Kept
 * separate from ENABLE_BUILD_TRACE_VIEW so a staging operator exposing
 * traces doesn't automatically expose the full assembled system prompt
 * (which can contain tenant-private SOP and FAQ content). Same truthy
 * set as the other flags. Off by default everywhere.
 *
 * Session C ships read-through only; the eventual edit path will reuse
 * this same gate.
 */
export function isRawPromptEditorEnabled(): boolean {
  const raw = process.env.ENABLE_RAW_PROMPT_EDITOR;
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return (
    normalized === '1' ||
    normalized === 'true' ||
    normalized === 'yes' ||
    normalized === 'on'
  );
}

/**
 * 2026-05-17 — Studio OpenAI reasoning effort. The dominant cost driver
 * on the gpt-5.4 path is reasoning tokens (billed at output rate). An
 * empirical 27-message session cost $2.50 at 'high'; dropping to
 * 'medium' should ~halve that, 'low' should ~quarter it. Override via
 * STUDIO_REASONING_EFFORT for A/B testing without code changes.
 *
 * Default 'medium' — balances tight slot questions / sharper drafts
 * (which DO benefit from deeper thinking) against the reality that
 * most rounds are read-and-summarize where high reasoning is wasted.
 */
export type StudioReasoningEffort = 'low' | 'medium' | 'high';

export function resolveStudioReasoningEffort(): StudioReasoningEffort {
  const raw = (process.env.STUDIO_REASONING_EFFORT ?? '').trim().toLowerCase();
  if (raw === 'low' || raw === 'medium' || raw === 'high') return raw;
  return 'medium';
}

/**
 * 2026-05-17 — Studio per-turn debug trace persistence.
 *
 * When enabled, every assistant turn persists a `data-debug-trace` part
 * into TuningMessage.parts with the assembled system prompt + per-region
 * sizes + model + provider + usage. Lets `scripts/dump-studio-conversation.ts`
 * recover the EXACT prompt the agent saw at a historical turn (otherwise
 * the dump reconstructs using current templates, which drift).
 *
 * Storage cost: ~30 KiB per assistant turn (uncompressed). Off by default
 * because it pads TuningMessage.parts noticeably for long-running sessions;
 * flip on per-tenant or globally when debugging a flaky agent.
 *
 * Truthy values: '1', 'true', 'yes', 'on' (case-insensitive).
 */
export function isStudioDebugTraceEnabled(): boolean {
  const raw = process.env.STUDIO_DEBUG_TRACE;
  if (!raw) return false;
  const n = raw.trim().toLowerCase();
  return n === '1' || n === 'true' || n === 'yes' || n === 'on';
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
