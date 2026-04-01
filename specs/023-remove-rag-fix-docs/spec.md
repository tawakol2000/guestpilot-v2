# Feature Specification: Remove RAG/Classifier Dead Code + Fix Document Checklist

**Feature Branch**: `023-remove-rag-fix-docs`
**Created**: 2026-04-01
**Status**: Draft
**Input**: Remove all RAG, classifier, and embeddings dead code from the backend. Fix marriage certificate requirement in document checklist for Arab married couples.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Remove Dead RAG/Classifier/Embeddings Code (Priority: P1)

The platform previously used a RAG (retrieval-augmented generation) system with vector embeddings and a KNN classifier for SOP routing. These were replaced by the `get_sop` tool-based system. The old code (RAG retrieval, embedding generation, classifier evaluation, reranking) is no longer used but still exists in the codebase — approximately 1,500 lines across 14 files, plus 3 database tables. This dead code adds maintenance burden, confusion for developers, and unnecessary database overhead. It should be completely removed.

**Why this priority**: Dead code removal is the largest scope item. It affects the most files, requires a database migration, and reduces long-term maintenance burden. Must be done first because other changes may touch the same files.

**Independent Test**: After removal, the AI pipeline continues to function identically — guest messages are processed, SOPs are fetched via the `get_sop` tool, escalations are created, and responses are delivered. No RAG retrieval, embedding generation, or classifier evaluation occurs. The application starts without errors.

**Acceptance Scenarios**:

1. **Given** the backend is deployed with all RAG/classifier/embeddings code removed, **When** a guest sends a message, **Then** the AI processes it using the `get_sop` tool and responds correctly (no RAG retrieval step).
2. **Given** the Prisma schema no longer contains PropertyKnowledgeChunk, ClassifierExample, or ClassifierEvaluation models, **When** `prisma db push` is run, **Then** the corresponding tables are dropped from the database without affecting other tables.
3. **Given** the embedding and rerank services are deleted, **When** the application starts, **Then** no embedding provider initialization occurs and no errors are thrown.
4. **Given** the property resync endpoint is called, **When** a property is updated from Hostaway, **Then** the property data is saved without attempting to ingest RAG knowledge chunks.
5. **Given** a developer searches the codebase for "rag", "classifier", "embedding", "rerank", **When** excluding test/spec files, **Then** no references exist in backend source code.

---

### User Story 2 - Fix Marriage Certificate Requirement for Arab Couples (Priority: P2)

When an Arab married couple books a stay, the screening AI should always request a marriage certificate as part of the document checklist. Currently, the AI inconsistently sets `marriage_certificate_needed` — sometimes `true`, sometimes `false` for the same type of guest (Arab married couple). The marriage certificate requirement must be reliably enforced for all Arab married couples.

**Why this priority**: This is a compliance requirement for the property. Missing marriage certificates from Arab couples violates house rules and could create legal issues.

**Independent Test**: When an Arab married couple inquires about booking, the `create_document_checklist` tool is called with `marriage_certificate_needed: true` every time, without exception.

**Acceptance Scenarios**:

1. **Given** an Egyptian married couple with 1 child inquires, **When** the screening AI processes the inquiry, **Then** `create_document_checklist` is called with `passports_needed: 3` and `marriage_certificate_needed: true`.
2. **Given** a Saudi married couple with 2 children inquires, **When** the screening AI processes the inquiry, **Then** `create_document_checklist` is called with `passports_needed: 4` and `marriage_certificate_needed: true`.
3. **Given** a British solo male inquires, **When** the screening AI processes the inquiry, **Then** `create_document_checklist` is called with `passports_needed: 1` and `marriage_certificate_needed: false`.
4. **Given** a group of 2 Arab females (not married) inquires, **When** the screening AI processes the inquiry, **Then** `create_document_checklist` is called with `passports_needed: 2` and `marriage_certificate_needed: false`.

---

