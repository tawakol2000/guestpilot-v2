/**
 * Sprint 049 Session A — A7.
 *
 * Shared structured-log emitter for tuning-pipeline fire-and-forget failures.
 * Four controller sites (shadow-preview diagnostic, shadow-preview compaction,
 * messages.controller Path A diagnostic, conversations.controller Path B
 * diagnostic) all swallow errors per CLAUDE.md rule #2 — a silent outage of
 * the tuning pipeline would leave zero product-side trace. The DB-backed
 * badge half of sprint-049-explore-report §2 P1-3 defers to sprint-050 once
 * a week of Railway log signal calibrates thresholds; this helper is the
 * log-tag-only half so `grep -rn TUNING_DIAGNOSTIC_FAILURE` is the operator
 * handle today.
 *
 * Centralised in one file so the literal `[TUNING_DIAGNOSTIC_FAILURE]` prefix
 * stays consistent across paths and so the test suite can pin the log shape
 * with a single unit spec.
 */
export type TuningDiagnosticFailurePhase =
  | 'diagnostic'
  | 'suggestion-write'
  | 'compaction';

export type TuningDiagnosticFailurePath =
  | 'shadow-preview'
  | 'messages'
  | 'conversations';

export type TuningDiagnosticFailureTrigger =
  | 'EDIT_TRIGGERED'
  | 'REJECT_TRIGGERED'
  | null;

export interface TuningDiagnosticFailureContext {
  phase: TuningDiagnosticFailurePhase;
  path: TuningDiagnosticFailurePath;
  tenantId: string;
  messageId: string;
  /** null for non-diagnostic phases (e.g. compaction). */
  triggerType: TuningDiagnosticFailureTrigger;
  error: unknown;
}

export function logTuningDiagnosticFailure(ctx: TuningDiagnosticFailureContext): void {
  console.error('[TUNING_DIAGNOSTIC_FAILURE]', {
    phase: ctx.phase,
    path: ctx.path,
    tenantId: ctx.tenantId,
    messageId: ctx.messageId,
    triggerType: ctx.triggerType,
    reason: ctx.error instanceof Error ? ctx.error.message : String(ctx.error),
    stack: ctx.error instanceof Error ? ctx.error.stack : undefined,
  });
}
