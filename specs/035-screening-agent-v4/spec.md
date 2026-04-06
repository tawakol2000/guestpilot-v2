# Feature Specification: Screening Agent v4 Rewrite

**Feature Branch**: `035-screening-agent-v4`
**Created**: 2026-04-06
**Status**: Implemented
**Depends on**: `033-coordinator-prompt-rework`, `034-sop-v4-rewrite`

## Summary

Bring the screening agent to v4 parity with the coordinator: add reasoning field, action enum (7 screening-specific values), sop_step traceability, rename guest message → guest_message, rewrite prompt with named screening paths A-Q, multilingual support, pre-computed screening context, positive directives, bookended constraints, and worked examples.

## Changes Made

### Schema
- Added `reasoning`, `action` (enum: reply, ask, screen_eligible, screen_violation, escalate_info_request, escalate_unclear, awaiting_manager), `sop_step` to SCREENING_SCHEMA
- Renamed `"guest message"` → `"guest_message"` for consistency with coordinator
- Updated all parsing locations: ai.service.ts, sandbox.ts, ai-config.controller.ts

### System Prompt
- Full rewrite of SEED_SCREENING_PROMPT with named screening paths (A through R)
- Operating rules bookended (top + bottom)
- Escalation title vocabulary (17 fixed titles)
- Tool usage with SOP-first pattern
- Tone/language: multilingual (removed "Always English"), Arabic formality matching
- Conversation repair section
- 3 worked examples showing reasoning, action, sop_step
- Content blocks preserved with {PRE_COMPUTED_CONTEXT} added

### Pre-Computed Context
- Extended computeContextVariables with screening-specific fields:
  - existing_screening_escalation_exists (boolean)
  - existing_screening_title (string or null)
  - document_checklist_already_created (boolean)
- These are injected for inquiry/pending guests only

### Response Parsing
- Screening responses now extract reasoning, action, sop_step into ragContext
- Backward compatibility maintained for "guest message" (space) field name

## Files Modified
- `backend/src/services/ai.service.ts` — schema, prompt, parsing, context
- `backend/src/routes/sandbox.ts` — parsing update
- `backend/src/controllers/ai-config.controller.ts` — parsing update
