# Implementation Plan: Smart Conversation Context Summarization

**Branch**: `024-smart-context-summary` | **Date**: 2026-04-01 | **Spec**: [spec.md](spec.md)

## Summary

Reduce conversation history from 20 raw messages to 10, plus an AI-generated summary of older messages. Summary is generated asynchronously (fire-and-forget after AI response) using the cheapest available model. Only GUEST + AI messages count toward the window. The Conversation model already has unused `conversationSummary`, `summaryUpdatedAt`, and `summaryMessageCount` fields — these will be activated.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+
**Primary Dependencies**: Express 4.x, Prisma ORM, OpenAI SDK (for summarization calls)
**Storage**: PostgreSQL + Prisma ORM (existing `conversationSummary` fields on Conversation model)
**Testing**: Battle test agents (turn.ts scripts)
**Target Platform**: Railway (backend)
**Project Type**: Web service (backend API)
**Performance Goals**: Zero added latency to AI responses (async summarization)
**Constraints**: Summary generation uses cheapest model (gpt-5.4-nano or equivalent). Summary capped at 150 words.
**Scale/Scope**: ~50 active conversations per tenant

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| §I Graceful Degradation | PASS | Summary generation failure falls back to 10 raw messages — no guest impact. Fire-and-forget pattern. |
| §II Multi-Tenant Isolation | PASS | Summary stored on Conversation model which has tenantId. All queries already scoped. |
| §III Guest Safety & Access Control | PASS | Summary is internal context — never exposed to guests. No access control changes. |
| §IV Structured AI Output | PASS | Summary is a plain text content block, not an AI output schema change. |
| §V Escalate When In Doubt | PASS | Escalation system unchanged. Summary provides better context for escalation decisions. |
| §VI Observability | PASS | Summary text will be visible in AI logs (part of user content blocks). |
| §VII Self-Improvement | N/A | No classifier or judge interaction. |

**Gate result**: PASS — no violations.

## Project Structure

### Documentation (this feature)

```text
specs/024-smart-context-summary/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 output
└── checklists/
    └── requirements.md  # Spec quality checklist
```

### Source Code (affected files)

```text
backend/
├── src/
│   ├── services/
│   │   ├── ai.service.ts            # MODIFY — change history from 20→10, inject summary block, trigger async summarization
│   │   └── summary.service.ts       # CREATE — summarization logic (generate, extend, store)
│   ├── routes/
│   │   └── sandbox.ts               # MODIFY — mirror history changes for sandbox route
│   └── config/
│       └── ai-config.json           # MODIFY — update messageHistoryCount to 10
├── prisma/
│   └── schema.prisma                # NO CHANGE — fields already exist (conversationSummary, summaryUpdatedAt, summaryMessageCount)
```

## Implementation Phases

### Phase 1: Create Summary Service (FR-002, FR-003, FR-005, FR-006, FR-007, FR-008)

Create `backend/src/services/summary.service.ts`:

**`generateOrExtendSummary(conversationId, prisma)`**:
1. Query the Conversation record for existing `conversationSummary`, `summaryMessageCount`
2. Fetch all GUEST + AI messages for the conversation, ordered by sentAt
3. Calculate total message count and determine how many are outside the 10-message window
4. If `summaryMessageCount` already covers all messages outside the window → skip (no work needed)
5. If no existing summary → generate from scratch using all messages before the window
6. If existing summary exists → extend it by feeding the existing summary + newly scrolled-out messages to the model
7. Store result in `conversationSummary`, update `summaryUpdatedAt` and `summaryMessageCount`

**Summarization prompt** (system instructions for the cheap model):
- "You are summarizing a guest conversation for a hotel AI assistant. Extract ONLY: guest identity details, special arrangements, preferences that affect service, expressed dissatisfaction, key decisions. EXCLUDE: routine service exchanges (cleaning times, WiFi, amenity requests) — these are tracked separately. Maximum 150 words. Output plain text, no formatting."

**Model choice**: Use `gpt-5.4-nano` (cheapest available). Fire-and-forget — errors logged but never block pipeline.

### Phase 2: Modify AI Service History Logic (FR-001, FR-004, FR-009, FR-011)

**ai.service.ts** changes:

1. Change `.slice(-20)` to `.slice(-10)` for `historyMsgs` (line ~1397)
2. After building `historyText`, check if conversation has a stored summary:
   - Query `conversationSummary` from the Conversation record
   - If summary exists, prepend it as a `### CONTEXT SUMMARY ###` content block before the conversation history
3. After the AI response is sent (fire-and-forget block at the end), trigger `generateOrExtendSummary(conversationId, prisma)`:
   - Only if total GUEST+AI message count > 10
   - Catch and log errors — never block
4. Update the `messageHistoryCount` in `ai-config.json` to 10 (documentation/config sync)

### Phase 3: Update Sandbox Route (FR-001)

**sandbox.ts** changes:
- Mirror the history slice change from 20 to 10
- Inject summary if available (same logic as ai.service.ts)

### Phase 4: Verify and Test (FR-009, FR-010)

1. Run `npx tsc --noEmit` — must compile clean
2. Deploy to Railway
3. Test with an existing conversation that has 15+ messages — verify:
   - AI receives 10 raw messages + summary
   - Summary captures critical context from early messages
   - Summary excludes routine operational exchanges
   - No added latency to AI response
4. Test with a new conversation (< 10 messages) — verify no summary is generated
5. Test summary generation failure (temporarily break the model name) — verify graceful fallback
