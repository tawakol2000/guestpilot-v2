/**
 * System-prompt assembler unit tests.
 *
 * Run:  npx tsx --test src/build-tune-agent/__tests__/system-prompt.test.ts
 *
 * Sprint 045 refresh: the assembler now takes a `mode` and emits a
 * mode addendum between the shared prefix and the dynamic suffix. These
 * tests lock down (a) the shared prefix is byte-identical across turns
 * for the same mode, (b) mode addenda swap content correctly, and (c)
 * the dynamic suffix's terminal recap is mode-selected.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assembleSystemPrompt,
  buildSharedPrefix,
  buildStaticPrefix,
  buildDynamicSuffix,
  type AgentMode,
  type SystemPromptContext,
} from '../system-prompt';
import {
  DYNAMIC_BOUNDARY_MARKER,
  SHARED_MODE_BOUNDARY_MARKER,
} from '../config';

function ctx(overrides: Partial<SystemPromptContext> = {}): SystemPromptContext {
  return {
    tenantId: 't1',
    conversationId: 'c1',
    anchorMessageId: null,
    selectedSuggestionId: null,
    memorySnapshot: [],
    pending: { total: 0, topThree: [], countsByCategory: {} },
    mode: 'TUNE' as AgentMode,
    ...overrides,
  };
}

test('assembleSystemPrompt emits shared→mode→dynamic regions separated by boundary markers', () => {
  const prompt = assembleSystemPrompt(ctx());
  assert.ok(prompt.includes(SHARED_MODE_BOUNDARY_MARKER), 'shared/mode boundary must be present');
  assert.ok(prompt.includes(DYNAMIC_BOUNDARY_MARKER), 'mode/dynamic boundary must be present');
  const sharedEnd = prompt.indexOf(SHARED_MODE_BOUNDARY_MARKER);
  const modeEnd = prompt.indexOf(DYNAMIC_BOUNDARY_MARKER);
  assert.ok(sharedEnd < modeEnd, 'shared/mode boundary must precede mode/dynamic boundary');

  const shared = prompt.slice(0, sharedEnd);
  const modeAddendum = prompt.slice(sharedEnd + SHARED_MODE_BOUNDARY_MARKER.length, modeEnd);
  const dynamic = prompt.slice(modeEnd + DYNAMIC_BOUNDARY_MARKER.length);

  assert.ok(shared.includes('<persona>'), 'shared must carry persona');
  assert.ok(shared.includes('<taxonomy>'), 'shared must carry taxonomy');
  assert.ok(shared.includes('<tools>'), 'shared must carry tool docs');
  assert.ok(modeAddendum.includes('<tune_mode>'), 'TUNE mode must emit tune_mode addendum');
  assert.ok(dynamic.includes('<memory_snapshot>'), 'dynamic must carry memory');
  assert.ok(dynamic.includes('<session_state>'), 'dynamic must carry session_state');
  assert.ok(dynamic.includes('<terminal_recap>'), 'dynamic must carry terminal_recap');
});

test('shared prefix is byte-identical across calls (cacheable)', () => {
  const a = buildSharedPrefix();
  const b = buildSharedPrefix();
  const c = buildSharedPrefix();
  assert.equal(a, b);
  assert.equal(b, c);
  // Back-compat alias returns the same string.
  assert.equal(buildStaticPrefix(), a);
});

test('shared prefix ordering (sprint 060-A): principles → response_contract → persona → capabilities → citation_grammar → taxonomy → tools → context_handling → platform_context → never_do → critical_rules', () => {
  const p = buildSharedPrefix();
  const idxPrinciples = p.indexOf('<principles>');
  const idxResponseContract = p.indexOf('<response_contract>');
  const idxPersona = p.indexOf('<persona>');
  const idxCapabilities = p.indexOf('<capabilities>');
  const idxCitation = p.indexOf('<citation_grammar>');
  const idxTaxonomy = p.indexOf('<taxonomy>');
  const idxTools = p.indexOf('<tools>');
  const idxContextHandling = p.indexOf('<context_handling>');
  const idxPlatform = p.indexOf('<platform_context>');
  // NEVER_DO is referenced by name inside CONTEXT_HANDLING ("follows
  // the <never_do> rules"); the actual block header is the LAST
  // occurrence of the tag in Region A.
  const idxNeverDo = p.lastIndexOf('<never_do>');
  const idxCritical = p.indexOf('<critical_rules>');
  assert.ok(idxPrinciples >= 0, 'principles must appear');
  assert.ok(idxResponseContract > idxPrinciples, 'response_contract must follow principles');
  assert.ok(idxPersona > idxResponseContract, 'persona must follow response_contract');
  assert.ok(idxCapabilities > idxPersona, 'capabilities must follow persona');
  assert.ok(idxCitation > idxCapabilities, 'citation_grammar must follow capabilities');
  assert.ok(idxTaxonomy > idxCitation, 'taxonomy must follow citation_grammar');
  assert.ok(idxTools > idxTaxonomy, 'tools must follow taxonomy');
  assert.ok(idxContextHandling > idxTools, 'context_handling must follow tools');
  assert.ok(idxPlatform > idxContextHandling, 'platform_context must follow context_handling');
  assert.ok(idxNeverDo > idxPlatform, 'never_do must follow platform_context');
  assert.ok(idxCritical > idxNeverDo, 'critical_rules must come last in the shared prefix');
});

test('shared prefix carries the Sprint 046 Response Contract verbatim (7 rules)', () => {
  const p = buildSharedPrefix();
  assert.ok(p.includes('<response_contract>'));
  assert.ok(p.includes('## Response contract'));
  assert.ok(p.includes('emit AT MOST ONE of the following structured'));
  assert.ok(p.includes('Prose is optional and capped at 120 words'));
  // Sprint 060-A: "You DO NOT emit markdown tables..." → "Emit
  // structured cards or capped prose only; ..." (affirmative pass).
  assert.ok(p.includes('Emit structured cards or capped prose only'));
  assert.ok(p.includes('question_choices'));
  assert.ok(p.includes('machine-readable target'));
  assert.ok(p.includes('Emoji status pills'));
  assert.ok(p.includes('"Recommended Next Steps"'));
});

test('TUNE addendum carries the Sprint 046 Triage block', () => {
  const tune = assembleSystemPrompt(ctx({ mode: 'TUNE' }));
  assert.ok(tune.includes('## Triage'));
  assert.ok(tune.includes("get_current_state(scope: 'all')"));
  assert.ok(tune.includes('impact × reversibility'));
  assert.ok(tune.includes('audit_report'));
});

test('BUILD addendum carries both interview-style and audit-style Triage branches', () => {
  const build = assembleSystemPrompt(ctx({ mode: 'BUILD' }));
  assert.ok(build.includes('## Triage'));
  assert.ok(build.includes("get_current_state(scope: 'summary')"));
  assert.ok(build.includes('question_choices'));
  assert.ok(build.includes("get_current_state(scope: 'all')"));
  assert.ok(build.includes('Pick the top ONE'));
});

test('shared principles: truthfulness-over-validation retained; NO_FIX-as-default moved to TUNE addendum', () => {
  // Sprint 045 §4: NO_FIX-as-default moved out of shared principles into TUNE addendum.
  const p = buildSharedPrefix();
  assert.ok(
    p.includes('Truthfulness over validation'),
    'truthfulness-over-validation principle stays in shared'
  );
  assert.ok(
    !p.includes('NO_FIX is the default'),
    'NO_FIX-as-default must NOT appear in shared prefix (moved to TUNE addendum)'
  );
  assert.ok(p.includes('Refuse directly without lecturing.'));
  assert.ok(p.includes('<critical_rules>'), 'terminal critical_rules block must appear');
});

test('TUNE addendum carries NO_FIX-as-default and the fragment rule', () => {
  const prompt = assembleSystemPrompt(ctx({ mode: 'TUNE' }));
  assert.ok(prompt.includes('<tune_mode>'), 'TUNE mode addendum must be present');
  assert.ok(
    prompt.includes('NO_FIX is the default'),
    'TUNE addendum must carry NO_FIX-as-default (moved from shared principles)'
  );
  // Sprint 060-A: "proposedText/newText must never be a fragment" →
  // "proposedText/newText always contains complete text" (affirmative pass).
  assert.ok(
    prompt.includes('proposedText/newText always contains complete'),
    'TUNE addendum must carry the fragment rule (moved from shared critical_rules)'
  );
});

test('BUILD addendum carries interview posture + defaults-as-markers rule', () => {
  const prompt = assembleSystemPrompt(ctx({ mode: 'BUILD' }));
  assert.ok(prompt.includes('<build_mode>'), 'BUILD mode addendum must be present');
  assert.ok(!prompt.includes('<tune_mode>'), 'BUILD prompt must not carry TUNE addendum');
  assert.ok(
    prompt.includes('Elicit through specific past incidents'),
    'BUILD addendum must carry incident-based interview posture'
  );
  assert.ok(
    prompt.includes('<!-- DEFAULT: change me -->'),
    'BUILD addendum must reference the default marker form'
  );
  assert.ok(
    prompt.includes('plan_build_changes'),
    'BUILD addendum must reference plan_build_changes orchestration'
  );
});

test('terminal recap is mode-selected: TUNE rule 2 is NO_FIX, BUILD rule 2 is default-mark', () => {
  const tune = assembleSystemPrompt(ctx({ mode: 'TUNE' }));
  const build = assembleSystemPrompt(ctx({ mode: 'BUILD' }));
  assert.ok(tune.includes('NO_FIX is correct when evidence is absent'), 'TUNE recap rule 2');
  assert.ok(
    build.includes('Propose a sensible default if the manager'),
    'BUILD recap rule 2'
  );
  assert.ok(
    !tune.includes('Propose a sensible default if the manager'),
    'TUNE must not carry BUILD recap'
  );
});

test('BUILD mode injects tenant_state block when tenantState is supplied', () => {
  const prompt = assembleSystemPrompt(
    ctx({
      mode: 'BUILD',
      tenantState: {
        posture: 'GREENFIELD',
        systemPromptStatus: 'EMPTY',
        systemPromptEditCount: 0,
        sopsDefined: 0,
        sopsDefaulted: 0,
        faqsGlobal: 0,
        faqsPropertyScoped: 0,
        customToolsDefined: 0,
        propertiesImported: 0,
        lastBuildSessionAt: null,
      },
    })
  );
  assert.ok(prompt.includes('<tenant_state>'), 'tenant_state block must be present in BUILD');
  assert.ok(prompt.includes('GREENFIELD'), 'GREENFIELD posture must render');
  assert.ok(prompt.includes('start from the generic hospitality template'));
});

test('TUNE mode does not inject tenant_state block', () => {
  const prompt = assembleSystemPrompt(ctx({ mode: 'TUNE' }));
  assert.ok(!prompt.includes('<tenant_state>'), 'tenant_state must not appear in TUNE');
});

test('dynamic suffix reflects pending + memory context (TUNE)', () => {
  const suffix = buildDynamicSuffix(
    ctx({
      memorySnapshot: [
        { key: 'preferences/tone', value: 'concise', source: null, updatedAt: '2026-04-15T00:00:00Z' },
      ],
      pending: {
        total: 2,
        countsByCategory: { SOP_CONTENT: 2 },
        topThree: [
          {
            id: 's1',
            diagnosticCategory: 'SOP_CONTENT',
            diagnosticSubLabel: 'parking-info-missing',
            confidence: 0.82,
            rationale: 'Guest asked about parking; SOP had no coverage.',
            createdAt: '2026-04-15T00:00:00Z',
          },
        ],
      },
      anchorMessageId: 'm1',
    })
  );
  assert.ok(suffix.includes('preferences/tone'));
  assert.ok(suffix.includes('SOP_CONTENT=2'));
  assert.ok(suffix.includes('parking-info-missing'));
  assert.ok(suffix.includes('anchorMessageId=m1'));
});

test('memory snapshot is index-only with lazy-load instruction (sprint 10 workstream E)', () => {
  const suffix = buildDynamicSuffix(
    ctx({
      memorySnapshot: [
        { key: 'preferences/tone', value: 'concise', source: null, updatedAt: '2026-04-15T00:00:00Z' },
      ],
      pending: { total: 0, topThree: [], countsByCategory: {} },
    })
  );
  assert.ok(
    suffix.includes("memory(op: 'view'"),
    'memory snapshot must instruct the agent to lazy-load full values'
  );
  assert.ok(suffix.includes('preferences/tone'));
});

test('empty queue + empty memory produce safe fallbacks (TUNE)', () => {
  const suffix = buildDynamicSuffix(ctx());
  assert.ok(suffix.includes('Queue is empty'));
  assert.ok(suffix.includes('No durable preferences on file'));
});

test('"preview_ai_response" is absent from the rendered prompt in both modes (sprint 045 A1)', () => {
  // preview_ai_response was re-scoped to test_pipeline in session 3. A stale
  // reference in the system prompt would make the agent emit a tool call
  // that the SDK's allow-list denies, surfacing as a failed tool invocation
  // to the manager mid-interview.
  const tune = assembleSystemPrompt(ctx({ mode: 'TUNE' }));
  const build = assembleSystemPrompt(ctx({ mode: 'BUILD' }));
  assert.ok(
    !tune.includes('preview_ai_response'),
    'TUNE-mode prompt must not mention preview_ai_response'
  );
  assert.ok(
    !build.includes('preview_ai_response'),
    'BUILD-mode prompt must not mention preview_ai_response'
  );
  assert.ok(tune.includes('test_pipeline'), 'TUNE-mode prompt must name test_pipeline');
  assert.ok(build.includes('test_pipeline'), 'BUILD-mode prompt must name test_pipeline');
});

test('054-A F3: BUILD addendum carries <verification_ritual> block stamped with VERIFICATION_RITUAL_VERSION', async () => {
  // If this test fails because the version string was bumped intentionally,
  // update the assertion below AND VERIFICATION_RITUAL_VERSION in
  // lib/ritual-state.ts — they must stay in lockstep.
  const { VERIFICATION_RITUAL_VERSION } = await import(
    '../lib/ritual-state'
  );
  assert.equal(VERIFICATION_RITUAL_VERSION, '054-a.1');
  const build = assembleSystemPrompt(ctx({ mode: 'BUILD' }));
  assert.ok(
    build.includes('<verification_ritual version="054-a.1">'),
    'BUILD addendum must carry <verification_ritual> block with the current version stamp',
  );
  assert.ok(
    build.includes('direct') &&
      build.includes('implicit') &&
      build.includes('framed axis'),
    'verification_ritual block must teach the direct / implicit / framed axis',
  );
  assert.ok(
    build.includes('testMessages: [t1, t2, t3]'),
    'verification_ritual block must name the testMessages array shape',
  );
  assert.ok(
    build.includes('CEILING, not a floor'),
    'verification_ritual block must instruct "1/1 and 2/2 honest, not padded to 3"',
  );
  assert.ok(
    build.includes('TEST_RITUAL_EXHAUSTED'),
    'verification_ritual block must reference the executor-level error on 4th call',
  );
  const tune = assembleSystemPrompt(ctx({ mode: 'TUNE' }));
  assert.ok(
    !tune.includes('<verification_ritual'),
    'TUNE addendum must not carry the verification_ritual block',
  );
});

test('054-A F1: BUILD addendum carries <write_rationale> block stamped with RATIONALE_PROMPT_VERSION', async () => {
  // If this test fails because the version string was bumped intentionally,
  // update the assertion below AND the RATIONALE_PROMPT_VERSION constant in
  // lib/rationale-validator.ts — they must stay in lockstep.
  const { RATIONALE_PROMPT_VERSION } = await import('../lib/rationale-validator');
  assert.equal(RATIONALE_PROMPT_VERSION, '054-a.1');
  const build = assembleSystemPrompt(ctx({ mode: 'BUILD' }));
  assert.ok(
    build.includes('<write_rationale version="054-a.1">'),
    'BUILD addendum must carry <write_rationale> block with the current version stamp'
  );
  assert.ok(
    build.includes('required "rationale" string parameter'),
    'write_rationale block must document the rationale parameter'
  );
  // Must include both a good example and a bad example (teaches by counter-example).
  assert.ok(build.includes('Good examples'));
  assert.ok(build.includes('Bad examples'));
  // TUNE mode should NOT carry this block (it's BUILD-mode-specific).
  const tune = assembleSystemPrompt(ctx({ mode: 'TUNE' }));
  assert.ok(
    !tune.includes('<write_rationale'),
    'TUNE addendum must not carry the write_rationale block'
  );
});

test('BUILD dynamic suffix renders interview_progress instead of pending_suggestions', () => {
  const suffix = buildDynamicSuffix(
    ctx({
      mode: 'BUILD',
      interviewProgress: {
        loadBearingFilled: 2,
        loadBearingTotal: 6,
        nonLoadBearingFilled: 0,
        nonLoadBearingTotal: 14,
        defaultedSlots: [],
      },
    })
  );
  assert.ok(suffix.includes('<interview_progress>'));
  assert.ok(suffix.includes('2/6'));
  assert.ok(!suffix.includes('<pending_suggestions>'));
});
