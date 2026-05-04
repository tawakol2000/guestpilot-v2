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
  // 2026-05-03: critical_rules is now also referenced inside
  // SELF_REPORT's "Continue to follow <principles>, <response_contract>,
  // <critical_rules> ..." — the actual block header is the LAST
  // occurrence, same convention as never_do above.
  const idxCritical = p.lastIndexOf('<critical_rules>');
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

test('shared prefix carries the Response Contract (5 rules post-060-B) and a compressed NEVER_DO', () => {
  const p = buildSharedPrefix();
  assert.ok(p.includes('<response_contract>'));
  assert.ok(p.includes('## Response contract'));
  assert.ok(p.includes('emit AT MOST ONE of the following structured'));
  assert.ok(p.includes('Prose is optional and capped at 120 words'));
  // Sprint 060-B: rule 3 compressed to one sentence, rules 6 (emoji
  // pills) and 7 ("Recommended Next Steps" enumerations) deleted from
  // RESPONSE_CONTRACT.
  assert.ok(p.includes('rank them and emit'));
  assert.ok(p.includes('question_choices'));
  assert.ok(p.includes('machine-readable target'));
  // 2026-05-04 (research-backed refactor): NEVER_DO compressed
  // from 18 items across 5 categories to 7 prioritised items
  // expressed as "instead of X, do Y" pairs (negation-priming
  // research, IFScale 2025). The "emoji status pills" / "Recommended
  // Next Steps" anchors moved out of NEVER_DO since the response
  // contract already enforces structured cards over free-form
  // enumerations. The block-presence + count guard below is the
  // load-bearing assertion now.
  assert.ok(p.includes('<never_do>'));
  assert.ok(p.includes('</never_do>'));
});

test('NEVER_DO contains at most 7 numbered items (research-backed compression)', () => {
  // IFScale + ManyIFEval (2025): instruction compliance degrades
  // monotonically with rule count. Cap at 7 prioritised items per
  // block; longer-form rules live in their domain blocks
  // (state_machine, build_mode, tool descriptions).
  const p = buildSharedPrefix();
  const start = p.indexOf('<never_do>');
  const end = p.indexOf('</never_do>');
  assert.ok(start >= 0 && end > start, 'never_do block must be present');
  const body = p.slice(start, end);
  const numberedItems = body.match(/^\d+\./gm) ?? [];
  assert.ok(
    numberedItems.length <= 7,
    `NEVER_DO must carry ≤7 numbered items, found ${numberedItems.length}`,
  );
});

test('TUNE addendum carries the audit Triage block', () => {
  const tune = assembleSystemPrompt(ctx({ mode: 'TUNE' }));
  // 2026-05-04 (research-backed refactor): TUNE addendum reorganised
  // around an outcome contract (named sub-blocks) instead of
  // numbered Step 1/2/3 sections. The audit-style flow keeps its
  // "## Audit triage" header so the existing assertion still
  // anchors.
  assert.ok(tune.includes('## Audit triage'));
  // Sprint 060-D: legacy get_current_state references replaced with the
  // index-then-fetch pair (studio_get_tenant_index → studio_get_artifact).
  assert.ok(tune.includes('studio_get_tenant_index'));
  assert.ok(tune.includes('impact × reversibility'));
  assert.ok(tune.includes('audit_report'));
});

test('TUNE addendum carries the outcome-contract sub-blocks', () => {
  // 2026-05-04 research-backed refactor: replace numbered Steps
  // with named sub-blocks (Anthropic Claude 4 Best Practices —
  // outcome contract beats procedural scaffold on reasoning models).
  const tune = assembleSystemPrompt(ctx({ mode: 'TUNE' }));
  assert.ok(tune.includes('<tune_mode_contract>'), '<tune_mode_contract> wrapper present');
  assert.ok(tune.includes('<edit_triage>'), 'edit_triage sub-block present');
  assert.ok(tune.includes('<reasons_not_to_act>'), 'reasons_not_to_act gate present');
  assert.ok(tune.includes('<memory_use>'), 'memory_use sub-block present');
  assert.ok(tune.includes('<output_contract>'), 'output_contract sub-block present');
});

