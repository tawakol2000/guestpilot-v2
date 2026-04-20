# Tuning Agent — Session Handover

> Last updated: 2026-04-17
> For: next Cowork session continuing tuning agent development

---

## What Was Done This Session

### 1. Research Phase
- Read and analyzed two research papers:
  - **Claude Code source leak** (512K lines TypeScript) — architectural patterns for prompt caching, memory, compaction, tool systems, verification subagents
  - **Claude AI deep research** — 14-topic paper on tuning agent intelligence + system prompt engineering, 40+ cited papers
- Cross-referenced both papers against the actual GuestPilot tuning codebase
- Synthesized findings into actionable recommendations

### 2. Files Created This Session

| File | Purpose |
|------|---------|
| `specs/041-conversational-tuning/tuning-research-recommendations.md` | Master reference — 9 modifications, 8 additions, 10 deferred items, 6 cross-apply notes. Status-tagged (SPRINT 10, SPRINT 11+, DEFERRED, BACKLOG, CROSS-APPLY) |
| `specs/041-conversational-tuning/sprint-10-research-implementation.md` | Sprint 10 spec — 5 workstreams (proposedText format, prompt reorder, diagnostic upgrades, oscillation fix, memory optimization), 20 acceptance criteria |
| `specs/041-conversational-tuning/sprint-10-system-prompt.md` | Claude Code system prompt for sprint 10 execution |
| `specs/041-conversational-tuning/tuning-agent-research-prompt.md` | The original research prompt given to Claude AI (both system prompts embedded + 14 topics) |
| `specs/main-ai-system-prompt-rewrite.md` | Claude AI prompt to rewrite coordinator + screening + manager translator system prompts (5 improvements, 11 constraints) |
| `specs/main-ai-pipeline-improvements.md` | Sprint spec for main AI pipeline changes (timestamps, message compaction, summary scope, baked-in SOP fix, image cache fix, screening reasoning, get_faq telemetry) |
| `specs/main-ai-pipeline-improvements-system-prompt.md` | Claude Code system prompt for pipeline improvements |

### 3. Research Papers (uploaded, referenced)
- `Claude Leak.md` — full analysis of the Claude Code npm source leak
- `Tuning Agent critique and roadmap.md` — Claude AI's 14-topic research output with prioritized roadmap

### 4. Main AI Audit
- Comprehensive audit of coordinator + screening system prompts, AI pipeline (28-step flow), tool system, SOP system, summary service, escalation enrichment, task manager, debounce, tenant config
- Identified 12 improvement areas, prioritized top 5
- User reviewed and approved a new screening prompt (with confidence field, injection example, voice tag) — not yet committed to code

---

## What's Already Been Implemented (discovered in codebase audit)

Several items from the pipeline improvements spec have ALREADY been built by Claude Code in prior sessions:

- **Message timestamps** — already injected into conversation history
- **Message compaction** — `message-compaction.service.ts` exists, `Message.compactedContent` field exists, 500-char threshold, gpt-5-nano compaction at save time
- **aiConfidence** — written to Message on save
- **Langfuse observability** — `observability.service.ts` with AsyncLocalStorage, spans wired throughout pipeline
- **System prompts v28** — coordinator and screening prompts already updated with `<scheduled_time>` block, confidence scale, injection-attack example
- **Tuning agent tools** — now 10 tools (not 8): added `search-replace` tool and a `names`/`types` module
- **Elision validator** — `validators/elision-patterns.ts` already exists in the tuning agent

### Items from pipeline spec that may still be needed (verify before executing):
- Summary scope expansion (check if `summary.service.ts` EXCLUDE list was updated)
- Baked-in SOPs injection verification
- Image instructions moved to dynamic content block
- Screening reasoning effort set to `low`
- get_faq telemetry logging

---

## What's Pending

