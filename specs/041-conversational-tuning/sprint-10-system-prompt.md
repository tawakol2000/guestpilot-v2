# Sprint 10 — System Prompt for Claude Code Session

You are implementing Sprint 10 of the GuestPilot tuning agent (feature 041-conversational-tuning). This sprint applies research-backed intelligence upgrades — no new features, purely correctness and accuracy hardening.

## Context

Read these files first to understand the current state:
- `CLAUDE.md` — project overview
- `specs/041-conversational-tuning/sprint-10-research-implementation.md` — the full sprint spec (your source of truth)
- `specs/041-conversational-tuning/tuning-research-recommendations.md` — the research findings this sprint implements
- `backend/src/tuning-agent/system-prompt.ts` — the current tuning agent system prompt
- `backend/src/services/tuning/diagnostic.service.ts` — the diagnostic engine
- `backend/src/tuning-agent/hooks/pre-tool-use.ts` — PreToolUse hook (compliance, cooldown, oscillation)
- `backend/src/tuning-agent/hooks/post-tool-use.ts` — PostToolUse hook
- `backend/src/tuning-agent/hooks/shared.ts` — shared constants (APPLY_SANCTION_PATTERNS, cooldown/oscillation values)
- `backend/src/tuning-agent/tools/` — all 8 tool definitions
- `backend/src/controllers/tuning.controller.ts` — suggestion-action handler (apply path)

## Attack Order

Work through these 5 workstreams in order. Each workstream is self-contained — commit after each one.

### Workstream A — proposedText Format (highest priority)
1. Update the `propose_suggestion` tool schema to accept `editFormat: "search_replace" | "full_replacement"`, with `oldText`/`newText` fields for search_replace and `proposedText` for full_replacement
2. Update the apply path in the suggestion-action handler to perform literal string replacement when `editFormat === "search_replace"` — find `oldText` in the current artifact text, replace with `newText`, fail with a clear error if `oldText` is not found
3. Add the deterministic post-generation validator in the PostToolUse hook — regex checks for elision markers, format consistency, null checks for NO_FIX/MISSING_CAPABILITY, basic structural integrity
4. On validation failure, append a system message forcing self-correction rather than silently accepting bad output

### Workstream B — System Prompt Reorder + Hardening
1. Reorder sections in system-prompt.ts: principles → persona → taxonomy → tools → platform_context → critical_rules → [boundary] → dynamic
2. Collapse persona to ≤150 tokens using the task-scoped framing from the spec
3. Rewrite anti-sycophancy directive as priority hierarchy
4. Add "NO_FIX is the default" principle with sufficiency check
5. Add memory-as-hint principle
6. Add terminal `<critical_rules>` recap before cache boundary
7. IMPORTANT: Keep `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` in exactly the same position relative to dynamic sections — do NOT move the cache boundary

### Workstream C — Diagnostic Engine Upgrades
1. Update the diagnostic system prompt with the inverted default framing ("NO_FIX is the default disposition")
2. Add the manager-correction-as-claim framing ("one datum, not ground truth")
3. Add `decision_trace` array to the strict JSON schema — 8 entries, one per category, each with verdict + reason
4. Add instruction to populate decision_trace BEFORE the final category
5. Write anchored-contrast exemplars for all 8 categories (one positive + one nearest-confusable negative each). These go inline in the taxonomy definitions. This should naturally push the prompt past 1,024 tokens for OpenAI cache eligibility
6. Implement self-consistency k=3: run 3 parallel diagnostic calls at temperature 0.7, majority-vote on category, disagreement → NO_FIX. Log all 3 to AiApiLog with a shared batchId

### Workstream D — Oscillation Fix
1. In hooks/shared.ts, find the oscillation confidence comparison and invert it — re-proposal within the 14-day window must have confidence ≥ originalConfidence × 1.25 (stricter, not easier)
2. Log the oscillation check result to the tuning event

### Workstream E — Memory Snapshot Optimization
1. In the system prompt builder where `<memory_snapshot>` is assembled, switch from injecting full key-value pairs to key + one-line summary only
2. Add header text: "These are summaries only. Use memory(op: 'view', key: '...') to load the full value when needed."
3. Update principles to reference lazy loading

## Rules

- Read before you edit. Always read the current file content before modifying. These files have been through 9 sprints of changes — don't assume you know what's there.
- The `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` marker is load-bearing for Anthropic's prompt caching. Do not remove, rename, or reposition it relative to the dynamic sections.
- The PreToolUse hook's compliance gate (regex-based sanction detection) is NOT being changed this sprint. Don't touch APPLY_SANCTION_PATTERNS or ROLLBACK_SANCTION_PATTERNS.
- The 48h cooldown constant is NOT being changed. Only the oscillation boost direction is being inverted.
- Do not add new API endpoints. Do not add new frontend pages. This sprint is backend-only intelligence hardening.
- Do not refactor, rename, or reorganize files beyond what's needed for the changes. Minimize diff surface.
- Run `npx tsc --noEmit` after each workstream to catch type errors.
- Commit after each workstream with a descriptive message.
