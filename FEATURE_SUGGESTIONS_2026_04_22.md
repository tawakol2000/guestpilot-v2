# Feature Suggestions / Suggested Edits — 2026-04-22 → 2026-04-23

> Ideas surfaced during the autonomous bug-fix run. Each entry includes
> rationale + estimated effort + risk. **Do not build without user
> approval.** Review when the user wakes up.

## Format

```
### [Severity-of-impact] Title
**Where:** file path / area
**Idea:** what to build/change
**Why:** the operator-visible win
**Effort:** XS / S / M / L
**Risk:** low / med / high (and why)
**Depends on:** prerequisites if any
```

## Suggestions

### [LOW-impact] Centralize TenantAiConfig save into `buildTenantConfigPatch` helper
**Where:** `frontend/components/configure-ai-v5.tsx` (TenantConfigSection, SystemPromptsSection, ImageHandlingSection)
**Idea:** Each save handler currently passes a hand-curated subset of fields. Extract a `buildTenantConfigPatch(local: TenantAiConfig): Partial<TenantAiConfig>` helper that returns the complete patch shape, OR flip to passing `local` whole and let the server reconcile.
**Why:** Prevents the silent-dropped-field class of bug we already saw twice in this run (`property_ai_changed` no-op, `availableStatuses` write gap). New TenantAiConfig fields will Just Work without remembering to add them to all three section save buttons.
**Effort:** S (~30 min for the helper extraction; or M if we go to whole-object save with server-side ALLOWLIST validation)
**Risk:** low — shrinking the surface area, not expanding it
**Depends on:** none

## Code-hygiene findings (post-bug-hunt scan, 2026-04-23)

> Not bugs — quality improvements found while looking for what else could be valuable. Ranked by impact. None require sacred-file edits unless explicitly noted.

### [HIGH-impact] Extract Hostaway status-string → ReservationStatus enum into one helper
**Where:** Currently duplicated across 4 files:
  - `backend/src/services/ai.service.ts:1473-1479` (sacred — but the consumer call-site can move to a helper)
  - `backend/src/controllers/webhooks.controller.ts:~65`
  - `backend/src/jobs/reservationSync.job.ts:~19`
  - `backend/src/services/import.service.ts:~40`