### Ready for Claude Code sessions:
1. **Sprint 10 — Tuning agent intelligence upgrades** — Some items may already be done (search/replace tool exists, elision validator exists). MUST audit before executing. Remaining items likely: prompt reorder (principles-first), diagnostic self-consistency k=3, diagnostic decision_trace field, anchored-contrast exemplars, oscillation inversion, memory lazy loading, anti-sycophancy reframe.
2. **Main AI pipeline improvements** — PARTIALLY DONE (see above). Audit what remains before executing.

### Ready for Claude AI:
3. **System prompt rewrite** (`main-ai-system-prompt-rewrite.md`) — May need updating since prompts are now at v28 with confidence field and scheduled_time block. Read the current prompts in ai.service.ts before pasting into Claude AI.

### Not yet specced:
4. **Build mode for the tuning agent** — THE NEXT TASK (see below)

---

## Next Task: Build Mode for the Tuning Agent

### What it is
A second operating mode for the tuning agent where users can create their AI's behavior from scratch through conversation, rather than only fixing mistakes after the fact. This is the key unlock for commercialization — "vibe code your AI through chat."

### Current state (tune mode only)
- Triggered when a manager edits/rejects an AI response
- Diagnostic classifies the correction into 1 of 8 categories
- Conversational agent proposes artifact fixes (SOPs, FAQs, system prompt, tools)
- Requires an evidence bundle (what the AI saw, what it did wrong)

### What build mode needs
- Entry point that doesn't require a failed AI message
- The tuning agent acts as an onboarding interviewer — asks about the business, understands the domain, generates initial artifacts
- Can create system prompts, SOPs/knowledge entries, FAQs, and tool definitions from conversation
- No diagnostic taxonomy needed in build mode — different tool set (create vs fix)
- Must use the same prompt architecture: XML tags, principles-first ordering, terminal recap, cache boundary, hook enforcement

