# Implementation Plan: Tools Management Page

**Branch**: `018-tools-management` | **Date**: 2026-03-23 | **Spec**: [spec.md](./spec.md)

## Summary

Rebuild the Tools page from a hardcoded display into a full management interface. New DB model (`ToolDefinition`) stores all tool metadata — system tools seeded from code, custom tools created by operators. Editable descriptions, enable/disable toggles, custom webhook tools with JSON schema editor. Backend reads tool definitions from DB at runtime instead of hardcoded arrays.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+
**Primary Dependencies**: OpenAI Node.js SDK, Express 4.x, Prisma ORM, axios (webhook calls)
**Storage**: PostgreSQL + Prisma ORM (new ToolDefinition model)
**Target Platform**: Railway (backend), Vercel (frontend)
**Project Type**: Web service (backend + frontend)
**Constraints**: System tools keep hardcoded handlers; custom tools use webhook forwarding with 10s timeout.

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| §I Graceful Degradation | PASS | Missing/disabled tools → AI functions without them. Webhook timeout → graceful error to AI. |
| §II Multi-Tenant Isolation | PASS | ToolDefinition is tenant-scoped. |
| §III Guest Safety & Access | PASS | Tools don't expose access codes. Custom webhooks are operator-configured. |
| §IV Structured AI Output | PASS | Tool schemas use strict JSON. |
| §V Escalate When In Doubt | PASS | Failed tool → AI escalates instead. |
| §VI Observability | PASS | Tool invocations logged in AiApiLog.ragContext (existing). |
| §VII Self-Improvement | N/A | |
| Security | PASS | Webhook auth out of scope per spec. Webhook URLs stored per-tenant, not exposed to AI. |

No violations.

## Data Model

### New: `ToolDefinition`

```prisma
model ToolDefinition {
  id            String   @id @default(cuid())
  tenantId      String
  name          String   // unique per tenant: "search_available_properties"
  displayName   String   // "Property Search"
  description   String   @db.Text  // AI-facing description (editable)
  defaultDescription String @db.Text // Seed default (for reset)
  parameters    Json     // JSON Schema for tool parameters
  agentScope    String   // "screening" | "coordinator" | "both"
  type          String   // "system" | "custom"
  enabled       Boolean  @default(true)
  webhookUrl    String?  // Only for custom tools
  webhookTimeout Int     @default(10000) // ms
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([tenantId, name])
}
```

### Seeding

On first access per tenant, seed system tools from code:
- `get_sop` (both agents)
- `search_available_properties` (screening)
- `create_document_checklist` (screening)
- `check_extend_availability` (coordinator)
- `mark_document_received` (coordinator, conditional)

Same pattern as SOP seeding — upsert with `update: {}` (never overwrite edits).

## Implementation Details

### Phase 1: DB Model + Seed + CRUD Service

**New file**: `backend/src/services/tool-definition.service.ts`
- `getToolDefinitions(tenantId, prisma)` — returns all enabled tools (cached 5min)
- `seedToolDefinitions(tenantId, prisma)` — creates system tools if not exist
- `updateToolDefinition(id, updates, prisma)` — edit description, enabled, webhookUrl
- `createCustomTool(tenantId, data, prisma)` — create custom tool
- `deleteCustomTool(id, prisma)` — delete (only type=custom)
- `resetDescription(id, prisma)` — restore defaultDescription
- Cache invalidation on any write

### Phase 2: Wire Tools from DB into AI Pipeline

**Changes to `ai.service.ts`**:

Currently tools are hardcoded arrays (`screeningTools`, `coordinatorTools`). Replace with:

```typescript
const toolDefs = await getToolDefinitions(tenantId, prisma);
const agentTools = toolDefs
  .filter(t => t.enabled && (t.agentScope === agentType || t.agentScope === 'both'))
  .map(t => ({
    type: 'function',
    name: t.name,
    description: t.description,
    strict: true,
    parameters: t.parameters,
  }));
```

Tool handlers: system tools keep their existing handlers (matched by `name`). Custom tools get a generic webhook handler:

```typescript
if (handler) {
  result = await handler(input, context);
} else if (toolDef.webhookUrl) {
  result = await callWebhook(toolDef.webhookUrl, input, toolDef.webhookTimeout);
} else {
  result = JSON.stringify({ error: `No handler for tool: ${name}` });
}
```

**New file**: `backend/src/services/webhook-tool.service.ts`
- `callWebhook(url, input, timeoutMs)` — POST JSON, return response string, 10s timeout, graceful error

### Phase 3: REST API

**New file**: `backend/src/routes/tool-definitions.ts`

```
GET    /api/tools              → list all tool definitions for tenant
PUT    /api/tools/:id          → update description, enabled, webhookUrl
POST   /api/tools              → create custom tool
DELETE /api/tools/:id           → delete custom tool (type=custom only)
POST   /api/tools/:id/reset    → reset description to default
```

### Phase 4: Frontend — Tools Page Rebuild

**Rewrite**: `frontend/components/tools-v5.tsx`

**Layout**:
- **Header**: "Tools" title + "Add Custom Tool" button
- **Tool cards grid**: One card per tool
  - Tool name + type badge (system/custom)
  - Agent scope badge (screening/coordinator/both)
  - Enable/disable toggle
  - Description (inline editable textarea, save button)
  - Expandable: parameter schema (read-only formatted JSON)
  - For custom tools: webhook URL field, delete button
  - "Reset to Default" link for edited system tool descriptions
- **Invocation log**: Existing table at bottom, extended to show all tools

**Custom Tool Creator Modal**:
- Name (text input, validated unique)
- Display name (text input)
- Description (textarea)
- Agent scope (dropdown: screening/coordinator/both)
- Webhook URL (text input)
- Parameter schema (monospace JSON editor with validation)
- Save / Cancel

### Phase 5: Sandbox Integration

Update sandbox to also read tools from DB (same as production). Currently sandbox has hardcoded tool arrays — replace with `getToolDefinitions()`.

### Files Modified

```text
backend/prisma/schema.prisma                     # New ToolDefinition model
backend/src/services/ai.service.ts               # Read tools from DB, webhook handler fallback
backend/src/routes/sandbox.ts                    # Read tools from DB
backend/src/app.ts                               # Register tool-definitions router
frontend/components/tools-v5.tsx                 # Full rewrite
frontend/lib/api.ts                              # New API types + functions
```

### New Files

```text
backend/src/services/tool-definition.service.ts  # CRUD + seeding + caching
backend/src/services/webhook-tool.service.ts     # Webhook caller with timeout
backend/src/routes/tool-definitions.ts           # REST endpoints
```

### What Stays Unchanged

- SOP classification (`get_sop`) — still uses `buildToolDefinition()` from sop.service.ts for the dynamic enum. The ToolDefinition stores the metadata, but the SOP tool's special behavior (dynamic categories) is preserved.
- Tool invocation logging in ragContext — already works
- Existing tool handlers (search, extend, checklist) — keep their code, just matched by name
