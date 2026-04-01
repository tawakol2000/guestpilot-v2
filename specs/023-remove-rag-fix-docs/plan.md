# Implementation Plan: Remove RAG/Classifier Dead Code + Fix Document Checklist

**Branch**: `023-remove-rag-fix-docs` | **Date**: 2026-04-01 | **Spec**: [spec.md](spec.md)

## Summary

Remove ~1,500 lines of dead RAG, classifier, and embeddings code that was replaced by the `get_sop` tool system. Drop 3 unused database tables. Fix marriage certificate enforcement in the document checklist screening flow. Clean up the judge service's classifier dependency.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+
**Primary Dependencies**: Express 4.x, Prisma ORM, OpenAI SDK
**Storage**: PostgreSQL + Prisma ORM (dropping 3 tables, removing 4 fields)
**Testing**: Battle test agents (turn.ts scripts)
**Target Platform**: Railway (backend), Vercel (frontend)
**Project Type**: Web service (backend API)
**Constraints**: Zero downtime — production guests must not be affected during deployment

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| §I Graceful Degradation | PASS | Removing unused code. The `get_sop` tool pipeline is unaffected. No new failure modes introduced. |
| §II Multi-Tenant Isolation | PASS | No changes to tenant scoping. The "classifier training data shared globally" exception in §II becomes irrelevant — note for future constitution update. |
| §III Guest Safety & Access Control | PASS | Marriage cert fix strengthens compliance. No access control changes. |
| §IV Structured AI Output | PASS | No changes to output schemas. |
| §V Escalate When In Doubt | PASS | Escalation system untouched. |
| §VI Observability | NOTE | Constitution references ClassifierEvaluation and RAG context in AiApiLog. These are being removed. The `ragContext` JSON field in AiApiLog is KEPT (still used for pipeline metadata like tool calls, SOP classification). Constitution §VI should be updated in a future amendment to remove classifier references. |
| §VII Self-Improvement | NOTE | Entire classifier self-improvement loop is removed. Constitution §VII becomes mostly irrelevant. Future amendment needed. |

**Gate result**: PASS — no violations. Two principles need future constitution amendments (out of scope for this feature).

## Project Structure

### Documentation (this feature)

```text
specs/023-remove-rag-fix-docs/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output (schema changes)
└── checklists/
    └── requirements.md  # Spec quality checklist
```

### Source Code (affected files)

```text
backend/
├── src/
│   ├── services/
│   │   ├── rag.service.ts          # DELETE (662 lines)
│   │   ├── embeddings.service.ts   # DELETE (207 lines)
│   │   ├── rerank.service.ts       # DELETE (78 lines)
│   │   ├── judge.service.ts        # MODIFY (remove ClassifierEvaluation writes)
│   │   ├── ai.service.ts           # MODIFY (remove RAG retrieval call)
│   │   ├── import.service.ts       # MODIFY (remove ingestPropertyKnowledge call)
│   │   └── tenant-config.service.ts # No change (field removal handled by schema)
│   ├── controllers/
│   │   ├── knowledge.controller.ts # MODIFY (remove appendLearnedAnswer, rateMessage, gap analysis)
│   │   └── conversations.controller.ts # MODIFY (clean ragContext from AI log query)
│   ├── routes/
│   │   ├── knowledge.ts            # MODIFY (remove 7 endpoints)
│   │   ├── properties.ts           # MODIFY (remove ingestPropertyKnowledge)
│   │   └── sandbox.ts              # MODIFY (remove retrieveRelevantKnowledge)
│   ├── config/
│   │   └── ai-config.json          # MODIFY (add marriage cert enforcement to screening prompt)
│   ├── server.ts                   # MODIFY (remove embedding init)
│   └── app.ts                      # MODIFY (remove reindex-knowledge endpoint)
├── prisma/
│   └── schema.prisma               # MODIFY (drop 3 models, remove 4 fields)
```

## Implementation Phases

