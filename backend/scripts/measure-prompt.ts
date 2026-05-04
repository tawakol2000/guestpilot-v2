// One-shot measurement of assembled-prompt sizes. Not part of the
// build; run via `npx tsx scripts/measure-prompt.ts` from backend/.
// Approximate token count = ceil(chars / 3.6) — Anthropic Sonnet-class
// tokenizers average ~3.5–3.8 chars per token on English. Real
// tokenizer counts will differ by a few percent.
import {
  assembleSystemPrompt,
  buildSharedPrefix,
  buildDynamicSuffix,
} from '../src/build-tune-agent/system-prompt';

const baseCtx = {
  tenantId: 't',
  conversationId: 'c',
  anchorMessageId: null,
  selectedSuggestionId: null,
  memorySnapshot: [],
  pending: { total: 0, countsByCategory: {}, topThree: [] },
  tenantState: null,
  interviewProgress: null,
  stateMachineSnapshot: null,
} as any;

// 2026-05-04 — also measure Region C (the dynamic, uncached portion) at
// realistic loads so we can see what's driving the uncached-token tail in
// the Anthropic console. Region A+B is locked behind cache_control; Region
// C ships fresh every turn AND is paid at full $3/M Sonnet input rate
// every internal messages.create round inside an SDK query.
const MID_CTX = {
  ...baseCtx,
  memorySnapshot: Array.from({ length: 12 }, (_, i) => ({
    key: `preferences/sample-${i}`,
    value: 'A typical preference value of moderate length, perhaps mentioning a specific behaviour the agent should follow consistently across turns.',
    source: null,
    updatedAt: '2026-05-04T00:00:00Z',
  })),
  pending: {
    total: 5,
    countsByCategory: { SOP_CONTENT: 3, FAQ: 2 },
    topThree: Array.from({ length: 3 }, (_, i) => ({
      id: `s${i}`,
      diagnosticCategory: 'SOP_CONTENT',
      diagnosticSubLabel: `sample-${i}`,
      confidence: 0.8,
      rationale: 'A medium-length rationale explaining why this fix is being proposed and what the underlying gap is.',
      createdAt: '2026-05-04T00:00:00Z',
    })),
  },
  tenantState: {
    posture: 'BROWNFIELD' as const,
    lastBuildSessionAt: '2026-05-04T00:00:00Z',
    systemPromptStatus: 'CUSTOMISED' as const,
    sopCount: 21,
    faqCount: 14,
    customToolCount: 3,
    propertyCount: 20,
  },
  interviewProgress: {
    filledSlots: ['property_type', 'check_in_time', 'check_out_time'].map((k) => ({
      key: k,
      value: 'A confirmed slot value',
      isDefault: false,
    })),
    pendingSlots: ['screening_rules', 'late_checkout_policy'],
    defaultedSlots: [],
    loadBearingFilled: 3,
    loadBearingTotal: 6,
    nonLoadBearingFilled: 0,
    nonLoadBearingTotal: 14,
  },
  stateMachineSnapshot: {
    inner_state: 'drafting' as const,
    outer_mode: 'TUNE' as const,
    transition_ack_pending: false,
    last_transition_at: null,
    last_transition_reason: null,
    pending_transition: null,
  },
} as any;

const TOKEN_DIV = 3.6;
const tk = (s: string) => Math.ceil(s.length / TOKEN_DIV);

const shared = buildSharedPrefix();
const tunePrompt = assembleSystemPrompt({ ...baseCtx, mode: 'TUNE' });
const buildPrompt = assembleSystemPrompt({ ...baseCtx, mode: 'BUILD' });

const tuneAddendumStart = tunePrompt.indexOf('<tune_mode>');
const tuneAddendumEnd = tunePrompt.indexOf('</tune_mode>') + '</tune_mode>'.length;
const buildAddendumStart = buildPrompt.indexOf('<build_mode>');
const buildAddendumEnd = buildPrompt.indexOf('</build_mode>') + '</build_mode>'.length;

const tuneAddendum = tunePrompt.slice(tuneAddendumStart, tuneAddendumEnd);
const buildAddendum = buildPrompt.slice(buildAddendumStart, buildAddendumEnd);

const fmt = (label: string, s: string) =>
  `${label.padEnd(30)} ${String(s.length).padStart(7)} chars  ${String(tk(s)).padStart(6)} tokens`;

console.log(fmt('Region A (shared):', shared));
console.log(fmt('TUNE addendum (Region B):', tuneAddendum));
console.log(fmt('BUILD addendum (Region B):', buildAddendum));
console.log(fmt('TUNE full assembled:', tunePrompt));
console.log(fmt('BUILD full assembled:', buildPrompt));

console.log('\n─── Region C (dynamic, UNCACHED — paid every round) ──────────');
const tuneCEmpty = buildDynamicSuffix({ ...baseCtx, mode: 'TUNE' });
const tuneCMid = buildDynamicSuffix({ ...MID_CTX, mode: 'TUNE' });
const buildCEmpty = buildDynamicSuffix({ ...baseCtx, mode: 'BUILD' });
const buildCMid = buildDynamicSuffix({ ...MID_CTX, mode: 'BUILD' });
console.log(fmt('TUNE Region C (empty):', tuneCEmpty));
console.log(fmt('TUNE Region C (typical):', tuneCMid));
console.log(fmt('BUILD Region C (empty):', buildCEmpty));
console.log(fmt('BUILD Region C (typical):', buildCMid));

console.log('\n─── Per-round cost @ $3/M Sonnet input (Region C only) ───────');
const costPerRound = (s: string) => `$${((tk(s) * 3) / 1_000_000).toFixed(5)}`;
console.log(`  TUNE  empty=${costPerRound(tuneCEmpty)}  typical=${costPerRound(tuneCMid)}`);
console.log(`  BUILD empty=${costPerRound(buildCEmpty)}  typical=${costPerRound(buildCMid)}`);
console.log('\n  At 5 rounds/turn × 1 turn:  ' + `tune=$${(tk(tuneCMid) * 5 * 3 / 1_000_000).toFixed(4)}  build=$${(tk(buildCMid) * 5 * 3 / 1_000_000).toFixed(4)}`);
console.log('  At 5 rounds × 20 turns/day: ' + `tune=$${(tk(tuneCMid) * 5 * 20 * 3 / 1_000_000).toFixed(2)}  build=$${(tk(buildCMid) * 5 * 20 * 3 / 1_000_000).toFixed(2)}`);

console.log('\n─── Top Region C blocks (TUNE typical) ───────────────────────');
const blocks = [
  ['<active_directives>', '</active_directives>'],
  ['<memory_snapshot>', '</memory_snapshot>'],
  ['<current_state>', '</current_state>'],
  ['<state_transition>', '</state_transition>'],
  ['<tenant_state>', '</tenant_state>'],
  ['<pending_suggestions>', '</pending_suggestions>'],
  ['<interview_progress>', '</interview_progress>'],
  ['<session_state>', '</session_state>'],
  ['<terminal_recap>', '</terminal_recap>'],
];
for (const [open, close] of blocks) {
  const start = tuneCMid.indexOf(open);
  if (start < 0) continue;
  const end = tuneCMid.indexOf(close, start);
  if (end < 0) continue;
  const slice = tuneCMid.slice(start, end + close.length);
  console.log(`  ${String(slice.length).padStart(6)} chars  ${String(tk(slice)).padStart(5)} tok  ${open}`);
}
