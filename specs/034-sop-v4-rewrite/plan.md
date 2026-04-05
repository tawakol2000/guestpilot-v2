# Implementation Plan: SOP Library v4 Rewrite

**Branch**: `034-sop-v4-rewrite` | **Date**: 2026-04-06 | **Spec**: [spec.md](spec.md)
**Depends on**: `033-coordinator-prompt-rework`

## Summary

Rewrite all 22 SOP categories in structured Markdown with XML tags. Split multi-status SOPs. Add action enum and sop_step to coordinator schema. Add pre-computed context variables. Add post-parse validation. Update system prompt with SOP reading instructions and bookended constraints. Remove back-to-back auto-enrichment (replaced by pre-computed context).

## Files to Change

| File | Change |
|------|--------|
| `backend/src/services/sop.service.ts` | Replace SEED_SOP_CONTENT and SEED_STATUS_VARIANTS with v4 content |
| `backend/src/services/ai.service.ts` | Schema (action + sop_step), pre-computed context, prompt update, validation, remove auto-enrichment |
| `backend/src/routes/sandbox.ts` | Schema sync, pre-computed context for sandbox |

## Implementation Phases

### Phase 1: Schema + Validation
- Add `action` and `sop_step` to COORDINATOR_SCHEMA
- Add post-parse validation function
- Wire validation into pipeline

### Phase 2: Pre-Computed Context
- Add computeContextVariables function
- Add {PRE_COMPUTED_CONTEXT} template variable
- Inject into content blocks
- Remove back-to-back auto-enrichment from get_sop handler

### Phase 3: System Prompt Updates  
- Add "How to read SOPs" section
- Bookend hard constraints (top + bottom)
- Update "none" handling in tool routing

### Phase 4: SOP Content Rewrite
- Replace all SEED_SOP_CONTENT entries
- Replace all SEED_STATUS_VARIANTS entries  
- All in structured Markdown with XML tags, paths, rules, examples

### Phase 5: Sandbox + Polish
- Sync sandbox schema
- Type check
- Verify template variable interpolation still works
