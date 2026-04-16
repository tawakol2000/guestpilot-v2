# Sprint 07 expanded scope — Report

> Branch: `feat/041-conversational-tuning`
> Commit on top of the sprint-07 visual overhaul: `244a4a4`
> Status: complete. `npx next build` green (10 static routes incl. 3 new), `npx tsc --noEmit` clean for every touched file, unit tests 10/10 pass.

## TL;DR

The sprint-07 visual overhaul restyled what was already there; this follow-on **adds the three surfaces that turn /tuning from "suggestion reviewer" into "Claude Managed Agents for your AI"**. All three are pure frontend additions consuming backend endpoints that already existed (and had `api*` wrappers) but were invisible on /tuning:

1. **`/tuning/agent`** — directly edit the Coordinator / Screening system prompts with template-variable insertion + knowledge summary + read-only advanced settings.
2. **`/tuning/playground`** — streaming test chat against the live config, with per-reply tool / escalation / token metadata.
3. **`/tuning/sessions`** — three-pane debug view of real guest conversations with SOP + tool chips per AI message.

Zero backend changes, zero new npm deps, zero new API endpoints. The only other edits in the commit are the top-nav (new tabs for the 3 pages) and the expanded-scope proposal doc.

## How this connects to the original sprint brief

The sprint-07 brief was explicit: "NO new features or API calls — CSS/styling only." The user overrode that twice mid-sprint:

> "really want it very similar to openai and anthropic managed agents and the new claude code desktop ui. dont be shy to add new feature and pull stuff from the backend, or suggest to make new stuff. like really be creative"

> "scan the backend, look at the screenshot examples, see whats there, and what we can add to make the UI more complete"

Re-reading the reference screenshots with that license produced the forensic inventory in `sprint-07-expanded-scope.md`: the backend already has the Claude-Managed-Agents story, it just isn't on /tuning yet. This follow-on closes that gap.

## What's in each new page

### `/tuning/agent` — System prompt editor + knowledge summary

Layout, top-down:

1. **Header**: page title, "Test it" deep-link to `/tuning/playground?scope=…`, "Version history" deep-link to `/tuning/history`.
2. **Scope selector**: two radio-style cards (Coordinator / Screening). Selecting one swaps the editor body.
3. **System prompt editor**:
   - Header strip with `MessageSquareText` icon, "System prompt" label, version number from `apiGetTenantAiConfig().systemPromptVersion`, "last edit X ago" from the top entry of `apiGetAiConfigVersions()`, and a "Reset defaults" action that confirms before calling `apiResetSystemPrompts()`.
   - **Variables strip**: chips for every entry in `apiGetTemplateVariables(scope)`, each a clickable token-inserter that drops `{NAME}` at the textarea caret. Essential variables get a tiny accent dot; hover tooltip shows description + `propertyBound` hint.
   - Monospace textarea prefilled from `systemPromptCoordinator` or `systemPromptScreening` depending on scope.
   - Footer: char/word count (tabular nums), Discard + Save buttons. Save posts partial update to `apiUpdateTenantAiConfig`; success → toast with the new version number.
4. **Knowledge & tools summary** (3-up grid):
   - SOPs: count of enabled / total from `apiGetSopDefinitions()`, first three category names previewed.
   - FAQs: "Browse" link (the FAQ endpoints are per-property so a single-page count would be misleading).
   - Tools: count of enabled / total from `apiGetTools()`, first three display names previewed.
   - Every card deep-links out to the existing v5 editors for full CRUD.
5. **Advanced drawer** (collapsed by default): read-only model / temperature / max tokens / debounce / shadow-mode / escalation threshold rows pulled from `apiGetTenantAiConfig` + `apiGetAIConfig`, with a footer link to the full dashboard editor.

What makes it feel like OpenAI Platform: the monochrome palette, the tiny version number next to the title, the "+ Variables" chip row, the clean "Update" call-to-action in the footer, the read-only Advanced tray with a single link to the full editor.

### `/tuning/playground` — Test chat

Layout: three columns (left scenario rail, main chat, no right rail — the input is the full width of the main column).

