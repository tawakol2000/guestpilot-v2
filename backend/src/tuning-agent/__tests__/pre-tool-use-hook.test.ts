/**
 * Sprint 04 — PreToolUse hook unit tests. Covers the three guardrails:
 * compliance, cooldown, oscillation.
 *
 * Run:  npx tsx --test src/tuning-agent/__tests__/pre-tool-use-hook.test.ts
 */
// Side-effect: satisfy auth middleware's top-level JWT_SECRET assertion so
// transitive imports don't process.exit() during test boot. Any value works.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-pre-tool-use';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPreToolUseHook } from '../hooks/pre-tool-use';
import { TUNING_AGENT_TOOL_NAMES } from '../tools/names';

function ctx(overrides: any = {}) {
  return {
    prisma: overrides.prisma,
    tenantId: 't1',
    conversationId: 'c1',
    userId: null,
    readLastUserMessage: overrides.readLastUserMessage ?? (() => ''),
    emitDataPart: undefined,
    compliance: { lastUserSanctionedApply: false },
  };
}

function invoke(hook: any, toolName: string, toolInput: unknown) {
  return hook(
    {
      hook_event_name: 'PreToolUse',
      session_id: 's',
      transcript_path: '',
      cwd: '',
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: 'tu1',
    },
    'tu1',
    { signal: new AbortController().signal }
  );
}

test('passes through non-apply suggestion_action calls', async () => {
  const c = ctx({ prisma: {} });
  const hook = buildPreToolUseHook(() => c);
  const res = await invoke(hook, TUNING_AGENT_TOOL_NAMES.suggestion_action, { action: 'queue' });
  assert.deepEqual(res, { continue: true });
});

test('denies apply without manager sanction', async () => {
  const c = ctx({
    readLastUserMessage: () => 'What did the AI do here?',
    prisma: {
      tuningSuggestion: {
        findFirst: async () => null,
      },
    },
  });
  const hook = buildPreToolUseHook(() => c);
  const res = await invoke(hook, TUNING_AGENT_TOOL_NAMES.suggestion_action, {
    action: 'apply',
    suggestionId: 's1',
  });
  assert.equal(res.continue, false);
  assert.equal(res.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(res.hookSpecificOutput?.permissionDecisionReason || '', /Compliance/);
});

test('denies apply when cooldown is hit', async () => {
  const recent = new Date();
  const c = ctx({
    readLastUserMessage: () => 'apply',
    prisma: {
      tuningSuggestion: {
        findFirst: async (args: any) => {
          if (args.where.id === 's1') {
            return {
              id: 's1',
              diagnosticCategory: 'SOP_CONTENT',
              confidence: 0.8,
              sopCategory: 'sop-checkin',
              sopStatus: 'CONFIRMED',
              sopPropertyId: null,
              systemPromptVariant: null,
              faqEntryId: null,
              status: 'PENDING',
            };
          }
          // Cooldown query: recent accepted suggestion on same target.
          if (args.where.status === 'ACCEPTED' && args.where.appliedAt) {
            return { id: 'prior', appliedAt: recent };
          }
          return null;
        },
      },
    },
  });
  const hook = buildPreToolUseHook(() => c);
  const res = await invoke(hook, TUNING_AGENT_TOOL_NAMES.suggestion_action, {
    action: 'apply',
    suggestionId: 's1',
  });
  assert.equal(res.continue, false);
  assert.match(res.hookSpecificOutput?.permissionDecisionReason || '', /Cooldown/);
});

test('denies oscillation reversal without confidence boost', async () => {
  let call = 0;
  const earlier = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // 2 days ago
  const c = ctx({
    readLastUserMessage: () => 'apply',
    prisma: {
      tuningSuggestion: {
        findFirst: async () => {
          call += 1;
          if (call === 1) {
            // Suggestion lookup
            return {
              id: 's1',
              diagnosticCategory: 'SOP_CONTENT',
              confidence: 0.5,
              sopCategory: 'sop-checkin',
              sopStatus: 'CONFIRMED',
              sopPropertyId: null,
              systemPromptVariant: null,
              faqEntryId: null,
              status: 'PENDING',
            };
          }
          if (call === 2) {
            // Cooldown check — nothing within 48h
            return null;
          }
          // Oscillation check — prior accepted at confidence 0.6 (2 days ago)
          return { id: 'prior', confidence: 0.6, appliedAt: earlier };
        },
      },
    },
  });
  const hook = buildPreToolUseHook(() => c);
  const res = await invoke(hook, TUNING_AGENT_TOOL_NAMES.suggestion_action, {
    action: 'apply',
    suggestionId: 's1',
  });
  assert.equal(res.continue, false);
  assert.match(res.hookSpecificOutput?.permissionDecisionReason || '', /Oscillation/);
});

test('allows apply when sanction present and no cooldown/oscillation', async () => {
  let call = 0;
  const c = ctx({
    readLastUserMessage: () => 'apply',
    prisma: {
      tuningSuggestion: {
        findFirst: async () => {
          call += 1;
          if (call === 1) {
            return {
              id: 's1',
              diagnosticCategory: 'FAQ',
              confidence: 0.8,
              sopCategory: null,
              sopStatus: null,
              sopPropertyId: null,
              systemPromptVariant: null,
              faqEntryId: 'faq1',
              status: 'PENDING',
            };
          }
          return null; // no cooldown/oscillation matches
        },
      },
    },
  });
  const hook = buildPreToolUseHook(() => c);
  const res = await invoke(hook, TUNING_AGENT_TOOL_NAMES.suggestion_action, {
    action: 'apply',
    suggestionId: 's1',
  });
  assert.deepEqual(res, { continue: true });
  assert.equal(c.compliance.lastUserSanctionedApply, true);
});

test('ignores non-suggestion_action tools', async () => {
  const c = ctx({ prisma: {} });
  const hook = buildPreToolUseHook(() => c);
  const res = await invoke(hook, TUNING_AGENT_TOOL_NAMES.get_context, {});
  assert.deepEqual(res, { continue: true });
});
