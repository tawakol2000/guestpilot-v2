/**
 * Sprint 052 A C1 — shared slug rule.
 *
 * Contract with `backend/src/build-tune-agent/lib/slug.ts` (byte-identical
 * output for the same input). Also declared in the `<citation_grammar>`
 * block of `backend/src/build-tune-agent/system-prompt.ts` so the agent
 * emits fragments the frontend can resolve. If you change this rule,
 * update the backend mirror, the prompt block, and the regression test
 * in `backend/src/build-tune-agent/__tests__/citation-grammar.test.ts`.
 *
 * Rule: lowercase, replace any run of non-alphanumeric characters with a
 * single `-`, strip leading/trailing `-`. Empty or alphanumeric-less
 * inputs return `''`.
 */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
