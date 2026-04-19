/**
 * PreCompact hook — runs before context compaction. Injects a summary of
 * durable preferences + recent decisions so they survive compaction.
 *
 * Reads `preferences/*` and `decisions/*` via the AgentMemory service and
 * returns them as `additionalContext` on the PreCompact hook-specific
 * output, which the SDK folds into the compact-generation pass.
 */
import type {
  HookCallback,
  HookInput,
  HookJSONOutput,
  PreCompactHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { listMemoryByPrefix } from '../memory/service';
import type { HookContext } from './shared';

export function buildPreCompactHook(ctx: () => HookContext): HookCallback {
  return async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'PreCompact') {
      return { continue: true } as HookJSONOutput;
    }
    const _pre = input as PreCompactHookInput;
    const c = ctx();
    try {
      const [prefs, decisions] = await Promise.all([
        listMemoryByPrefix(c.prisma, c.tenantId, 'preferences/', 30),
        listMemoryByPrefix(c.prisma, c.tenantId, 'decisions/', 10),
      ]);
      const lines: string[] = [];
      if (prefs.length > 0) {
        lines.push('Durable manager preferences (do not forget during compaction):');
        for (const p of prefs) lines.push(`  - ${p.key}: ${JSON.stringify(p.value)}`);
      }
      if (decisions.length > 0) {
        lines.push('Recent decisions (avoid oscillation):');
        for (const d of decisions) lines.push(`  - ${d.key}: ${JSON.stringify(d.value)}`);
      }
      if (lines.length === 0) {
        return { continue: true } as HookJSONOutput;
      }
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PreCompact',
          additionalContext: lines.join('\n'),
        },
      } as unknown as HookJSONOutput;
    } catch (err) {
      console.warn('[tuning-agent.PreCompact] memory fetch failed:', err);
      return { continue: true } as HookJSONOutput;
    }
  };
}
