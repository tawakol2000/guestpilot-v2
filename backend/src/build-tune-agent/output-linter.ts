/**
 * Output linter (sprint 046 Session A).
 *
 * A cheap post-turn pass over the agent's output. Flags turns that
 * violate the Response Contract in the system-prompt. Log-only in this
 * session — session D flips the drop-not-log switch after we have a
 * week of trace data to calibrate against.
 *
 * Rules (plan §5.5 + session-a §2.6):
 *   - R1: zero structured data-parts AND final text > 120 words.
 *   - R2: more than one `data-suggested-fix` emitted in the turn.
 *   - R3: >2 lines of markdown-list syntax (`^\s*[-*]\s` or `^\s*\d+\.\s`)
 *         in any text part.
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
