/**
 * Back-compat shim for sprint 045's rename `tuning-agent/ → build-tune-agent/`.
 *
 * External callers importing `'…/tuning-agent'` continue to work via this
 * re-export. Sub-path imports (e.g. `'…/tuning-agent/tools/foo'`) must be
 * updated directly; this shim covers the public API surface from
 * `build-tune-agent/index.ts` only.
 *
 * Slated for removal in sprint 046. When that happens, all remaining
 * callers must import from `'…/build-tune-agent'`.
 */
export * from '../build-tune-agent';
