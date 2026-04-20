# Main AI Pipeline Improvements — System Prompt for Claude Code

You are implementing pipeline improvements to the main guest-facing AI in GuestPilot. This is NOT the tuning agent — this is the coordinator and screening AI that talks to guests directly.

**Important: You are NOT rewriting the system prompts.** The prompts (SEED_COORDINATOR_PROMPT, SEED_SCREENING_PROMPT, MANAGER_TRANSLATOR_SYSTEM_PROMPT) will be replaced separately. You are only changing the pipeline code around them.

## Context

Read these files first:
- `CLAUDE.md` — project overview
- `specs/main-ai-pipeline-improvements.md` — the full sprint spec (your source of truth)
- `backend/src/services/ai.service.ts` — the core AI pipeline (2306 lines, this is the big one)
- `backend/src/services/summary.service.ts` — conversation summary service
- `backend/src/config/baked-in-sops.ts` — baked-in SOP content
- `backend/prisma/schema.prisma` — database schema (for the new compactedContent field)

## Attack Order

### Workstream A — Message Timestamps
1. Find where conversation history is built for `{CONVERSATION_HISTORY}` injection in ai.service.ts
2. Add `[MMM DD, h:mm A]` timestamps to each message, using the tenant's `workingHoursTimezone` (fall back to `Africa/Cairo`)
3. Same-day messages use short format `[h:mm A]` — compare message date to current date in the tenant's timezone
4. Use a lightweight date formatter — do NOT add moment.js or luxon. Use `Intl.DateTimeFormat` or the date-fns functions already in the project (check package.json first).

### Workstream B — Automated Message Compaction
1. Add `compactedContent String?` to the Message model in `schema.prisma`
2. Run `npx prisma db push` or add a note that schema needs pushing
3. Create a compaction function that takes a message and returns a compacted version via gpt-5-nano
4. The compaction prompt is in the spec — use it exactly
5. Call compaction at message SAVE time — when an automated/long message is stored in the DB, not at AI call time
6. Find where HOST/AI messages are saved (look for the message creation paths in ai.service.ts or related controllers)
7. If the message content exceeds 300 tokens (~1200 characters as rough heuristic), run compaction and store result in `compactedContent`
8. In the conversation history builder, use `compactedContent` if available, otherwise fall back to full `content`
9. If the nano call fails for any reason, catch the error, log it, and leave `compactedContent` null (graceful fallback)

### Workstream C — Summary Scope
1. In `summary.service.ts`, update `SUMMARIZE_PROMPT` and `EXTEND_PROMPT`
2. The exact wording changes are in the spec — replace the EXCLUDE section with the new version that distinguishes "routine resolved" from "complaint/unresolved"
3. Do not change any other logic in the summary service

### Workstream D — Pipeline Fixes
1. **Baked-in SOPs:** Search for where `BAKED_IN_SOPS_TEXT` is imported and used. If it IS injected into the coordinator prompt, document where (add a comment). If it is NOT injected, add it as the last static section before `<!-- CONTENT_BLOCKS -->` in the coordinator prompt assembly.
2. **Image instructions:** Find where image handling instructions are appended to the system prompt (~line 1940). Move them into a dynamic content block (`<!-- BLOCK -->` with `<image_instructions>` tags) instead of appending to the static string. This prevents cache-busting.
3. **Screening reasoning:** Find where reasoning effort is determined per agent type. Change screening from `none` to `low`. The code likely has a conditional or config lookup — just change the value.
4. **get_faq telemetry:** After the tool loop completes and the response is parsed, if the escalation urgency is `info_request`, check whether `get_faq` was called during this turn. If not, log: `[AI] [${conversationId}] info_request escalation without get_faq call`. This is telemetry only — do NOT block the response.

## Rules

- Read before you edit. `ai.service.ts` is 2306 lines — read the relevant sections before modifying.
- Do not touch the system prompt text (SEED_COORDINATOR_PROMPT, SEED_SCREENING_PROMPT, MANAGER_TRANSLATOR_SYSTEM_PROMPT) — those are being rewritten separately.
- Do not add new npm dependencies for date formatting. Use what's already available.
- The compaction nano call must be fire-and-forget with error handling — never block message saving on a failed compaction.
- Run `npx tsc --noEmit` after each workstream.
- Commit after each workstream with a descriptive message.
- If you find that baked-in SOPs ARE already injected, just add a clarifying comment and move on — don't reorganize working code.
