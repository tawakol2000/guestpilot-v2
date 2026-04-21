/**
 * Output linter (sprint 046 Sessions A + D).
 *
 * A cheap post-turn pass over the agent's output. Flags turns that
 * violate the Response Contract in the system-prompt.
 *
 * Rules (plan §5.5 + session-a §2.6):
 *   - R1: zero structured data-parts AND final text > 120 words.
 *   - R2: more than one `data-suggested-fix` emitted in the turn.
 *   - R3: >2 lines of markdown-list syntax (`^\s*[-*]\s` or `^\s*\d+\.\s`)
 *         in any text part.
 *
 * Session D enforcement (plan §5.5 + NEXT.md §2.4):
 *   - R1: emit a `data-advisory` (kind: 'linter-drop') with the prose
 *         word count hint. The original text is not retroactively
 *         truncated in the live stream; DB persistence keeps the full
 *         text so a rerun surfaces the lint hit plus original prose.
 *   - R2: extra `data-suggested-fix` emissions are intercepted at the
 *         emitDataPart boundary (runtime.ts) — only the first survives.
 *         A `data-advisory` documents the drop count.
 *   - R3: remains log-only. Too noisy for enforcement this session per
 *         plan §5.5 risk — revisit after a week of trace calibration.
 */

export type LinterSeverity = 'warn';

export interface LinterFinding {
  rule: 'R1' | 'R2' | 'R3';
  severity: LinterSeverity;
  message: string;
  detail?: Record<string, unknown>;
}

export interface LinterInput {
  /** Concatenated text emitted by the assistant (all text parts joined). */
  finalText: string;
  /** Type strings of every data-part emitted on this turn, in order. */
  dataPartTypes: string[];
}

/** Known "structured" data-part type strings. Keep this list narrow —
 *  transient advisories like `data-advisory` do NOT count as a structured
 *  artifact for the purposes of R1. */
const STRUCTURED_PART_TYPES = new Set<string>([
  'data-build-plan',
  'data-suggested-fix',
  'data-question-choices',
  'data-audit-report',
  'data-state-snapshot',
  'data-test-pipeline-result',
  // Pre-sprint-046 TUNE parts that already encode a structured card.
  'data-suggestion-preview',
  'data-faq-created',
  'data-sop-created',
  'data-tool-definition-created',
  'data-system-prompt-written',
]);

const SUGGESTED_FIX_TYPE = 'data-suggested-fix';

const MARKDOWN_BULLET_RE = /^\s*[-*]\s+\S/;
const MARKDOWN_ORDERED_RE = /^\s*\d+\.\s+\S/;

/** Rough word-count; not tokeniser-accurate, just used as a threshold cue. */
function wordCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Run the three rules and return every finding. Pure function — no I/O,
 * no side effects. Callers decide what to do with the findings (session
 * A writes them to BuildToolCallLog as synthetic __lint__ rows; session
 * D will drop or downgrade the offending output).
 */
export function lintAgentOutput(input: LinterInput): LinterFinding[] {
  const findings: LinterFinding[] = [];

  const structuredParts = input.dataPartTypes.filter((t) =>
    STRUCTURED_PART_TYPES.has(t)
  );
  const words = wordCount(input.finalText);

  if (structuredParts.length === 0 && words > 120) {
    findings.push({
      rule: 'R1',
      severity: 'warn',
      message:
        'Turn emitted no structured card and produced prose over 120 words. ' +
        'Response Contract rule 2 asks for a card-shaped payload instead.',
      detail: { words },
    });
  }

  const suggestedFixCount = input.dataPartTypes.filter((t) => t === SUGGESTED_FIX_TYPE).length;
  if (suggestedFixCount > 1) {
    findings.push({
      rule: 'R2',
      severity: 'warn',
      message:
        'Turn emitted multiple data-suggested-fix parts; Response Contract ' +
        'rule 3 requires surfacing only the top finding.',
      detail: { suggestedFixCount },
    });
  }

  const bulletLines: string[] = [];
  const orderedLines: string[] = [];
  for (const line of input.finalText.split('\n')) {
    if (MARKDOWN_BULLET_RE.test(line)) bulletLines.push(line);
    else if (MARKDOWN_ORDERED_RE.test(line)) orderedLines.push(line);
  }
  if (bulletLines.length > 2 || orderedLines.length > 2) {
    findings.push({
      rule: 'R3',
      severity: 'warn',
      message:
        'Turn contains a markdown-list with more than 2 items; Response ' +
        'Contract rule 3 bans enumerated recommendations.',
      detail: {
        bulletLineCount: bulletLines.length,
        orderedLineCount: orderedLines.length,
        sampleBullets: bulletLines.slice(0, 3),
        sampleOrdered: orderedLines.slice(0, 3),
      },
    });
  }

  return findings;
}

/** Stable, test-friendly synthetic tool name used when persisting lint rows. */
export const LINTER_SYNTHETIC_TOOL_NAME = '__lint__';

/**
 * Shape of an advisory payload the runtime should emit when a lint rule
 * fires. Caller decides when to write to the stream; this function is
 * pure and returns the advisories alongside the findings.
 *
 * Sprint 046 Session D — R1 and R2 enforcement. R3 stays log-only.
 */
export interface LinterAdvisoryPayload {
  kind: 'linter-drop';
  message: string;
  context?: Record<string, unknown>;
}

export interface EnforceOptions {
  /**
   * Number of `data-suggested-fix` parts the runtime actually delivered
   * to the persisted stream (i.e. after its own first-wins interception).
   * If the runtime intercepted, `findings` will still include R2 based on
   * the in-session emit attempts; this number tells `enforce` how many
   * were actually dropped so the advisory message is accurate.
   */
  droppedSuggestedFixCount?: number;
}

export function buildLinterAdvisories(
  findings: LinterFinding[],
  opts: EnforceOptions = {}
): LinterAdvisoryPayload[] {
  const advisories: LinterAdvisoryPayload[] = [];
  for (const f of findings) {
    if (f.rule === 'R1') {
      const words = (f.detail as any)?.words ?? '?';
      // Sprint 047 Session A — Path A: drop the inaccurate "card omitted"
      // phrasing. The linter does not truncate the prose, so claiming a
      // card was omitted was misleading. Describe what actually happened
      // and prompt the agent to rephrase next turn.
      advisories.push({
        kind: 'linter-drop',
        message:
          'Agent reply was long-form prose without a structured card. Asking for a card-shaped summary usually helps.',
        context: { rule: 'R1', words },
      });
    } else if (f.rule === 'R2') {
      const dropped = opts.droppedSuggestedFixCount ?? Math.max(
        0,
        (((f.detail as any)?.suggestedFixCount ?? 1) as number) - 1
      );
      advisories.push({
        kind: 'linter-drop',
        message: `Dropped ${dropped} additional suggested fix${dropped === 1 ? '' : 'es'} — surface the top one first.`,
        context: { rule: 'R2', dropped },
      });
    }
    // R3 stays log-only — no advisory this session.
  }
  return advisories;
}
