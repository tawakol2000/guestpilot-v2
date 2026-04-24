/**
 * Sprint 045 Gate 3 — single-reply grader for the `test_pipeline` tool.
 *
 * Intentionally minimal: one Anthropic API call per judgement, no
 * retry ladder, no batch. Failures return a non-fatal score=0 with
 * rationale so the tool can surface the problem without throwing.
 *
 * Model choice: Sonnet 4.6 is cross-family to the GPT-5.4 pipeline
 * generator (Anthropic grading OpenAI), so the Zheng et al.
 * self-enhancement bias does not apply here. We still enforce the
 * general principle "judge ≠ generator" in code comments so future
 * contributors don't swap Sonnet for the pipeline's model without
 * thinking.
 *
 * The grading prompt is version-stamped as {@link JUDGE_PROMPT_VERSION}
 * and emitted with every result so later edits don't silently re-score
 * old runs. When editing the prompt body, bump the version string.
 *
 * The function name intentionally references `test-judge` (not
 * `judge-opus` or `judge-llm`) so future swaps of the underlying model
 * don't force a rename.
 */
import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'crypto';

export const JUDGE_MODEL = 'claude-sonnet-4-6';
// Bugfix (2026-04-23): was a hand-maintained string ("test-judge/v1 —
// 2026-04-19") that authors had to remember to bump when editing
// `JUDGE_SYSTEM`. Nothing enforced the bump — so silent judge drift
// became possible (old verdicts carrying stale version tags next to
// re-graded output). Derive the version from the first 10 chars of a
// SHA-256 over the canonical judge prompt + model id, computed at
// module load. Any edit to JUDGE_SYSTEM or JUDGE_MODEL advances the
// tag automatically. The `v1 — YYYY-MM-DD` human tag stays as a
// readable prefix so operators can eyeball the date when the prompt
// was last touched; the hash suffix makes the version unique per
// edit. `_HUMAN_TAG` should still be bumped by hand on intentional
// material edits so the date advances, but the hash alone is enough
// to detect drift.
const _JUDGE_SYSTEM_HUMAN_TAG = 'test-judge/v2 — 2026-04-24';

/**
 * Background action the pipeline planned, surfaced to the judge so it
 * can credit a short ack + manager hand-off as appropriate.
 *
 * 2026-04-24: added because variants 1 & 2 of the passport-verification
 * ritual were scoring 'missing-sop-reference' FAILS even though the
 * pipeline's structured output CORRECTLY set escalation = { title:
 * 'document_verification', urgency: 'info_request' }. The judge could
 * only see the prose reply ("Thanks for sending the passport.") and
 * had no way to know the SOP's escalation signal had fired. Judge now
 * gets the full picture.
 */
export interface JudgePipelineAction {
  escalation?: {
    title: string;
    note: string;
    urgency: 'immediate' | 'scheduled' | 'info_request';
  } | null;
  scheduledTime?: {
    kind: 'check_in' | 'check_out';
    time: string;
  } | null;
  resolveTaskId?: string | null;
  updateTaskId?: string | null;
}

export interface TestJudgeInput {
  /** Compact summary of the tenant's active SOPs / top FAQs / system-prompt excerpt. ≤ ~2K tokens. */
  tenantContext: string;
  /** The guest message that was put through the pipeline. */
  guestMessage: string;
  /** The AI reply the pipeline produced. */
  aiReply: string;
  /**
   * Structured non-reply actions the pipeline planned on this turn
   * (escalation to manager, scheduled-time hand-off, task
   * resolve/update). Optional for back-compat with callers that don't
   * yet thread the structured pipeline output through.
   */
  pipelineAction?: JudgePipelineAction;
}

export interface TestJudgeResult {
  /** 0..1 score. 0.7+ is "good enough for BUILD verification". */
  score: number;
  /** One-paragraph explanation of the score, referencing evidence from the tenant context. */
  rationale: string;
  /**
   * Short tag when score < 0.7. Examples:
   *   "missing-sop-reference" — the reply should have cited a specific SOP and didn't.
   *   "policy-violation" — the reply contradicts a known tenant policy.
   *   "channel-tone" — the reply's register is wrong for the stated channel.
   *   "hallucination" — the reply invented facts not in tenant context.
   *   "off-topic" — the reply didn't address the guest's question.
   * Absent when score ≥ 0.7.
   */
  failureCategory?: string;
  /** Version stamp of the prompt used. */
  promptVersion: string;
  /** Judge model id used. */
  judgeModel: string;
}