test('TUNE addendum requires witness, reasons, and memory citation', () => {
  // The contract gates: witnessQuote required for non-NO_FIX,
  // ≥2 reasonsNotToAct entries, consultedMemoryKeys populated.
  // Schema-level NO_FIX default per Cole et al. EMNLP 2023 +
  // Sharma et al. Anthropic 2023 (sycophancy / abstention work).
  const tune = assembleSystemPrompt(ctx({ mode: 'TUNE' }));
  assert.ok(tune.includes('witnessQuote'), 'witnessQuote field referenced');
  assert.ok(tune.includes('reasonsNotToAct'), 'reasonsNotToAct field referenced');
  assert.ok(tune.includes('consultedMemoryKeys'), 'consultedMemoryKeys field referenced');
  assert.ok(tune.includes('NO_FIX is the default'), 'NO_FIX-as-default phrase preserved');
});

test('TUNE addendum names its three failure modes up front', () => {
  // Salience effect: naming the failure modes early primes the agent
  // to suppress them. Imported pattern from the BUILD addendum
  // refactor (research synthesis §1; same Sharma et al. 2023
  // schema-level vs instruction-only mitigation evidence).
  const tune = assembleSystemPrompt(ctx({ mode: 'TUNE' }));
  assert.ok(tune.includes('three failure modes'), 'failure-modes header present');
  assert.ok(tune.includes('wording-only edits'), 'failure mode 1 named');
  assert.ok(tune.includes('ignoring memory preferences'), 'failure mode 2 named');
  assert.ok(tune.includes('piling on existing pending'), 'failure mode 3 named');
});

test('TUNE addendum requires read-back framing on impact for non-NO_FIX', () => {
  // Clark & Brennan 1991 grounding-in-communication; AAFP/PMC
  // teach-back. Converts impact from a marketing headline into a
  // falsifiable behavioral claim the operator can sanity-test
  // before clicking Accept.
  const tune = assembleSystemPrompt(ctx({ mode: 'TUNE' }));
  assert.ok(tune.includes('read-back'), 'read-back framing referenced');
  assert.ok(
    tune.includes('After this fix, a guest'),
    'specific impact phrasing template present',
  );
  assert.ok(
    tune.includes('Edge cases the operator should verify'),
    'impact must enumerate edge cases for falsifiability',
  );
});

test('TUNE addendum carries the six IteraTeR-aligned edit_types', () => {
  const tune = assembleSystemPrompt(ctx({ mode: 'TUNE' }));
  for (const editType of [
    'STYLE_WORDING',
    'FRAMING_TONE',
    'FACTUAL',
    'BEHAVIORAL',
    'OMISSION',
    'REMOVAL',
  ]) {
    assert.ok(tune.includes(editType), `edit_type ${editType} must be enumerated`);
  }
});

test('SELF_REPORT structured into three named fields', () => {
  // Free-form self-critique produces sycophantic rubberstamping
  // (Sharma et al. 2023 Anthropic; Tan et al. 2025). Three named
  // fields force specific failure modes.
  const p = buildSharedPrefix();
  assert.ok(p.includes('<self_report>'));
  assert.ok(p.includes('weakest_inference'), 'weakest_inference field present');
  assert.ok(p.includes('most_fragile_assumption'), 'most_fragile_assumption field present');
  assert.ok(
    p.includes('preferred_alternative_classification'),
    'preferred_alternative_classification field present',
  );
});

test('BUILD addendum carries both interview-style and audit-style Triage branches', () => {
  const build = assembleSystemPrompt(ctx({ mode: 'BUILD' }));
  assert.ok(build.includes('## Triage'));
  assert.ok(build.includes('studio_get_tenant_index'));
  assert.ok(build.includes('question_choices'));
  assert.ok(build.includes('studio_get_artifact'));
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
  // 2026-05-03: P3 reframed from "Direct refusals." (refuse style
  // tics) to "Wording vs behavior." (the broader triage rule that
  // wording-only edits are NO_FIX, only behavior changes warrant
  // artifact edits). Assert the new label so the principle stays
  // anchored in shared.
  assert.ok(p.includes('Wording vs behavior.'));
  assert.ok(p.includes('<critical_rules>'), 'terminal critical_rules block must appear');
});

