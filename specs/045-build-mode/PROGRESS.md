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
| 1    | Rename `tuning-agent` → `build-tune-agent` + shim | ⏳ | |
| 1    | System-prompt surgery                  | ⏳ | Persona, principles, mode addenda, tenant_state, terminal_recap. |
| 1    | Explicit 3-breakpoint cache_control    | ⏳ | Requires structured systemPrompt in SDK call. |
| 1    | `BuildTransaction` model + nullable FKs | ⏳ | `prisma db push`. |
| 1    | `rollback` extended with `transactionId` | ⏳ | |
| 1    | Runtime mode + `allowed_tools` + `ENABLE_BUILD_MODE` | ⏳ | |
| 2    | 6 new tools                            | ⏳ | `create_sop`, `create_faq`, `create_tool_definition`, `write_system_prompt`, `plan_build_changes`, `preview_ai_response`. |
| 3    | Preview subsystem                      | ⏳ | Golden set, adversarial, rubric, Opus judge. |
| 4    | `GENERIC_HOSPITALITY_SEED.md`          | ⏳ | 20 slots, 1,500–2,500 tokens fully filled. |
| 5    | Backend `/api/build/*`                 | ⏳ | Controller, routes, `ENABLE_BUILD_MODE` gate. |
| 6    | Frontend `/build` page                 | ⏳ | 3-pane layout, tuning tokens palette. |
| 7    | End-to-end test + `NEXT.md` handoff    | ⏳ | |

## Decisions made this sprint (explicitly out of spec scope)

- **V2 skipped.** Terminal-recap location defaults to `dynamic_suffix` per
  the spec's own tiebreaker rule. Deferred to sprint 046 with a
  Langfuse-adherence trigger.

## Open follow-ups (from Langfuse / production once this ships)

- Re-evaluate V2 if terminal-recap rule adherence <80% in prod.
- BUILD-mode cooldown / oscillation semantics (sprint 046).
- Cross-mode PreToolUse sanction gate (sprint 046).

## Changelog

- 2026-04-19 — Sprint opened on `feat/045-build-mode`. Branch created,
  validation dir scaffolded, tool count confirmed at 8 (final 14).
