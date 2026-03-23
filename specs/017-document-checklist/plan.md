# Implementation Plan: Document Checklist

**Branch**: `017-document-checklist` | **Date**: 2026-03-23 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/017-document-checklist/spec.md`

## Summary

Screening agent creates a document checklist (passports + marriage cert) via tool call when escalating. Coordinator sees the checklist in context and tracks document receipt via images. Data stored on existing `Reservation.screeningAnswers` JSON field. Two new AI tools + context injection + inbox sidebar display.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+
**Primary Dependencies**: OpenAI Node.js SDK, Express 4.x, Prisma ORM
**Storage**: PostgreSQL + Prisma ORM (no schema changes — uses existing `screeningAnswers` JSON field)
**Testing**: Manual — sandbox + real conversations
**Target Platform**: Railway (backend), Vercel (frontend)
**Project Type**: Web service (backend + frontend)
**Constraints**: Zero new DB models, zero migrations. Two new tools, context injection, UI display.

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| §I Graceful Degradation | PASS | FR-011: coordinator functions without checklist. Tool failures → fallback to no-checklist behavior |
| §II Multi-Tenant Isolation | PASS | Checklist on Reservation (already tenant-scoped via cascade) |
| §III Guest Safety & Access | PASS | Documents requested AFTER booking acceptance only. No document sharing to INQUIRY guests |
| §IV Structured AI Output | PASS | Tools use strict JSON schema. Checklist data is structured JSON |
| §V Escalate When In Doubt | PASS | Unclear images → escalate for manager review |
| §VI Observability | PASS | Tool calls logged in ragContext (existing pattern) |
| §VII Self-Improvement | N/A | No classifier changes |
| Security | PASS | Document images handled via existing image flow, not stored permanently |

No violations.

## Project Structure

### Files Modified

```text
backend/src/services/ai.service.ts          # Add tools to both agents, inject checklist context
backend/src/routes/sandbox.ts               # Add tools to sandbox
backend/src/controllers/conversations.ts    # Return checklist in conversation detail
frontend/components/inbox-v5.tsx            # Display checklist in sidebar + manual override
frontend/lib/api.ts                         # API types for checklist endpoints
```

### New Files

```text
backend/src/services/document-checklist.service.ts  # Tool handlers + checklist CRUD
backend/src/routes/document-checklist.ts            # REST endpoints for manual override
```

## Implementation Details

### Data Model — No Schema Change

Use existing `Reservation.screeningAnswers` (Json field, currently `{}`):

```json
{
  "documentChecklist": {
    "passportsNeeded": 2,
    "passportsReceived": 0,
    "marriageCertNeeded": true,
    "marriageCertReceived": false,
    "createdAt": "2026-03-23T10:00:00Z",
    "updatedAt": "2026-03-23T12:00:00Z",
    "createdBy": "screening-agent"
  }
}
```

Read/write via Prisma JSON field access. No migration needed.

### Tool 1: `create_document_checklist` (Screening Agent)

Added to the screening agent's tool list (alongside `search_available_properties`):

```json
{
  "type": "function",
  "name": "create_document_checklist",
  "description": "Create a document checklist for this booking. Call this when you have determined the guest's eligibility and are about to escalate to the manager. Records what documents the guest will need to submit after booking acceptance.",
  "strict": true,
  "parameters": {
    "type": "object",
    "properties": {
      "passports_needed": {
        "type": "number",
        "description": "Number of passport/ID documents needed (one per guest in the party)"
      },
      "marriage_certificate_needed": {
        "type": "boolean",
        "description": "Whether a marriage certificate is required (true for Arab married couples)"
      },
      "reason": {
        "type": "string",
        "description": "Brief note, e.g. 'Egyptian married couple, 2 guests'"
      }
    },
    "required": ["passports_needed", "marriage_certificate_needed", "reason"],
    "additionalProperties": false
  }
}
```

Tool handler: writes to `Reservation.screeningAnswers.documentChecklist` via Prisma.

### Tool 2: `mark_document_received` (Guest Coordinator)

Added to the coordinator's tool list (alongside `check_extend_availability`):

```json
{
  "type": "function",
  "name": "mark_document_received",
  "description": "Mark a document as received after the guest sends it through the chat. Call this when you see an image that is clearly a passport, ID, or marriage certificate. Do NOT call this for unclear images — escalate those instead.",
  "strict": true,
  "parameters": {
    "type": "object",
    "properties": {
      "document_type": {
        "type": "string",
        "enum": ["passport", "marriage_certificate"],
        "description": "Type of document received"
      },
      "notes": {
        "type": "string",
        "description": "Brief description, e.g. 'passport for Mohamed' or 'marriage certificate'"
      }
    },
    "required": ["document_type", "notes"],
    "additionalProperties": false
  }
}
```

Tool handler:
- `passport` → increment `passportsReceived` (cap at `passportsNeeded`)
- `marriage_certificate` → set `marriageCertReceived: true`
- Returns the updated checklist state as confirmation

### Context Injection

In `generateAndSendAiReply`, after building `propertyInfo`, inject checklist if it exists:

```typescript
const checklist = (context.screeningAnswers as any)?.documentChecklist;
if (checklist && (checklist.passportsReceived < checklist.passportsNeeded || (checklist.marriageCertNeeded && !checklist.marriageCertReceived))) {
  propertyInfo += `\n### DOCUMENT CHECKLIST ###\n`;
  propertyInfo += `Passports: ${checklist.passportsReceived}/${checklist.passportsNeeded} received\n`;
  if (checklist.marriageCertNeeded) {
    propertyInfo += `Marriage Certificate: ${checklist.marriageCertReceived ? 'received' : 'pending'}\n`;
  }
}
```

This only shows when documents are pending. Once complete, it disappears from context.

### System Prompt Addition

One line added to the coordinator system prompt (DB-backed, via Configure AI):

```
If the DOCUMENT CHECKLIST shows pending items, naturally remind the guest to send their documents through the chat. Don't demand documents on every message — ask when appropriate.
```

### Screening Prompt Addition

One line added to the screening system prompt:

```
When you escalate with a booking recommendation, also call the create_document_checklist tool to record what documents the guest will need to submit after acceptance.
```

### Inbox Sidebar UI

In `inbox-v5.tsx`, add a "Documents" section below TASKS in the sidebar:

```
📋 DOCUMENTS
  Passports:      1/2 ✅❌
  Marriage Cert:   pending ❌  [✓]
```

Each item has a toggle button for manual override. Calls `PUT /api/conversations/:id/checklist` endpoint.

### REST Endpoints for Manual Override

```
GET  /api/conversations/:id/checklist    → returns checklist or null
PUT  /api/conversations/:id/checklist    → manual update (passportsReceived, marriageCertReceived)
```

### Tool Use Flow — Multi-Tool Support

Currently each agent has ONE tool. This feature adds a second tool to each:
- Screening: `search_available_properties` + `create_document_checklist`
- Coordinator: `check_extend_availability` + `mark_document_received`

The `tools` array in `createMessage` already supports multiple tools. `tool_choice: 'auto'` lets the model pick which tool (or none). The tool loop in `createMessage` already handles tool calls.

**One consideration**: the current tool loop only processes ONE function call per response. If the model calls two tools in one response, the second is ignored. This is fine for our use case — the screening agent won't call both tools in one turn (search is for inquiry phase, checklist is for escalation phase).

### What Stays Unchanged

- `createMessage()` — already handles tools, no changes needed
- SOP classification — unaffected
- Image handling — already works, just now the coordinator has a tool to call when it sees documents
- Task manager — unaffected
- Debounce — unaffected
