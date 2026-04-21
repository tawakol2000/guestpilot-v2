# Next — after sprint-056 Session A close-out

> Sprint 056-A closed at `d982dd4` on `feat/056-session-a`, stacked on
> `feat/055-session-a` (`ae863fc`) → `feat/054-session-a` → ... → `main`.
>
> **Five gates shipped:**
> - F1: Compose-at-cursor bubble + `/api/build/compose-span` — highlight text in
>   the drawer, describe the change, Accept → merged into preview buffer → Apply writes.
> - F2: `get_edit_history` tool — agent can now look up stored rationale for
>   "why did we change this?" questions against `BuildArtifactHistory`.
> - F3: Prompt-cache breakpoint infrastructure wired (documentation stub; SDK
>   surface limitation blocks explicit `cache_control` — blocked region logged to
>   SSE and LangFuse as `explicitCacheControlWired: false`).
> - F4: Plan-row click opens the artifact drawer — the checklist is now a
>   navigation surface.
> - F5: Test-failure inline rollback CTA — one-click revert from a `0/3 passed`
>   card, no ledger hunt required.

## Primary candidate — sprint-057: Session-wide diff summary

**What:** At the end of a BUILD session, the agent (or a triggered call) produces
a concise human-readable summary of every artifact that changed: what was created,
what was updated, what was reverted. Surfaced as a `data-session-diff-summary` SSE
part rendered in the Studio chat as a collapsible card.

**Why now:** After F2 + F4, the operator can inspect individual artifacts from
the plan. But there's no "here's everything that changed this session" view. The
diff summary closes that gap without requiring the operator to scroll the ledger.

**Scope estimate:** Small–medium. Needs a new tool `emit_session_summary` (or a
turn-end trigger in the controller) that reads `BuildArtifactHistory` scoped to
the `conversationId`, formats a structured diff, and emits the SSE part.

## Secondary candidates

### F3 explicit `cache_control` — unblock when SDK supports it

The Agent SDK (`sdk.d.ts:1475`) currently accepts `systemPrompt: string | { type: 'preset' }` only.
When a future SDK version exposes block-array system prompts, F3 step 2 can be completed
by unwrapping `prompt-cache-blocks.ts` infrastructure that's already in place. Track the
Anthropic Claude Agent SDK changelog for the `systemPrompt: ContentBlock[]` surface.

### Verify-without-writing ritual

Allow a manager to ask "test the current SOP without making any changes" — a
single-turn `test_pipeline` call scoped to the existing saved artifact body, not
a post-write ritual window.

### 049 P1 sweep

Sprint-049 explore-report listed P1 gaps that have been deferred across 050–056.
Reassess which are still open after the 055–056 inline-edit + compose-at-cursor
changes; a sweep session may be able to close several in one go.

## Infrastructure: staging walkthrough + stack merge to main

Branches 050–056 are stacked. A live walkthrough session testing the full
BUILD-mode flow end-to-end (green-field tenant, all five F1–F5 gates live)
should precede any merge to main.
Prerequisite: `ENABLE_BUILD_MODE=true` on the staging Railway instance.
