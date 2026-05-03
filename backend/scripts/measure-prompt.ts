// One-shot measurement of assembled-prompt sizes. Not part of the
// build; run via `npx tsx scripts/measure-prompt.ts` from backend/.
// Approximate token count = ceil(chars / 3.6) — Anthropic Sonnet-class
// tokenizers average ~3.5–3.8 chars per token on English. Real
// tokenizer counts will differ by a few percent.
import {
  assembleSystemPrompt,
  buildSharedPrefix,
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
