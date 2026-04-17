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
    if (post.tool_name === TUNING_AGENT_TOOL_NAMES.propose_suggestion) {
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

// Sprint 10 workstream A.2 follow-up: the `[rest of …]` and `TODO: fill`
// patterns flagged legitimate SOP/FAQ content ("call them for the rest of
// your stay", "TODO: fill out form on arrival"). Tightened to phrases that
// clearly signal AI-elision-placeholder intent: "[rest of the content]",
// "[rest of the prompt]", etc., and "TODO: fill in" instead of any "TODO:
// fill" substring. Added Unicode ellipsis (U+2026) detection.
const ELISION_PATTERNS: RegExp[] = [
  /\/\/\s*\.\.\./i,
  /\/\/\s*rest\s+(of\s+)?unchanged/i,
  /\/\/\s*existing\s+code/i,
  /\/\*\s*\.\.\.\s*\*\//i,
  /#\s*rest\s+(of\s+)?unchanged/i,
  /#\s*existing\s+code/i,
  /<!--\s*remaining\s*-->/i,
  /<!--\s*\.\.\.\s*-->/i,
  /\[\s*unchanged\s*\]/i,
  /\[\s*rest\s+of\s+(the\s+)?(content|prompt|rules|section|file|text|code)[^\]]*\]/i,
  /TODO:\s*fill\s+in\b/i,
  /\.\.\.\s*existing\s+code\s*\.\.\./i,
];

function containsElisionMarker(text: string): string | null {
  for (const re of ELISION_PATTERNS) {
    if (re.test(text)) return re.source;
  }
  if (/^\s*\.\.\.\s*$/m.test(text)) return 'bare-ellipsis-line';
  return null;
}

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
  const elision = containsElisionMarker(textToCheck);
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