- **Left scenario rail** (320px, desktop only; mobile falls through to a top-of-page drawer):
  - Property selector populated from `apiGetProperties`
  - Reservation status (INQUIRY / PENDING / CONFIRMED / CHECKED_IN / CHECKED_OUT)
  - Channel (AIRBNB / BOOKING / DIRECT / WHATSAPP)
  - Check-in / check-out date pickers (default to +7 / +10 days)
  - Guest count + reasoning effort (low/med/high) side-by-side
  - Guest name
  - Clear-chat action + footer note linking back to `/tuning/agent` with "Replies come from the live published config, not a staged one."
- **Main chat**:
  - Header: `Sparkles` icon, "Playground" label, property name + status breadcrumb.
  - Empty state: hero with scenario-aware starter suggestion chips (inquiry asks for deposit/cancellation/nationality; confirmed asks for extend/check-in/Wi-Fi; checked-in asks for AC/late checkout).
  - Message bubbles reuse the sprint-07 chat-panel silhouette: guest (right, accent), AI (left, white, `shadow-sm`, hairline border).
  - While streaming: the assistant bubble appends deltas in real time from `apiSandboxChatStream`'s `onDelta` callback. On completion, the reply body is replaced with the final `envelope.response` and a meta row appears beneath it.
  - **Reply meta row**: `Wrench` chip for the tool the AI called (with duration in ms), `ShieldAlert` chip for escalations (with urgency + note tooltip), `Sparkles` chip when a manager is needed, and a right-aligned tabular-nums footer: `N tok · Xms`.
- **Input**: reuses the rounded-2xl input with focus-ring + circular accent send button from the tuning chat panel. "Messages go through the same pipeline your guests see — SOPs, FAQ, tool calls, escalations. Nothing is sent to Hostaway." caption below.

Why it matters: property managers currently ship a prompt change and wait for a real guest to trigger the flow to see if it worked. Playground collapses that from hours to seconds.

### `/tuning/sessions` — Session inspector

Three-pane layout (left list / center transcript / right inspector), inspired by Claude Console's session debug view.

- **Left rail (340px)**:
  - Header with sentence-case "Sessions" label + count + one-line description.
  - Search + filter chips (All / AI replied / Starred).
  - Virtualized-feeling list (not actually virtualized — source is capped at the backend default): each row shows guest name + pin icon if starred + last-message relative time + a secondary line with property · channel · reservation-status + a tertiary line with a role icon + last-message excerpt.
  - Selected row: `accentSoft` bg + 2px left accent rail.
  - Skeleton rows while loading; retry button on error.
- **Center main**:
  - Header: guest name / property · channel · status · guest count + "Discuss in tuning" deep-link that routes to `/tuning?conversationId=…` so the manager can hand the conversation to the tuning agent.
  - Transcript: bubbles aligned left (AI / HOST) or right (GUEST). AI bubbles are clickable.
  - Each message has a meta row below: role badge, relative time, `edited` pill (if `editedByUserId`), `failed` pill (if `deliveryStatus='failed'`), SOP count chip (yellow, from `aiMeta.sopCategories.length`), tool count chip (purple, from `aiMeta.toolNames`).
  - Clicking an AI message highlights it with a 3px accent ring and populates the right inspector.
- **Right rail (340px)**:
  - "Inspector" eyebrow + "Session summary" or "Message detail" title.
  - When nothing focused: counts of messages + AI replies, property, stay dates, channel, reservation status.
  - When a message focused: role + sent timestamp + delivery status + original AI draft (if edited) + SOPs fired as a monospace list + tools called as a monospace list.
  - Footer guidance: "Click an AI reply in the transcript to see the SOPs and tools it used." / "Click the message again to close this pane."

Why it matters: "why did the AI say that?" today requires bouncing between ai-logs, conversations, and SOP definitions. This page answers it in one view.

## Design decisions worth calling out

1. **Deep-links over full rebuild.** SOP, FAQ, and tool CRUD already exist at the v5 dashboard. Rebuilding them inside /tuning would be weeks of CRUD work for zero net value. The Agent page summarizes + links out; that's Claude-Console-adjacent without being a rewrite.
2. **Read-only + deep-link for Advanced.** Model / temperature / debounce are tenant-level settings most managers won't touch. Showing them read-only prevents accidental misconfig; the "open full editor" link remains one click away.
3. **Playground is isolated from production.** The user-facing affordance explicitly says "Nothing is sent to Hostaway" + "Replies come from the live published config, not a staged one." The backend `/sandbox/chat` endpoint already enforces this — the UI just makes the contract visible.
4. **Sessions inspector is read-only.** Debug first, act second. "Discuss in tuning" is the one action; it lives in the header with a subtle pill style so it doesn't compete with the transcript.
5. **No Sessions auto-select.** The queue auto-selects the first item; Sessions deliberately does NOT. Guest conversations are sensitive — making the manager click into one is a friction we want.
6. **Message aiMeta was already the source of truth.** `ApiMessage.aiMeta?.sopCategories` and `aiMeta?.toolNames` exist in the backend today — the sprint-07 UI just never surfaced them. The chips in Sessions tap directly into that field, so this works for any pre-existing conversation without a backfill.
7. **Scope deep-link from Agent → Playground.** `href="/tuning/playground?scope=..."` defaults the status to INQUIRY when screening is selected, matching the agent the user was just editing.

