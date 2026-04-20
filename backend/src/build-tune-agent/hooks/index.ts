/**
 * Assembles the hook map passed to the Claude Agent SDK `query()` options.
 * Hook callbacks close over a shared HookContext so they see the same tenant
 * scope and message state.
 */
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { HookContext } from './shared';
import { buildPreToolUseHook } from './pre-tool-use';
import { buildPostToolUseHook } from './post-tool-use';
import { buildPreCompactHook } from './pre-compact';
import { buildStopHook } from './stop';
import { buildPreToolTraceHook, buildPostToolTraceHook } from './tool-trace';

export function buildTuningAgentHooks(getCtx: () => HookContext): Options['hooks'] {
  return {
    // Sprint 046 Session A — trace hooks run first so they capture start
    // times before compliance/cooldown denies in the regular hooks.
    PreToolUse: [
      { hooks: [buildPreToolTraceHook(getCtx)] },
      { hooks: [buildPreToolUseHook(getCtx)] },
    ],
    PostToolUse: [
      { hooks: [buildPostToolUseHook(getCtx)] },
      { hooks: [buildPostToolTraceHook(getCtx)] },
    ],
    PreCompact: [{ hooks: [buildPreCompactHook(getCtx)] }],
    Stop: [{ hooks: [buildStopHook(getCtx)] }],
  };
}

export type { HookContext } from './shared';
