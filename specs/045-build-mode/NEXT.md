# Next — after sprint-055 Session A close-out

> Sprint 055-A closed at `72e64a4` on `feat/055-session-a`, stacked on
> `feat/054-session-a` (`88ccc9c`) → ... → `main`.
> Plan mode is now a live progress checklist with no Approve gate.
> Drawer previews are editable before Apply. Every operator edit carries
> provenance (`✏️ Edited` chip in ledger + drawer).

## Primary candidate — sprint-056: Compose-at-cursor

**What:** Highlight any text in the Studio chat or in a rendered artifact body,
and a contextual agent-chat bubble opens pre-scoped to that selection. Lets the
manager ask "make this sound less formal" about a specific sentence without
writing a free-form prompt from scratch.

**Why now:** The inline-edit affordance (055-A) makes the manager feel like they
own the artifacts. Compose-at-cursor completes the loop — they can also
*refine* via natural language scoped to a selection, not just type-in-place.

**Scope estimate:** Medium. Needs a selection-detection hook, a floating
bubble component, a scoped prompt prefix injector, and an SSE part type
(`data-scoped-reply`) so the response replaces only the selected fragment.

**Non-negotiables carry forward:**
- `ai.service.ts` stays untouched.
- No schema change for the compose bubble itself.
- The existing per-artifact Apply gate remains the only write gate.

## Secondary candidate — 049 explore-report P1 sweep

The sprint-049 explore-report listed P1 gaps (citation slug drift, viewer
faithfulness regressions, etc.) that were deferred across sprints 050–055.
A sweep session closing out all open P1s is overdue if any have been
unblocked by the 050–055 work.

## Tertiary candidate — staging walkthrough + merge to main

All five branches (050–055) are stacked off `main`. A walkthrough session
that tests the full live-agent path end-to-end and merges the stack is
overdue. Prerequisite: `ENABLE_BUILD_MODE=true` on the staging Railway
instance and a real `ANTHROPIC_API_KEY` in the session shell.
