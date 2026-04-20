# Feature Specification: Deep Code Cleanup

**Feature Branch**: `022-deep-code-cleanup`
**Created**: 2026-03-29
**Status**: Draft
**Input**: Full codebase audit — identify all dead, disabled, and unused code across backend and frontend, then surgically remove it without breaking active functionality.

## Codebase Audit Results

### Current Active AI Flow

1. Guest sends message via Hostaway webhook
2. Message saved, debounce scheduled (2s copilot / 30s autopilot)
3. BullMQ worker or debounce poll fires AI generation
4. SOP classification via forced get_sop tool call (DB-backed, status-aware variants)
5. RAG retrieval (pgvector + Cohere reranking)
6. Template variable resolution (content blocks separated from system prompt for caching)
7. OpenAI GPT-5.4 Mini Responses API call with JSON schema output
8. Copilot: store suggestion, SSE broadcast / Autopilot: send via Hostaway, save, SSE broadcast

### Active Features (DO NOT TOUCH)

- AI messaging pipeline (coordinator + screening agents)
- SOP tool routing with DB-backed definitions and status variants
- Copilot mode (suggestion hold, approve, re-suggest)
- Autopilot mode (auto-send)
- Adaptive debounce (3x/6x multiplier for rapid messages)
- RAG knowledge retrieval with pgvector + Cohere reranking
- Document checklist (screening creates, coordinator marks received)
- Task management (AI dedup, resolve, update)
- Tool definitions (webhook-based custom tools)
- Property search + extend stay tools
- Judge self-improvement (evaluate + auto-fix)
- Escalation enrichment (keyword signals)
- Working hours deferral
- SSE real-time sync (messages, typing, suggestions, AI toggle, mode change, star, resolve)
- Web push notifications
- Import from Hostaway (properties, reservations, messages)
- AI Logs with cost/cache tracking
- Sandbox chat testing
- Configure AI (system prompts, version history, template variables)
- Listings management (knowledge base, description summarization)
- Message templates
- Analytics dashboard

## Clarifications

### Session 2026-03-29

- Q: Remove dead API functions from frontend only, or also delete corresponding backend routes? → A: Frontend only — backend endpoints stay untouched (mobile app may use them)
- Q: Drop OpusReport and ClassifierWeights tables from DB? → A: Drop both — data has no value without deleted code
- Q: Remove all 11 unused shadcn/ui components? → A: Keep them for now — may use later, trivial to re-add
- Q: Remove automated messages backend (controller + route) along with dead frontend functions? → A: Remove both backend and frontend automated messages code entirely
- Q: Audit and remove orphaned backend routes that only served deleted frontend features (opus, SOP monitor, AI pipeline)? → A: Yes — remove orphaned backend routes for deleted features

---

## Dead Code Inventory (3-round audit, verified)

### BACKEND — Entirely Dead Services (delete files)

| File | Lines | Reason |
|------|-------|--------|
| `services/memory.service.ts` | ~136 | Zero external importers. ai.service.ts comment: "memory.service imports removed" |
| `services/snapshot.service.ts` | ~274 | Only called by dead `routes/ai-pipeline.ts` (cascading dead) |

### BACKEND — Dead Routes + Controllers (delete files)

| File | Reason |
|------|--------|
| `routes/ai-pipeline.ts` | All 4 endpoints only called by dead `ai-pipeline-v5.tsx` frontend |
| `routes/automated-messages.ts` | Entire feature removed per clarification |
| `controllers/automated-messages.controller.ts` | Entire feature removed per clarification |

### BACKEND — Orphaned Endpoints in Active Route Files

| Route File | Endpoint | Reason |
|-----------|----------|--------|
| `routes/ai-config.ts` | `POST /api/ai-config/sandbox-chat` | Duplicate of `/api/sandbox/chat` — never called |
| `routes/knowledge.ts` | `GET /api/knowledge/sop-classifications` | Only called by dead sop-monitor-v5.tsx |
| `routes/knowledge.ts` | `GET /api/knowledge/evaluation-stats` | Only called by dead sop-monitor-v5.tsx |

### BACKEND — Dead Exports (in active files)

| File | Export | Reason |
|------|--------|--------|
| `services/queue.service.ts` | `getQueueInstance()` | Exported but never called |
| `services/embeddings.service.ts` | `getEmbeddingDimensions()` | Exported but never called |
| `services/rerank.service.ts` | `setRerankEnabled()` | Exported but never called |

### BACKEND — Dead Code in ai.service.ts

