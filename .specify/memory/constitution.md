<!--
Sync Impact Report
===================
Version change: 1.1.1 → 2.0.0
Modified principles:
  - §IV Structured AI Output: updated to reflect OpenAI json_schema enforcement
  - §VI Observability by Default: removed ClassifierEvaluation and OPUS references
  - §VII Self-Improvement: removed (classifier + judge system no longer exists)
  - Added §VII Tool-Based Architecture: new principle for tool system
  - Added §VIII FAQ Knowledge Loop: new principle for FAQ auto-suggest
Removed principles:
  - §VII Self-Improvement with Guardrails (entire 3-tier classifier + judge removed)
Modified sections:
  - Security & Data Protection: ANTHROPIC_API_KEY → OPENAI_API_KEY
  - Development Workflow: updated branch strategy, removed classifier references
Templates requiring updates: None
Follow-up TODOs: None
-->

# GuestPilot v2 Constitution

## Core Principles

### I. Graceful Degradation (NON-NEGOTIABLE)

The main guest messaging flow MUST never break. Every feature, service,
and integration MUST degrade gracefully when dependencies are unavailable.

- Optional dependencies (Redis, Langfuse, Web Push) MUST fall back
  silently — never crash, never block the pipeline.
- New features MUST NOT introduce hard dependencies on optional services.
- If an AI pipeline stage fails, the system MUST either skip that stage
  and continue or escalate to a human operator — never leave a guest
  message unanswered silently.
- The webhook handler (`POST /webhooks/hostaway/:tenantId`) MUST return
  200 immediately and process asynchronously. Webhook processing failures
  MUST NOT propagate to the caller.
- Fire-and-forget services (summary, FAQ suggest, task manager, push
  notifications) MUST catch all errors internally. A failure in post-
  processing MUST NOT affect the already-delivered guest response.

**Rationale:** This is a production guest communication platform. A silent
failure means a real guest waiting for a reply that never comes. Uptime
of the core messaging loop is the single most important system property.

### II. Multi-Tenant Isolation (NON-NEGOTIABLE)

Every database query, API response, and background job MUST be scoped to
the authenticated tenant. Data leakage between tenants is a critical
security violation.

- Every Prisma model includes `tenantId`. All queries MUST filter by it.
- JWT tokens carry `tenantId` and `plan` — the auth middleware injects
  these into every authenticated request.
- Background jobs (debounce poll, BullMQ workers) MUST resolve tenant
  context from the job payload, never from global state.
- Socket.IO event streams MUST only broadcast to connections authenticated
  for the target tenant.
- Cascade deletes (`onDelete: Cascade`) on tenant relations MUST be
  preserved — deleting a tenant MUST remove all associated data.
- SOP definitions, tool definitions, FAQ entries, and AI config are all
  per-tenant. Global FAQ entries (scope: GLOBAL) are still scoped to
  the tenant that created them.

**Rationale:** GuestPilot serves multiple independent apartment operators.
A tenant MUST never see another tenant's guests, messages, properties,
or AI configuration.

### III. Guest Safety & Access Control (NON-NEGOTIABLE)

The AI MUST protect guest and property security through strict
information gating based on reservation status.

- Access codes (door codes, WiFi passwords) MUST never be exposed to
  guests with INQUIRY reservation status. The `{ACCESS_CONNECTIVITY}`
  template variable is omitted entirely for INQUIRY guests.
- The AI MUST never authorize refunds, credits, or discounts.
- The AI MUST never guarantee specific service times.
- The AI MUST never discuss its own nature as AI, reference managers,
  or reveal internal processes to guests.
- Screening rules (SPEC.md Section 9) MUST be enforced exactly as
  specified — the AI has no discretion to override screening criteria.
- Documents MUST only be requested AFTER booking acceptance, never before.

**Rationale:** Incorrect information disclosure (e.g., door codes to
non-guests) is a physical security risk. Financial commitments by AI
create legal liability. Guests must interact with "Omar" as a
consistent human-like persona.

### IV. Structured AI Output

All AI responses MUST be valid JSON conforming to the defined output
schemas, enforced via OpenAI's `json_schema` structured output.

- Coordinator output: `{ guest_message, escalation?, resolveTaskId?, updateTaskId? }`
- Screening output: `{ "guest message", manager: { needed, title, note } }`
- Schema enforcement is strict (`strict: true`) — the API guarantees
  valid JSON matching the schema.
- Response parsing MUST still strip code fences as a defensive measure.
- GPT-5-Nano services (summary, FAQ suggest, task manager) also use
  json_schema or plain text output — never unstructured JSON.

**Rationale:** The entire post-generation pipeline (escalation handling,
task creation, message delivery) depends on reliably parsing AI output.
Malformed output breaks the pipeline for that guest.

### V. Escalate When In Doubt

The system MUST prefer over-escalation to under-escalation. Missing a
genuine issue (safety, complaint, urgent maintenance) is worse than
creating a false-positive task for a manager to dismiss.

- 25 escalation triggers across three urgency tiers (immediate, scheduled,
  info_request) MUST be respected as defined in SPEC.md Section 10.
- The escalation-enrichment service adds keyword-based signals that
  supplement AI judgment — these MUST NOT be removed or weakened without
  explicit review.
- The task manager dedup service (GPT-5-Nano) MUST default to CREATE on
  any error — never silently drop an escalation.
- Every escalation creates a Task record and broadcasts a Socket.IO event.
- When the AI is uncertain about how to handle a request, it MUST escalate
  rather than guess.

**Rationale:** A missed safety escalation (fire, flood, locked-out guest)
has real-world consequences. A false escalation costs a manager 10 seconds
to dismiss. The cost asymmetry strongly favors over-escalation.

