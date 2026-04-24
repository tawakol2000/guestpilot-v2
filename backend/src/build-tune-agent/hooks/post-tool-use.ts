/**
 * PostToolUse hook — runs after every tool call. Responsibilities:
 *   1. Langfuse span logging (tool name + brief output summary). The tool
 *      handler also emits a span via startAiSpan, so this hook's log is a
 *      complementary "observed-from-outside" record of tool calls.
 *   2. Category-stats update on `suggestion_action(apply | edit_then_apply
 *      | reject)` — already done inside the tool handler, so we avoid
 *      double-counting here. This hook's job is to log, not mutate.
 *   3. Preference-pair capture is ALSO handled inside `suggestion_action`
 *      (because the handler has the before/rejected/preferred triple in
 *      scope). The hook observes the resulting status and logs the
 *      outcome to Langfuse.
 */
import type {
  HookCallback,
  HookInput,
  HookJSONOutput,
  PostToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { startAiSpan } from '../../services/observability.service';
import { TUNING_AGENT_TOOL_NAMES } from '../tools/names';
import { detectElisionMarker } from '../validators/elision-patterns';
import type { HookContext } from './shared';

export function buildPostToolUseHook(_ctx: () => HookContext): HookCallback {
  return async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'PostToolUse') {
      return { continue: true } as HookJSONOutput;
    }
    const post = input as PostToolUseHookInput;

    // Synthesize a span so Langfuse captures tool activity even if the
    // handler itself didn't. Truncate heavy payloads.
    const span = startAiSpan(`tuning-agent.hook.${post.tool_name}`, truncateForLog(post.tool_input));
    try {
      span.end(truncateForLog(post.tool_response));
    } catch {
      /* noop */
    }

    // Sprint 10 workstream A.2: deterministic post-generation validator for
    // propose_suggestion. Catches elision markers, missing/mismatched
    // edit-format fields, and null-violations for NO_FIX / MISSING_CAPABILITY.
    // On failure, feed the reason back as additionalContext so the agent
    // self-corrects on the next turn rather than silently shipping bad output.
    // 060-D: propose_suggestion folded into studio_suggestion(op='propose').
    // The validator only fires when the propose op is invoked.
    if (
      post.tool_name === TUNING_AGENT_TOOL_NAMES.studio_suggestion &&
      (post.tool_input as { op?: string })?.op === 'propose'
    ) {
      const validationError = validateProposeSuggestion(post.tool_input);
      if (validationError) {
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: `[Validation error: ${validationError}. Please re-examine the current artifact text and regenerate the suggestion.]`,
          },
        } as HookJSONOutput;
      }
    }

    return { continue: true } as HookJSONOutput;
  };
}

// Sprint 10 workstream A.2 — pure-regex validator. No LLM calls, no DB.
// Patterns live in ../validators/elision-patterns so the draft-apply
// path in tools/suggestion-action.ts shares the same source of truth.

function countXmlTags(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const re = /<\/?([A-Za-z_][A-Za-z0-9_-]*)\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const full = m[0];
    const tag = m[1].toLowerCase();
    const isClose = full.startsWith('</');
    const isSelfClose = /\/>\s*$/.test(full);
    if (isSelfClose) continue;
    const delta = isClose ? -1 : 1;
    counts.set(tag, (counts.get(tag) ?? 0) + delta);
  }
  return counts;
}

function validateProposeSuggestion(toolInput: unknown): string | null {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const args = toolInput as {
    category?: string;
    editFormat?: string;
    proposedText?: string | null;
    oldText?: string | null;
    newText?: string | null;
    beforeText?: string | null;
  };
  const category = args.category;
  const editFormat = args.editFormat ?? 'full_replacement';

  if (category === 'NO_FIX' || category === 'MISSING_CAPABILITY') {
    if (args.proposedText || args.oldText || args.newText) {
      return `${category} must have proposedText/oldText/newText all null`;
    }
    return null;
  }

  if (editFormat === 'search_replace') {
    if (!args.oldText || !args.newText) {
      return 'editFormat=search_replace requires both oldText and newText (non-empty)';
    }
    if (args.oldText === args.newText) {
      return 'editFormat=search_replace requires oldText !== newText';
    }
  } else {
    if (!args.proposedText || args.proposedText.length === 0) {
      return 'editFormat=full_replacement requires a non-empty proposedText';
    }
  }

  const textToCheck = editFormat === 'search_replace' ? args.newText ?? '' : args.proposedText ?? '';
  const elision = detectElisionMarker(textToCheck);
  if (elision) {
    return `proposed text contains an elision marker (${elision}). Include the complete text, not a placeholder`;
  }

  if (editFormat === 'full_replacement' && args.beforeText && /<[A-Za-z_][A-Za-z0-9_-]*\b/.test(args.beforeText)) {
    const beforeCounts = countXmlTags(args.beforeText);
    const afterCounts = countXmlTags(textToCheck);
    for (const [tag, before] of beforeCounts) {
      const after = afterCounts.get(tag) ?? 0;
      if (before === 0 && after !== 0) {
        return `XML tag <${tag}> is unbalanced in proposed text (net ${after} unmatched opens)`;
      }
    }
  }

  return null;
}

function truncateForLog(v: unknown): unknown {
  // Sprint 09 fix 12: the old implementation did
  //   JSON.parse(s.slice(0, 4000) + '..."TRUNCATED"')
  // which ALWAYS threw because slicing mid-JSON produces invalid syntax,
  // so every over-4000-char payload fell through to
  //   { note: 'unserializable' }
  // losing all detail. Return a truncated string instead — the log field
  // accepts any JSON value and a partial body is far more useful than a
  // generic marker.
  try {
    const s = JSON.stringify(v);
    if (!s) return v;
    if (s.length <= 4000) return v;
    return s.slice(0, 4000) + '…[truncated]';
  } catch {
    return { note: 'unserializable' };
  }
}