| Line | Issue |
|------|-------|
| ~141 | `REASONING_CATEGORIES` constant — defined, never referenced anywhere |
| ~18 | Unused import: `SOP_CATEGORIES` from sop.service |
| ~24 | Unused import: `getChecklist` from document-checklist.service |
| ~1249 | Dead variable: `conversationTurns` — declared, never read |
| ~1302 | Dead variable: `knowledgeText` — declared, never read |
| ~1360 | Dead variable: `classificationInput` — declared, never read |
| ~970 | Dead parameter: `retrievedChunks` in `buildPropertyInfo()` — never used in body |
| ~1258-1268 | Redundant: copilot/autopilot `currentMsgs` branches are identical code |

### BACKEND — Dead Code in Other Active Files

| File | Issue |
|------|-------|
| `import.service.ts` | `PLAN_LIMITS` constant — all values are Infinity, has zero effect |
| `task.controller.ts` | `NextFunction` imported but never used |
| `judge.service.ts` | Stale TODO T027 — feature never implemented |

### BACKEND — Dead Prisma Models (drop tables)

| Model | Reason |
|-------|--------|
| `OpusReport` | Zero code references. Opus service deleted in feature 014. |
| `ClassifierWeights` | Zero code references (only a comment). Old classifier deleted in feature 013. |
| `AutomatedMessage` | Remove after automated-messages route/controller deletion if zero remaining references. |

### FRONTEND — Dead Components (delete files)

| File | Lines | Reason |
|------|-------|--------|
| `components/ai-pipeline-v5.tsx` | ~2,375 | Removed from inbox nav. Comment: "no longer needed" |
| `components/opus-v5.tsx` | ~528 | Removed from inbox nav. Comment: "daily audit service deleted" |
| `components/sop-monitor-v5.tsx` | ~673 | Removed from inbox nav. Comment: "no longer needed" |
| `components/theme-provider.tsx` | ~20 | Never imported by any file |

### FRONTEND — Dead API Functions (in `lib/api.ts`)

| Function | Reason |
|----------|--------|
| `apiCancelPendingAi` | Never called |
| `apiSendAiNow` | Never called |
| `apiTranslateMessage` | Never called |
| `apiGetAutomatedMessages` | Never called |
| `apiCreateAutomatedMessage` | Never called |
| `apiUpdateAutomatedMessage` | Never called |
| `apiToggleAutomatedMessage` | Never called |
| `apiDeleteAutomatedMessage` | Never called |
| `apiGetConversationChecklist` | Never called (`apiUpdateConversationChecklist` IS used) |
| `apiGetProperty` | Never called (plural `apiGetProperties` IS used) |
| `apiInquiryAction` | Never called |
| `apiGetSopData` | Never called |
| `apiCreateConversationTask` | Never called |
| `apiReindexPropertyKnowledge` | Never called |
| `apiGenerateOpusReport` | Only in dead opus-v5.tsx |
| `apiGetOpusReports` | Only in dead opus-v5.tsx |
| `apiGetOpusReport` | Only in dead opus-v5.tsx |
| `apiGetOpusReportRaw` | Only in dead opus-v5.tsx |
| `apiGetSopClassifications` | Only in dead sop-monitor-v5.tsx |
| `apiGetSopStats` | Only in dead sop-monitor-v5.tsx |
| `apiFetchAccuracy` | Only in dead ai-pipeline-v5.tsx |
| `apiGenerateSnapshot` | Only in dead ai-pipeline-v5.tsx |
| `mapCheckInStatus` | Never called |
| `mapReservationStatus` | Never called |

### FRONTEND — Dead Types in `lib/api.ts`

| Type | Reason |
|------|--------|
| `OpusReportSummary` | Only used by dead opus API functions |
| `OpusReportDetail` | Only used by dead opus API functions |
| `AccuracyMetrics` | Only used by dead ai-pipeline API functions |

### FRONTEND — Dead State Variables in Active Components

| Component | Variable | Reason |
|-----------|----------|--------|
| `analytics-v5.tsx` | `tooltip` state (line ~225) | Never set to visible — `setTooltip()` never called |
| `analytics-v5.tsx` | `hoveredDay` (line ~234) | Declared, never used or set |
| `ai-logs-v5.tsx` | `showRaw` (line ~225) | Declared, never toggled |
| `sandbox-chat-v5.tsx` | `reasoningEffort` (line ~93) | Always sent as undefined — no UI selector |

### FRONTEND — shadcn/ui Components (KEEP — decision: may use later)