### VI. Observability by Default

Every AI call, tool invocation, and escalation decision MUST be logged
with sufficient detail for post-hoc debugging and audit.

- `AiApiLog` MUST record: model, tokens, cost, duration, full prompt,
  response, and ragContext snapshot (SOP classification, tool calls,
  escalation signals, cache stats) for every AI call.
- The ragContext.tools array MUST store per-tool details: name, input,
  results, and durationMs for every tool invocation.
- Langfuse tracing (when configured) MUST fire-and-forget — observability
  failures MUST NOT block the pipeline (see Principle I).
- Socket.IO events MUST provide real-time visibility into AI activity
  (`ai_typing`, `ai_typing_clear`, `ai_typing_text`, `ai_suggestion`).
- The AI Logs page MUST surface all tool calls, content blocks, SOP
  classification, cache hit rates, and escalation signals.

**Rationale:** An AI system that handles guest communication autonomously
MUST be auditable. When the AI makes a mistake, operators need full
context to understand why and to improve the system.

### VII. Tool-Based Architecture

The AI pipeline MUST use tool calls as the primary mechanism for accessing
SOPs, FAQ knowledge, property search, and external actions.

- SOP classification MUST use a forced `get_sop` tool call — the AI
  selects categories based on the guest message, not a separate classifier.
- Tool definitions are DB-backed and per-tenant. System tools have fixed
  schemas; custom tools are webhook-backed with user-defined parameters.
- Tool scope MUST be enforced by reservation status (`agentScope`). Tools
  that expose sensitive operations (extend stay, mark document) MUST only
  be available for appropriate statuses.
- New capabilities SHOULD be added as tools rather than hardcoded logic,
  enabling per-tenant customization and observability.
- The tool use loop MUST be bounded (max 5 rounds) to prevent infinite
  loops or runaway costs.

**Rationale:** Tool-based architecture provides clear audit trails (every
tool call is logged), per-tenant customization (tools can be enabled/
disabled), and extensibility (new tools via webhooks without code changes).

### VIII. FAQ Knowledge Loop

The FAQ auto-suggest pipeline MUST operate autonomously but require
human approval before any FAQ entry affects AI responses.

- Auto-suggested FAQ entries MUST have status=SUGGESTED until a manager
  explicitly approves them. The AI MUST NOT use SUGGESTED entries.
- Only ACTIVE entries are returned by `get_faq` tool calls.
- FAQ entries support dual scope: GLOBAL (all properties) and PROPERTY
  (specific listing). Property-specific entries override global on
  first-50-char fingerprint match.
- Stale entries (90 days without use) are automatically marked STALE.
  Unreviewed suggestions expire after 28 days.
- The FAQ suggest service MUST be fire-and-forget — failures MUST NOT
  affect message delivery.

**Rationale:** FAQ auto-suggest captures institutional knowledge that
would otherwise be lost in one-off manager replies. Human approval
prevents low-quality or incorrect answers from reaching guests.

## Security & Data Protection

- **Secrets MUST never be committed** to version control — `.env` files,
  API keys, credentials, and webhook secrets are excluded via `.gitignore`.
- **JWT tokens** expire after 30 days. The `JWT_SECRET` environment variable
  is required and MUST be explicitly set — no fallback value.
- **Webhook endpoints** (`/webhooks/hostaway/:tenantId`) are public-facing.
  Hostaway webhook secrets MUST be validated when configured.
- **Hostaway API keys** are stored per-tenant in the database. They MUST
  be treated as secrets — never logged, never in API responses, never
  in error messages.
- **OpenAI API key** (`OPENAI_API_KEY`) is the only required AI provider
  key. It MUST NOT be logged or exposed.
- **Image handling**: Guest images are downloaded from Hostaway, converted
  to base64, and passed to OpenAI as content blocks. Images MUST NOT be
  stored permanently beyond the AI call.
- **CORS** is restricted to explicitly configured origins (`CORS_ORIGINS`).

## Development Workflow

- **Branch strategy**: Feature branches merge directly to `main`.
  No long-lived development branches.
- **Database changes**: Schema modifications via `prisma/schema.prisma`
  applied with `npx prisma db push`. Destructive migrations require
  data migration planning.
- **Environment variable discipline**: New optional dependencies MUST
  check for the env var at startup and disable silently if missing.
  Required variables (`DATABASE_URL`, `JWT_SECRET`, `OPENAI_API_KEY`)
  MUST cause a clear startup error if absent.
- **AI prompt changes**: System prompts are DB-stored per-tenant.
  Changes to seed constants only affect new tenants or tenants who
  "Reset to Default". The sandbox endpoint exists for testing.
- **Cost awareness**: AI model selection has direct cost implications.
  GPT-5-Nano is used for lightweight tasks ($0.05/1M). Changes that
  increase per-message cost MUST be flagged and justified.

## Governance

This constitution defines the non-negotiable principles and constraints
for the GuestPilot v2 platform. It supersedes ad-hoc decisions and MUST
be consulted when architectural trade-offs arise.

- **Amendment process**: Changes MUST be documented with a version bump,
  rationale, and sync impact report. Principles marked NON-NEGOTIABLE
  require stronger justification for modification.
- **Versioning**: Semantic versioning — MAJOR for principle removals or
  redefinitions, MINOR for new principles, PATCH for clarifications.
- **Authoritative references**: `SPEC.md` is the system specification.
  `AI_SYSTEM_FLOW.md` is the pipeline reference. `CLAUDE.md` is the
  development guide. This constitution governs the principles that those
  documents implement.

**Version**: 2.0.0 | **Ratified**: 2026-04-03 | **Last Amended**: 2026-04-03
