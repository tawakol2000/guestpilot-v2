# V1 — `allowed_tools` cache preservation

**Status:** ⏸️ DEFERRED — no `ANTHROPIC_API_KEY` available in this
session's environment. Theoretical argument below is strong; must be
confirmed with a live run before BUILD mode flips on in staging.

**Date:** 2026-04-19

## Goal (from spec §V1)

Confirm that setting `allowed_tools` per-request does NOT invalidate the
`tools` array prompt cache on Sonnet 4.6 via the Claude Agent SDK.

## Theoretical argument (supports PASS)

The Claude Agent SDK's `allowedTools` option is a **client-side filter**:
it tells the SDK wrapper which tool-use blocks the agent is permitted to
invoke. It does not modify the `tools` array sent to the Anthropic API.

Evidence from the existing runtime:

- `backend/src/tuning-agent/runtime.ts:265` passes
  `allowedTools: Object.values(TUNING_AGENT_TOOL_NAMES)` — an explicit
  whitelist, currently always the full set.
- The `tools` array sent to the API is the MCP server's full tool
  registry (8 tools today), independent of `allowedTools`.
- Anthropic's prompt cache keys on the bytes of the outbound request
  (system + tools + messages). If `allowedTools` doesn't change those
  bytes, cache survives.

Therefore cache invalidation on `allowedTools` change is **impossible by
construction** for this SDK. V1 as written asks the right question —
it's just that the answer is determined by the SDK's design, not by
observation.

## Why we still want the live run

One edge case we can't rule out without instruments: the SDK may opt to
serialise only the *allowed* tool set to the API as an optimisation on
some versions. The SDK is `@anthropic-ai/claude-agent-sdk@^0.2.109`;
future minor bumps could change this silently.

## Fallback if V1 fails on a later run

Spec §V1: "put BUILD and TUNE on separate prompt invocations with
separate cached prefixes (two cache hashes, one per mode). Cost: 2x
cache writes on cold start. Still cheaper than conditional tool loading."

If this fallback becomes necessary:
- Keep the shared system prompt (breakpoints 1 + 2).
- Route BUILD vs TUNE through separate `query()` calls with distinct
  hash-stable prefixes.
- `allowedTools` stays as a defence-in-depth layer; the primary gate
  becomes prompt routing.

## Next-session unblock

Before BUILD mode is enabled in staging (per spec acceptance criterion
"Cache hit rate on mixed sessions ≥0.995 over a 48h window"):

1. Export `ANTHROPIC_API_KEY` into the runner shell.
2. Run `npx ts-node specs/045-build-mode/validation/V1-live.ts` (to be
   written in the next session — see `specs/045-build-mode/NEXT.md`).
3. Expected: on turns 2+ after an `allowedTools` change, Langfuse
   `cache_read_input_tokens` remains ≥95% of turn-1 prefix tokens and
   `cache_creation_input_tokens` remains ~0.
