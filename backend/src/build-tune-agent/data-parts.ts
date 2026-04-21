/**
 * Structured SSE data-part contracts for the BUILD + TUNE agent
 * (sprint 046 Session B, plan §5.4).
 *
 * Data parts flow *around* the SDK → UIMessageChunk bridge in
 * `stream-bridge.ts`: tools emit them directly via the runtime's
 * `emitDataPart` sink, which writes to the Vercel AI SDK stream.
 * Because data parts never touch `bridgeSDKMessage`, the bridge needs
 * no additional switch cases. What *does* need to exist is a single
 * typed registry of the part contracts — so emitters and frontend
 * consumers agree on the payload shape. This module is that registry.
 *
 * The part-type string is the key the frontend uses to discriminate
 * in its `StandalonePart` renderer. Never rename without also updating
 * every `frontend/components/studio/*` consumer.
 *
 * Existing parts retained (Session A and earlier) — `data-build-plan`,
 * `data-test-pipeline-result`, `data-state-snapshot`,
 * `data-suggestion-preview` — keep their historical shapes; only the
 * four new parts added this session are defined below with full type
 * interfaces.
 */

/** Stable part-type keys. Shared between backend emitters and the frontend StandalonePart renderer. */
export const DATA_PART_TYPES = {
  suggested_fix: 'data-suggested-fix',
  question_choices: 'data-question-choices',
  audit_report: 'data-audit-report',
  advisory: 'data-advisory',
  state_snapshot: 'data-state-snapshot',
  build_plan: 'data-build-plan',
  test_pipeline_result: 'data-test-pipeline-result',
  /**
   * @deprecated Sprint 046 Session D — retired. Use `suggested_fix` instead.
   * Key retained for stream-bridge back-compat (an in-flight session on an
   * older deploy may still deliver this part type; the Studio renderer
   * returns null for it). No new emitter should reference this.
   */
  suggestion_preview: 'data-suggestion-preview',
  agent_disabled: 'data-agent-disabled',
  /**
   * Sprint 050 A1 — typographic-attribution artifact quote. Additive,
   * renderer-only this sprint: the Studio frontend knows how to show
   * these as monospace blocks with a left-rule + source chip, so the
   * emitter (a future `propose_suggestion` enhancement) can ship
   * independently whenever it lands.
   */
  artifact_quote: 'data-artifact-quote',
} as const;

export type DataPartType = (typeof DATA_PART_TYPES)[keyof typeof DATA_PART_TYPES];

// ─── New part contracts (sprint 046 Session B) ─────────────────────────

/**
 * Machine-readable target for a proposed edit. At least one field must
 * be present. Consumed by the suggested-fix card to render a chip and
 * by rollback / apply paths to locate the artifact.
 *
 * Sprint 047 Session A — extended with optional category-specific apply
 * hints (sopCategory/sopStatus/sopPropertyId/faqEntryId/systemPromptVariant)
 * so the Studio accept-on-preview path has everything it needs to
 * dispatch the write. These mirror the fields the legacy TUNE
 * `targetHint` shape carries; propose_suggestion populates them when
 * the hint is present. All additive; existing consumers ignore unknown
 * fields.
 */
export interface FixTarget {
  artifact?: 'system_prompt' | 'sop' | 'faq' | 'tool_definition' | 'property_override';
  artifactId?: string;
  sectionId?: string;
  slotKey?: string;
  lineRange?: [number, number];
  sopCategory?: string;
  sopStatus?: 'DEFAULT' | 'INQUIRY' | 'CONFIRMED' | 'CHECKED_IN';
  sopPropertyId?: string;
  faqEntryId?: string;
  systemPromptVariant?: 'coordinator' | 'screening';
}

export interface SuggestedFixData {
  /** Stable id for rejection-memory hashing (sprint 046 Session D). */
  id: string;
  target: FixTarget;
  /** The existing text the fix replaces. Empty string when creating net-new. */
  before: string;
  /** The proposed replacement text. */
  after: string;
  rationale: string;
  /** Free-form impact statement. e.g. "Closes the weekend-late-checkout gap". */
  impact?: string;
  /** Category pastel key — consumed by the frontend pill palette. */
  category?:
    | 'SOP_CONTENT'
    | 'SOP_ROUTING'
    | 'FAQ'
    | 'SYSTEM_PROMPT'
    | 'TOOL_CONFIG'
    | 'PROPERTY_OVERRIDE'
    | 'MISSING_CAPABILITY'
    | 'NO_FIX';
  /** ISO timestamp — set by the emitter, never by the agent input. */
  createdAt: string;
}

export interface QuestionChoiceOption {
  id: string;
  label: string;
  /** Exactly one option per payload should be flagged `recommended`. */
  recommended?: boolean;
}

export interface QuestionChoicesData {
  question: string;
  options: QuestionChoiceOption[];
  /** If true the frontend renders a "…or type something else" input row. */
  allowCustomInput: boolean;
}

export interface AuditReportRow {
  artifact: 'system_prompt' | 'sop' | 'faq' | 'tool_definition' | 'property';
  artifactId?: string;
  label: string;
  status: 'ok' | 'warn' | 'gap' | 'danger' | 'unknown';
  note: string;
  /** When set, the matching row gets a "Fix" primary CTA that scrolls to the paired suggested-fix card. */
  findingId?: string;
}

export interface AuditReportData {
  rows: AuditReportRow[];
  /** id of the row whose paired suggested_fix card the Fix CTA should jump to. */
  topFindingId: string | null;
  /** Free-form headline for the card — e.g. "3 gaps, 1 critical". */
  summary?: string;
}

export interface AdvisoryData {
  kind: 'recent-edit' | 'oscillation' | 'linter-drop' | 'rate-limit' | 'other';
  /** Short, muted one-liner — rendered above the paired card, never as a modal. */
  message: string;
  /** Optional structured context — recent-edit carries the prior edit ts. */
  context?: Record<string, unknown>;
}

/**
 * Sprint 050 A1 — inline quote of existing artifact content (what
 * `get_current_state` surfaced) that the agent wants to reference
 * verbatim inside a message. Rendered by Studio as a monospace block
 * with a left-rule and source chip — distinct from agent-authored prose.
 */
export interface ArtifactQuoteData {
  artifact: 'system_prompt' | 'sop' | 'faq' | 'tool_definition' | 'property_override';
  artifactId: string;
  /** Human-readable label — e.g. "SOP: early-checkin · CONFIRMED". */
  sourceLabel: string;
  /** The quoted verbatim content. */
  body: string;
}

// ─── Typed helper (non-enforcing) ──────────────────────────────────────

/**
 * Typed data-part envelope. Use when you want the callsite to be strict
 * about payload shape — e.g. tools emitting a known part type. The
 * `emitDataPart` sink on `ToolContext` still accepts untyped `{type,
 * data}` envelopes for back-compat with existing emitters.
 */
export type StructuredDataPart =
  | { type: typeof DATA_PART_TYPES.suggested_fix; id?: string; data: SuggestedFixData; transient?: boolean }
  | { type: typeof DATA_PART_TYPES.question_choices; id?: string; data: QuestionChoicesData; transient?: boolean }
  | { type: typeof DATA_PART_TYPES.audit_report; id?: string; data: AuditReportData; transient?: boolean }
  | { type: typeof DATA_PART_TYPES.advisory; id?: string; data: AdvisoryData; transient?: boolean };