test('TUNE addendum carries NO_FIX-as-default and the fragment rule', () => {
  const prompt = assembleSystemPrompt(ctx({ mode: 'TUNE' }));
  assert.ok(prompt.includes('<tune_mode>'), 'TUNE mode addendum must be present');
  assert.ok(
    prompt.includes('NO_FIX is the default'),
    'TUNE addendum must carry NO_FIX-as-default (moved from shared principles)'
  );
  // Sprint 060-B: the duplicated "TUNE-mode critical rule" paragraph
  // about fragments was dropped — the canonical rule lives in NEVER_DO
  // (shared prefix), which the assembled prompt still carries.
  assert.ok(
    prompt.includes('No fragment proposedText / newText'),
    'fragment rule must remain anchored in NEVER_DO (shared prefix)'
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

test('BUILD addendum names the three failure modes up front (research-backed)', () => {
  // 2026-05-04 research-backed refactor: failure-mode salience effect
  // — naming the three modes early in the addendum primes the agent
  // to suppress them. Sharma et al. 2023 (Anthropic) on schema-level
  // sycophancy suppression beating instruction-only mitigation.
  const prompt = assembleSystemPrompt(ctx({ mode: 'BUILD' }));
  assert.ok(prompt.includes('leading questions'), 'failure mode 1 named');
  assert.ok(prompt.includes('premature drafting'), 'failure mode 2 named');
  assert.ok(prompt.includes('silent defaulting'), 'failure mode 3 named');
});

test('BUILD addendum carries the slot-quorum precondition (5/6 confirmed)', () => {
  // Plan-before-write encoded as a state-machine guard. Anthropic
  // τ-bench result (+54% relative on planning); Yao et al. 2022 ReAct.
  // The 5/6 quorum is the load-bearing slot discipline from the
  // dialog-state-tracking literature (Rastogi et al. 2020 SGD;
  // Heck et al. 2020 TripPy).
  const prompt = assembleSystemPrompt(ctx({ mode: 'BUILD' }));
  assert.ok(prompt.includes('5 of the 6 load-bearing slots'), 'quorum text present');
  assert.ok(
    prompt.includes('hard error'),
    'quorum violation must be framed as a hard error, not a soft preference',
  );
});

test('BUILD addendum carries the read-back rule (teach-back fidelity check)', () => {
  // Clark & Brennan 1991 grounding-in-communication; AAFP/PMC
  // teach-back evidence. Cheap fidelity check before any write.
  // (Substrings chosen to fit on single physical lines after the
  // 70-char wrap; the assertions tolerate the wrapping inside the
  // addendum.)
  const prompt = assembleSystemPrompt(ctx({ mode: 'BUILD' }));
  assert.ok(prompt.includes('Read-back before write'), 'read-back rule heading');
  assert.ok(
    prompt.includes('answer correctly with'),
    'specific read-back phrasing present',
  );
});

test('BUILD addendum carries the contradiction-handling tactic ("and also")', () => {
  // Miller & Rollnick 2013 motivational interviewing — "developing
  // discrepancy" via labeling, not confrontation. Voss labeling
  // tactic. The "and also" framing is non-confrontational and
  // surfaces conflict in the operator's own words.
  const prompt = assembleSystemPrompt(ctx({ mode: 'BUILD' }));
  assert.ok(prompt.includes('and also'), '"and also" tactic phrasing');
  assert.ok(
    prompt.includes('Never silently pick'),
    'no-silent-pick rule present (counters RLHF reward-hack of dropping a branch)',
  );
});

test('BUILD addendum carries effort-allocation guidance + bans "anything else?"', () => {
  // Anthropic adaptive-thinking docs (Sonnet 4.6) + OpenAI reasoning
  // guide. Interview turns default terse; reserve depth for synthesis.
  // "anything else?" is empirically near-useless in qualitative
  // interview practice (Fisher & Geiselman 1992).
  const prompt = assembleSystemPrompt(ctx({ mode: 'BUILD' }));
  assert.ok(prompt.includes('Effort allocation'), 'effort-allocation section');
  assert.ok(prompt.includes('interview drag'), 'interview-drag named as failure mode');
  assert.ok(
    prompt.includes('anything else?'),
    'addendum mentions the banned closing-turn phrase (it is named to ban it)',
  );
  assert.ok(
    prompt.includes('guest situation') && prompt.includes('surprised you'),
    'specific replacement probe present (substrings tolerate the line wrap)',
  );
});

test('BUILD addendum carries the 4-incident hard cap + recognition ladder ≤3', () => {
  // Guest, Namey & Chen 2020 base+run+threshold saturation rule.
  // Cowan 2001 + Iyengar & Lepper 2000 on choice overload.
  const prompt = assembleSystemPrompt(ctx({ mode: 'BUILD' }));
  // Substrings split across the 70-char wrap; assert each half.
  assert.ok(
    prompt.includes('Hard cap at four') && prompt.includes('incidents per slot'),
    'four-incident saturation cap present',
  );
  // "offer at\n  most 3 corpus-derived options" wraps; assert both sides.
  assert.ok(
    prompt.includes('3 corpus-derived options'),
    'recognition ladder ≤3 present',
  );
});

test('BUILD addendum yes/no question stem ban', () => {
  // Loftus & Palmer 1974 + Fisher & Geiselman 1992 cognitive
  // interview. open_question discipline forbids yes/no stems.
  // The addendum enumerates the banned stems explicitly across two
  // wrapped lines; assert each half so the test tolerates the wrap.
  const prompt = assembleSystemPrompt(ctx({ mode: 'BUILD' }));
  assert.ok(
    prompt.includes('Do you / Does the'),
    'first banned stems enumerated',
  );
  assert.ok(
    prompt.includes('Will you / Would you'),
    'second banned stems enumerated',
  );
});

test('terminal recap is mode-selected: TUNE rule 2 is NO_FIX, BUILD rule 2 is default-mark', () => {
  const tune = assembleSystemPrompt(ctx({ mode: 'TUNE' }));
  const build = assembleSystemPrompt(ctx({ mode: 'BUILD' }));
  // Sprint 060-A follow-up: redundant sentence removed; the rule
  // now reads "When evidence is absent, supply NO_FIX and explain
  // what evidence would change the classification."
  assert.ok(tune.includes('When evidence is absent, supply NO_FIX'), 'TUNE recap rule 2');
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
  assert.ok(
    !suffix.includes('<active_directives>'),
    'active_directives must not render when there are no constraint-shaped keys'
  );
});

test('2026-05-04: constraint-shaped preference keys render in <active_directives> with full values', () => {
  // The 280-char per-row summary in <memory_snapshot> is right for browsing
  // the catalogue but wrong for load-bearing rules. Keys whose name encodes
  // a directive (no-*, never-*, always-*, do-not-*, skip-*, prefer-*,
  // use-*, require-*) get a dedicated full-value block above the
  // snapshot. Failure mode this catches: "preferences/no-sop-for-screening"
  // had its rule body clipped past "Screening workflow gaps map to
  // SYSTEM_PROMPT" and the agent kept proposing SOPs for screening.
  const longRule =
    'Screening workflow gaps map to SYSTEM_PROMPT on the screening variant, ' +
    'not SOP. The screening rules live in TenantAiConfig.systemPromptScreening; ' +
    "do NOT propose a new SOP for screening-related edits. Edit the system " +
    'prompt instead, or classify NO_FIX if the wording is operator preference.';
  const suffix = buildDynamicSuffix(
    ctx({
      memorySnapshot: [
        {
          key: 'preferences/no-sop-for-screening',
          value: longRule,
          source: 'manager-rule-2026-05-03',
          updatedAt: '2026-05-03T00:00:00Z',
        },
        {
          key: 'preferences/tone',
          value: 'concise',
          source: null,
          updatedAt: '2026-04-15T00:00:00Z',
        },
      ],
    })
  );
  assert.ok(
    suffix.includes('<active_directives>'),
    'active_directives block must render when a directive-shaped key exists'
  );
  assert.ok(suffix.includes('preferences/no-sop-for-screening'));
  // Full rule body present — not clipped at 280 chars like the catalogue summary
  assert.ok(
    suffix.includes('do NOT propose a new SOP for screening-related edits'),
    'active_directives must render full value text, not the 280-char summary'
  );
  // Block ordering: active_directives must precede memory_snapshot
  assert.ok(
    suffix.indexOf('<active_directives>') < suffix.indexOf('<memory_snapshot>'),
    'active_directives must render before memory_snapshot in Region C'
  );
  // Non-directive keys do NOT get rendered in active_directives — they
  // still appear in the snapshot
  const directivesBlock = suffix.slice(
    suffix.indexOf('<active_directives>'),
    suffix.indexOf('</active_directives>')
  );
  assert.ok(
    !directivesBlock.includes('preferences/tone'),
    'non-directive keys (preferences/tone) must not appear in active_directives'
  );
});

test('2026-05-04: memory snapshot loads keys from preferences/, facts/, decisions/ namespaces', () => {
  // listMemoryForSnapshot now loads all three namespaces. The renderer is
  // namespace-agnostic — anything passed in shows up in the snapshot. This
  // test is the contract from the renderer's side: a facts/ key passed in
  // is preserved verbatim in the rendered output.
  const suffix = buildDynamicSuffix(
    ctx({
      memorySnapshot: [
        {
          key: 'facts/screening-rules-in-system-prompt',
          value: 'Screening logic lives in systemPromptScreening, not SOPs.',
          source: null,
          updatedAt: '2026-05-03T00:00:00Z',
        },
        {
          key: 'decisions/2026-05-03-no-sop-for-gender-screening',
          value: 'Confirmed with manager: do not author a Screening SOP.',
          source: null,
          updatedAt: '2026-05-03T00:00:00Z',
        },
      ],
    })
  );
  assert.ok(suffix.includes('facts/screening-rules-in-system-prompt'));
  assert.ok(suffix.includes('decisions/2026-05-03-no-sop-for-gender-screening'));
});

test('2026-05-04: <memory_use> block names both active_directives and memory_snapshot', () => {
  // The TUNE contract's memory_use sub-block must reference the new
  // active_directives block so the agent knows where directives live vs.
  // where the catalogue lives. If a future refactor drops the
  // active_directives block, this assertion catches the orphan reference.
  const tune = assembleSystemPrompt(ctx({ mode: 'TUNE' }));
  assert.ok(tune.includes('<active_directives>'));
  assert.ok(tune.includes('<memory_snapshot>'));
  // Region A reference (in <memory_use>) — narrow check: both names appear
  // in the same block. Use a window around <memory_use> to scope.
  const muStart = tune.indexOf('<memory_use>');
  const muEnd = tune.indexOf('</memory_use>');
  assert.ok(muStart >= 0 && muEnd > muStart, '<memory_use> block must exist');
  const muBody = tune.slice(muStart, muEnd);
  assert.ok(muBody.includes('active_directives'));
  assert.ok(muBody.includes('memory_snapshot'));
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

test('060-C: <verification_ritual> block is fully retired (replaced by <state_machine> + tool description)', async () => {
  // The block was removed in sprint 060-C. Its rules absorbed into:
  //  - <state_machine> in Region A (allowed tools per state, transition
  //    discipline, the 3-distinct-triggers ceiling).
  //  - studio_test_pipeline's tool description (unchanged from 054-A;
  //    already had the direct/implicit/framed guidance).
  //  - TEST_RITUAL_EXHAUSTED hook (unchanged; ritual window IS now the
  //    verifying state).
  // VERIFICATION_RITUAL_VERSION constant in lib/ritual-state.ts stays
  // (the per-write ritual-state mechanism still tracks which write
  // opened a verifying ritual window).
  const build = assembleSystemPrompt(ctx({ mode: 'BUILD' }));
  const tune = assembleSystemPrompt(ctx({ mode: 'TUNE' }));
  assert.equal(build.includes('<verification_ritual'), false, 'BUILD addendum must not carry the retired verification_ritual block');
  assert.equal(tune.includes('<verification_ritual'), false, 'TUNE addendum must not carry the verification_ritual block either');
  // The semantics it taught now live in <state_machine>:
  assert.ok(build.includes('<state_machine>'), 'state_machine block lives in Region A');
  assert.ok(build.includes('verifying'), 'verifying state described in state_machine');
  assert.ok(build.includes('CEILING, not a floor'), 'three-trigger ceiling rule preserved in state_machine');
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

// ─── Feature 047 PR 4 — read budget + speculative-reads + disabled-artifacts ─

test('047 PR4: <read_budget> block names per-state caps in TUNE and BUILD', () => {
  for (const mode of ['TUNE', 'BUILD'] as const) {
    const prompt = assembleSystemPrompt(ctx({ mode }));
    assert.ok(prompt.includes('<read_budget>'), `${mode}: <read_budget> block must render`);
    assert.ok(prompt.includes('scoping  — up to 4'), `${mode}: scoping cap=4 must be named`);
    assert.ok(prompt.includes('drafting — up to 2'), `${mode}: drafting cap=2 must be named`);
    assert.ok(prompt.includes('verifying — 1'), `${mode}: verifying cap=1 must be named`);
  }
});

test('047 PR4: <no_speculative_reads> block in TUNE addendum (not in BUILD)', () => {
  const tune = assembleSystemPrompt(ctx({ mode: 'TUNE' }));
  const build = assembleSystemPrompt(ctx({ mode: 'BUILD' }));
  assert.ok(tune.includes('<no_speculative_reads>'));
  assert.ok(!build.includes('<no_speculative_reads>'));
});

test('047 PR4: <disabled_artifacts> block in TUNE addendum names the rule', () => {
  const tune = assembleSystemPrompt(ctx({ mode: 'TUNE' }));
  assert.ok(tune.includes('<disabled_artifacts>'));
  assert.ok(tune.includes("status:'disabled'"));
  assert.ok(tune.includes('Do NOT call studio_get_artifact on a disabled SOP'));
});

// ─── Feature 047 PR 7 — conversation_anchor Region C block ──────────────

test('047 PR7: <conversation_anchor> renders when ctx provides anchor data', () => {
  const suffix = buildDynamicSuffix(
    ctx({
      conversationAnchor: {
        text: 'Thanks for getting back to us — could you confirm your check-in time?',
        role: 'AI',
        lastEditSummary: 'SYSTEM_PROMPT:rejection-gender-mention — operator removed gender language.',
      },
    })
  );
  assert.ok(suffix.includes('<conversation_anchor>'));
  assert.ok(suffix.includes('confirm your check-in time'));
  assert.ok(suffix.includes('Last edit applied:'));
  assert.ok(suffix.includes('rejection-gender-mention'));
});

test('047 PR7: <conversation_anchor> omitted when ctx.conversationAnchor is null', () => {
  const suffix = buildDynamicSuffix(ctx({ conversationAnchor: null }));
  assert.ok(!suffix.includes('<conversation_anchor>'));
});

test('047 PR7: <conversation_anchor> handles missing lastEditSummary with friendly default', () => {
  const suffix = buildDynamicSuffix(
    ctx({
      conversationAnchor: {
        text: 'Hi there!',
        role: 'GUEST',
        lastEditSummary: null,
      },
    })
  );
  assert.ok(suffix.includes('<conversation_anchor>'));
  assert.ok(suffix.includes('No prior edits applied in this session.'));
});

test('047 PR7: <conversation_anchor> truncates long anchor text at 800 chars with ellipsis', () => {
  const longText = 'x'.repeat(2000);
  const suffix = buildDynamicSuffix(
    ctx({
      conversationAnchor: {
        text: longText,
        role: 'GUEST',
        lastEditSummary: null,
      },
    })
  );
  // Should contain the head excerpt but not the full 2K
  assert.ok(suffix.includes('x'.repeat(800)));
  assert.ok(!suffix.includes('x'.repeat(801)));
  assert.ok(suffix.includes('…'));
});
