/**
 * Sprint 052 A C1 — shared slug rule (backend mirror).
 *
 * Byte-identical output for the same input as the frontend mirror at
 * `frontend/lib/slug.ts`. Declared in the `<citation_grammar>` block of
 * `system-prompt.ts` so the agent emits fragments the frontend can
 * resolve. Regression-locked by
 * `backend/src/build-tune-agent/__tests__/citation-grammar.test.ts`.
 *
 * Rule: lowercase, replace any run of non-alphanumeric characters with a
 * single `-`, strip leading/trailing `-`. Empty or alphanumeric-less
 * inputs return `''`.
 */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
