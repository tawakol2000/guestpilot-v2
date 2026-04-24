// Sprint 046 — Studio design overhaul (plan T008 + research.md R4).
//
// Client helper for firing a test-pipeline run through the build agent.
//
// IMPORTANT: The test-pipeline-runner service is driven by the build
// agent's `test_pipeline` tool call, not a direct client endpoint. Its
// results stream back as SSE parts (`data-test-pipeline-result`) which
// `StudioChat` already hoists via its `onTestResult` callback. So this
// helper doesn't call an HTTP endpoint — it formats a user message
// that asks the build agent to run the tool, which the shell then
// sends through the existing chat pipeline.
//
// Two entry points use this helper:
//   1. Preview tab's inline input + Send test button (FR-033)
//   2. Composer's Test chip (FR-025b) — forwards current textarea
//      contents, then focuses the Preview tab
//
// The `onlyVariant` argument (FR-034 Tests tab Re-run chevron) is
// surfaced as a structured annotation the build agent honors when
// deciding how many variants to run.

export interface RunTestPipelineArgs {
  /** The guest message to test against the draft reply-pipeline. */
  message: string
  /**
   * Sprint 046 FR-034 — when set, re-runs a single variant from the
   * most recent test suite instead of the full suite. Agent reads
   * this from the structured annotation below.
   */
  onlyVariant?: string
}

/**
 * Build the user-message text the build agent should see to trigger a
 * test-pipeline run. Keeps the intent machine-readable (JSON tail) so
 * the build agent's coordinator can parse it reliably, while also
 * staying readable to an operator reviewing session history.
 */
export function formatRunTestPipelineMessage(args: RunTestPipelineArgs): string {
  const { message, onlyVariant } = args
  const annotation: Record<string, unknown> = {
    action: 'run_test_pipeline',
    message,
  }
  if (onlyVariant) annotation.onlyVariant = onlyVariant
  const headline = onlyVariant
    ? `Re-run variant \`${onlyVariant}\` of the test suite against:\n\n> ${message.trim()}`
    : `Run the draft reply-pipeline against this guest message:\n\n> ${message.trim()}`
  return `${headline}\n\n<!-- studio:test-pipeline ${JSON.stringify(annotation)} -->`
}
