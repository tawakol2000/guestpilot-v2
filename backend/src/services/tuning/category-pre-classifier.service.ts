/**
 * Category pre-classifier (2026-05-17).
 *
 * Cheap (gpt-5-nano) front gate that runs BEFORE the expensive gpt-5.4 k=3
 * full diagnostic in `diagnostic.service.ts`. Looks at just the (original AI
 * draft, manager's edited text, similarity score) and decides whether the
 * edit is worth a full diagnostic at all, and if so, which broad category
 * it belongs to.
 *
 * Why: the full diagnostic burns ~$0.21 + ~120s per fire. A large share of
 * shadow-preview / copilot edits are pure wording polish that the full
 * diagnostic would also classify as NO_FIX — but only after spending the
 * compute. This classifier short-circuits those.
 *
 * Output taxonomy is intentionally coarser than the 8-category diagnostic
 * taxonomy — we only need enough resolution to (a) gate NO_FIX edits and
 * (b) probe the per-category cooldown:
 *
 *   - SYSTEM_PROMPT  → maps to diagnostic SYSTEM_PROMPT
 *   - SOP            → maps to diagnostic SOP_CONTENT / SOP_ROUTING / PROPERTY_OVERRIDE
 *   - FAQ            → maps to diagnostic FAQ
 *   - NO_FIX         → skip diagnostic entirely
 *
 * The classifier is NOT authoritative — when it predicts SOP/FAQ/SYSTEM_PROMPT,
 * we still run the full diagnostic (the cheap model can't pick the exact
 * variant or compose proposed text). The only short-circuit cases are:
 *   1. NO_FIX with high confidence  → skip
 *   2. predicted category already had a recent ACCEPTED suggestion within
 *      48h → skip (the full diagnostic's 48h cooldown would drop it anyway)
 *
 * Degrades silently on missing OPENAI_API_KEY / OpenAI error / parse error
 * per CLAUDE.md critical rule #2: returns null and the caller falls through
 * to the existing diagnostic path.
 */
import OpenAI from 'openai';
import type { TuningDiagnosticCategory } from '@prisma/client';

export type PreClassifierCategory = 'SYSTEM_PROMPT' | 'SOP' | 'FAQ' | 'NO_FIX';

export interface PreClassifierInput {
  originalText: string;
  editedText: string;
  /** semanticSimilarity() output, 0..1. Passed through to the prompt as context. */
  similarity: number;
  /** Optional context hints — narrow the model's guess without forcing it. */
  reservationStatus?: string | null;
  channel?: string | null;
}

export interface PreClassifierResult {
  category: PreClassifierCategory;
  confidence: number;
  rationale: string;
  modelUsed: string;
  latencyMs: number;
}

// ─── Category mapping for cooldown probe scoping ────────────────────────────

/**
 * Expand a coarse pre-classifier category into the set of full
 * TuningDiagnosticCategory values the cooldown probe should scan. SOP is the
 * widest — manager edits about "policy" content can land in any of the three
 * SOP-shaped categories depending on what the full diagnostic decides.
 */
export function expandToFullCategories(
  c: PreClassifierCategory,
): TuningDiagnosticCategory[] {
  switch (c) {
    case 'SYSTEM_PROMPT':
      return ['SYSTEM_PROMPT'];
    case 'SOP':
      return ['SOP_CONTENT', 'SOP_ROUTING', 'PROPERTY_OVERRIDE'];
    case 'FAQ':
      return ['FAQ'];
    case 'NO_FIX':
      return [];
  }
}