### Architecture decisions already made
- Keep it hospitality/property-management locked for now (don't generalize to e-commerce yet)
- Same Claude Sonnet 4.6 model as tune mode
- Same Claude Agent SDK with hooks
- Same frontend (tuning chat interface)
- The system prompt should follow everything learned from the research: U-shaped attention (principles first, recap last), anti-sycophancy priority hierarchy, memory-as-hint, task-scoped persona

### Open questions for next session
- Does build mode get its own system prompt or does the existing prompt branch based on mode?
- What tools does build mode need? (create_sop, create_faq, write_system_prompt, preview_ai_response?)
- How does the handoff from build mode to tune mode work? (user finishes setup → first guest messages come in → corrections trigger tune mode)
- Should build mode have a structured onboarding flow (step 1: describe your business, step 2: define policies, etc.) or fully freeform?
- How does build mode handle the seed prompts? Does it generate a new SEED_COORDINATOR_PROMPT from scratch or fill in a template?

---

## Key Technical Context

### Tuning Agent Architecture
- **Conversational model:** Claude Sonnet 4.6 via Claude Agent SDK
- **Diagnostic model:** GPT-5.4 full with reasoning:high, strict JSON schema
- **Hooks:** PreToolUse (compliance gate, 48h cooldown, 14-day oscillation), PostToolUse (Langfuse logging, acceptance stats, preference pairs), PreCompact (memory reinjection), Stop (follow-up)
- **Tools (10):** get_context, search_corrections, fetch_evidence_bundle, propose_suggestion, suggestion_action, memory, get_version_history, rollback, search_replace, names/types
- **Validators:** elision-patterns.ts (prevents truncation of applied text)
- **Frontend:** /tuning/* pages (queue, chat, history, capability requests, pairs, sessions, agent settings, playground)
- **Cache:** `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` separates static prefix (~2,400 tokens) from dynamic suffix (~500 tokens). 0.999 cache hit rate.

### Main AI Architecture
- **Model:** GPT-5.4-mini (coordinator + screening), GPT-5-nano (summaries, task dedup, message compaction)
- **Pipeline:** 28-step flow in ai.service.ts (~2300 lines)
- **Prompts:** v28 — SEED_COORDINATOR_PROMPT (with scheduled_time block, confidence scale), SEED_SCREENING_PROMPT (with confidence field, injection example, voice tag), MANAGER_TRANSLATOR_SYSTEM_PROMPT
- **Tools (6 system):** get_sop, get_faq, search_available_properties, create_document_checklist, check_extend_availability, mark_document_received
- **Output schemas:**
  - Coordinator: `{guest_message, escalation, resolveTaskId, updateTaskId, confidence, scheduledTime?}`
  - Screening: `{guest message, confidence, manager: {needed, title, note}}`
- **Message compaction:** gpt-5-nano, 500-char threshold, cached on `Message.compactedContent`
- **Observability:** Langfuse with AsyncLocalStorage spans

### Features on Current Branch (044-doc-handoff-whatsapp)
- **041:** Full tuning agent workbench (diagnostic, conversational agent, 10 tools, hooks, frontend, 9 sprints)
- **042:** Translation toggle (provider-abstracted, cached on `Message.contentTranslationEn`)
- **043:** Check-in/checkout action cards (auto-accept thresholds, reply templates, `TaskActionLog`)
- **044:** WhatsApp doc-handoff state machine (WAsender, `DocumentHandoffState`, 2-min polling job)

### Features on Main Only (not yet merged to 044)
- iOS/APNs push notifications (`IosPushToken`, `apns.service.ts`)
- Rate limiting on mutation endpoints
- `GET/PATCH /api/me` tenant profile endpoint
- Extended socket event broadcasting

### Branch
- **Current:** `feat/044-doc-handoff-whatsapp` — 124 commits ahead of origin/main
- **Main has diverged** with iOS/APNs work not yet merged back
- New work should either branch from 044 or resolve the main↔044 divergence first

### Sprints completed (tuning agent)
- Sprint 01-07: Core tuning feature
- Sprint 08: V2 foundations (retention summary, escalation-triggered events, preference pairs, graduation metrics, per-category confidence gating)
- Sprint 09: Production hardening (18 bug fixes)
- Sprint 10: Spec written, partially implemented (search/replace tool + elision validator exist; prompt reorder, self-consistency, diagnostic upgrades still pending)

---

## Reference Files for Next Session

### Research & Recommendations
- `specs/041-conversational-tuning/tuning-research-recommendations.md` — full recommendation list with status tags
- `specs/041-conversational-tuning/tuning-agent-research-prompt.md` — the research prompt (for reference)

### Pending Specs (audit before executing — some items already done)
- `specs/041-conversational-tuning/sprint-10-research-implementation.md`
- `specs/041-conversational-tuning/sprint-10-system-prompt.md`
- `specs/main-ai-system-prompt-rewrite.md` — needs updating to reflect v28 prompts
- `specs/main-ai-pipeline-improvements.md` — partially implemented
- `specs/main-ai-pipeline-improvements-system-prompt.md`

### Key Code Files
- `backend/src/tuning-agent/system-prompt.ts` — tuning agent prompt
- `backend/src/tuning-agent/tools/` — all 10 tool definitions
- `backend/src/tuning-agent/hooks/` — all 4 hooks
- `backend/src/services/tuning/diagnostic.service.ts` — diagnostic engine
- `backend/src/services/ai.service.ts` — main AI pipeline + system prompts
- `backend/src/services/message-compaction.service.ts` — nano compaction
- `backend/src/services/observability.service.ts` — Langfuse tracing
- `backend/prisma/schema.prisma` — full schema

---

## User Preferences (for tone/workflow)
- Name: Abdelrahman (ab.tawakol@gmail.com)
- Prefers direct, no-fluff communication
- Wants specs (md file) + system prompts for fresh Claude Code sessions
- Likes to review and approve before execution
- Pushes back when things are overcomplicated — keep it simple
- Tested decision trees for screening and found prose works better
- Values the research but wants practical application, not academic exercises
- Goal: commercialize GuestPilot as a vibe-codeable AI chatbot platform
- Near-term: keep hospitality/property-management locked, add build mode to tuning agent
- Model decisions: stay on Sonnet for tuning agent, GPT-5.4 for diagnostic, no fine-tuning