**Idea:** New `mapHostawayStatus(s: string): ReservationStatus` exported from `backend/src/services/hostaway.service.ts`. Each call site calls the helper instead of inlining its own switch.
**Why:** Each copy has slightly different fallbacks (some include `inquirypreapproved`, others don't). Hostaway adds new statuses over time → drift across the 4 sites. A single source eliminates the silent-coverage-gap risk.
**Effort:** S (~30 min: extract + 4 call sites + a 20-row table test).
**Risk:** low — pure fn, easy to unit-test.

### [HIGH-impact] Split the 1100-line `generateAndSendAiReply` (ai.service.ts:1416)
**Where:** `backend/src/services/ai.service.ts:1416-2570`
**Idea:** Carve into ~5 named private helpers along clear seams:
  1. pre-response sync + reservation-status refresh (~1440-1540)
  2. context assembly / template resolution
  3. SOP classification + tool loop
  4. structured-output parse + escalation branch
  5. send + post-hooks
**Why:** Largest single-block function in the codebase after round 8's hygiene pass; the only one of comparable size already extracted (forced-first-turn) became unit-testable. Smaller functions = smaller test surfaces, easier diff review, smaller blast radius on future edits.
**Effort:** L (1-2 days; touches the most-called fn + needs careful regression coverage).
**Risk:** med-high (sacred file; the existing integration tests would catch most regressions but a careful hand is needed). User must explicitly authorize touching ai.service.ts.

### [MEDIUM-impact] Extract self-contained sub-components from inbox-v5.tsx
**Where:** `frontend/components/inbox-v5.tsx` (~4700-line file)
**Idea:** Move these already-local components to `frontend/components/inbox/`:
  `MiniCalendar`, `TasksBox`, `AlterationPanel`, `PanelSection`, `DataRow`, `AppleToggle`, `MessagesSkeleton`, `ShimmerText`, `IntelligenceGlowBorder`, `TypingIndicator`.
**Why:** Each becomes independently testable; main file shrinks ~1500 lines; future hook-order/race fixes (we've shipped two this run) become easier to reason about in a smaller file.
**Effort:** M (~half a day — mostly mechanical extract, but each move needs prop typing + a story/test if you want one).
**Risk:** low — pure refactor, no behaviour change.

### [MEDIUM-impact] Typed OpenAI Responses-API wrapper
**Where:** `backend/src/services/ai.service.ts` lines 256, 374, 454, 496, 576 (5 call sites all use `(openai.responses as any).create(...)`)
**Idea:** New `function callResponses(params: ResponsesCreateParams): Promise<ResponsesResponse>` wrapper that types the calls. Removes 5 `as any` casts in the hot path.
**Why:** Eliminates the most common cast-class in the hottest file. Future changes to OpenAI's Responses API surface will surface as TS errors at the wrapper, not silent runtime drift across 5 call sites.
**Effort:** S (~1-2h once the canonical type is found).
**Risk:** low — wrapper is mechanical; existing tests cover.

### [MEDIUM-impact] Widen TenantAiConfig type accessors so per-call casts disappear
**Where:** `backend/src/services/ai.service.ts:1640, 1709, 1717, 1863, 2065-2066`
**Idea:** `(tenantConfig as any)?.workingHoursTimezone` / `imageHandlingInstructions` / `reasoningScreening` / `reasoningCoordinator` / `(m as any).compactedContent` — the fields exist on the Prisma models. Either regen Prisma types or add the fields to the local `TenantAiConfig` interface used in this file.
**Why:** ~5 casts vanish in the hottest file.
**Effort:** XS (~10 min if the Prisma types are already correct; ~30 min if the interface needs widening).
**Risk:** low.

### [MEDIUM-impact] `clamp01(n)` utility (5 call-site duplication)
**Where:** `Math.max(0, Math.min(1, x))` appears at:
  - `ai.service.ts:2168, 2201`
  - `tuning/diff.service.ts:118`
  - `tuning/diagnostic.service.ts:1011`
  - `tuning-dashboards.controller.ts:51`
**Idea:** Trivial utility in `backend/src/lib/math.ts` (or similar).
**Effort:** XS.
**Risk:** none.

### [LOW-impact] JSDoc on the three biggest functions in ai.service.ts
**Where:** `createMessage` (~455 lines, `:294`), `generateAndSendAiReply` (~1100 lines, `:1416`), `stripCodeFences` (`:749`).
**Idea:** Each function gets a 5-10 line JSDoc covering purpose, retry semantics, tool-loop limits, and (for stripCodeFences) the dual-purpose nature. Or: rename `stripCodeFences` → `cleanModelJson` since it does fence-stripping AND concatenated-JSON disambiguation.
**Why:** These three functions get read by every new contributor; current state forces them to read 100s of lines to understand intent.
**Effort:** XS.
**Risk:** none.

### [LOW-impact] tool-definition.service.ts SYSTEM_TOOLS upsert in $transaction
**Where:** `backend/src/services/tool-definition.service.ts:226, :252`
**Idea:** Wrap the serial upsert loop in `prisma.$transaction([...])`. Round-trips drop ~10×. Only fires on tenant seed so impact is small but free.
**Effort:** XS.
**Risk:** none.

### [LOW-impact] Repository hygiene: delete unused root files + prune worktrees
**Where:** Repo root + `.claude/worktrees/`
**Idea:**
  - `studio-showcase.html` (1016 lines, untracked) — zero references in any source/test/doc file. Delete or move to `docs/`.
  - `.claude/worktrees/agent-*` — 6 stale agent worktree directories from earlier sprints visible in `git status`. `git worktree prune` plus a manual `rm -rf .claude/worktrees/agent-*` will clean them.
**Why:** Repo cleanliness; reduces cognitive load when reviewing git status.
**Effort:** XS.
**Risk:** none — pure deletion of confirmed-unused content.

### [LOW-impact] Codify `npx next build` in the frontend after-gate routine
**Where:** sprint kickoff prompts; `specs/045-build-mode/NEXT.md` after-gate routine
**Idea:** Add a required after-gate step: `cd frontend && npx next build` (not just vitest + tsc).
**Why:** Vercel's deploy runs `npx next build` which performs strict tsc + static prerender checks. Vitest + tsc alone can pass while Vercel fails. Example: the 2026-04-23 deploy failed on a duplicate `const` declaration (tsc-strict caught) and a missing Suspense around `useSearchParams()` (Next's static-generation step caught). Both were invisible to `npm test -- --run`. Same class as the 2026-04-22 `tsc --noEmit` codification — transpile-only test runners miss production-grade compile errors.
**Effort:** XS (docs only).
**Risk:** none.

### [LOW-impact] Test-coverage targets for highest-leverage gaps
**Where:**
  - `ai.service.ts:749` `stripCodeFences` (or its renamed equivalent) — pure-fn, table-driven test for hand-tuned edge cases (concatenated JSON, mixed code fences).
  - `ai.service.ts:1215` `handleEscalation` — only exercised via integration; direct unit tests for urgency inference + task-dedup fall-through would be high-leverage.
  - Hostaway status-mapping (after the extract above): 20-row table test.
**Effort:** S each.
**Risk:** none — additive only.

### [LOW-impact] WebhookLog retention sweep job
**Where:** `backend/src/jobs/webhookLogRetention.job.ts` (new)
**Idea:** Daily job mirroring `buildToolCallLogRetention.job.ts`. Default 30-day retention; configurable via env.
**Why:** WebhookLog grows unbounded today. High-volume tenants accumulate hundreds of rows/day. Other log tables already have retention.
**Effort:** XS (10 min — copy buildToolCallLogRetention.job.ts shape)
**Risk:** low (deletion is by-age, not by-content; safe)
**Depends on:** user decision on retention window (30d default sane?)

(Appended as encountered.)

---
