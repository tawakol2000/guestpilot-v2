/**
 * Stop hook — runs when the agent decides to stop a turn. Emits a transient
 * `data-follow-up` part so the UI can show a quiet "Anything else you'd
 * like me to look at?" nudge without persisting it into TuningMessage.
 */
import type { HookCallback, HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import type { HookContext } from './shared';

const FOLLOW_UPS = [
  'Anything else you want me to look at?',
  'Want me to check related suggestions next?',
  'Want me to record any preferences from this?',
];

export function buildStopHook(ctx: () => HookContext): HookCallback {
  let turnCount = 0;
  return async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'Stop') {
      return { continue: true } as HookJSONOutput;
    }
    turnCount += 1;
    const c = ctx();
    if (!c.emitDataPart) return { continue: true } as HookJSONOutput;
    const suggestion = FOLLOW_UPS[turnCount % FOLLOW_UPS.length];
    try {
      c.emitDataPart({
        type: 'data-follow-up',
        id: `follow-up:${turnCount}`,
        data: { suggestion },
        transient: true,
      });
    } catch {
      /* swallow */
    }
    return { continue: true } as HookJSONOutput;
  };
}