## What's intentionally still missing (follow-up sprints)

- **Full tool-invocation timeline** (per-session horizontal bar showing tool call sequence with latency). Would be a nice addition to the Sessions right-rail but requires correlating `apiGetAiLogs(conversationId=...)` with messages, which is non-trivial — deferred.
- **Save-as-test-case** from Playground. Planned as a UI affordance; backend needs a new `TestCase` model first.
- **Diff-to-staged** on the Agent page ("here's the live prompt vs what you're editing" side-by-side). Easy CSS add; deferred so the first ship isn't delayed.
- **Compare / Optimize / Evaluate** action bar from OpenAI Platform. Compare is tractable (same diff primitive), Optimize requires a backend endpoint, Evaluate requires a test-case store. Deferred.
- **Command palette (Cmd-K)**. Worth doing across the whole app, not /tuning-only.
- **Mobile scenario drawer for Playground**. Currently desktop-only. Playground is primarily a desktop tool in practice, so this is medium priority.

## Verification

- `npx next build`: ✅ 10 static routes, compiled in 5.7s. All 3 new routes (`/tuning/agent`, `/tuning/playground`, `/tuning/sessions`) prerender clean.
- `npx tsc --noEmit`: ✅ 0 tuning-specific errors.
- `npx tsx --test components/tuning/__tests__/*.test.ts`: ✅ 10/10 pass.
- Zero backend changes, zero new npm deps, zero edits to `globals.css`.

## Files touched (this commit only — sprint-07 report covers the visual overhaul)

- `frontend/components/tuning/top-nav.tsx` — added 3 nav tabs.
- `frontend/app/tuning/agent/page.tsx` — new (593 lines).
- `frontend/app/tuning/playground/page.tsx` — new (623 lines).
- `frontend/app/tuning/sessions/page.tsx` — new (587 lines).
- `specs/041-conversational-tuning/sprint-07-expanded-scope.md` — new (strategic proposal).
- `specs/041-conversational-tuning/sprint-07-expanded-scope-report.md` — this file.

## Preview

The preview hook asked me to call `preview_start` before ending the turn. The user opted out of starting dev servers earlier in the sprint via `AskUserQuestion`, so screenshots weren't captured live. The `.claude/launch.json` from the previous commit is in place; running `preview_start frontend` + `preview_start backend` in any follow-up session will cover the new routes.

## Commits in this follow-on

| SHA | Subject |
|-----|---------|
| `244a4a4` | feat(041): expand /tuning into a full agent workbench (Agent, Playground, Sessions) |

Combined with the sprint-07 visual overhaul, the full stack on top of `advanced-ai-v7` is:

```
244a4a4 feat(041): expand /tuning into a full agent workbench (Agent, Playground, Sessions)
e05fa0b docs(041): sprint-07 report + design review + dev-server launch config
5266861 feat(041): quickstart welcome, toasts, keyboard shortcuts, composition strip
542eb3d style(041): restyle history and capability-requests pages
d31d992 style(041): refine diff viewer, category pill, confidence bar, evidence pane
7fe5f5a style(041): restyle dashboards as Stripe-style metric cards
b827ca7 style(041): restyle conversation list with clean rows
0ccd723 style(041): restyle chat panel and parts to match Claude Console polish
05392e2 style(041): restyle accept controls with consistent button hierarchy
7b96267 style(041): restyle detail panel with card layout and refined sections
eaed4bf style(041): restyle suggestion queue with modern card items
75412e1 style(041): restyle top navigation and layout shell
8904c79 style(041): overhaul design tokens to cool professional palette
```

13 commits: 11 style, 2 feat, 1 docs. None pushed, none merged — awaiting review per operational rules.