const JUDGE_SYSTEM = `You are a strict but fair judge grading one AI reply that a serviced-apartment tenant's AI chatbot produced for a guest message. Return a single JSON object with keys "score" (number 0..1), "rationale" (string, 1-3 sentences), and "failureCategory" (string or null).

You judge the WHOLE pipeline turn, not just the reply text. The turn has TWO parts:
  A) <ai_reply>          — what the guest sees.
  B) <pipeline_action>    — structured non-reply actions the pipeline planned (manager escalation, scheduled-time hand-off, task resolve/update). This is often how an SOP is satisfied WITHOUT spelling it out in prose.

Grading criteria (descending importance):

1. Did the turn — reply + action combined — address the guest's question/request?
2. Did the turn reflect the tenant's policies, SOPs, and FAQs shown? A turn that IGNORES a clearly-applicable SOP in BOTH the reply and the pipeline_action scores low (≤0.5). If the SOP prescribes "acknowledge and escalate", a short acknowledgement IS acceptable when <pipeline_action> contains a matching escalation (title/urgency) — do NOT penalise "missing-sop-reference" in that case. The SOP's obligation is met by the escalation, not by prose recitation.
3. Is the reply factually grounded in the tenant context? Penalise hallucinated details.
4. Is the tone appropriate for a short-term-rental hospitality conversation (friendly, concise, not overly formal)?
5. Does the reply avoid exposing access codes (door codes, wifi passwords) when the guest status implies INQUIRY?
6. If the guest sent a low-quality artefact (blurry image, unreadable document, cropped ID), the reply SHOULD ask for a clearer version. A generic "we'll take a look" on a blurry submission is a miss even when the escalation fires — the operational gap is real.

Scoring guide:
  0.9-1.0 — Turn (reply + action) is accurate, grounded, cites or routes to relevant policy, appropriate tone.
  0.7-0.89 — Turn is correct but shallow, slightly off-tone, or misses a minor detail. A short acknowledgement + correct escalation lands here by default.
  0.5-0.69 — Turn misses a clearly-applicable SOP/FAQ in BOTH reply and action, OR has a tone problem.
  0.3-0.49 — Reply contradicts tenant policy OR hallucinates material facts.
  0-0.29 — Turn is off-topic, unsafe, or entirely irrelevant.

When you assign a score below 0.7, set "failureCategory" to one of:
  "missing-sop-reference" | "policy-violation" | "channel-tone" | "hallucination" | "off-topic" | "safety" | "quality-gap"
(use "quality-gap" for criteria 6 — failed to request clearer input on a low-quality submission).
Otherwise set "failureCategory" to null.

Return ONLY the JSON object. No code fences, no prose prefix.`;

// Derived AFTER JUDGE_SYSTEM is declared so the hash covers the final
// prompt body. Any edit to the system text bumps the hash suffix and
// surfaces as a visible version change in the verdict history —
// operators can spot judge drift without re-reading the diff.
const _JUDGE_SYSTEM_HASH = createHash('sha256')
  .update(JUDGE_SYSTEM)
  .update('\x00')
  .update(JUDGE_MODEL)
  .digest('hex')
  .slice(0, 10);
export const JUDGE_PROMPT_VERSION = `${_JUDGE_SYSTEM_HUMAN_TAG} (${_JUDGE_SYSTEM_HASH})`;

/**
 * Shuffle an array deterministically-given-input by a simple seeded swap.
 * Used to randomise irrelevant detail order (per Zheng et al. position bias).
 * Deterministic seeding lets tests assert stability.
 */
function stableShuffle<T>(items: T[], seed: string): T[] {
  const arr = items.slice();
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  for (let i = arr.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 13), 1540483477);
    const j = Math.abs(h) % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Split the tenant-context on `\n\n` boundaries and shuffle the resulting
 * paragraphs. Reduces position-in-prompt bias without changing any of the
 * information the judge sees. Seeded by the guest message so the same
 * test message produces a reproducible order.
 */
export function shuffleTenantContext(tenantContext: string, seed: string): string {
  const paragraphs = tenantContext
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paragraphs.length <= 1) return tenantContext;
  return stableShuffle(paragraphs, seed).join('\n\n');
}

export interface TestJudgeOptions {
  /**
   * Inject a custom Anthropic client — used by unit tests to avoid hitting
   * the network. If omitted, we construct one via the ANTHROPIC_API_KEY env.
   */
  client?: Pick<Anthropic, 'messages'>;
}

