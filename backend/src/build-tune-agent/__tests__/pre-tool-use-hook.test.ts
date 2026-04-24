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
    emitDataPart: overrides.emitDataPart,
    compliance: { lastUserSanctionedApply: false, lastUserSanctionedRollback: false },
    // Sprint 046 Session A: tool-trace hook fields — unused here but
    // required by the HookContext interface.
    turn: 1,
    toolCallStartTimes: new Map<string, number>(),
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
  // 060-D: 'queue' op was dropped; 'propose' is the new non-write op that the hook passes through.
  const res = await invoke(hook, TUNING_AGENT_TOOL_NAMES.studio_suggestion, { op: 'propose' });
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
  const res = await invoke(hook, TUNING_AGENT_TOOL_NAMES.studio_suggestion, {
    op: 'apply',
    suggestionId: 's1',
  });
  assert.equal(res.continue, false);
  assert.equal(res.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(res.hookSpecificOutput?.permissionDecisionReason || '', /Compliance/);
});

// Sprint 046 Session D — cooldown-deny deleted. The hook no longer
// blocks on a prior recent apply; it emits a non-blocking recent-edit
// advisory instead. The legacy "denies apply when cooldown is hit"
// test was removed in this session. See the new
// "recent-edit advisory is emitted but does not deny" test below.

test('emits recent-edit advisory without denying when prior apply is within 48h', async () => {
  const recent = new Date();
  const emits: any[] = [];
  const c = ctx({
    readLastUserMessage: () => 'apply it',
    emitDataPart: (part: any) => emits.push(part),
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
          if (args.where.status === 'ACCEPTED' && args.where.appliedAt) {
            return { id: 'prior', appliedAt: recent, confidence: null };
          }
          return null;
        },
      },
    },
  });
  const hook = buildPreToolUseHook(() => c);
  const res = await invoke(hook, TUNING_AGENT_TOOL_NAMES.studio_suggestion, {
    op: 'apply',
    suggestionId: 's1',
  });
  assert.deepEqual(res, { continue: true });
  const recentEdit = emits.find(
    (p) => p.type === 'data-advisory' && p.data?.kind === 'recent-edit'
  );
  assert.ok(recentEdit, 'expected a recent-edit advisory data part');
});

