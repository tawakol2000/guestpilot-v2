# Implementation Quality Checklist: AI Flow Audit

**Purpose**: For Claude — validate that all implementation changes meet requirements before committing
**Created**: 2026-03-20
**Feature**: [spec.md](../spec.md) | [plan.md](../plan.md) | [research.md](../research.md)
**Actor**: Implementer (Claude)
**Timing**: After each phase, before commit

## Requirement Completeness

- [ ] CHK001 Are all 4 CRITICAL bugs (AUD-001, AUD-009, and variants) addressed with code changes? [Completeness, Research §Stage 1-2]
- [ ] CHK002 Are all 9 HIGH bugs addressed or explicitly deferred with justification? [Completeness, Research §All stages]
- [ ] CHK003 Are all 5 clarification decisions (FR-011 through FR-015) implemented? [Completeness, Spec §Clarifications]
- [ ] CHK004 Is the hostawayMessageId unique constraint migration included with pre-migration cleanup? [Completeness, Data-Model §Schema Change 1]
- [ ] CHK005 Are all 3 new return fields (centroidSimilarity, centroidThreshold, switchMethod) added to getReinjectedLabels()? [Completeness, Data-Model §Interface Changes]
- [ ] CHK006 Is the ragContext updated to include full chunk content (not truncated to 200 chars)? [Completeness, Spec §FR-007]
- [ ] CHK007 Are escalation signals injected into Claude's prompt content blocks? [Completeness, Spec §FR-012]

## Requirement Clarity

- [ ] CHK008 Is the atomic claim guard in the poll job using the exact same pattern as BullMQ worker (updateMany where fired:false)? [Clarity, Research §AUD-009]
- [ ] CHK009 Is the centroid topic switch threshold clearly sourced from topic_state_config.json, not hardcoded? [Clarity, Spec §FR-015]
- [ ] CHK010 Is the distinction between "centroid-primary, keyword-fallback" clearly enforced in the code flow? [Clarity, Spec §FR-015]
- [ ] CHK011 Is the host reply cancellation calling cancelPendingAiReply AND broadcasting ai_typing_clear SSE event? [Clarity, Spec §FR-011]

## Requirement Consistency

- [ ] CHK012 Is the aiMode check consistent between webhook handler, poll job, and BullMQ worker (all using whitelist)? [Consistency, Research §AUD-003/AUD-011]
- [ ] CHK013 Is getSopContent called with propertyAmenities in ALL paths — HIGH, MEDIUM, LOW, Tier 2, Tier 3? [Consistency, Spec §FR-013]
- [ ] CHK014 Is the _lastClassifierResult global eliminated everywhere — rag.service.ts, ai.service.ts, and judge call? [Consistency, Research §AUD-022/AUD-024]
- [ ] CHK015 Is the lmOverride → llmOverride typo fix applied in all frontend locations (type definition, usages)? [Consistency, Research §FE-001]

## Safety & Constitution Alignment

- [ ] CHK016 Does the judge service use lazy Anthropic client initialization (not top-level)? [Safety, Constitution §I, Research §AUD-052]
- [ ] CHK017 Does the addExample() call in judge have a validLabels.length > 0 guard in BOTH auto-fix and reinforcement paths? [Safety, Constitution §VII, Research §AUD-053/054]
- [ ] CHK018 Does the dimension validation in classifyWithLR throw before producing NaN scores? [Safety, Research §AUD-015]
- [ ] CHK019 Does cosineSimilarity validate that both vectors have the same length? [Safety, Research §AUD-016]
- [ ] CHK020 Does the system prompt in ai-config.json include the date cross-reference instruction for conditional SOPs? [Safety, Spec §FR-003]

## Cross-Tier Deduplication

- [ ] CHK021 Is retrievedChunks deduplicated by category AFTER all tiers (RAG + Tier 3 + Tier 2) have added their chunks? [Completeness, Spec §FR-001]
- [ ] CHK022 Does the dedup happen BEFORE buildPropertyInfo() assembles the prompt? [Clarity, Research §AUD-037]
- [ ] CHK023 Is the chunk count in ragContext reflecting the deduplicated count, not the pre-dedup count? [Consistency]

## Frontend & Observability

- [ ] CHK024 Does the pipeline feed include centroidSimilarity, centroidThreshold, and switchMethod? [Completeness, Data-Model §Pipeline Feed Response]
- [ ] CHK025 Does the pipeline feed include llmOverride data? [Completeness, Spec §FR-008]
- [ ] CHK026 Does the frontend display numeric centroid scores in the Tier 3 section? [Completeness, Spec §FR-005]
- [ ] CHK027 Is the AiApiLog index on [tenantId, conversationId] added to schema.prisma? [Completeness, Research §DB-002]

## Build & Deploy

- [ ] CHK028 Does `npx tsc --noEmit` pass with zero errors in backend? [Build]
- [ ] CHK029 Does `next build` pass with zero errors in frontend? [Build]
- [ ] CHK030 Is the schema migration sequenced correctly (cleanup → code → constraint)? [Deploy, Quickstart]

## Notes

- Check items off as code changes are verified
- Each CHK maps to a specific research finding or spec requirement
- CRITICAL and HIGH items (CHK001-CHK002) must ALL pass before any commit
