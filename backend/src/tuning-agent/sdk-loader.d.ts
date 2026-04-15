/**
 * Type declarations for the hand-written `./sdk-loader.cjs` shim. Mirrors
 * the SDK's own type surface so TS-side callers get autocomplete + compile
 * errors on wrong exports.
 */
export function loadAgentSdk(): Promise<typeof import('@anthropic-ai/claude-agent-sdk')>;
