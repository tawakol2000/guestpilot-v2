// @ts-nocheck
/**
 * Hand-written CommonJS loader for the ESM-only
 * `@anthropic-ai/claude-agent-sdk`. The package ships as `sdk.mjs` and has
 * no CJS entry. Our backend compiles with `module: "commonjs"`, and TS
 * rewrites `await import("esm-pkg")` to `Promise.resolve(require("esm-pkg"))`
 * which fails with ERR_REQUIRE_ESM at runtime.
 *
 * Keeping this file as plain `.cjs` means TypeScript never touches it; the
 * dynamic `import()` stays a real ECMAScript dynamic import and Node's CJS
 * loader happily pulls the ESM module that way.
 *
 * The build step copies this file into `dist/tuning-agent/` alongside the
 * compiled TS output. See package.json "build" script.
 */
'use strict';

let cached = null;

function loadAgentSdk() {
  if (!cached) cached = import('@anthropic-ai/claude-agent-sdk');
  return cached;
}

module.exports = { loadAgentSdk };