### User Story 3 - Clean Up Judge Service Classifier Dependencies (Priority: P3)

The judge service writes evaluation results to the `ClassifierEvaluation` table, which is being removed. The judge service must be updated to remove this dependency, or be removed entirely if it serves no purpose without the classifier.

**Why this priority**: Depends on Story 1 (table removal). Lower priority because it's a cascading cleanup from the main removal.

**Independent Test**: After the judge service is updated or removed, the AI pipeline processes messages without errors. No writes to non-existent tables occur.

**Acceptance Scenarios**:

1. **Given** the ClassifierEvaluation table is removed, **When** the AI processes a message that would trigger judge evaluation, **Then** no error is thrown and the response is delivered normally.
2. **Given** the judge service dependency is removed from the AI service, **When** the AI generates a response, **Then** no post-response evaluation step occurs.

---

### Edge Cases

- What happens if the database still has data in the removed tables when the migration runs? The migration must drop the tables cleanly regardless of existing data.
- What happens if a property resync is triggered after RAG removal? The resync should update property data without attempting knowledge chunk ingestion.
- What happens if existing AiApiLog entries have `ragContext` data? Existing entries retain their data; new entries no longer populate RAG-specific fields but may still use this field for pipeline metadata (tool calls, SOP classification).
- What happens if a tenant has `ragEnabled: true` in their config? The field is removed from the schema; any code checking this field is also removed.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST delete the `rag.service.ts`, `embeddings.service.ts`, and `rerank.service.ts` service files entirely.
- **FR-002**: System MUST remove the `PropertyKnowledgeChunk`, `ClassifierExample`, and `ClassifierEvaluation` models from the Prisma schema and drop the corresponding database tables.
- **FR-003**: System MUST remove the `ragEnabled`, `classifierVoteThreshold`, `classifierContextualGate`, and `embeddingProvider` fields from the `TenantAiConfig` model.
- **FR-004**: System MUST remove all imports and function calls referencing `retrieveRelevantKnowledge`, `ingestPropertyKnowledge`, `appendLearnedAnswer`, `setEmbeddingProvider`, `getEmbeddingProvider`, and `evaluateAndImprove` from all files.
- **FR-005**: System MUST remove all RAG-related API endpoints: seed-sops, chunks CRUD, evaluations, classifier-thresholds, gap-analysis, reindex-knowledge.
- **FR-006**: System MUST remove the RAG retrieval step from the AI pipeline so messages are processed without embedding search.
- **FR-007**: System MUST remove the RAG retrieval step from the sandbox route.
- **FR-008**: System MUST update the property resync endpoint to no longer call `ingestPropertyKnowledge`.
- **FR-009**: System MUST remove or update the judge service to eliminate ClassifierEvaluation writes.
- **FR-010**: System MUST ensure the screening system prompt or tool description enforces `marriage_certificate_needed: true` for all Arab married couples.
- **FR-011**: System MUST continue to function correctly after all removals — the `get_sop` tool, escalation system, document checklist tools, and all other AI features must work unchanged.
- **FR-012**: System MUST compile without errors after all changes.

### Key Entities

- **AiApiLog**: The `ragContext` JSON field may be kept for backward compatibility with existing log entries. New entries will no longer populate RAG-specific fields but continue using it for pipeline metadata.
- **TenantAiConfig**: Loses 4 fields related to RAG/classifier configuration. All remaining fields are unaffected.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Zero references to RAG/classifier/embedding services in production backend source code.
- **SC-002**: 3 database tables removed (PropertyKnowledgeChunk, ClassifierExample, ClassifierEvaluation) after migration.
- **SC-003**: Application starts and processes guest messages end-to-end without errors after all changes.
- **SC-004**: Arab married couple screening always produces `marriage_certificate_needed: true` in the document checklist.
- **SC-005**: Property resync completes successfully without RAG ingestion.
- **SC-006**: Approximately 1,500 lines of dead code removed from the codebase.