11 unused components retained per clarification decision. Not part of cleanup scope.

### FRONTEND — Dead Hooks

| File | Reason |
|------|--------|
| `hooks/use-mobile.ts` | Never imported |
| `hooks/use-toast.ts` | Never imported |

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Remove Dead Frontend Code (Priority: P1)

Delete 4 dead component files, 24+ dead API functions from lib/api.ts, and 2 dead hooks. shadcn/ui components are kept. After deletion, the application builds and all existing features work identically.

**Why this priority**: Largest volume of dead code. Immediate reduction in codebase noise and bundle size.

**Independent Test**: Run frontend build after deletions. Open every navigation tab. Verify all 11 active tabs render correctly.

**Acceptance Scenarios**:

1. **Given** dead components deleted, **When** frontend builds, **Then** build succeeds with zero errors
2. **Given** dead API functions removed, **When** any active page loads, **Then** no import errors or runtime crashes
3. **Given** all inbox tabs clicked, **When** each tab renders, **Then** all 11 active tabs display correctly

---

### User Story 2 - Remove Dead Backend Code + Orphaned Routes (Priority: P2)

Delete 2 entirely dead service files (memory.service.ts, snapshot.service.ts), 3 dead route/controller files (ai-pipeline.ts, automated-messages route + controller), remove orphaned endpoints from active route files, remove dead exports/imports/variables from ai.service.ts and other files, and clean up dead code in active files. After removal, backend compiles and runs without errors.

**Why this priority**: Removes entire dead service files (~410 lines), dead routes (~500+ lines), dead code in ai.service.ts (~50 lines), and other dead artifacts. Significant codebase reduction.

**Independent Test**: Run backend compilation after changes. Verify AI pipeline processes a guest message end-to-end. Verify all active endpoints respond correctly.

**Acceptance Scenarios**:

1. **Given** dead services and routes removed, **When** backend compiles, **Then** compilation succeeds with zero errors
2. **Given** backend deployed, **When** a guest sends a message, **Then** AI responds correctly
3. **Given** orphaned routes removed, **When** any active endpoint is called, **Then** no 404 errors on live features
4. **Given** dead imports/variables removed from ai.service.ts, **When** backend compiles, **Then** zero unused-variable warnings

---

### User Story 3 - Remove Dead Prisma Models (Priority: P3)

Remove `OpusReport` and `ClassifierWeights` models from the Prisma schema. After removal, schema push applies cleanly and no runtime errors occur.

**Why this priority**: Schema cleanup. These models have zero code references but dropping tables is irreversible — requires confirmation.

**Independent Test**: Run schema push after changes. Verify application starts and handles messages.

**Acceptance Scenarios**:

1. **Given** dead models removed, **When** schema push runs, **Then** migration applies without errors
2. **Given** schema updated, **When** application starts, **Then** no Prisma client errors

---

### Edge Cases

- Backend endpoints for non-automated-messages features stay untouched — mobile app may call them directly
- shadcn/ui components kept per decision — re-add via CLI if accidentally deleted
- ClassifierExample and ClassifierEvaluation models are part of active judge/knowledge flow — do NOT remove
- Automated messages Prisma model (AutomatedMessage) should also be removed if no code references remain after route deletion

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: All deleted files MUST have zero active importers verified before removal
- **FR-002**: Frontend MUST build with zero errors after all deletions
- **FR-003**: Backend MUST compile with zero errors after all deletions
- **FR-004**: All 11 active navigation tabs MUST render correctly after cleanup
- **FR-005**: AI pipeline MUST process messages end-to-end after cleanup
- **FR-006**: Copilot suggestion flow MUST work after cleanup
- **FR-007**: No models referenced by active code may be removed
- **FR-008**: Dead code removal MUST be done in separate, reviewable commits (frontend, backend, schema)

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Zero dead component files remain in the frontend
- **SC-002**: All 24+ dead API functions removed from lib/api.ts
- **SC-003**: Frontend builds with zero errors and zero import warnings
- **SC-004**: Backend compiles with zero errors related to cleaned code
- **SC-005**: All active features verified working post-cleanup
- **SC-006**: Total lines of dead code removed exceeds 4,000 lines

## Assumptions

- Backend endpoints stay untouched except for automated messages and explicitly dead feature routes (opus, SOP monitor, AI pipeline)
- ClassifierExample and ClassifierEvaluation models are active (judge/knowledge flow) — not removed
- shadcn/ui components kept per clarification decision
- Automated messages feature removed entirely (frontend + backend + Prisma model if orphaned)