export async function runTestJudge(
  input: TestJudgeInput,
  options?: TestJudgeOptions
): Promise<TestJudgeResult> {
  const client: Pick<Anthropic, 'messages'> = options?.client ?? new Anthropic();
  const shuffledContext = shuffleTenantContext(input.tenantContext, input.guestMessage);

  const actionBlock = formatPipelineAction(input.pipelineAction);
  const userPrompt = [
    '<tenant_context>',
    shuffledContext,
    '</tenant_context>',
    '',
    '<guest_message>',
    input.guestMessage,
    '</guest_message>',
    '',
    '<ai_reply>',
    input.aiReply,
    '</ai_reply>',
    '',
    '<pipeline_action>',
    actionBlock,
    '</pipeline_action>',
    '',
    'Grade the whole turn (reply + action) now. Return only the JSON object.',
  ].join('\n');

  // Bugfix (2026-04-23): no explicit timeout used to mean a hung
  // Anthropic connection would hang the judge call for the SDK
  // default (~60s+) while the test_pipeline SSE stream showed a
  // stuck spinner. Wrap in Promise.race with a 30s ceiling; the
  // timeout path falls through to the same catch branch as any
  // other judge failure, producing a score=0 + `judge-error`
  // verdict so the UI renders a visible failure row instead of
  // staying indefinitely pending.
  const JUDGE_TIMEOUT_MS = 30_000;
  try {
    const apiCall = client.messages.create({
      model: JUDGE_MODEL,
      max_tokens: 512,
      system: JUDGE_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const timer = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Judge call timed out after ${JUDGE_TIMEOUT_MS}ms`)),
        JUDGE_TIMEOUT_MS,
      ),
    );
    const resp = await Promise.race([apiCall, timer]);
    const text =
      resp.content
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('')
        .trim();
    const parsed = parseJudgeJson(text);
    return {
      score: clamp01(parsed.score),
      rationale: parsed.rationale.trim() || '(judge returned empty rationale)',
      failureCategory:
        parsed.score < 0.7 && parsed.failureCategory
          ? parsed.failureCategory
          : undefined,
      promptVersion: JUDGE_PROMPT_VERSION,
      judgeModel: JUDGE_MODEL,
    };
  } catch (err: any) {
    return {
      score: 0,
      rationale: `Judge call failed: ${err?.message ?? String(err)}`,
      failureCategory: 'judge-error',
      promptVersion: JUDGE_PROMPT_VERSION,
      judgeModel: JUDGE_MODEL,
    };
  }
}

/**
 * Render the structured action block for the judge prompt. Returns a
 * compact, deterministic string so the prompt-hash version stamp moves
 * only when the schema changes, not when action values change.
 */
export function formatPipelineAction(action: JudgePipelineAction | undefined): string {
  if (!action) return 'None provided (legacy caller — judge the reply alone).';
  const lines: string[] = [];
  if (action.escalation) {
    lines.push(
      `escalation: { title: "${action.escalation.title}", urgency: "${action.escalation.urgency}", note: ${JSON.stringify(action.escalation.note)} }`
    );
  } else {
    lines.push('escalation: null');
  }
  if (action.scheduledTime) {
    lines.push(
      `scheduledTime: { kind: "${action.scheduledTime.kind}", time: "${action.scheduledTime.time}" }`
    );
  }
  if (action.resolveTaskId) lines.push(`resolveTaskId: "${action.resolveTaskId}"`);
  if (action.updateTaskId) lines.push(`updateTaskId: "${action.updateTaskId}"`);
  return lines.join('\n');
}

function clamp01(n: unknown): number {
  const x = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

interface ParsedJudge {
  score: number;
  rationale: string;
  failureCategory?: string;
}

export function parseJudgeJson(raw: string): ParsedJudge {
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) {
    return { score: 0, rationale: `Judge output was not JSON: ${raw.slice(0, 200)}` };
  }
  try {
    const obj = JSON.parse(match[0]);
    return {
      score: typeof obj.score === 'number' ? obj.score : 0,
      rationale:
        typeof obj.rationale === 'string' ? obj.rationale : '(missing rationale)',
      failureCategory:
        typeof obj.failureCategory === 'string' && obj.failureCategory.length > 0
          ? obj.failureCategory
          : undefined,
    };
  } catch (err: any) {
    return {
      score: 0,
      rationale: `Judge output was invalid JSON: ${err?.message ?? String(err)}`,
    };
  }
}