test('does NOT emit recent-edit advisory when prior apply is older than 48h', async () => {
  const long = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days ago
  const emits: any[] = [];
  const c = ctx({
    readLastUserMessage: () => 'apply it',
    emitDataPart: (part: any) => emits.push(part),
    prisma: {
      tuningSuggestion: {
        findFirst: async (args: any) => {
          if (args.where.id === 's3') {
            return {
              id: 's3',
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
          // The where clause scopes appliedAt: { gte: recentSince }. A prior
          // apply from 10 days ago is out-of-window, so the prisma mock
          // returns null for both recent-edit and oscillation checks.
          if (args.where.status === 'ACCEPTED' && args.where.appliedAt) {
            // The query honours appliedAt>=recentSince; our mock can't
            // filter, so return null to mirror production behaviour on an
            // out-of-window prior.
            void long;
            return null;
          }
          return null;
        },
      },
    },
  });
  const hook = buildPreToolUseHook(() => c);
  const res = await invoke(hook, TUNING_AGENT_TOOL_NAMES.studio_suggestion, {
    op: 'apply',
    suggestionId: 's3',
  });
  assert.deepEqual(res, { continue: true });
  const recentEdit = emits.find(
    (p) => p.type === 'data-advisory' && p.data?.kind === 'recent-edit'
  );
  assert.equal(recentEdit, undefined);
});

test('allows immediate second apply of the same artifact (no cooldown deny)', async () => {
  const veryRecent = new Date();
  const emits: any[] = [];
  const c = ctx({
    readLastUserMessage: () => 'apply it',
    emitDataPart: (part: any) => emits.push(part),
    prisma: {
      tuningSuggestion: {
        findFirst: async (args: any) => {
          if (args.where.id === 's2') {
            return {
              id: 's2',
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
          // Emulate an apply that happened 5 seconds ago — still inside the
          // former 48h cooldown; the hook must not deny.
          if (args.where.status === 'ACCEPTED' && args.where.appliedAt) {
            return { id: 'prior', appliedAt: veryRecent, confidence: null };
          }
          return null;
        },
      },
    },
  });
  const hook = buildPreToolUseHook(() => c);
  const res = await invoke(hook, TUNING_AGENT_TOOL_NAMES.studio_suggestion, {
    op: 'apply',
    suggestionId: 's2',
  });
  assert.deepEqual(res, { continue: true });
});

test('oscillation reversal without confidence boost emits advisory, does NOT deny', async () => {
  let call = 0;
  const earlier = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // 2 days ago
  const emits: any[] = [];
  const c = ctx({
    readLastUserMessage: () => 'apply it',
    emitDataPart: (part: any) => emits.push(part),
    prisma: {
      tuningSuggestion: {
        findFirst: async () => {
          call += 1;
          if (call === 1) {
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
            // Recent-edit (prior-48h) check — also returns the older apply
            // since it pre-dates the 48h window here; return null to focus
            // this test on the oscillation path.
            return null;
          }
          // Oscillation check — prior accepted at confidence 0.6 (2 days ago)
          return { id: 'prior', confidence: 0.6, appliedAt: earlier };
        },
      },
    },
  });
  const hook = buildPreToolUseHook(() => c);
  const res = await invoke(hook, TUNING_AGENT_TOOL_NAMES.studio_suggestion, {
    op: 'apply',
    suggestionId: 's1',
  });
  assert.deepEqual(res, { continue: true });
  const osc = emits.find(
    (p) => p.type === 'data-advisory' && p.data?.kind === 'oscillation'
  );
  assert.ok(osc, 'expected an oscillation advisory data part');
});

test('allows apply when sanction present and no cooldown/oscillation', async () => {
  let call = 0;
  const c = ctx({
    readLastUserMessage: () => 'apply it',
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
  const res = await invoke(hook, TUNING_AGENT_TOOL_NAMES.studio_suggestion, {
    op: 'apply',
    suggestionId: 's1',
  });
  assert.deepEqual(res, { continue: true });
  assert.equal(c.compliance.lastUserSanctionedApply, true);
});

test('ignores non-suggestion_action tools', async () => {
  const c = ctx({ prisma: {} });
  const hook = buildPreToolUseHook(() => c);
  const res = await invoke(hook, TUNING_AGENT_TOOL_NAMES.studio_get_context, {});
  assert.deepEqual(res, { continue: true });
});

// Sprint 09 fix 6: compliance regex false positives.
test('does NOT sanction "I need to apply for a visa"', async () => {
  const { detectApplySanction } = await import('../hooks/shared');
  assert.equal(detectApplySanction('I need to apply for a visa'), false);
});

test('does NOT sanction "Can you confirm what the SOP says?"', async () => {
  const { detectApplySanction } = await import('../hooks/shared');
  assert.equal(detectApplySanction('Can you confirm what the SOP says?'), false);
});

test('sanctions "apply it" and "apply the change"', async () => {
  const { detectApplySanction } = await import('../hooks/shared');
  assert.equal(detectApplySanction('apply it'), true);
  assert.equal(detectApplySanction('Please apply the change'), true);
});

test('sanctions politeness-prefixed "apply" phrases', async () => {
  const { detectApplySanction } = await import('../hooks/shared');
  assert.equal(detectApplySanction('please apply'), true);
  assert.equal(detectApplySanction('sure, apply'), true);
  assert.equal(detectApplySanction('ok apply'), true);
  assert.equal(detectApplySanction('Could you apply'), true);
  assert.equal(detectApplySanction('apply'), true); // bare one-word turn
  // Verify the "apply for a visa" negative still holds after the new pattern
  assert.equal(detectApplySanction('I need to apply for a visa'), false);
  assert.equal(detectApplySanction('apply for a grant'), false);
});

test('sanctions "confirm the rollback"', async () => {
  const { detectApplySanction } = await import('../hooks/shared');
  assert.equal(detectApplySanction('confirm the rollback'), true);
});

test('rollback sanction requires rollback-specific phrasing', async () => {
  const { detectRollbackSanction } = await import('../hooks/shared');
  assert.equal(detectRollbackSanction('apply it'), false);
  assert.equal(detectRollbackSanction('revert it'), true);
  assert.equal(detectRollbackSanction('yes, roll back'), true);
  assert.equal(detectRollbackSanction('undo the change'), true);
});

// ─── Sprint 047 Session A — BUILD-creator advisory extension ────────

test('create_sop on a recently-edited artifact emits a recent-edit advisory without denying', async () => {
  const recent = new Date();
  const emits: any[] = [];
  const c = ctx({
    emitDataPart: (part: any) => emits.push(part),
    prisma: {
      tuningSuggestion: {
        findFirst: async (args: any) => {
          if (
            args.where.status === 'ACCEPTED' &&
            args.where.appliedAt &&
            args.where.sopCategory === 'sop-checkin'
          ) {
            return { id: 'prior', appliedAt: recent, confidence: null };
          }
          return null;
        },
      },
    },
  });
  const hook = buildPreToolUseHook(() => c);
  const res = await invoke(hook, TUNING_AGENT_TOOL_NAMES.studio_create_sop, {
    sopCategory: 'sop-checkin',
  });
  assert.deepEqual(res, { continue: true });
  const advisory = emits.find(
    (p) => p.type === 'data-advisory' && p.data?.kind === 'recent-edit'
  );
  assert.ok(advisory, 'expected a recent-edit advisory for create_sop');
  assert.match(String(advisory.id), /recent-edit:studio_create_sop:/);
});

test('create_sop on an artifact never written emits no advisory and does not block', async () => {
  const emits: any[] = [];
  const c = ctx({
    emitDataPart: (part: any) => emits.push(part),
    prisma: {
      tuningSuggestion: {
        findFirst: async () => null,
      },
    },
  });
  const hook = buildPreToolUseHook(() => c);
  const res = await invoke(hook, TUNING_AGENT_TOOL_NAMES.studio_create_sop, {
    sopCategory: 'sop-never-written',
  });
  assert.deepEqual(res, { continue: true });
  assert.equal(emits.length, 0, 'no advisory should be emitted');
});

test('create_faq does not block the tool even without an advisory emitted', async () => {
  const c = ctx({
    prisma: {
      tuningSuggestion: {
        findFirst: async () => null,
      },
    },
  });
  const hook = buildPreToolUseHook(() => c);
  const res = await invoke(hook, TUNING_AGENT_TOOL_NAMES.studio_create_faq, {
    question: 'Where can guests park?',
    category: 'parking',
  });
  assert.deepEqual(res, { continue: true });
});

test('write_system_prompt on recently-edited variant emits recent-edit advisory', async () => {
  const recent = new Date();
  const emits: any[] = [];
  const c = ctx({
    emitDataPart: (part: any) => emits.push(part),
    prisma: {
      tuningSuggestion: {
        findFirst: async (args: any) => {
          if (
            args.where.status === 'ACCEPTED' &&
            args.where.appliedAt &&
            args.where.systemPromptVariant === 'coordinator'
          ) {
            return { id: 'prior-prompt', appliedAt: recent, confidence: null };
          }
          return null;
        },
      },
    },
  });
  const hook = buildPreToolUseHook(() => c);
  const res = await invoke(hook, TUNING_AGENT_TOOL_NAMES.studio_create_system_prompt, {
    variant: 'coordinator',
    text: 'ignored by the hook',
  });
  assert.deepEqual(res, { continue: true });
  const advisory = emits.find(
    (p) => p.type === 'data-advisory' && p.data?.kind === 'recent-edit'
  );
  assert.ok(advisory, 'expected a recent-edit advisory for write_system_prompt');
});
