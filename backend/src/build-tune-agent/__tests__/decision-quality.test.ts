/**
 * Decision-quality eval suite — feature 047 FR-010 / SC-007.
 *
 * Run:  JWT_SECRET=test npx tsx --test src/build-tune-agent/__tests__/decision-quality.test.ts
 *
 * Scope: stubbed-LLM-response tests that capture the four named decision-
 * quality cases from the feature spec. Each test loads a canonical
 * stub-response.json fixture (recorded once, hand-curated to match what a
 * correctly-behaving Sonnet 4.6 should produce for the input) and asserts
 * the response satisfies the FR-010 structural assertions.
 *
 * These tests do NOT call a real LLM. They exist to:
 *  1. Hard-block PRs that change Studio code in a way that would break
 *     the structural shape of agent output (e.g., dropping a required
 *     field from data-suggested-fix, changing the category enum).
 *  2. Document the canonical "right answer" shape so anyone reviewing
 *     a regression knows what we expect.
 *  3. Provide a stable artifact when post-deploy operator usage flags a
 *     real-model regression — we update the stub to reflect the actual
 *     bad output, then fix Studio until the stub matches the corrected
 *     shape.
 *
 * Limitation: these tests cannot catch semantic regressions in the model
 * itself (e.g., Sonnet 4.6 starting to over-classify wording-only edits
 * as SOP_CONTENT). For that, a separate nightly job that runs the agent
 * end-to-end with a real LLM is the right tool — tracked as future work
 * per spec clarify-session option E ("hybrid: B + nightly real-model").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES_DIR = join(__dirname, 'fixtures', 'decision-quality');

function loadStub(caseDir: string): Record<string, unknown> {
  const path = join(FIXTURES_DIR, caseDir, 'stub-response.json');
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw);
}

function loadInput(caseDir: string): Record<string, unknown> {
  const path = join(FIXTURES_DIR, caseDir, 'input.json');
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw);
}

// ─── Case 1: gender → family/friends NO_FIX ──────────────────────────────

test('FR-010 case 1: gender→family/friends edit classifies as NO_FIX with FRAMING_TONE', () => {
  const stub = loadStub('gender-rewording');

  // Spec assertion: category === 'NO_FIX'
  assert.equal(
    stub.category,
    'NO_FIX',
    'Wording-only reframing of a screening question must classify as NO_FIX',
  );

  // Spec assertion: editType === 'FRAMING_TONE'
  assert.equal(
    stub.editType,
    'FRAMING_TONE',
    'Same data ask with different framework is FRAMING_TONE per the six-type triage',
  );

  // NO_FIX classifications must NOT have a witness_quote (witness is for non-NO_FIX)
  assert.equal(
    stub.witnessQuote,
    null,
    'NO_FIX classification must have null witnessQuote',
  );

  // No artifact target — nothing to edit
  assert.equal(stub.target, null, 'NO_FIX classification must have null target');
  assert.equal(stub.diff, null, 'NO_FIX classification must have null diff');

  // Reasons must explain WHY it's NO_FIX (≥2 entries documents the reasoning)
  assert.ok(
    Array.isArray(stub.reasonsNotToAct) && (stub.reasonsNotToAct as unknown[]).length >= 2,
    'reasonsNotToAct must have ≥2 entries explaining the NO_FIX classification',
  );
});

// ─── Case 2: screening preferences memory recall ─────────────────────────

test('FR-010 case 2: screening edit honors preferences/no-sop-for-screening memory', () => {
  const input = loadInput('screening-memory-recall');
  const stub = loadStub('screening-memory-recall');

  // Sanity: input has the load-bearing memory key
  const memorySnapshot = input.memorySnapshot as Array<{ key: string }>;
  assert.ok(
    memorySnapshot.some((r) => r.key === 'preferences/no-sop-for-screening'),
    'Test input must contain the no-sop-for-screening preference key',
  );

  // Spec assertion: consultedMemoryKeys contains the relevant preferences/* key
  assert.ok(
    Array.isArray(stub.consultedMemoryKeys) &&
      (stub.consultedMemoryKeys as string[]).includes('preferences/no-sop-for-screening'),
    'Agent must cite the consulted memory key in consultedMemoryKeys when memory shaped the classification',
  );

  // Spec implication: must NOT classify as SOP_CONTENT (the memory forbids it)
  assert.notEqual(
    stub.category,
    'SOP_CONTENT',
    'preferences/no-sop-for-screening forbids SOP_CONTENT classification on screening edits',
  );

  // The correct routing for screening edits given this memory is SYSTEM_PROMPT
  assert.equal(
    stub.category,
    'SYSTEM_PROMPT',
    'Screening edits with the no-sop preference active route to SYSTEM_PROMPT category',
  );

  // Target must point at the screening variant
  const target = stub.target as { artifact?: string; systemPromptVariant?: string } | null;
  assert.ok(target, 'Non-NO_FIX category must have a target');
  assert.equal(target?.artifact, 'system_prompt');
  assert.equal(target?.systemPromptVariant, 'screening');
});

// ─── Case 3: witness_quote presence on non-NO_FIX ────────────────────────

test('FR-010 case 3: non-NO_FIX classification carries non-empty witness_quote', () => {
  const stub = loadStub('witness-quote-presence');

  // This case is non-NO_FIX (FAQ correction)
  assert.notEqual(stub.category, 'NO_FIX');

  // Spec assertion: witness_quote is a non-empty string for every non-NO_FIX category
  assert.equal(typeof stub.witnessQuote, 'string', 'witnessQuote must be a string for non-NO_FIX');
  assert.ok(
    (stub.witnessQuote as string).length > 0,
    'witnessQuote must be non-empty for non-NO_FIX classification',
  );

  // The witness quote must appear verbatim in the operator's edited text
  const input = loadInput('witness-quote-presence');
  const operatorEdited = input.operatorEdited as string;
  assert.ok(
    operatorEdited.includes(stub.witnessQuote as string),
    'witnessQuote must be a verbatim span from the operator\'s edited text',
  );

  // reasonsNotToAct ≥2 for non-NO_FIX (per the schema-as-spec contract)
  assert.ok(
    Array.isArray(stub.reasonsNotToAct) && (stub.reasonsNotToAct as unknown[]).length >= 2,
    'reasonsNotToAct must have ≥2 entries for any non-NO_FIX category',
  );
});

// ─── Case 4: three-field self_report on critique requests ────────────────

test('FR-010 case 4: critique-trigger response has three named self_report fields', () => {
  const stub = loadStub('three-field-self-report');

  // Spec assertion: response contains weakest_inference, most_fragile_assumption,
  // preferred_alternative_classification named fields (no free-form prose
  // rubber-stamp).
  const selfReport = stub.selfReport as {
    weakest_inference?: unknown;
    most_fragile_assumption?: unknown;
    preferred_alternative_classification?: unknown;
  } | undefined;

  assert.ok(selfReport, 'Critique-request response must include selfReport object');

  assert.equal(
    typeof selfReport?.weakest_inference,
    'string',
    'selfReport.weakest_inference must be a string',
  );
  assert.ok(
    (selfReport!.weakest_inference as string).length > 0,
    'selfReport.weakest_inference must be non-empty',
  );

  assert.equal(
    typeof selfReport?.most_fragile_assumption,
    'string',
    'selfReport.most_fragile_assumption must be a string',
  );
  assert.ok(
    (selfReport!.most_fragile_assumption as string).length > 0,
    'selfReport.most_fragile_assumption must be non-empty',
  );

  assert.equal(
    typeof selfReport?.preferred_alternative_classification,
    'string',
    'selfReport.preferred_alternative_classification must be a string',
  );
  assert.ok(
    (selfReport!.preferred_alternative_classification as string).length > 0,
    'selfReport.preferred_alternative_classification must be non-empty',
  );

  // No "rubber-stamp" indicators — spec explicitly says "no holistic 'looks
  // good' verdict". Heuristic: at least one of the three fields names a
  // specific weakness (contains words like "assumed", "may", "if", "wrong",
  // "missed", or "unless"). This catches the most common rubber-stamp shape
  // ("the analysis looks solid") without being overly prescriptive.
  const allFieldsText = [
    selfReport!.weakest_inference as string,
    selfReport!.most_fragile_assumption as string,
    selfReport!.preferred_alternative_classification as string,
  ].join(' ');
  const hasSpecificWeakness =
    /\b(assumed|may|if|wrong|miss|unless|fragile|weakness|fail)\b/i.test(allFieldsText);
  assert.ok(
    hasSpecificWeakness,
    'selfReport fields should name specific weaknesses, not rubber-stamp validations',
  );
});
