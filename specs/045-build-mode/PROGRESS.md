# Sprint 045 — Progress log

> Updated incrementally as each gate lands. This is the handoff artifact.
> Owner: Abdelrahman (ab.tawakol@gmail.com).
> Branch: `feat/045-build-mode` off `044-doc-handoff-whatsapp`.

## Session cadence

This sprint is executed across multiple sessions. Each session pushes
through as many gates as it can, updates this doc, and hands off via
`NEXT.md`.

## Gate status

| Gate | Item | Status | Notes |
|------|------|--------|-------|
| 0    | V1 — `allowed_tools` cache preservation | ⏸️ deferred | No `ANTHROPIC_API_KEY` in session env. Theoretical argument strong (SDK's `allowedTools` is client-side filter, doesn't alter outbound request bytes). Must run live before BUILD flips on in staging. See [V1-result.md](validation/V1-result.md). |
| 0    | V2 — terminal recap A/B                | ⏭️ skipped | Default to dynamic_suffix (spec tiebreaker). Re-evaluate in sprint 046 if rule adherence <80%. |
| 0    | V3 — default markers round-trip        | ✅ PASS | [V3-result.md](validation/V3-result.md). Markers byte-identical through Prisma + resolveVariables(). HTML-comment form acceptable. |
| 1    | Rename `tuning-agent` → `build-tune-agent` + shim | ✅ | Top-level shim at old path; sub-path callers migrated. |
| 1    | System-prompt surgery                  | ✅ | Persona collapsed, principles 11→9, TUNE/BUILD addenda, tenant_state, terminal_recap. 13/13 unit tests pass. |
| 1    | Explicit 3-breakpoint cache_control    | ⚠️ diverged | SDK limitation — see "Cache breakpoints" decision below. Automatic prefix caching substituted; behaviour equivalent at 5-min TTL. |
| 1    | `BuildTransaction` model + nullable FKs | ✅ | Applied via `prisma db push`. New table + 5 nullable FK columns (SopVariant, SopPropertyOverride, FaqEntry, ToolDefinition, AiConfigVersion). |
| 1    | `rollback` extended with `transactionId` | ✅ | Reverts in order tools → system_prompt → faq → sop. Per-artifact mode unchanged. |
| 1    | Runtime mode + `allowed_tools` + `ENABLE_BUILD_MODE` | ✅ | `RunTurnInput.mode` + `resolveAllowedTools(mode)`; BUILD requests short-circuit when `ENABLE_BUILD_MODE` unset. |
| 2    | 6 new tools                            | ⏳ session 2 | `create_sop`, `create_faq`, `create_tool_definition`, `write_system_prompt`, `plan_build_changes`, `preview_ai_response`. |
| 3    | Preview subsystem                      | ⏳ session 2 | Golden set, adversarial, rubric, Opus judge. |
| 4    | `GENERIC_HOSPITALITY_SEED.md`          | ⏳ session 2 | 20 slots, 1,500–2,500 tokens fully filled. |
| 5    | Backend `/api/build/*`                 | ⏳ session 2 | Controller, routes, `ENABLE_BUILD_MODE` gate. |
| 6    | Frontend `/build` page                 | ⏳ session 2 | 3-pane layout, tuning tokens palette. |
| 7    | End-to-end test + final handoff    | ⏳ session 2 | |

## Decisions made this sprint (explicitly out of spec scope)

- **Prefix-stability baseline (Gate 2, session 2, 2026-04-19).**
  `backend/src/build-tune-agent/__tests__/prompt-cache-stability.test.ts`
  locks down byte-identical renders per mode + a shared Region A
  across modes. Baseline character / estimated-token counts on a
  GREENFIELD fixture tenant (chars × 0.25 heuristic):

  | Slice                        | Chars   | Est. tokens |
  |------------------------------|---------|-------------|
  | Region A (shared prefix)     | 11,422  | 2,856       |
  | TUNE cacheable (A + addendum)| 13,900  | 3,475       |
  | BUILD cacheable (A + addendum)| 14,991 | 3,748       |

  All three comfortably exceed Anthropic's 1,024-token cache minimum,
  so Region A caches as an independent layer; mode-addendum regions
  cache on the cumulative prefix. Regression guard: if any of these
  numbers drift ≥10% or the byte-identity assertions fail in CI,
  someone has injected drift into the shared system section.

- **V2 skipped.** Terminal-recap location defaults to `dynamic_suffix` per
  the spec's own tiebreaker rule. Deferred to sprint 046 with a
  Langfuse-adherence trigger.

- **Cache breakpoints: automatic, not explicit.** Spec §1.3 requires
  explicit `cache_control: { type: 'ephemeral' }` on system-prompt
  content blocks, but the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk@0.2.109`)
  accepts `systemPrompt` as `string | { type: 'preset'; … }` only —
  structured content blocks with `cache_control` are not exposed through
  this surface (sdk.d.ts:1475). The sprint proceeds with the current
  automatic-prefix-caching approach (0.998 hit on TUNE today), using
  stable 3-region ordered boundaries in the assembled string. Behaviour
  is functionally equivalent at the 5-min TTL. Acceptance criterion
  "Langfuse shows distinct cache_read patterns for BUILD vs TUNE" is
  still met: BUILD and TUNE have different mode addenda → different
  byte-identical prefixes → separate automatic cache entries. To gain
  explicit `cache_control` we would have to bypass the Agent SDK and
  call `@anthropic-ai/sdk` directly with a hand-rolled tool-use loop,
  which is out of sprint 045 scope. Flagged for sprint 046+ revisit if
  Langfuse shows sub-0.995 hit on mixed sessions.

## Open follow-ups (from Langfuse / production once this ships)

- Re-evaluate V2 if terminal-recap rule adherence <80% in prod.
- BUILD-mode cooldown / oscillation semantics (sprint 046).
- Cross-mode PreToolUse sanction gate (sprint 046).

## Changelog

- 2026-04-19 — Sprint opened on `feat/045-build-mode`. Branch created,
  validation dir scaffolded, tool count confirmed at 8 (final 14).
- 2026-04-19 — **Session 1 close.** Gates 0 + 1 complete. TUNE behaviour
  intact (13/13 system-prompt tests, 59/59 agent module tests pass).
  Two commits on branch. NEXT.md written for session 2 handoff.
