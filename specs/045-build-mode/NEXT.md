# Next — after sprint-057 Session A close-out

> Sprint 057-A closed at `308186a` on `feat/057-session-a`, stacked on
> `feat/056-session-a` (`812bc55`) → `feat/055-session-a` (`ae863fc`) → ... → `main`.
>
> **Three gates shipped:**
> - F1: Collapsed tool-chain summary per agent message — each assistant turn now
>   shows a one-line `⚙️ Read state · Got FAQ · Planned 3 writes · Ran test` summary
>   above the body. Click `▸` to expand the full chip row. TOOL_VERB_MAP coverage
>   regression test locks any new tool addition.
> - F2: Typographic attribution everywhere — `attributedStyle('ai'|'human'|'mixed')`
>   helper in `tokens.ts` applied to all six surfaces (write-ledger, plan-checklist,
>   test-pipeline-result, artifact-drawer/rationale-card, compose-bubble,
>   suggested-fix/audit-report). AI prose in grey (#52525B), operator prose in black.
> - F3: Scroll discipline + queue-while-busy — unconditional auto-scroll replaced
>   with `isAtBottom` tracking + "↓ N new" pill. Auto-queue accepts up to 3 follow-up
>   messages while the agent is streaming; flushes in order on next `ready` transition.

## Primary candidate — sprint-058: Editable plan mode

**What:** Allow the manager to edit an in-flight `plan_build_changes` checklist before
approving — reorder, delete, or add rows directly in the plan card. Edits are persisted
to the `BuildTransaction.plan` JSON before the `approve` call fires.

**Why now:** The plan is now clickable (056 F4) and visible as a checklist (055 F1).
The natural next affordance is mutability — the operator shouldn't have to accept the
agent's exact plan verbatim when a few tweaks would make it better.

**Scope estimate:** Medium. Needs an inline edit mode on `plan-checklist.tsx`, a new
`PATCH /api/build/transaction/:id/plan` endpoint, and a client-side optimistic update.
No schema change needed (the `plan` column already holds JSON).

## Secondary candidate — sprint-058: Session-diff summary

**What:** At the end of a BUILD session, produce a concise human-readable summary of
every artifact that changed: created, updated, reverted. Surfaced as a collapsible
card in Studio chat.

**Why now:** After 055 F1 (plan-as-checklist) + 056 F4 (plan-row click), operators
can inspect artifacts from the plan. But there's no "everything that changed this
session" view. The diff summary closes that gap without requiring ledger scroll.

**Scope estimate:** Small–medium. Needs a `emit_session_summary` trigger in the
build controller that reads `BuildArtifactHistory` scoped to `conversationId`, emits
a `data-session-diff-summary` SSE part, and a frontend renderer.

## Infrastructure

Stack 050–057 still off `main`. A staging walkthrough (green-field tenant, full
BUILD-mode flow end-to-end) should precede the merge.
Prerequisite: `ENABLE_BUILD_MODE=true` on the staging Railway instance.