// ─── OpenAI client (lazy) ───────────────────────────────────────────────────

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI | null {
  if (_openai) return _openai;
  if (!process.env.OPENAI_API_KEY) return null;
  _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

// 2026-05-17: bumped from gpt-5-nano → gpt-5.4-mini after a live test on a
// borderline edit ("please confirm your nationality so I can check eligibility"
// → trim trailing clause) where nano mis-routed SYSTEM_PROMPT as SOP at 0.62
// confidence. Mini handles voice/style vs factual-change disambiguation
// reliably enough that the ~10× per-call cost (~$0.01 vs $0.001) is still
// trivial relative to the $0.21 full diagnostic it gates. Set
// TUNING_PRE_CLASSIFIER_MODEL=gpt-5-nano to roll back.
const DEFAULT_PRE_CLASSIFIER_MODEL = 'gpt-5.4-mini-2026-03-17';

function getClassifierModel(): string {
  return (process.env.TUNING_PRE_CLASSIFIER_MODEL || DEFAULT_PRE_CLASSIFIER_MODEL).trim();
}

// ─── Prompt + schema ────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `
You are a fast pre-classifier inside GuestPilot's tuning pipeline. A property
manager edited an AI-generated guest-reply draft before sending it. Your job
is to decide, in a single cheap pass, which broad fix-target the edit points
at — OR to declare it doesn't warrant a fix at all.

Output exactly one of four categories:

1. SYSTEM_PROMPT — Tone, voice, formality, channel-specific style,
   conversational habits, or reasoning/policy at the prompt level. The
   edit changes HOW the AI talks across many topics, not WHAT it says
   about one topic. **This is the right category whenever the edit
   removes explanatory/self-justifying clauses, hedges, sycophantic
   preambles, or "thinking out loud" without changing any factual claim.**
   ✓ Example: "Hi there! 😊 Looking forward..." → "Hello. Looking forward..."
     (tone shift, consistent with brand voice — pattern, not content.)
   ✓ Example: edit removes a sycophantic preamble the AI keeps adding.
   ✓ Example: "please confirm your nationality so I can check eligibility"
     → "please confirm your nationality" (the AI volunteered the *reason*
     it's asking; manager wants it to stop explaining why. No fact
     changed — same ask, less rationale. This is a voice/habit rule,
     not an SOP.)
   ✓ Example: "I'll need to check with my team and get back to you" →
     "I'll get back to you" (removed unnecessary process narration).

2. SOP — A factual or procedural error about a specific topic the SOPs
   cover (check-in time, parking, WiFi access policy, payment terms,
   cancellation, extending stay, etc.). The edit changes WHAT the AI said,
   not how it said it. **Required signal: a specific FACT changed — a
   number, time, price, address, code, name, eligibility rule, or
   procedure that a guest could read and act on differently.** If the
   only thing that changed is whether the AI explains itself, that is
   NOT SOP.
   ✓ Example: "checkout is 11am" → "checkout is 12pm".
   ✓ Example: "you can park anywhere" → "use spot 14, the gate code is XYZ".
   ✗ Counter (SYSTEM_PROMPT): manager trims "so I can verify" from
     "please send your passport so I can verify" — no fact about the
     verification process changed, just removed AI's self-narration.

3. FAQ — A factual detail the AI didn't know but that a guest will ask
   again (nearest pharmacy, local restaurants, what's on the rooftop, can
   I bring a pet, is there a high chair). NOT covered by an SOP.
   ✓ Example: AI: "I don't know about pharmacies." → manager: "The nearest
     pharmacy is on Main St, 200m walk."

4. NO_FIX — Cosmetic polish, one-off rewording, punctuation, typos,
   personal style preference that doesn't generalize, or a manager edit
   that just rephrased the same content. The full diagnostic would also
   abstain — skip the compute.
   ✓ Example: "your reservation" → "Your reservation" (capitalization).
   ✓ Example: AI: "Sure! I'll check on that and get back to you." →
     manager: "I'll look into this and reply shortly." (same content,
     different phrasing.)
   ✓ Example: a comma added, a sentence reordered, an emoji removed once.

DEFAULT: NO_FIX. Only commit to SYSTEM_PROMPT / SOP / FAQ when the edit
clearly changes a factual claim, procedural detail, or persistent stylistic
pattern. When in doubt, return NO_FIX with confidence ~0.6.

Confidence is your own 0..1 self-assessment. 0.9+ = definite, 0.7 = likely,
0.5 = guess. Keep the rationale to one short sentence — no preambles, no
hedging. The downstream diagnostic gets the full evidence bundle and can
override you; your job is to skip clear NO_FIX edits.
`.trim();

const PRE_CLASSIFIER_SCHEMA = {
  type: 'json_schema' as const,
  name: 'tuning_pre_classifier',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['SYSTEM_PROMPT', 'SOP', 'FAQ', 'NO_FIX'],
      },
      confidence: { type: 'number' },
      rationale: { type: 'string' },
    },
    required: ['category', 'confidence', 'rationale'],
    additionalProperties: false,
  },
} as const;

function buildUserMessage(input: PreClassifierInput): string {
  const ctxBits: string[] = [];
  if (input.reservationStatus) ctxBits.push(`reservation status: ${input.reservationStatus}`);
  if (input.channel) ctxBits.push(`channel: ${input.channel}`);
  ctxBits.push(`similarity: ${input.similarity.toFixed(2)}`);
  const ctx = ctxBits.join(' · ');

  return `Context: ${ctx}

AI original draft:
"""
${input.originalText}
"""

Manager's edited final text:
"""
${input.editedText}
"""

Classify the edit.`.trim();
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function classifyEditCategory(
  input: PreClassifierInput,
): Promise<PreClassifierResult | null> {
  const client = getOpenAI();
  if (!client) return null;

  const model = getClassifierModel();
  const started = Date.now();
  try {
    const resp = await client.responses.create({
      model,
      input: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserMessage(input) },
      ],
      text: { format: PRE_CLASSIFIER_SCHEMA, verbosity: 'low' } as any,
      reasoning: { effort: 'low' } as any,
      store: false,
      max_output_tokens: 400,
    } as any);

    const text = (resp as any).output_text ?? '';
    if (!text) return null;

    const parsed = JSON.parse(text) as {
      category: PreClassifierCategory;
      confidence: number;
      rationale: string;
    };

    return {
      category: parsed.category,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      rationale: parsed.rationale || '(no rationale)',
      modelUsed: model,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    console.warn(
      `[PreClassifier] classifier failed (model=${model}, ${Date.now() - started}ms) — falling through to full diagnostic.`,
      err,
    );
    return null;
  }
}