### Phase 1: Delete Service Files (FR-001)

Delete these 3 files entirely:
- `backend/src/services/rag.service.ts` (662 lines)
- `backend/src/services/embeddings.service.ts` (207 lines)
- `backend/src/services/rerank.service.ts` (78 lines)

### Phase 2: Schema Changes (FR-002, FR-003)

**Drop models** from `prisma/schema.prisma`:
- `PropertyKnowledgeChunk` (and its relations in Tenant, Property)
- `ClassifierExample` (and its relation in Tenant)
- `ClassifierEvaluation` (and its relation in Tenant)

**Remove fields** from `TenantAiConfig`:
- `ragEnabled`
- `classifierVoteThreshold`
- `classifierContextualGate`
- `embeddingProvider`

**Keep**: `ragContext Json?` field in `AiApiLog` — still used for pipeline metadata (tool calls, SOP classification, cost tracking).

Run `npx prisma db push` to apply.

### Phase 3: Remove Imports and Calls (FR-004, FR-006, FR-007, FR-008)

**ai.service.ts**:
- Remove `import { retrieveRelevantKnowledge }`
- Remove `import { evaluateAndImprove }`
- Remove the RAG retrieval block (~10 lines)
- Remove the `evaluateAndImprove` fire-and-forget call
- Keep `ragContext` field in AiApiLog writes (still populated with tool/SOP metadata)

**sandbox.ts**:
- Remove `import { retrieveRelevantKnowledge }`
- Remove the RAG retrieval call and result handling
- Set `retrievedChunks` to empty array

**server.ts**:
- Remove `import { seedTenantSops, ingestPropertyKnowledge }`
- Remove `import { setEmbeddingProvider }`
- Remove the background re-embedding initialization block

**routes/properties.ts**:
- Remove `import { ingestPropertyKnowledge }`
- Remove `ingestPropertyKnowledge` call in property resync handler

**app.ts**:
- Remove the `reindex-knowledge` endpoint

**controllers/knowledge.controller.ts**:
- Remove `import { appendLearnedAnswer }`
- Remove `appendLearnedAnswer` call
- Remove `rateMessage` endpoint (writes to ClassifierExample/ClassifierEvaluation)
- Remove ClassifierEvaluation/ClassifierExample queries from gap analysis

### Phase 4: Remove API Endpoints (FR-005)

**routes/knowledge.ts** — remove these endpoints:
- POST `/seed-sops`
- GET `/chunk-stats`
- GET `/chunks`
- PATCH `/chunks/:id`
- DELETE `/chunks/:id`
- GET `/evaluations`
- GET+POST `/classifier-thresholds`
- POST `/gap-analysis`

### Phase 5: Clean Up Judge Service (FR-009)

**judge.service.ts**:
- Remove the `ClassifierEvaluation` create call
- Remove the `ClassifierExample` update call
- If the remaining function body is empty/useless, delete the service entirely
- Remove the import from `ai.service.ts`

### Phase 6: Fix Marriage Certificate (FR-010)

**Option A** (preferred): Update the `create_document_checklist` tool description in the screening system prompt or tool definition to explicitly state: "For Arab married couples, ALWAYS set marriage_certificate_needed to true."

**Option B**: Update the `create_document_checklist` tool handler to auto-set `marriage_certificate_needed: true` when the guest party includes an Arab married couple. This requires the tool to have access to nationality and party composition context.

Check the tool definition in the SOP service or tool-definition table and the screening system prompt in `ai-config.json`.

### Phase 7: Verify and Test (FR-011, FR-012)

1. Run `npx tsc --noEmit` — must compile clean
2. Run `npx prisma db push` — tables dropped, schema clean
3. Start the server locally or deploy to Railway
4. Spawn a battle test agent to verify:
   - Guest message → AI response via get_sop (no RAG)
   - Arab married couple → create_document_checklist with marriage_cert=true
   - Property resync works without RAG ingestion
